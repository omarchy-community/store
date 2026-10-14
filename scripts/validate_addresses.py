#!/usr/bin/env python3
"""Validate crypto receive addresses before they go on the site.

A single wrong character sends money somewhere unrecoverable, so every address is checked
against its real checksum, not just its shape. No third-party libraries are available here,
so bech32, Keccak-256 and base58 are implemented below and SELF-TESTED against published
vectors first — a validator that wrongly reports "valid" is worse than no validator.

Usage: validate_addresses.py            (runs self-tests, then checks the addresses below)
"""
import hashlib
import sys

# --------------------------------------------------------------------- Keccak-256
# Ethereum's EIP-55 checksum uses ORIGINAL Keccak-256, which is NOT hashlib.sha3_256
# (SHA3 adds different padding). Implemented from the Keccak-f[1600] spec.
_RC = [0x0000000000000001, 0x0000000000008082, 0x800000000000808A, 0x8000000080008000,
       0x000000000000808B, 0x0000000080000001, 0x8000000080008081, 0x8000000000008009,
       0x000000000000008A, 0x0000000000000088, 0x0000000080008009, 0x000000008000000A,
       0x000000008000808B, 0x800000000000008B, 0x8000000000008089, 0x8000000000008003,
       0x8000000000008002, 0x8000000000000080, 0x000000000000800A, 0x800000008000000A,
       0x8000000080008081, 0x8000000000008080, 0x0000000080000001, 0x8000000080008008]
_ROT = [[0, 36, 3, 41, 18], [1, 44, 10, 45, 2], [62, 6, 43, 15, 61],
        [28, 55, 25, 21, 56], [27, 20, 39, 8, 14]]
_M = (1 << 64) - 1


def _rotl(x, n):
    return ((x << n) | (x >> (64 - n))) & _M if n else x


def _keccak_f(a):
    for rnd in range(24):
        c = [a[x][0] ^ a[x][1] ^ a[x][2] ^ a[x][3] ^ a[x][4] for x in range(5)]
        d = [c[(x - 1) % 5] ^ _rotl(c[(x + 1) % 5], 1) for x in range(5)]
        for x in range(5):
            for y in range(5):
                a[x][y] ^= d[x]
        b = [[0] * 5 for _ in range(5)]
        for x in range(5):
            for y in range(5):
                b[y][(2 * x + 3 * y) % 5] = _rotl(a[x][y], _ROT[x][y])
        for x in range(5):
            for y in range(5):
                a[x][y] = b[x][y] ^ ((~b[(x + 1) % 5][y]) & _M & b[(x + 2) % 5][y])
        a[0][0] ^= _RC[rnd]
    return a


def keccak256(data: bytes) -> bytes:
    rate = 136  # 1088 bits for Keccak-256
    a = [[0] * 5 for _ in range(5)]
    # Keccak pad10*1 uses 0x01; SHA3 would use 0x06 — this is the crucial difference.
    padded = data + b"\x01" + b"\x00" * ((-len(data) - 1) % rate)
    padded = padded[:-1] + bytes([padded[-1] ^ 0x80])
    for off in range(0, len(padded), rate):
        blk = padded[off:off + rate]
        for i in range(rate // 8):
            w = int.from_bytes(blk[i * 8:i * 8 + 8], "little")
            a[i % 5][i // 5] ^= w
        a = _keccak_f(a)
    out = b""
    for i in range(4):  # 32 bytes
        out += a[i % 5][i // 5].to_bytes(8, "little")
    return out[:32]


# ------------------------------------------------------------------------ bech32
B32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"


def _polymod(values):
    gen = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
    chk = 1
    for v in values:
        top = chk >> 25
        chk = ((chk & 0x1ffffff) << 5) ^ v
        for i in range(5):
            chk ^= gen[i] if ((top >> i) & 1) else 0
    return chk


def _hrp_expand(hrp):
    return [ord(c) >> 5 for c in hrp] + [0] + [ord(c) & 31 for c in hrp]


def bech32_check(addr):
    """Returns (ok, detail). Handles bech32 (BIP-173) and bech32m (BIP-350)."""
    if addr != addr.lower() and addr != addr.upper():
        return False, "mixed case"
    a = addr.lower()
    pos = a.rfind("1")
    if pos < 1 or pos + 7 > len(a) or len(a) > 90:
        return False, "bad separator or length"
    hrp, data = a[:pos], a[pos + 1:]
    if any(c not in B32 for c in data):
        bad = [c for c in data if c not in B32]
        return False, f"character(s) not in the bech32 alphabet: {bad}"
    vals = [B32.index(c) for c in data]
    const = _polymod(_hrp_expand(hrp) + vals)
    if const == 1:
        enc = "bech32"
    elif const == 0x2bc830a3:
        enc = "bech32m"
    else:
        return False, "CHECKSUM FAILED"
    witver = vals[0]
    if witver == 0 and enc != "bech32":
        return False, "v0 must use bech32"
    if witver != 0 and enc != "bech32m":
        return False, "v1+ must use bech32m"
    # convert 5-bit groups to bytes to size the witness program
    acc = bits = 0
    prog = []
    for v in vals[1:-6]:
        acc = (acc << 5) | v
        bits += 5
        if bits >= 8:
            bits -= 8
            prog.append((acc >> bits) & 0xff)
    if bits >= 5 or (acc << (8 - bits)) & 0xff:
        return False, "bad padding"
    kind = {20: "P2WPKH", 32: "P2WSH/P2TR"}.get(len(prog), f"{len(prog)}-byte program")
    return True, f"{enc}, witness v{witver}, {kind}, hrp={hrp}"


# ------------------------------------------------------------------------ base58
BTC58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
XRP58 = "rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz"


def b58decode(s, alphabet):
    n = 0
    for ch in s:
        i = alphabet.find(ch)
        if i < 0:
            raise ValueError(f"character {ch!r} is not in this base58 alphabet")
        n = n * 58 + i
    full = n.to_bytes((n.bit_length() + 7) // 8, "big") if n else b""
    pad = len(s) - len(s.lstrip(alphabet[0]))
    return b"\x00" * pad + full


def solana_check(addr):
    try:
        raw = b58decode(addr, BTC58)
    except ValueError as e:
        return False, str(e)
    if len(raw) != 32:
        return False, f"decodes to {len(raw)} bytes, a Solana address must be exactly 32"
    return True, "32-byte base58 ed25519 public key"


def xrp_check(addr):
    if not addr.startswith("r"):
        return False, "classic XRP addresses start with r"
    try:
        raw = b58decode(addr, XRP58)
    except ValueError as e:
        return False, str(e)
    if len(raw) != 25:
        return False, f"decodes to {len(raw)} bytes, expected 25"
    body, chk = raw[:21], raw[21:]
    if hashlib.sha256(hashlib.sha256(body).digest()).digest()[:4] != chk:
        return False, "CHECKSUM FAILED"
    if body[0] != 0x00:
        return False, f"type prefix {body[0]:#x} is not an account address"
    return True, "base58 + double-SHA256 checksum valid, 20-byte account ID"


def evm_check(addr):
    if not addr.startswith("0x") or len(addr) != 42:
        return False, "must be 0x followed by 40 hex characters"
    h = addr[2:]
    if any(c not in "0123456789abcdefABCDEF" for c in h):
        return False, "contains non-hex characters"
    if h == h.lower() or h == h.upper():
        return True, "valid hex, but ALL ONE CASE so there is no EIP-55 checksum to verify"
    digest = keccak256(h.lower().encode()).hex()
    for i, c in enumerate(h):
        if c.isalpha():
            want = c.upper() if int(digest[i], 16) >= 8 else c.lower()
            if c != want:
                return False, f"EIP-55 CHECKSUM FAILED at position {i} ({c!r} should be {want!r})"
    return True, "EIP-55 mixed-case checksum valid"


# -------------------------------------------------------------------- self-tests
def self_test():
    fails = []

    def t(name, got, want):
        if got != want:
            fails.append(f"{name}: got {got!r}, expected {want!r}")

    # Keccak-256 known vectors
    t("keccak('')", keccak256(b"").hex(),
      "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470")
    t("keccak('abc')", keccak256(b"abc").hex(),
      "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45")
    # bech32 BIP-173 vectors
    t("bip173 valid", bech32_check("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4")[0], True)
    t("bip173 bad checksum", bech32_check("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5")[0], False)
    # EIP-55 vectors
    t("eip55 valid", evm_check("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed")[0], True)
    t("eip55 tampered", evm_check("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD")[0], False)
    # XRP: ACCOUNT_ZERO is a real, valid address
    t("xrp valid", xrp_check("rrrrrrrrrrrrrrrrrrrrrhoLvTp")[0], True)
    t("xrp tampered", xrp_check("rrrrrrrrrrrrrrrrrrrrrhoLvTq")[0], False)
    # Solana: the USDC mint is a well-known valid 32-byte key
    t("sol valid", solana_check("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")[0], True)
    t("sol too short", solana_check("abc")[0], False)
    return fails


ADDRESSES = [
    ("Bitcoin",          "bc1q0r9gmldnalw9f3937208jz66526wgllp8xjklm",   bech32_check),
    ("Ethereum / Base",  "0x75a50d6A248dA0E4FC0D9439e4F99000dd3E47DC",   evm_check),
    ("Solana",           "7UzaFpPezTCTRN6AeKM5z16ACd1dkQE1NrqPtZr4i1Zb", solana_check),
    ("XRP",              "r9fY1YK1LCVh8um2bs7b9DueNCWDB4Yq33",           xrp_check),
]

if __name__ == "__main__":
    bad = self_test()
    if bad:
        print("SELF-TESTS FAILED — the validators themselves are wrong, trust nothing below:")
        for b in bad:
            print("   ", b)
        sys.exit(2)
    print("✓ validator self-tests pass (Keccak-256, bech32, EIP-55, XRP, base58)\n")

    all_ok = True
    for name, addr, fn in ADDRESSES:
        ok, detail = fn(addr)
        all_ok &= ok
        print(f"{'✓' if ok else '✗'} {name:17s} {addr}")
        print(f"  {'' if ok else '>>> '}{detail}\n")
    print("ALL ADDRESSES VALID" if all_ok else "SOMETHING IS WRONG — DO NOT PUBLISH")
    sys.exit(0 if all_ok else 1)
