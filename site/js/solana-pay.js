/**
 * Omarchy Store — Solana Pay checkout
 *
 * Buyers pay in USDC on Solana. One atomic transaction carries BOTH transfers,
 * so the developer's 90% and the store's 10% either both land or neither does.
 *
 * Only dependency: @solana/web3.js (window.solanaWeb3).
 * The SPL token instructions are built by hand below, because the @solana/spl-token
 * UMD bundle is large, frequently broken on CDNs, and we only need two instructions.
 *
 * The store never holds keys and never takes custody: the buyer's wallet signs and
 * the funds go straight to the developer's and the store's public addresses.
 */
(function () {
  "use strict";

  // ---------------------------------------------------------------- constants
  var RPC = "https://api.mainnet-beta.solana.com";
  var USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // mainnet USDC
  var USDC_DECIMALS = 6;
  var STORE_WALLET = "13XS2jdwJKZbvj8KcuJwgKcysea5y5nrQe8N5maKoaUU"; // public address
  var TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
  var ASSOC_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
  var SYSVAR_RENT = "SysvarRent111111111111111111111111111111111";
  var STORE_CUT = 0.10; // 10% — the developer keeps 90%

  var LS_KEY = "omarchy_purchases";

  // ---------------------------------------------------------------- utilities
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function web3() {
    if (!window.solanaWeb3) throw new Error("Solana library didn't load. Check your connection and reload the page.");
    return window.solanaWeb3;
  }

  /** USD -> integer USDC base units, rounded to the cent so floats never drift. */
  function toBaseUnits(usd) {
    return Math.round(Number(usd) * Math.pow(10, USDC_DECIMALS));
  }

  function fmtUSD(n) {
    return "$" + (Math.round(Number(n) * 100) / 100).toFixed(2);
  }

  /** little-endian u64 as 8 bytes (amounts here are far below 2^53, so Number is safe). */
  function u64le(n) {
    var b = new Uint8Array(8);
    for (var i = 0; i < 8; i++) { b[i] = n & 0xff; n = Math.floor(n / 256); }
    return b;
  }

  // ------------------------------------------------- SPL token, built by hand
  /** Associated Token Account address for (owner, mint). */
  async function ata(ownerPk, mintPk) {
    var W = web3();
    var res = await W.PublicKey.findProgramAddress(
      [ownerPk.toBuffer(), new W.PublicKey(TOKEN_PROGRAM).toBuffer(), mintPk.toBuffer()],
      new W.PublicKey(ASSOC_TOKEN_PROGRAM)
    );
    return res[0];
  }

  /** SPL Token `Transfer` (instruction 3). */
  function transferIx(fromAta, toAta, ownerPk, amount) {
    var W = web3();
    var data = new Uint8Array(9);
    data[0] = 3;
    data.set(u64le(amount), 1);
    return new W.TransactionInstruction({
      programId: new W.PublicKey(TOKEN_PROGRAM),
      keys: [
        { pubkey: fromAta, isSigner: false, isWritable: true },
        { pubkey: toAta, isSigner: false, isWritable: true },
        { pubkey: ownerPk, isSigner: true, isWritable: false },
      ],
      data: data,
    });
  }

  /** Create an Associated Token Account, paid for by `payer`. */
  function createAtaIx(payerPk, ataPk, ownerPk, mintPk) {
    var W = web3();
    return new W.TransactionInstruction({
      programId: new W.PublicKey(ASSOC_TOKEN_PROGRAM),
      keys: [
        { pubkey: payerPk, isSigner: true, isWritable: true },
        { pubkey: ataPk, isSigner: false, isWritable: true },
        { pubkey: ownerPk, isSigner: false, isWritable: false },
        { pubkey: mintPk, isSigner: false, isWritable: false },
        { pubkey: W.SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: new W.PublicKey(TOKEN_PROGRAM), isSigner: false, isWritable: false },
        { pubkey: new W.PublicKey(SYSVAR_RENT), isSigner: false, isWritable: false },
      ],
      data: new Uint8Array(0),
    });
  }

  // ------------------------------------------------------------------ wallets
  function availableWallets() {
    var out = [];
    if (window.phantom && window.phantom.solana && window.phantom.solana.isPhantom)
      out.push({ name: "Phantom", provider: window.phantom.solana });
    if (window.solflare && window.solflare.isSolflare)
      out.push({ name: "Solflare", provider: window.solflare });
    if (window.backpack && window.backpack.isBackpack)
      out.push({ name: "Backpack", provider: window.backpack });
    if (!out.length && window.solana) out.push({ name: "Solana wallet", provider: window.solana });
    return out;
  }

  // -------------------------------------------------------------------- modal
  function modal(cls, inner) {
    var el = document.createElement("div");
    el.className = "wallet-modal " + (cls || "");
    el.innerHTML = '<div class="wallet-modal-content" role="dialog" aria-modal="true">' + inner + "</div>";
    function close() { el.remove(); document.removeEventListener("keydown", onKey); }
    function onKey(e) { if (e.key === "Escape") close(); }
    el.addEventListener("click", function (e) {
      if (e.target === el || (e.target.closest && e.target.closest("[data-wm-close]"))) close();
    });
    document.addEventListener("keydown", onKey);
    document.body.appendChild(el);
    el.close = close;
    return el;
  }

  function installWalletModal() {
    modal("", [
      "<h2>You need a Solana wallet</h2>",
      "<p>Paid apps are bought with USDC on Solana. Install one of these free wallets, add a little USDC, then come back and press Buy.</p>",
      '<div class="wallet-options">',
      '<a class="wallet-option" href="https://phantom.app/" target="_blank" rel="noopener"><span>Phantom</span><small>Most popular</small></a>',
      '<a class="wallet-option" href="https://solflare.com/" target="_blank" rel="noopener"><span>Solflare</span></a>',
      '<a class="wallet-option" href="https://backpack.app/" target="_blank" rel="noopener"><span>Backpack</span></a>',
      "</div>",
      '<button class="cancel-btn" data-wm-close>Close</button>',
    ].join(""));
  }

  function pickWallet(wallets) {
    return new Promise(function (resolve) {
      var m = modal("", [
        "<h2>Choose your wallet</h2>",
        '<div class="wallet-options">',
        wallets.map(function (w, i) {
          return '<button class="wallet-option" data-i="' + i + '"><span>' + esc(w.name) + "</span></button>";
        }).join(""),
        "</div>",
        '<button class="cancel-btn" data-wm-close>Cancel</button>',
      ].join(""));
      m.querySelectorAll("[data-i]").forEach(function (b) {
        b.onclick = function () { var i = +b.dataset.i; m.close(); resolve(wallets[i]); };
      });
      m.addEventListener("click", function (e) {
        if (e.target === m || (e.target.closest && e.target.closest("[data-wm-close]"))) resolve(null);
      });
    });
  }

  function confirmModal(app, price, devWallet) {
    var dev = Math.round(price * (1 - STORE_CUT) * 100) / 100;
    var store = Math.round(price * STORE_CUT * 100) / 100;
    return new Promise(function (resolve) {
      var m = modal("", [
        "<h2>Buy " + esc(app.name) + "</h2>",
        '<div class="pay-sum">',
        '<div class="pay-row"><span>Price</span><b>' + esc(fmtUSD(price)) + " USDC</b></div>",
        '<div class="pay-row sub"><span>' + esc(app.developer || "Developer") + " (90%)</span><span>" + esc(fmtUSD(dev)) + "</span></div>",
        '<div class="pay-row sub"><span>Omarchy Store (10%)</span><span>' + esc(fmtUSD(store)) + "</span></div>",
        "</div>",
        "<p class=\"pay-note\">One transaction on Solana, signed by you in your own wallet. Network fee is about $0.0003. Blockchain payments can't be reversed.</p>",
        '<div class="pay-actions"><button class="cancel-btn" data-wm-close>Cancel</button><button class="download-btn" data-go>Pay ' + esc(fmtUSD(price)) + " USDC</button></div>",
      ].join(""));
      m.querySelector("[data-go]").onclick = function () { m.close(); resolve(true); };
      m.addEventListener("click", function (e) {
        if (e.target === m || (e.target.closest && e.target.closest("[data-wm-close]"))) resolve(false);
      });
    });
  }

  function busyModal(text) {
    return modal("busy", "<h2>" + esc(text) + "</h2><p class=\"pay-note\">Approve the transaction in your wallet. Don't close this tab.</p>");
  }

  function successModal(app, sig) {
    modal("success", [
      "<h2>&#10003; " + esc(app.name) + " is yours</h2>",
      "<p>Payment confirmed on Solana. You can install it now — press <b>GET</b> on the app page.</p>",
      '<p class="signature"><a href="https://solscan.io/tx/' + encodeURIComponent(sig) + '" target="_blank" rel="noopener">View the transaction</a></p>',
      '<button class="download-btn" data-wm-close>Done</button>',
    ].join(""));
  }

  // `retryable` false means trying again cannot help (e.g. the app has no payout wallet),
  // so we must not tell the buyer to try again.
  function errorModal(msg, retryable) {
    modal("error", [
      "<h2>Payment not completed</h2>",
      "<p>" + esc(msg) + "</p>",
      retryable === false
        ? "<p class=\"pay-note\">Nothing was charged.</p>"
        : "<p class=\"pay-note\">Nothing was charged. You can safely try again.</p>",
      '<button class="cancel-btn" data-wm-close>Close</button>',
    ].join(""));
  }

  // ------------------------------------------------------------- purchase log
  function purchases() {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || "{}"); } catch (e) { return {}; }
  }
  function hasPurchased(appId) { return !!purchases()[appId]; }
  function recordPurchase(appId, sig, buyer) {
    var p = purchases();
    p[appId] = { signature: sig, buyer: buyer, at: Date.now() };
    try { localStorage.setItem(LS_KEY, JSON.stringify(p)); } catch (e) {}
  }

  // ------------------------------------------------------------------ the buy
  async function buy(app) {
    var price = Number(app.price_usd);
    var devWallet = app.developer_wallet;

    if (!(price > 0)) return errorModal("This app doesn't have a price set yet.", false);
    // Never charge without somewhere to send the developer's 90%.
    if (!devWallet) {
      return errorModal(
        "This app isn't ready to sell yet — the developer hasn't given us a payout wallet. " +
        "Please check back shortly.", false
      );
    }

    var W;
    try { W = web3(); } catch (e) { return errorModal(e.message); }

    var devPk;
    try { devPk = new W.PublicKey(devWallet); } catch (e) {
      return errorModal("The developer's payout address is invalid, so we won't take a payment.", false);
    }

    var wallets = availableWallets();
    if (!wallets.length) return installWalletModal();

    var chosen = wallets.length === 1 ? wallets[0] : await pickWallet(wallets);
    if (!chosen) return;

    if (!(await confirmModal(app, price, devWallet))) return;

    var busy = busyModal("Waiting for your wallet…");
    try {
      var res = await chosen.provider.connect();
      var buyerPk = new W.PublicKey((res && res.publicKey ? res.publicKey : chosen.provider.publicKey).toString());

      var conn = new W.Connection(RPC, "confirmed");
      var mintPk = new W.PublicKey(USDC_MINT);
      var storePk = new W.PublicKey(STORE_WALLET);

      var buyerAta = await ata(buyerPk, mintPk);
      var devAta = await ata(devPk, mintPk);
      var storeAta = await ata(storePk, mintPk);

      // Make sure the buyer actually holds enough USDC before asking them to sign.
      var total = toBaseUnits(price);
      var bal = null;
      try {
        var r = await conn.getTokenAccountBalance(buyerAta);
        bal = r && r.value ? Number(r.value.amount) : 0;
      } catch (e) { bal = 0; }
      if (bal < total) {
        busy.close();
        return errorModal(
          "Your wallet holds " + fmtUSD((bal || 0) / 1e6) + " USDC but this costs " + fmtUSD(price) +
          ". Top up USDC on Solana and try again."
        );
      }

      var devShare = Math.floor(total * (1 - STORE_CUT));
      var storeShare = total - devShare; // remainder, so the two always add up exactly

      var tx = new W.Transaction();
      // Create the recipients' USDC accounts if they don't exist yet (buyer pays the small rent).
      var infos = await conn.getMultipleAccountsInfo([devAta, storeAta]);
      if (!infos[0]) tx.add(createAtaIx(buyerPk, devAta, devPk, mintPk));
      if (!infos[1]) tx.add(createAtaIx(buyerPk, storeAta, storePk, mintPk));
      // Both transfers in ONE transaction: atomic, so the split can't half-fail.
      tx.add(transferIx(buyerAta, devAta, buyerPk, devShare));
      tx.add(transferIx(buyerAta, storeAta, buyerPk, storeShare));

      var bh = await conn.getLatestBlockhash("confirmed");
      tx.recentBlockhash = bh.blockhash;
      tx.feePayer = buyerPk;

      var signed = await chosen.provider.signTransaction(tx);
      var sig = await conn.sendRawTransaction(signed.serialize());
      await conn.confirmTransaction(
        { signature: sig, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight },
        "confirmed"
      );

      recordPurchase(app.id, sig, buyerPk.toString());
      busy.close();
      successModal(app, sig);
      document.dispatchEvent(new CustomEvent("omarchy:purchased", { detail: { id: app.id, signature: sig } }));
    } catch (err) {
      busy.close();
      var m = (err && err.message) || "Something went wrong.";
      if (/User rejected|rejected the request|declined/i.test(m)) m = "You cancelled the payment in your wallet.";
      errorModal(m);
    }
  }

  window.OmarchyPay = {
    buy: buy,
    hasPurchased: hasPurchased,
    availableWallets: availableWallets,
    STORE_CUT: STORE_CUT,
  };
})();
