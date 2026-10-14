// Omarchy Store API — Cloudflare Worker.
//   Public:  POST /hit, POST /event, GET /reviews, POST /reviews, POST /developers, GET /config,
//            POST /orders (BTC checkout), GET /orders/:id
//   Admin:   /admin/* with "Authorization: Bearer <ADMIN_KEY>"
// Privacy: no IP addresses or cookies are stored. A daily-rotating hash counts unique visitors.

import { storeBot, dailyDrop, notifyUser } from "./bot.js";

const ORIGINS = [/^https:\/\/(www\.)?omarchystore\.com$/, /^https:\/\/omarchy-community\.github\.io$/, /^http:\/\/(127\.0\.0\.1|localhost):\d+$/];
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const origin = req.headers.get("Origin") || "";
    const okOrigin = ORIGINS.some((r) => r.test(origin));
    const cors = okOrigin ? { "Access-Control-Allow-Origin": origin, "Vary": "Origin",
      "Access-Control-Allow-Headers": "Content-Type, Authorization", "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS", "Access-Control-Max-Age": "86400" } : {};
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    try {
      const res = await route(req, env, ctx, url, okOrigin);
      for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
      res.headers.set("X-Content-Type-Options", "nosniff");
      return res;
    } catch (e) {
      const status = e.status || 500;
      if (status === 500) console.error(e.stack || e);
      return json({ error: status === 500 ? "server error" : e.message }, status, cors);
    }
  },
  async scheduled(evt, env, ctx) {
    ctx.waitUntil(checkOrders(env));
    // Daily drop to the Telegram channel + subscribers, once a day after 16:00 UTC (noon EDT).
    if (new Date(evt.scheduledTime).getUTCHours() >= 16) ctx.waitUntil(dailyDrop(env).catch((e) => console.error(e)));
  },
};

// ------------------------------------------------------------------ helpers
const json = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers } });
const fail = (msg, status = 400) => { const e = new Error(msg); e.status = status; throw e; };
const day = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
const clip = (s, n) => (typeof s === "string" ? s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, n) : "");

async function body(req, max = 8192) {
  const t = await req.text();
  if (t.length > max) fail("too large", 413);
  try { return JSON.parse(t || "{}"); } catch { fail("bad json"); }
}
async function sha(s) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
// Daily visitor id: hash(ip + UA + day + secret). Can't be reversed, changes every day.
const visitor = (req, env) => sha(`${req.headers.get("CF-Connecting-IP") || ""}|${req.headers.get("User-Agent") || ""}|${day()}|${env.ADMIN_KEY}`).then((h) => h.slice(0, 24));

async function turnstile(token, req, env) {
  if (!env.TURNSTILE_SECRET) return true;
  if (!token || typeof token !== "string") fail("Please complete the anti-spam check");
  const fd = new FormData();
  fd.append("secret", env.TURNSTILE_SECRET); fd.append("response", token);
  fd.append("remoteip", req.headers.get("CF-Connecting-IP") || "");
  const r = await (await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: fd })).json();
  if (!r.success) fail("The anti-spam check failed — please try again");
  return true;
}

async function telegram(env, text) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
    });
  } catch {}
}

async function isAdmin(req, env) {
  const got = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!env.ADMIN_KEY || !got) return false;
  // constant-time compare via hashes
  const [a, b] = await Promise.all([sha(got), sha(env.ADMIN_KEY)]);
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function rateLimit(env, key, max, windowSec) {
  // Small D1-backed limiter (good enough at store scale).
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS rl (k TEXT PRIMARY KEY, n INTEGER, reset INTEGER)").run();
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare("SELECT n, reset FROM rl WHERE k=?").bind(key).first();
  if (!row || row.reset < now) {
    await env.DB.prepare("INSERT OR REPLACE INTO rl (k, n, reset) VALUES (?, 1, ?)").bind(key, now + windowSec).run();
    return;
  }
  if (row.n >= max) fail("Too many requests — please try again later", 429);
  await env.DB.prepare("UPDATE rl SET n = n + 1 WHERE k=?").bind(key).run();
}

// ------------------------------------------------------------------ router
async function route(req, env, ctx, url, okOrigin) {
  const p = url.pathname.replace(/\/+$/, "") || "/";
  const M = req.method;

  if (p === "/" ) return json({ ok: true, service: "omarchy-store-api" });
  if (p.startsWith("/tg/") && M === "POST") return storeBot(req, env, ctx, p.slice(4));
  if (p === "/config" && M === "GET")
    return json({ turnstile: env.TURNSTILE_SITEKEY, payments: methods(env) }, 200, { "Cache-Control": "public, max-age=300" });

  // Public writes must come from the store itself (website or desktop app).
  if (M !== "GET" && !p.startsWith("/admin") && !okOrigin) fail("forbidden", 403);

  if (p === "/hit" && M === "POST") return hit(req, env, ctx);
  if (p === "/event" && M === "POST") return event(req, env, ctx);
  if (p === "/reviews" && M === "GET") return getReviews(url, env);
  if (p === "/reviews" && M === "POST") return postReview(req, env, ctx);
  if (p === "/ratings" && M === "GET") return ratings(env);
  if (p === "/trending" && M === "GET") return trending(env);
  if (p === "/developers" && M === "POST") return postDeveloper(req, env, ctx);
  if (p === "/orders" && M === "POST") return createOrder(req, env);
  if (p.startsWith("/orders/") && M === "GET") return getOrder(p.split("/")[2], env);

  if (p.startsWith("/admin")) {
    if (!(await isAdmin(req, env))) fail("wrong admin key", 401);
    if (p === "/admin/check") return json({ ok: true });
    if (p === "/admin/stats" && M === "GET") return stats(url, env);
    if (p === "/admin/developers" && M === "GET")
      return json({ developers: (await env.DB.prepare("SELECT * FROM developers ORDER BY ts DESC LIMIT 500").all()).results });
    if (p.startsWith("/admin/developers/") && M === "POST") return setDeveloper(p.split("/")[3], req, env, ctx);
    if (p === "/admin/reviews" && M === "GET")
      return json({ reviews: (await env.DB.prepare("SELECT id, app, rating, title, body, name, ts, hidden FROM reviews ORDER BY ts DESC LIMIT 500").all()).results });
    if (p.startsWith("/admin/reviews/") && M === "DELETE") {
      await env.DB.prepare("DELETE FROM reviews WHERE id=?").bind(Number(p.split("/")[3])).run();
      return json({ ok: true });
    }
    if (p.startsWith("/admin/reviews/") && M === "POST") {
      const b = await body(req);
      await env.DB.prepare("UPDATE reviews SET hidden=? WHERE id=?").bind(b.hidden ? 1 : 0, Number(p.split("/")[3])).run();
      return json({ ok: true });
    }
    if (p === "/admin/orders" && M === "GET")
      return json({ orders: (await env.DB.prepare("SELECT * FROM orders ORDER BY ts DESC LIMIT 500").all()).results, wallets: { btc: env.WALLET_BTC, evm: env.WALLET_EVM, sol: env.WALLET_SOL, xrp: env.WALLET_XRP } });
    if (p === "/admin/check-orders" && M === "POST") return json(await checkOrders(env));
  }
  fail("not found", 404);
}

// ------------------------------------------------------------------ analytics
const BOT = /bot|crawl|spider|slurp|bing|google|facebookexternalhit|preview|headless|lighthouse|curl|wget|python|monitor/i;
async function hit(req, env, ctx) {
  const ua = req.headers.get("User-Agent") || "";
  if (BOT.test(ua)) return json({ ok: true, bot: true });
  const b = await body(req, 2048);
  const path = clip(b.path, 200).replace(/[?#].*$/, "") || "/";
  let ref = "";
  try { ref = b.ref ? new URL(b.ref).hostname.replace(/^www\./, "") : ""; } catch {}
  if (/omarchystore\.com$|^127\.0\.0\.1$|^localhost$/.test(ref)) ref = "";
  const device = b.desktop ? "desktop-app" : /Mobi|Android|iPhone|iPad/.test(ua) ? "phone" : "computer";
  const v = await visitor(req, env);
  ctx.waitUntil(env.DB.prepare("INSERT INTO hits (day, ts, path, ref, country, device, visitor) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(day(), Date.now(), path, clip(ref, 100), req.cf?.country || "", device, v).run());
  return json({ ok: true });
}

async function event(req, env, ctx) {
  const b = await body(req, 1024);
  const kind = clip(b.kind, 20), item = clip(b.item, 80);
  if (!/^(install|get|open|theme|plugin|usb|update|remove)$/.test(kind) || !/^[a-z0-9._-]{1,80}$/i.test(item)) fail("bad event");
  const v = await visitor(req, env);
  ctx.waitUntil(env.DB.prepare("INSERT INTO events (day, ts, kind, item, visitor) VALUES (?, ?, ?, ?, ?)").bind(day(), Date.now(), kind, item, v).run());
  return json({ ok: true });
}

async function stats(url, env) {
  const days = Math.min(365, Math.max(1, Number(url.searchParams.get("days")) || 30));
  const since = day(Date.now() - (days - 1) * 864e5);
  const q = (sql, ...a) => env.DB.prepare(sql).bind(...a).all().then((r) => r.results);
  const one = (sql, ...a) => env.DB.prepare(sql).bind(...a).first();
  const [perDay, totals, today, pages, refs, countries, devices, installs, kinds, revs, devs, orders] = await Promise.all([
    q("SELECT day, COUNT(*) views, COUNT(DISTINCT visitor) visitors FROM hits WHERE day >= ? GROUP BY day ORDER BY day", since),
    one("SELECT COUNT(*) views, COUNT(DISTINCT visitor || day) visitors FROM hits WHERE day >= ?", since),
    one("SELECT COUNT(*) views, COUNT(DISTINCT visitor) visitors FROM hits WHERE day = ?", day()),
    q("SELECT path, COUNT(*) views FROM hits WHERE day >= ? GROUP BY path ORDER BY views DESC LIMIT 25", since),
    q("SELECT ref, COUNT(*) views FROM hits WHERE day >= ? AND ref != '' GROUP BY ref ORDER BY views DESC LIMIT 15", since),
    q("SELECT country, COUNT(DISTINCT visitor || day) visitors FROM hits WHERE day >= ? AND country != '' GROUP BY country ORDER BY visitors DESC LIMIT 15", since),
    q("SELECT device, COUNT(DISTINCT visitor || day) visitors FROM hits WHERE day >= ? GROUP BY device", since),
    q("SELECT item, COUNT(*) n FROM events WHERE day >= ? AND kind = 'install' GROUP BY item ORDER BY n DESC LIMIT 20", since),
    q("SELECT kind, COUNT(*) n FROM events WHERE day >= ? GROUP BY kind", since),
    one("SELECT COUNT(*) n, ROUND(AVG(rating), 2) avg FROM reviews WHERE hidden = 0"),
    q("SELECT status, COUNT(*) n FROM developers GROUP BY status"),
    q("SELECT status, COUNT(*) n, ROUND(SUM(usd), 2) usd FROM orders GROUP BY status"),
  ]);
  // fill empty days so the chart has no gaps
  const map = Object.fromEntries(perDay.map((r) => [r.day, r]));
  const series = [];
  for (let i = days - 1; i >= 0; i--) { const d = day(Date.now() - i * 864e5); series.push(map[d] || { day: d, views: 0, visitors: 0 }); }
  return json({ days, series, totals, today, pages, refs, countries, devices, installs, kinds, reviews: revs, developers: devs, orders });
}

// ------------------------------------------------------------------ reviews
async function getReviews(url, env) {
  const app = url.searchParams.get("app") || "";
  if (!ID_RE.test(app)) fail("bad app");
  const [list, agg, dist] = await Promise.all([
    env.DB.prepare("SELECT id, rating, title, body, name, ts FROM reviews WHERE app=? AND hidden=0 ORDER BY ts DESC LIMIT 50").bind(app).all(),
    env.DB.prepare("SELECT COUNT(*) n, ROUND(AVG(rating), 1) avg FROM reviews WHERE app=? AND hidden=0").bind(app).first(),
    env.DB.prepare("SELECT rating, COUNT(*) n FROM reviews WHERE app=? AND hidden=0 GROUP BY rating").bind(app).all(),
  ]);
  return json({ app, count: agg.n, average: agg.avg, stars: Object.fromEntries(dist.results.map((r) => [r.rating, r.n])), reviews: list.results },
    200, { "Cache-Control": "public, max-age=15" });
}

async function ratings(env) {
  const r = await env.DB.prepare("SELECT app, COUNT(*) n, ROUND(AVG(rating), 1) avg FROM reviews WHERE hidden=0 GROUP BY app").all();
  return json({ ratings: Object.fromEntries(r.results.map((x) => [x.app, [x.avg, x.n]])) }, 200, { "Cache-Control": "public, max-age=120" });
}

async function postReview(req, env, ctx) {
  const b = await body(req);
  const app = clip(b.app, 64), rating = Number(b.rating);
  if (!ID_RE.test(app)) fail("bad app");
  if (!(rating >= 1 && rating <= 5 && Number.isInteger(rating))) fail("Pick 1 to 5 stars");
  const title = clip(b.title, 80), text = clip(b.body, 2000), name = clip(b.name, 40) || "Omarchy user";
  if (/https?:\/\/|www\./i.test(title + " " + text) && text.length < 40) fail("Links aren't allowed in short reviews");
  await turnstile(b.turnstile, req, env);
  const v = await visitor(req, env);
  await rateLimit(env, "rev:" + v, 5, 3600);
  // One review per person per app per day: sending again replaces your earlier review instead of failing.
  const dup = await env.DB.prepare("SELECT id FROM reviews WHERE app=? AND visitor=?").bind(app, v).first();
  if (dup) await env.DB.prepare("UPDATE reviews SET rating=?, title=?, body=?, name=?, ts=?, hidden=0 WHERE id=?")
    .bind(rating, title, text, name, Date.now(), dup.id).run();
  else await env.DB.prepare("INSERT INTO reviews (app, rating, title, body, name, ts, visitor) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(app, rating, title, text, name, Date.now(), v).run();
  ctx.waitUntil(telegram(env, `⭐ ${dup ? "Updated" : "New"} review: ${app} — ${"★".repeat(rating)}${"☆".repeat(5 - rating)}\n${title ? title + "\n" : ""}${text.slice(0, 300)}\n— ${name}\n\nManage: ${env.SITE}/admin/`));
  return json({ ok: true, updated: !!dup });
}

// ------------------------------------------------------------------ trending (drives Featured App + App of the Week)
// Counts DIFFERENT people who installed (desktop app) or copied the install command (website) — one person
// clicking 50 times still counts once, so the picks can't be gamed by a single visitor.
async function trending(env) {
  const now = new Date();
  const monday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - ((now.getUTCDay() + 6) % 7) * 864e5;
  const thisWeek = day(monday), lastWeek = day(monday - 7 * 864e5), recent = day(Date.now() - 2 * 864e5);
  const q = (since, until) => env.DB.prepare(
    "SELECT item id, COUNT(DISTINCT visitor) n FROM events WHERE kind IN ('install','get') AND day >= ? AND day < ? GROUP BY item ORDER BY n DESC, MAX(ts) DESC LIMIT 25")
    .bind(since, until).all().then((r) => r.results);
  const [last_week, this_week, last_2_days] = await Promise.all([q(lastWeek, thisWeek), q(thisWeek, "9999"), q(recent, "9999")]);
  return json({ week_of: thisWeek, today: day(), last_week, this_week, last_2_days }, 200, { "Cache-Control": "public, max-age=600" });
}

// ------------------------------------------------------------------ developers
async function postDeveloper(req, env, ctx) {
  const b = await body(req, 16384);
  const name = clip(b.name, 80), email = clip(b.email, 120);
  if (!name) fail("Please enter your name");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) fail("Please enter a valid email");
  const site = clip(b.website, 200), gh = clip(b.github, 100), appName = clip(b.app_name, 80), desc = clip(b.app_desc, 3000), appUrl = clip(b.app_url, 300);
  if (!appName || desc.length < 20) fail("Tell us your app's name and a short description (at least 20 characters)");
  for (const u of [site, appUrl]) if (u && !/^https:\/\//.test(u)) fail("Links must start with https://");
  // Marketing assets: every listing needs a logo, a one-line tagline, a proper write-up and screenshots.
  const tagline = clip(b.tagline, 90), logo = clip(b.logo_url, 400), tgUser = clip(b.telegram, 40).replace(/^@/, "");
  const shots = (Array.isArray(b.screenshots) ? b.screenshots : String(b.screenshots || "").split(/\s+/))
    .map((s) => clip(s, 400)).filter(Boolean).slice(0, 6);
  const IMG = /^https:\/\/[^\s"'<>]+$/;
  if (tagline.length < 10) fail("Add a one-line tagline (10–90 characters)");
  if (desc.length < 200) fail("Your write-up needs at least 200 characters: what it does, who it's for, and its key features");
  if (!IMG.test(logo)) fail("Add a link to your logo (https://…, PNG or SVG, at least 256×256)");
  if (!shots.length) fail("Add at least one screenshot link (https://…)");
  for (const s of shots) if (!IMG.test(s)) fail("Screenshot links must start with https://");
  if (tgUser && !/^[A-Za-z0-9_]{5,32}$/.test(tgUser)) fail("That Telegram username doesn't look right");
  const wantsPaid = !!b.wants_paid;
  const price = wantsPaid ? Math.round(Number(b.price_usd) * 100) / 100 : null;
  if (wantsPaid && !(price >= 0.99 && price <= 999)) fail("Price must be between $0.99 and $999");
  const payout = {};
  // The form sends p_evm/p_sol/p_btc/p_xrp; older clients send {payout:{base,sol,btc,xrp}}. Accept both.
  const po = (b.payout && typeof b.payout === "object") ? b.payout : {};
  b.payout = { btc: clip(po.btc || b.p_btc, 80), base: clip(po.base || b.p_evm, 60), sol: clip(po.sol || b.p_sol, 60), xrp: clip(po.xrp || b.p_xrp, 60) };
  if (b.payout && typeof b.payout === "object") {
    if (b.payout.btc) { if (!/^(bc1[ac-hj-np-z02-9]{11,71}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/.test(b.payout.btc)) fail("That Bitcoin address doesn't look right"); payout.btc = b.payout.btc; }
    if (b.payout.base) { if (!/^0x[0-9a-fA-F]{40}$/.test(b.payout.base)) fail("That Base/Ethereum address doesn't look right"); payout.base = b.payout.base; }
    if (b.payout.sol) { if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(b.payout.sol)) fail("That Solana address doesn't look right"); payout.sol = b.payout.sol; }
    if (b.payout.xrp) { if (!/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(b.payout.xrp)) fail("That XRP address doesn't look right"); payout.xrp = b.payout.xrp; }
  }
  if (!b.agree) fail("Please accept the developer terms");
  await turnstile(b.turnstile, req, env);
  const v = await visitor(req, env);
  await rateLimit(env, "dev:" + v, 3, 86400);
  const r = await env.DB.prepare(`INSERT INTO developers (ts, name, email, website, github, app_name, app_desc, app_url, wants_paid, price_usd, payout, tagline, logo_url, screenshots, telegram)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(Date.now(), name, email, site, gh, appName, desc, appUrl, wantsPaid ? 1 : 0, price, JSON.stringify(payout), tagline, logo, JSON.stringify(shots), tgUser || null).run();
  ctx.waitUntil(telegram(env, `🧑‍💻 New developer sign-up #${r.meta.last_row_id}\n${name} <${email}>${tgUser ? ` · @${tgUser}` : ""}\nApp: ${appName}${wantsPaid ? ` — wants to sell at $${price}` : " — free"}\n${tagline}\n\n${desc.slice(0, 300)}\n\nLogo + ${shots.length} screenshot(s) attached.\nApprove or reject: ${env.SITE}/admin/`));
  return json({ ok: true, id: r.meta.last_row_id });
}

async function setDeveloper(id, req, env, ctx) {
  const b = await body(req);
  if (!["pending", "approved", "rejected"].includes(b.status)) fail("bad status");
  const note = clip(b.note, 500);
  await env.DB.prepare("UPDATE developers SET status=?, note=? WHERE id=?").bind(b.status, note, Number(id)).run();
  if (b.status === "approved" || b.status === "rejected") {
    const d = await env.DB.prepare("SELECT app_name, telegram_chat_id FROM developers WHERE id=?").bind(Number(id)).first();
    if (d?.telegram_chat_id) {
      const text = b.status === "approved"
        ? `🎉 <b>${esc(d.app_name)} was approved!</b>\n\nWe're packaging it for the store now — it'll be live at ${env.SITE} shortly. Thanks for submitting!`
        : `Your submission <b>${esc(d.app_name)}</b> wasn't approved this time.${note ? `\n\nNote: ${esc(note)}` : ""}\n\nQuestions? Reply here or email ${"info@omarchystore.com"}.`;
      ctx.waitUntil(notifyUser(env, d.telegram_chat_id, text));
    }
  }
  return json({ ok: true });
}

// ------------------------------------------------------------------ crypto checkout
// Each order asks for a UNIQUE amount (price + a tiny random tail) so the payment can be matched to
// the order just by watching the owner's public cold-wallet address on the blockchain. Read-only:
// the backend never holds keys and never moves money.
//   btc        Bitcoin           (amount in sats)
//   usdc-base  USDC on Base      (6 decimals, stable $)       -> WALLET_EVM
//   usdc-eth   USDC on Ethereum  (6 decimals, stable $)       -> WALLET_EVM
//   eth-base   ETH on Base       (18 decimals)                -> WALLET_EVM
//   sol        SOL on Solana     (9 decimals)                 -> WALLET_SOL
//   usdc-sol   USDC on Solana    (6 decimals, stable $)       -> WALLET_SOL
//   xrp        XRP Ledger        (6 decimals, unique DestinationTag) -> WALLET_XRP
const USDC = {
  base: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  eth: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  sol: "EPjFWJdk2s4kfjWMs1Dxd6sPBsS56RJ5yQSCo3qDYrqn",
};
const EVM_RPC = { base: ["https://base-rpc.publicnode.com", "https://mainnet.base.org"], eth: ["https://ethereum-rpc.publicnode.com"] };
const SOL_RPC = ["https://api.mainnet-beta.solana.com", "https://solana-rpc.publicnode.com"];
const XRP_RPC = ["https://xrplcluster.com/", "https://s1.ripple.com:51234/"];
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

function methods(env) {
  const m = [];
  if (env.WALLET_EVM) m.push(
    { id: "usdc-base", name: "USDC on Base", coin: "USDC", network: "Base", stable: true, recommended: true },
    { id: "usdc-eth", name: "USDC on Ethereum", coin: "USDC", network: "Ethereum", stable: true },
    { id: "eth-base", name: "ETH on Base", coin: "ETH", network: "Base" });
  if (env.WALLET_SOL) m.push({ id: "usdc-sol", name: "USDC on Solana", coin: "USDC", network: "Solana", stable: true }, { id: "sol", name: "Solana", coin: "SOL", network: "Solana" });
  if (env.WALLET_BTC) m.push({ id: "btc", name: "Bitcoin", coin: "BTC", network: "Bitcoin" });
  if (env.WALLET_XRP) m.push({ id: "xrp", name: "XRP", coin: "XRP", network: "XRP Ledger" });
  return m;
}
const DEC = { btc: 8, "usdc-base": 6, "usdc-eth": 6, "usdc-sol": 6, "eth-base": 18, sol: 9, xrp: 6 };
const COIN = { btc: "BTC", "usdc-base": "USDC", "usdc-eth": "USDC", "usdc-sol": "USDC", "eth-base": "ETH", sol: "SOL", xrp: "XRP" };
const addrFor = (env, chain) => ({ btc: env.WALLET_BTC, xrp: env.WALLET_XRP, sol: env.WALLET_SOL, "usdc-sol": env.WALLET_SOL }[chain] || env.WALLET_EVM);
const fmt = (units, dec) => { const s = BigInt(units).toString().padStart(dec + 1, "0"); return (s.slice(0, -dec) + "." + s.slice(-dec)).replace(/\.?0+$/, ""); };

async function usdPrice(coin) {
  if (coin === "USDC") return 1;
  const r = await fetch(`https://api.coinbase.com/v2/prices/${coin}-USD/spot`, { headers: { "User-Agent": "omarchy-store" }, cf: { cacheTtl: 60 } });
  const p = Number((await r.json())?.data?.amount);
  if (!(p > 0)) fail("price feed unavailable — try again in a minute", 503);
  return p;
}

async function rpc(urls, method, params) {
  let last;
  for (const u of urls) {
    try {
      const r = await fetch(u, { method: "POST", headers: { "Content-Type": "application/json", "User-Agent": "omarchy-store" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      const j = await r.json();
      if (j.error) throw new Error(JSON.stringify(j.error));
      return j.result;
    } catch (e) { last = e; }
  }
  throw last || new Error("rpc failed");
}

async function createOrder(req, env) {
  const b = await body(req);
  const app = clip(b.app, 64), chain = clip(b.chain, 12) || "usdc-base";
  if (!ID_RE.test(app)) fail("bad app");
  if (!methods(env).some((m) => m.id === chain)) fail("That payment method isn't available");
  // The price comes from the store's own catalog (never from the browser), so it can't be tampered with.
  const cat = await (await fetch(`${env.SITE}/catalog.json`, { cf: { cacheTtl: 300 } })).json();
  const a = (cat.apps || []).find((x) => x.id === app);
  const price = Number(a?.price_usd);
  if (!(price > 0)) fail("This app is free — no payment needed");
  await turnstile(b.turnstile, req, env);
  const v = await visitor(req, env);
  await rateLimit(env, "ord:" + v, 10, 3600);
  const dec = DEC[chain], coin = COIN[chain];
  const rate = await usdPrice(coin);
  // Unique tail: stablecoins get 1–999 millionths of a dollar; volatile coins get a few smallest units scaled to the decimals.
  const base = BigInt(Math.round((price / rate) * 10 ** Math.min(dec, 9))) * 10n ** BigInt(Math.max(0, dec - 9));
  const tailUnit = dec === 18 ? 10n ** 9n : 1n;                 // ETH: vary at gwei level
  const tail = BigInt(100 + Math.floor(Math.random() * 900)) * tailUnit;
  const units = base + tail;
  const id = "OS-" + [...crypto.getRandomValues(new Uint8Array(10))].map((x) => "ABCDEFGHJKMNPQRSTUVWXYZ23456789"[x % 31]).join("");
  const address = addrFor(env, chain);
  const tag = chain === "xrp" ? 100000000 + Math.floor(Math.random() * 899999999) : null;
  await env.DB.prepare("INSERT INTO orders (id, ts, app, chain, address, usd, amount_sats, amount, tag, email) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)")
    .bind(id, Date.now(), app, chain, address, price, units.toString(), tag, clip(b.email, 120)).run();
  const amt = fmt(units, dec);
  const uri = chain === "btc" ? `bitcoin:${address}?amount=${amt}`
    : chain === "sol" ? `solana:${address}?amount=${amt}&label=${encodeURIComponent("Omarchy Store")}`
    : chain === "usdc-sol" ? `solana:${address}?amount=${amt}&spl-token=${USDC.sol}&label=${encodeURIComponent("Omarchy Store")}`
    : chain === "xrp" ? `https://xrpl.org/send?to=${address}&dt=${tag}&amount=${amt}`
    : chain === "eth-base" ? `ethereum:${address}@8453?value=${units}`
    : `ethereum:${chain === "usdc-base" ? USDC.base : USDC.eth}@${chain === "usdc-base" ? 8453 : 1}/transfer?address=${address}&uint256=${units}`;
  return json({ id, app, chain, coin, network: methods(env).find((m) => m.id === chain).network, address, amount: amt, tag, usd: price, uri, expires_in: 6 * 3600 });
}

async function getOrder(id, env) {
  if (!/^OS-[A-Z0-9]{10}$/.test(id || "")) fail("bad order");
  const sel = "SELECT id, app, chain, address, usd, amount, tag, status, txid, ts FROM orders WHERE id=?";
  let o = await env.DB.prepare(sel).bind(id).first();
  if (!o) fail("not found", 404);
  if (o.status === "waiting" || o.status === "seen") { await checkOrders(env, id); o = await env.DB.prepare(sel).bind(id).first(); }
  return json({ ...o, coin: COIN[o.chain], amount: fmt(o.amount, DEC[o.chain]), license: o.status === "paid" ? o.id : null });
}

// --- per-chain incoming payment lookups: return [{txid, units(BigInt), time(ms), confirmed, tag}]
async function incomingBTC(addr) {
  const txs = await (await fetch(`https://mempool.space/api/address/${addr}/txs`)).json();
  return txs.flatMap((t) => t.vout.filter((o) => o.scriptpubkey_address === addr)
    .map((o) => ({ txid: t.txid, units: BigInt(o.value), time: (t.status?.block_time || Date.now() / 1000) * 1000, confirmed: !!t.status?.confirmed })));
}
async function incomingERC20(net, token, addr) {
  const head = Number(BigInt(await rpc(EVM_RPC[net], "eth_blockNumber", [])));
  const span = net === "base" ? 9000 : 3000;                     // ~5 h Base, ~10 h Ethereum
  const topic = "0x" + "0".repeat(24) + addr.toLowerCase().slice(2);
  const logs = await rpc(EVM_RPC[net], "eth_getLogs", [{ address: token, topics: [TRANSFER, null, topic], fromBlock: "0x" + (head - span).toString(16), toBlock: "latest" }]);
  return logs.map((l) => ({ txid: l.transactionHash, units: BigInt(l.data), time: Date.now(), confirmed: head - Number(BigInt(l.blockNumber)) >= (net === "base" ? 10 : 3) }));
}
async function incomingETHBase(addr, orders) {
  // Native ETH has no logs; scan recent blocks' transactions to us (bounded, Base ~2 s blocks).
  const head = Number(BigInt(await rpc(EVM_RPC.base, "eth_blockNumber", [])));
  const out = [], want = new Set(orders.map((o) => o.amount));
  const from = Math.max(head - 150, ...orders.map(() => head - 150));
  for (let n = head; n > from && out.length < want.size; n--) {
    const blk = await rpc(EVM_RPC.base, "eth_getBlockByNumber", ["0x" + n.toString(16), true]);
    for (const t of blk?.transactions || [])
      if ((t.to || "").toLowerCase() === addr.toLowerCase() && want.has(BigInt(t.value).toString()))
        out.push({ txid: t.hash, units: BigInt(t.value), time: Date.now(), confirmed: head - n >= 10 });
  }
  return out;
}
async function incomingSOL(addr, mint) {
  const sigs = await rpc(SOL_RPC, "getSignaturesForAddress", [addr, { limit: 25 }]);
  const out = [];
  for (const s of sigs.filter((x) => !x.err).slice(0, 15)) {
    const tx = await rpc(SOL_RPC, "getTransaction", [s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]);
    const m = tx?.meta; if (!m) continue;
    let units = 0n;
    if (!mint) {
      const i = tx.transaction.message.accountKeys.findIndex((k) => (k.pubkey || k) === addr);
      if (i >= 0) units = BigInt(m.postBalances[i]) - BigInt(m.preBalances[i]);
    } else {
      const bal = (arr) => (arr || []).filter((x) => x.mint === mint && x.owner === addr).reduce((t, x) => t + BigInt(x.uiTokenAmount.amount), 0n);
      units = bal(m.postTokenBalances) - bal(m.preTokenBalances);
    }
    if (units > 0n) out.push({ txid: s.signature, units, time: (s.blockTime || Date.now() / 1000) * 1000, confirmed: s.confirmationStatus === "finalized" || s.confirmationStatus === "confirmed" });
  }
  return out;
}
async function incomingXRP(addr) {
  const r = await rpc(XRP_RPC, "account_tx", [{ account: addr, limit: 50 }]).catch(() => null)
    || (await (await fetch(XRP_RPC[0], { method: "POST", body: JSON.stringify({ method: "account_tx", params: [{ account: addr, limit: 50 }] }) })).json()).result;
  return (r?.transactions || []).filter((x) => x.tx?.TransactionType === "Payment" && x.tx.Destination === addr && x.meta?.TransactionResult === "tesSUCCESS"
    && typeof x.meta.delivered_amount === "string")
    .map((x) => ({ txid: x.tx.hash, units: BigInt(x.meta.delivered_amount), tag: x.tx.DestinationTag, time: ((x.tx.date || 0) + 946684800) * 1000, confirmed: !!x.validated }));
}

const EXPLORER = { btc: "https://mempool.space/tx/", "usdc-base": "https://basescan.org/tx/", "eth-base": "https://basescan.org/tx/",
  "usdc-eth": "https://etherscan.io/tx/", sol: "https://solscan.io/tx/", "usdc-sol": "https://solscan.io/tx/", xrp: "https://livenet.xrpl.org/transactions/" };

async function checkOrders(env, onlyId) {
  const open = (await env.DB.prepare(`SELECT * FROM orders WHERE status IN ('waiting','seen') ${onlyId ? "AND id=?" : ""} ORDER BY ts LIMIT 100`)
    .bind(...(onlyId ? [onlyId] : [])).all()).results;
  if (!open.length) return { checked: 0 };
  const groups = {};
  for (const o of open) (groups[o.chain + "|" + o.address] ||= []).push(o);
  let paid = 0;
  for (const [key, orders] of Object.entries(groups)) {
    const [chain, addr] = key.split("|");
    let inc = [];
    try {
      inc = chain === "btc" ? await incomingBTC(addr)
        : chain === "usdc-base" ? await incomingERC20("base", USDC.base, addr)
        : chain === "usdc-eth" ? await incomingERC20("eth", USDC.eth, addr)
        : chain === "eth-base" ? await incomingETHBase(addr, orders)
        : chain === "sol" ? await incomingSOL(addr, null)
        : chain === "usdc-sol" ? await incomingSOL(addr, USDC.sol)
        : chain === "xrp" ? await incomingXRP(addr) : [];
    } catch (e) { console.error("check", chain, e.message); continue; }
    for (const o of orders) {
      const want = BigInt(o.amount || o.amount_sats);
      const tx = inc.find((t) => t.units === want && t.time >= o.ts - 600e3 && (chain !== "xrp" || t.tag === o.tag));
      if (tx && tx.confirmed) {
        const used = await env.DB.prepare("SELECT id FROM orders WHERE txid=? AND id != ? AND status='paid'").bind(tx.txid, o.id).first();
        if (used) continue;                                         // a payment can only unlock one order
        await env.DB.prepare("UPDATE orders SET status='paid', txid=?, paid_ts=? WHERE id=?").bind(tx.txid, Date.now(), o.id).run();
        paid++;
        await telegram(env, `💰 Paid! ${o.app} — $${o.usd} in ${COIN[chain]} (${fmt(want, DEC[chain])})\nOrder ${o.id}\n${EXPLORER[chain]}${tx.txid}`);
      } else if (tx && o.status === "waiting") {
        await env.DB.prepare("UPDATE orders SET status='seen', txid=? WHERE id=?").bind(tx.txid, o.id).run();
      } else if (!tx && Date.now() - o.ts > 6 * 3600e3) {
        await env.DB.prepare("UPDATE orders SET status='expired' WHERE id=?").bind(o.id).run();
      }
    }
  }
  return { checked: open.length, paid };
}
