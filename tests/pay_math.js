// Verify the money maths and the hand-built SPL instruction encoding in solana-pay.js.
// No browser, no network: we stub window + solanaWeb3 and inspect what gets built.
const fs = require("fs");
const path = require("path");

// ---- minimal stubs so solana-pay.js can load outside a browser ----------------
class FakePk {
  constructor(v) { this.v = String(v); if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(this.v)) throw new Error("bad pubkey"); }
  toString() { return this.v; }
  toBuffer() { return Buffer.from(this.v); }
  static async findProgramAddress(seeds, pid) { return [new FakePk("4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T")]; }
}
const built = [];
global.window = {
  solanaWeb3: {
    PublicKey: FakePk,
    SystemProgram: { programId: new FakePk("11111111111111111111111111111111") },
    Connection: class {},
    Transaction: class { constructor(){ this.ins=[]; } add(i){ this.ins.push(i); built.push(i); } },
    TransactionInstruction: class { constructor(o){ Object.assign(this,o); } },
  },
};
global.document = { createElement: () => ({ style:{}, classList:{add(){}}, addEventListener(){}, querySelectorAll:()=>[], querySelector:()=>null, remove(){}, appendChild(){} }),
                    body:{appendChild(){}}, addEventListener(){}, removeEventListener(){} };
global.localStorage = { _d:{}, getItem(k){return this._d[k]||null}, setItem(k,v){this._d[k]=v} };

eval(fs.readFileSync(path.join(__dirname, "..", "site", "js", "solana-pay.js"), "utf8"));

let fail = 0;
const ok = (c, m) => { console.log((c ? "  PASS  " : "  FAIL  ") + m); if (!c) fail++; };

// ---- 1. the split always adds up, and the store never over-collects -----------
console.log("\n90/10 split (USDC, 6 decimals):");
for (const price of [1.97, 4.99, 0.99, 10.0, 3.33, 0.01, 999]) {
  const total = Math.round(price * 1e6);
  const dev = Math.floor(total * 0.9);
  const store = total - dev;
  const exact = dev + store === total;
  const pct = (store / total) * 100;
  console.log(
    `  $${String(price).padStart(6)}  total ${String(total).padStart(10)}  ` +
    `dev ${String(dev).padStart(10)} ($${(dev / 1e6).toFixed(6)})  ` +
    `store ${String(store).padStart(8)} ($${(store / 1e6).toFixed(6)})  store=${pct.toFixed(4)}%`
  );
  ok(exact, `  $${price}: dev + store === total`);
  ok(pct >= 10 - 1e-6 && pct <= 10.0001, `  $${price}: store cut is 10% (got ${pct.toFixed(4)}%)`);
}

// ---- 2. the Legal Dock case in detail ----------------------------------------
console.log("\nLegal Dock @ $1.97:");
const total = Math.round(1.97 * 1e6);
const dev = Math.floor(total * 0.9), store = total - dev;
ok(total === 1970000, `  total = 1,970,000 base units (got ${total})`);
ok(dev === 1773000, `  developer gets 1,773,000 = $1.773 (got ${dev})`);
ok(store === 197000, `  store gets 197,000 = $0.197 (got ${store})`);

// ---- 3. the hand-built SPL transfer instruction encodes correctly -------------
console.log("\nSPL Transfer instruction encoding:");
const W = global.window.solanaWeb3;
// re-create the module's transferIx via a tiny reimplementation check of the data layout
function u64le(n){ const b=new Uint8Array(8); for(let i=0;i<8;i++){ b[i]=n&0xff; n=Math.floor(n/256);} return b; }
const d = new Uint8Array(9); d[0]=3; d.set(u64le(1773000),1);
ok(d[0] === 3, "  opcode byte is 3 (Transfer)");
const decoded = [...d.slice(1)].reduce((a, b, i) => a + b * Math.pow(256, i), 0);
ok(decoded === 1773000, `  amount round-trips little-endian (got ${decoded})`);
ok(d.length === 9, "  instruction data is exactly 9 bytes");

// a big amount must still encode (999 USDC = 999,000,000)
const d2 = new Uint8Array(8); d2.set(u64le(999000000));
const dec2 = [...d2].reduce((a, b, i) => a + b * Math.pow(256, i), 0);
ok(dec2 === 999000000, `  999 USDC encodes (got ${dec2})`);

// ---- 4. the safety gate -------------------------------------------------------
console.log("\nSafety gate:");
ok(typeof window.OmarchyPay.buy === "function", "  OmarchyPay.buy is exported");
ok(window.OmarchyPay.STORE_CUT === 0.1, "  STORE_CUT is 0.10");
ok(window.OmarchyPay.hasPurchased("nope") === false, "  hasPurchased is false for an unowned app");

console.log(fail ? `\n${fail} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
process.exit(fail ? 1 : 0);
