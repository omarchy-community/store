// Omarchy Store — Portal v2 (developer status links, advertiser requests, donations, admin catalog editor).
// Helpers (json, fail, body, clip, ...) are passed in from index.js as `H` so there is one copy of each.
//
// Public:
//   GET  /dev/status?id&t        developer's private status page data
//   POST /dev/message            developer replies {id,t,body}
//   POST /dev/update             developer sends fixes {id,t, tagline, app_desc, logo_url, screenshots, ...}
//   POST /ads/request            advertiser booking request (Turnstile)
//   GET  /ads/status?id&t        advertiser's private status page data
//   POST /ads/message            advertiser replies
//   POST /ads/pay                pay an approved quote in crypto -> normal order (read-only verification)
//   GET  /donate                 wallets + approved supporters
//   POST /supporters             add your name to the thank-you wall (Turnstile, owner approves)
// Admin (Bearer key, store origin only):
//   /admin/overview, /admin/developers/:id (status + message), /admin/developers/:id/messages,
//   /admin/developers/:id/reset-link, /admin/ads/requests[/:id[/messages|/reset-link]],
//   /admin/donations, /admin/donations/scan, /admin/donations/:id, /admin/supporters/:id, /admin/audit,
//   /admin/gh/status, /admin/gh/file, /admin/gh/history, /admin/gh/ad-image, /admin/gh/apps

const DEV_STATUS = ["pending", "changes", "approved", "live", "rejected"];
const AD_STATUS = ["new", "quoted", "approved", "paid", "live", "declined", "done"];
const SLOTS = ["banner", "sponsored-app", "search", "artist"];
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const HTTPS = /^https:\/\/[^\s"'<>]+$/;

// ------------------------------------------------------------------ tokens (private status links)
const newToken = () => [...crypto.getRandomValues(new Uint8Array(24))].map((x) => "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789"[x % 57]).join("");
async function checkToken(H, table, id, t) {
  if (!/^\d{1,9}$/.test(String(id || "")) || typeof t !== "string" || t.length < 20 || t.length > 64) H.fail("That link isn't valid", 404);
  const row = await H.env.DB.prepare(`SELECT * FROM ${table} WHERE id=?`).bind(Number(id)).first();
  if (!row || !row.token_hash) H.fail("That link isn't valid", 404);
  const got = await H.sha(t);
  let d = got.length ^ row.token_hash.length;
  for (let i = 0; i < Math.min(got.length, row.token_hash.length); i++) d |= got.charCodeAt(i) ^ row.token_hash.charCodeAt(i);
  if (d) H.fail("That link isn't valid", 404);
  return row;
}
export async function issueToken(H) { const t = newToken(); return { token: t, hash: await H.sha(t) }; }

const audit = (env, action, target, detail) =>
  env.DB.prepare("INSERT INTO audit (ts, action, target, detail) VALUES (?, ?, ?, ?)").bind(Date.now(), action, String(target ?? ""), String(detail ?? "").slice(0, 1000)).run();
const parse = (s, d) => { try { return JSON.parse(s); } catch { return d; } };

// ------------------------------------------------------------------ router
export async function portalRoute(p, M, req, url, H) {
  const { env } = H;
  if (p === "/dev/status" && M === "GET") return devStatus(url, H);
  if (p === "/dev/message" && M === "POST") return devMessage(req, H);
  if (p === "/dev/update" && M === "POST") return devUpdate(req, H);
  if (p === "/ads/request" && M === "POST") return adRequest(req, H);
  if (p === "/ads/status" && M === "GET") return adStatus(url, H);
  if (p === "/ads/message" && M === "POST") return adMessage(req, H);
  if (p === "/ads/pay" && M === "POST") return adPay(req, H);
  if (p === "/donate" && M === "GET") return donateInfo(H);
  if (p === "/supporters" && M === "POST") return addSupporter(req, H);
  return null;
}

export async function portalAdmin(p, M, req, url, H) {
  const { env } = H, seg = p.split("/");
  if (p === "/admin/overview" && M === "GET") return overview(H);
  if (p === "/admin/audit" && M === "GET")
    return H.json({ audit: (await env.DB.prepare("SELECT * FROM audit ORDER BY ts DESC LIMIT 300").all()).results });
  // developers
  if (/^\/admin\/developers\/\d+\/messages$/.test(p) && M === "GET")
    return H.json({ messages: (await env.DB.prepare("SELECT * FROM dev_messages WHERE dev_id=? ORDER BY ts").bind(Number(seg[3])).all()).results });
  if (/^\/admin\/developers\/\d+\/reset-link$/.test(p) && M === "POST") {
    const { token, hash } = await issueToken(H);
    await env.DB.prepare("UPDATE developers SET token_hash=? WHERE id=?").bind(hash, Number(seg[3])).run();
    await audit(env, "developer.reset-link", seg[3]);
    return H.json({ url: `${env.SITE}/submit/?status=${seg[3]}&t=${token}` });
  }
  if (/^\/admin\/developers\/\d+$/.test(p) && M === "POST") return setDeveloper(Number(seg[3]), req, H);
  // ad requests
  if (p === "/admin/ads/requests" && M === "GET")
    return H.json({ requests: (await env.DB.prepare("SELECT * FROM ad_requests ORDER BY ts DESC LIMIT 300").all()).results });
  if (/^\/admin\/ads\/requests\/\d+\/messages$/.test(p) && M === "GET")
    return H.json({ messages: (await env.DB.prepare("SELECT * FROM ad_messages WHERE ad_id=? ORDER BY ts").bind(Number(seg[4])).all()).results });
  if (/^\/admin\/ads\/requests\/\d+\/reset-link$/.test(p) && M === "POST") {
    const { token, hash } = await issueToken(H);
    await env.DB.prepare("UPDATE ad_requests SET token_hash=? WHERE id=?").bind(hash, Number(seg[4])).run();
    await audit(env, "ad.reset-link", seg[4]);
    return H.json({ url: `${env.SITE}/advertise/?status=${seg[4]}&t=${token}` });
  }
  if (/^\/admin\/ads\/requests\/\d+$/.test(p) && M === "POST") return setAdRequest(Number(seg[4]), req, H);
  // donations + supporters
  if (p === "/admin/donations" && M === "GET") {
    const [d, s] = await Promise.all([
      env.DB.prepare("SELECT * FROM donations ORDER BY ts DESC LIMIT 500").all(),
      env.DB.prepare("SELECT * FROM supporters ORDER BY ts DESC LIMIT 500").all()]);
    return H.json({ donations: d.results, supporters: s.results, wallets: wallets(env), scanned: (await env.DB.prepare("SELECT v FROM meta WHERE k='don:last'").first())?.v || null });
  }
  if (p === "/admin/donations/scan" && M === "POST") return H.json(await scanDonations(H, true));
  if (/^\/admin\/donations\/\d+$/.test(p) && M === "POST") {
    const b = await H.body(req);
    await env.DB.prepare("UPDATE donations SET ignored=? WHERE id=?").bind(b.ignored ? 1 : 0, Number(seg[3])).run();
    await audit(env, b.ignored ? "donation.ignore" : "donation.restore", seg[3]);
    return H.json({ ok: true });
  }
  if (/^\/admin\/supporters\/\d+$/.test(p) && M === "POST") {
    const b = await H.body(req);
    await env.DB.prepare("UPDATE supporters SET approved=? WHERE id=?").bind(b.approved ? 1 : 0, Number(seg[3])).run();
    await audit(env, b.approved ? "supporter.approve" : "supporter.hide", seg[3]);
    return H.json({ ok: true });
  }
  if (/^\/admin\/supporters\/\d+$/.test(p) && M === "DELETE") {
    await env.DB.prepare("DELETE FROM supporters WHERE id=?").bind(Number(seg[3])).run();
    await audit(env, "supporter.delete", seg[3]);
    return H.json({ ok: true });
  }
  // GitHub-backed catalog editor
  if (p === "/admin/gh/status" && M === "GET") return ghStatus(H);
  if (p === "/admin/gh/apps" && M === "GET") return H.json({ ids: await registryIds(H) });
  if (p === "/admin/gh/file" && M === "GET") return ghGet(url, H);
  if (p === "/admin/gh/file" && M === "POST") return ghPut(req, H);
  if (p === "/admin/gh/history" && M === "GET") return ghHistory(url, H);
  if (p === "/admin/gh/ad-image" && M === "POST") return ghAdImage(req, H);
  return null;
}

// ------------------------------------------------------------------ overview (admin inbox counts)
async function overview(H) {
  const { env } = H, one = (sql, ...a) => env.DB.prepare(sql).bind(...a).first();
  const since30 = Date.now() - 30 * 864e5, since7 = Date.now() - 7 * 864e5, d30 = new Date(since30).toISOString().slice(0, 10);
  const [devs, ads, sup, don, revs, clicks, unread] = await Promise.all([
    env.DB.prepare("SELECT status, COUNT(*) n FROM developers GROUP BY status").all(),
    env.DB.prepare("SELECT status, COUNT(*) n FROM ad_requests GROUP BY status").all(),
    one("SELECT COUNT(*) n FROM supporters WHERE approved=0"),
    one("SELECT COUNT(*) n, ROUND(SUM(usd), 2) usd FROM donations WHERE ignored=0 AND ts >= ?", since30),
    one("SELECT COUNT(*) n FROM reviews WHERE ts >= ?", since7),
    env.DB.prepare("SELECT item, COUNT(*) n, COUNT(DISTINCT visitor) people FROM events WHERE kind='ad' AND day >= ? GROUP BY item ORDER BY n DESC").bind(d30).all(),
    env.DB.prepare(`SELECT 'dev' k, dev_id id, MAX(ts) ts FROM dev_messages GROUP BY dev_id HAVING MAX(CASE WHEN sender='store' THEN ts ELSE 0 END) < MAX(ts)
                    UNION ALL SELECT 'ad', ad_id, MAX(ts) FROM ad_messages GROUP BY ad_id HAVING MAX(CASE WHEN sender='store' THEN ts ELSE 0 END) < MAX(ts)`).all(),
  ]);
  const by = (r) => Object.fromEntries(r.results.map((x) => [x.status, x.n]));
  return H.json({ developers: by(devs), ads: by(ads), supporters_waiting: sup.n, donations_30d: don, reviews_7d: revs.n,
    ad_clicks_30d: clicks.results, unread: unread.results, github: !!env.GITHUB_TOKEN });
}

// ------------------------------------------------------------------ developers
async function devStatus(url, H) {
  const id = url.searchParams.get("id"), d = await checkToken(H, "developers", id, url.searchParams.get("t"));
  const msgs = (await H.env.DB.prepare("SELECT sender, body, ts FROM dev_messages WHERE dev_id=? ORDER BY ts").bind(d.id).all()).results;
  return H.json({
    id: d.id, ts: d.ts, updated_ts: d.updated_ts, status: d.status, app_name: d.app_name, company: d.company, name: d.name,
    tagline: d.tagline, app_desc: d.app_desc, logo_url: d.logo_url, screenshots: parse(d.screenshots, []), app_url: d.app_url, repo_url: d.repo_url,
    category: d.category, license: d.license, install_hint: d.install_hint, wants_paid: !!d.wants_paid, price_usd: d.price_usd,
    listing: d.listing_id ? `${H.env.SITE}/app/${d.listing_id}/` : null, telegram_linked: !!d.telegram_chat_id, messages: msgs,
  });
}

async function devMessage(req, H) {
  const b = await H.body(req), d = await checkToken(H, "developers", b.id, b.t);
  const text = H.clip(b.body, 2000);
  if (text.length < 2) H.fail("Write a message first");
  await H.rateLimit(H.env, "devmsg:" + d.id, 20, 86400);
  await H.env.DB.prepare("INSERT INTO dev_messages (dev_id, ts, sender, body) VALUES (?, ?, 'developer', ?)").bind(d.id, Date.now(), text).run();
  H.ctx.waitUntil(H.telegram(H.env, `💬 ${d.app_name} (#${d.id}) replied:\n${text.slice(0, 600)}\n\n${H.env.SITE}/admin/#submissions/${d.id}`));
  return H.json({ ok: true });
}

// Developer sends fixes (only while pending or when changes were requested). Goes back to "pending".
async function devUpdate(req, H) {
  const b = await H.body(req, 16384), d = await checkToken(H, "developers", b.id, b.t);
  if (!["pending", "changes"].includes(d.status)) H.fail("This app is already reviewed — send us a message instead");
  await H.rateLimit(H.env, "devupd:" + d.id, 15, 86400);
  const f = devFields(b, H, true);
  await H.env.DB.prepare(`UPDATE developers SET tagline=?, app_desc=?, logo_url=?, screenshots=?, app_url=?, repo_url=?, category=?, license=?, install_hint=?,
      status='pending', updated_ts=? WHERE id=?`)
    .bind(f.tagline, f.desc, f.logo, JSON.stringify(f.shots), f.appUrl, f.repo, f.category, f.license, f.install, Date.now(), d.id).run();
  await H.env.DB.prepare("INSERT INTO dev_messages (dev_id, ts, sender, body) VALUES (?, ?, 'developer', ?)")
    .bind(d.id, Date.now(), "Updated the submission" + (H.clip(b.note, 1000) ? `: ${H.clip(b.note, 1000)}` : ".")).run();
  H.ctx.waitUntil(H.telegram(H.env, `✏️ ${d.app_name} (#${d.id}) sent an updated submission — back in your queue.\n${H.env.SITE}/admin/#submissions/${d.id}`));
  return H.json({ ok: true });
}

// Shared validation for the listing fields (used by sign-up and by updates).
export function devFields(b, H, partial = false) {
  const tagline = H.clip(b.tagline, 90), desc = H.clip(b.app_desc, 3000), logo = H.clip(b.logo_url, 400);
  const shots = (Array.isArray(b.screenshots) ? b.screenshots : String(b.screenshots || "").split(/\s+/)).map((s) => H.clip(s, 400)).filter(Boolean).slice(0, 6);
  const appUrl = H.clip(b.app_url, 300), repo = H.clip(b.repo_url, 200).replace(/\.git$/, "").replace(/\/+$/, "");
  const category = H.clip(b.category, 40), license = H.clip(b.license, 40), install = H.clip(b.install_hint, 120);
  if (tagline.length < 10) H.fail("Add a one-line tagline (10–90 characters)");
  if (desc.length < 200) H.fail("Your write-up needs at least 200 characters: what it does, who it's for, and its key features");
  if (!HTTPS.test(logo)) H.fail("Add a link to your logo (https://…, PNG or SVG, at least 256×256)");
  if (!shots.length) H.fail("Add at least one screenshot link (https://…)");
  for (const s of shots) if (!HTTPS.test(s)) H.fail("Screenshot links must start with https://");
  if (appUrl && !HTTPS.test(appUrl)) H.fail("Links must start with https://");
  if (!/^https:\/\/(github\.com|gitlab\.com|codeberg\.org)\/[\w.-]+\/[\w.-]+$/.test(repo)) H.fail("Add your source repository (https://github.com/owner/repo — GitLab and Codeberg work too)");
  if (category && !/^[a-z-]{2,40}$/.test(category)) H.fail("Pick a category");
  return { tagline, desc, logo, shots, appUrl, repo, category: category || null, license: license || null, install: install || null };
}

async function setDeveloper(id, req, H) {
  const { env } = H, b = await H.body(req);
  const d = await env.DB.prepare("SELECT * FROM developers WHERE id=?").bind(id).first();
  if (!d) H.fail("not found", 404);
  const status = b.status ?? d.status;
  if (!DEV_STATUS.includes(status)) H.fail("bad status");
  const note = b.note !== undefined ? H.clip(b.note, 1000) : d.note;
  const listing = b.listing_id !== undefined ? (ID_RE.test(b.listing_id || "") ? b.listing_id : null) : d.listing_id;
  await env.DB.prepare("UPDATE developers SET status=?, note=?, listing_id=?, updated_ts=? WHERE id=?").bind(status, note, listing, Date.now(), id).run();
  const msg = H.clip(b.message, 2000);
  if (msg) await env.DB.prepare("INSERT INTO dev_messages (dev_id, ts, sender, body) VALUES (?, ?, 'store', ?)").bind(id, Date.now(), msg).run();
  if (status !== d.status) await audit(env, "developer." + status, `#${id} ${d.app_name}`, msg);
  else if (msg) await audit(env, "developer.message", `#${id} ${d.app_name}`, msg);
  if (d.telegram_chat_id && (status !== d.status || msg)) {
    const E = H.esc, name = `<b>${E(d.app_name)}</b>`;
    const head = status === d.status ? `New message about ${name}` : {
      approved: `🎉 ${name} was approved! We're preparing your store page now.`,
      live: `🚀 ${name} is live in the Omarchy Store!${listing ? `\n${env.SITE}/app/${listing}/` : ""}`,
      changes: `✏️ We need a few changes to ${name} before it can go live.`,
      rejected: `${name} wasn't approved this time.`,
      pending: `${name} is back in the review queue.`,
    }[status];
    H.ctx.waitUntil(H.notifyUser(env, d.telegram_chat_id, `${head}${msg ? `\n\n${E(msg)}` : ""}\n\nYour status page has the details.`));
  }
  return H.json({ ok: true });
}

// ------------------------------------------------------------------ advertisers
async function adRequest(req, H) {
  const { env } = H, b = await H.body(req, 8192), c = H.clip;
  const company = c(b.company, 80), name = c(b.name, 80), email = c(b.email, 120), website = c(b.website, 200), tg = c(b.telegram, 40).replace(/^@/, "");
  const slot = c(b.slot, 20), app = c(b.app, 64), starts = c(b.starts, 10), ends = c(b.ends, 10), budget = c(b.budget, 40);
  const headline = c(b.headline, 60), text = c(b.body, 140), cta = c(b.cta, 24), link = c(b.url, 300), image = c(b.image_url, 400), notes = c(b.notes, 1500);
  if (!company) H.fail("Enter your company or brand name");
  if (!name) H.fail("Enter your name");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) H.fail("Please enter a valid email");
  if (!SLOTS.includes(slot)) H.fail("Pick a placement");
  if (slot === "sponsored-app" && !ID_RE.test(app)) H.fail("Pick the app you want to sponsor");
  const D = /^\d{4}-\d{2}-\d{2}$/;
  if (!D.test(starts) || !D.test(ends) || ends < starts) H.fail("Pick a start and end date");
  if (starts < new Date().toISOString().slice(0, 10)) H.fail("The start date is in the past");
  if (slot !== "sponsored-app" && headline.length < 3) H.fail("Add a headline for your ad");
  if (link && !HTTPS.test(link)) H.fail("Your ad's link must start with https://");
  if (slot !== "sponsored-app" && !link) H.fail("Add the link your ad should open");
  if (image && !HTTPS.test(image)) H.fail("Image links must start with https://");
  if (website && !HTTPS.test(website)) H.fail("Links must start with https://");
  if (tg && !/^[A-Za-z0-9_]{5,32}$/.test(tg)) H.fail("That Telegram username doesn't look right");
  if (!b.agree) H.fail("Please accept the advertising policy");
  await H.turnstile(b.turnstile, req, env);
  const v = await H.visitor(req, env);
  await H.rateLimit(env, "ad:" + v, 5, 86400);
  const { token, hash } = await issueToken(H);
  const r = await env.DB.prepare(`INSERT INTO ad_requests (ts, status, company, name, email, website, telegram, slot, app, starts, ends, budget, headline, body, cta, url, image_url, notes, token_hash)
      VALUES (?, 'new', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(Date.now(), company, name, email, website, tg || null, slot, slot === "sponsored-app" ? app : null, starts, ends, budget, headline, text, cta, link, image, notes, hash).run();
  const id = r.meta.last_row_id;
  H.ctx.waitUntil(H.telegram(env, `📣 New ad request #${id}\n${company} — ${name} <${email}>${tg ? ` · @${tg}` : ""}\n${slot}${app ? ` (${app})` : ""} · ${starts} → ${ends}${budget ? ` · budget ${budget}` : ""}\n${headline}\n\nReview: ${env.SITE}/admin/#ads`));
  return H.json({ ok: true, id, token, url: `${env.SITE}/advertise/?status=${id}&t=${token}` });
}

async function adStatus(url, H) {
  const id = url.searchParams.get("id"), a = await checkToken(H, "ad_requests", id, url.searchParams.get("t"));
  const msgs = (await H.env.DB.prepare("SELECT sender, body, ts FROM ad_messages WHERE ad_id=? ORDER BY ts").bind(a.id).all()).results;
  const order = await H.env.DB.prepare("SELECT id, status FROM orders WHERE app=? ORDER BY ts DESC LIMIT 1").bind("ad-" + a.id).first();
  const { token_hash, admin_note, account_id, ...pub } = a;
  return H.json({ ...pub, messages: msgs, order, payments: H.methods(H.env) });
}

async function adMessage(req, H) {
  const b = await H.body(req), a = await checkToken(H, "ad_requests", b.id, b.t);
  const text = H.clip(b.body, 2000);
  if (text.length < 2) H.fail("Write a message first");
  await H.rateLimit(H.env, "admsg:" + a.id, 20, 86400);
  await H.env.DB.prepare("INSERT INTO ad_messages (ad_id, ts, sender, body) VALUES (?, ?, 'advertiser', ?)").bind(a.id, Date.now(), text).run();
  H.ctx.waitUntil(H.telegram(H.env, `💬 Advertiser ${a.company} (#${a.id}) replied:\n${text.slice(0, 600)}\n\n${H.env.SITE}/admin/#ads/${a.id}`));
  return H.json({ ok: true });
}

// Pay an accepted quote. The amount comes from the quote stored here, never from the browser.
async function adPay(req, H) {
  const b = await H.body(req), a = await checkToken(H, "ad_requests", b.id, b.t);
  if (!["quoted", "approved"].includes(a.status) || !(a.quote_usd > 0)) H.fail("There's no quote to pay yet");
  await H.rateLimit(H.env, "adpay:" + a.id, 10, 3600);
  const o = await H.makeOrder(H.env, { app: "ad-" + a.id, price: a.quote_usd, chain: H.clip(b.chain, 12) || "usdc-base", email: a.email });
  return H.json(o);
}

async function setAdRequest(id, req, H) {
  const { env } = H, b = await H.body(req);
  const a = await env.DB.prepare("SELECT * FROM ad_requests WHERE id=?").bind(id).first();
  if (!a) H.fail("not found", 404);
  const status = b.status ?? a.status;
  if (!AD_STATUS.includes(status)) H.fail("bad status");
  let quote = a.quote_usd;
  if (b.quote_usd !== undefined) { quote = b.quote_usd === null || b.quote_usd === "" ? null : Math.round(Number(b.quote_usd) * 100) / 100; if (quote !== null && !(quote >= 1 && quote <= 100000)) H.fail("Quote must be between $1 and $100,000"); }
  const note = b.admin_note !== undefined ? H.clip(b.admin_note, 1000) : a.admin_note;
  const camp = b.campaign_id !== undefined ? (ID_RE.test(b.campaign_id || "") ? b.campaign_id : null) : a.campaign_id;
  await env.DB.prepare("UPDATE ad_requests SET status=?, quote_usd=?, admin_note=?, campaign_id=?, updated_ts=? WHERE id=?").bind(status, quote, note, camp, Date.now(), id).run();
  const msg = H.clip(b.message, 2000);
  if (msg) await env.DB.prepare("INSERT INTO ad_messages (ad_id, ts, sender, body) VALUES (?, ?, 'store', ?)").bind(id, Date.now(), msg).run();
  await audit(env, "ad." + (status !== a.status ? status : msg ? "message" : "edit"), `#${id} ${a.company}`, [quote !== a.quote_usd ? `quote $${quote}` : "", msg].filter(Boolean).join(" · "));
  return H.json({ ok: true });
}

// Called by checkOrders when an "ad-<id>" order is paid.
export async function adPaid(env, order) {
  const id = Number(String(order.app).slice(3));
  if (!id) return;
  await env.DB.prepare("UPDATE ad_requests SET status='paid', updated_ts=? WHERE id=? AND status IN ('quoted','approved')").bind(Date.now(), id).run();
  await env.DB.prepare("INSERT INTO ad_messages (ad_id, ts, sender, body) VALUES (?, ?, 'store', ?)")
    .bind(id, Date.now(), `Payment received — thank you! Order ${order.id}. We'll confirm when your ad is live.`).run();
}

// ------------------------------------------------------------------ donations
const wallets = (env) => ({ btc: env.WALLET_BTC || null, evm: env.WALLET_EVM || null, sol: env.WALLET_SOL || null, xrp: env.WALLET_XRP || null });

async function donateInfo(H) {
  const s = (await H.env.DB.prepare("SELECT name, message, chain, ts FROM supporters WHERE approved=1 ORDER BY ts DESC LIMIT 60").all()).results;
  return H.json({ wallets: wallets(H.env), supporters: s }, 200, { "Cache-Control": "public, max-age=120" });
}

async function addSupporter(req, H) {
  const b = await H.body(req), name = H.clip(b.name, 40), message = H.clip(b.message, 140), chain = H.clip(b.chain, 12);
  if (name.length < 2) H.fail("Enter the name you'd like shown");
  if (/https?:\/\/|www\./i.test(name + " " + message)) H.fail("Links aren't allowed on the wall");
  await H.turnstile(b.turnstile, req, H.env);
  const v = await H.visitor(req, H.env);
  await H.rateLimit(H.env, "sup:" + v, 3, 86400);
  await H.env.DB.prepare("INSERT INTO supporters (ts, name, message, chain, visitor) VALUES (?, ?, ?, ?, ?)").bind(Date.now(), name, message, chain, v).run();
  H.ctx.waitUntil(H.telegram(H.env, `💜 ${name} wants to be on the supporters wall${message ? `: "${message}"` : ""}\nApprove: ${H.env.SITE}/admin/#donations`));
  return H.json({ ok: true });
}

const META = {
  get: async (env, k) => (await env.DB.prepare("SELECT v FROM meta WHERE k=?").bind(k).first())?.v ?? null,
  set: (env, k, v) => env.DB.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)").bind(k, String(v)).run(),
};

// Read-only scan of the public wallets for incoming money that isn't a store order = a donation.
// First run only records a baseline (so the owner's own earlier transfers are never counted).
export async function scanDonations(H, force = false) {
  const { env } = H, w = wallets(env), now = Date.now();
  const last = Number(await META.get(env, "don:last")) || 0;
  if (!force && now - last < 25 * 60e3) return { skipped: true };
  await META.set(env, "don:last", now);
  const init = !(await META.get(env, "don:since"));
  if (init) await META.set(env, "don:since", now);
  const since = Number(await META.get(env, "don:since"));
  const orderTx = new Set((await env.DB.prepare("SELECT txid FROM orders WHERE txid IS NOT NULL").all()).results.map((r) => r.txid));
  const found = [], errors = [];
  const add = (chain, txid, units, time) => { if (!orderTx.has(txid) && units > 0n && time >= since) found.push({ chain, txid, units, time }); };
  const tryit = async (name, fn) => { try { await fn(); } catch (e) { errors.push(`${name}: ${e.message}`); } };

  if (w.btc) await tryit("btc", async () => { for (const t of await H.incomingBTC(w.btc)) if (t.confirmed) add("btc", t.txid, t.units, t.time); });
  if (w.xrp) await tryit("xrp", async () => { for (const t of await H.incomingXRP(w.xrp)) if (t.confirmed) add("xrp", t.txid, t.units, t.time); });
  if (w.evm) for (const [net, chain] of [["base", "usdc-base"], ["eth", "usdc-eth"]]) await tryit(chain, async () => {
    const head = Number(BigInt(await H.rpc(H.EVM_RPC[net], "eth_blockNumber", [])));
    const span = net === "base" ? 9000 : 3000, conf = net === "base" ? 10 : 3, safe = head - conf;
    let from = Number(await META.get(env, "cur:" + chain)) || safe;
    if (safe - from > span * 4) from = safe - span * 4;             // never fall too far behind
    const topic = "0x" + "0".repeat(24) + w.evm.toLowerCase().slice(2);
    for (let a = from + 1; a <= safe; a += span) {
      const b = Math.min(safe, a + span - 1);
      const logs = await H.rpc(H.EVM_RPC[net], "eth_getLogs", [{ address: H.USDC[net], topics: [H.TRANSFER, null, topic], fromBlock: "0x" + a.toString(16), toBlock: "0x" + b.toString(16) }]);
      for (const l of logs) add(chain, l.transactionHash, BigInt(l.data), now);
    }
    await META.set(env, "cur:" + chain, safe);
  });
  // Native ETH has no logs: watch the balance. A rise not explained by a paid store order is a donation.
  if (w.evm) for (const [net, chain, rpcs] of [["eth", "eth", ["https://ethereum-rpc.publicnode.com"]], ["base", "eth-base", H.EVM_RPC.base]]) await tryit(chain, async () => {
    const bal = BigInt(await H.rpc(rpcs, "eth_getBalance", [w.evm, "latest"]));
    const prev = await META.get(env, "bal:" + chain);
    await META.set(env, "bal:" + chain, bal.toString());
    if (prev === null) return;
    let delta = bal - BigInt(prev);
    if (chain === "eth-base") {
      const paid = (await env.DB.prepare("SELECT amount FROM orders WHERE chain='eth-base' AND status='paid' AND paid_ts >= ?").bind(last || now).all()).results;
      for (const o of paid) delta -= BigInt(o.amount || 0);
    }
    if (delta > 0n) add(chain, `bal:${chain}:${now}`, delta, now);
  });
  if (w.sol) await tryit("sol", async () => {
    const until = await META.get(env, "cur:sol");
    const sigs = await H.rpc(H.SOL_RPC, "getSignaturesForAddress", [w.sol, { limit: 20, ...(until ? { until } : {}) }]);
    if (sigs.length) await META.set(env, "cur:sol", sigs[0].signature);
    if (!until) return;                                             // first run: baseline only
    for (const s of sigs.filter((x) => !x.err).slice(0, 12)) {
      const tx = await H.rpc(H.SOL_RPC, "getTransaction", [s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]);
      const m = tx?.meta; if (!m) continue;
      const i = tx.transaction.message.accountKeys.findIndex((k) => (k.pubkey || k) === w.sol);
      if (i >= 0) add("sol", s.signature, BigInt(m.postBalances[i]) - BigInt(m.preBalances[i]), now);
      const tb = (arr) => (arr || []).filter((x) => x.mint === H.USDC.sol && x.owner === w.sol).reduce((t, x) => t + BigInt(x.uiTokenAmount.amount), 0n);
      add("usdc-sol", s.signature + ":usdc", tb(m.postTokenBalances) - tb(m.preTokenBalances), now);
    }
  });

  let added = 0;
  const prices = {};
  for (const f of found) {
    const coin = H.COIN[f.chain] || "ETH", dec = H.DEC[f.chain] ?? 18;
    if (!(coin in prices)) prices[coin] = await H.usdPrice(coin).catch(() => null);
    const amt = Number(H.fmt(f.units, dec)), usd = prices[coin] ? Math.round(amt * prices[coin] * 100) / 100 : null;
    const r = await env.DB.prepare("INSERT OR IGNORE INTO donations (ts, chain, txid, units, coin, usd) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(f.time || now, f.chain, f.txid, f.units.toString(), coin, usd).run();
    if (r.meta.changes) {
      added++;
      await H.telegram(env, `💜 Donation received: ${H.fmt(f.units, dec)} ${coin}${usd ? ` (≈ $${usd})` : ""}${f.txid.startsWith("bal:") ? "" : `\n${H.EXPLORER[f.chain] || ""}${f.txid.replace(/:usdc$/, "")}`}`);
    }
  }
  return { ok: true, baseline: init, added, errors };
}

// ------------------------------------------------------------------ GitHub-backed catalog editor
// The Worker commits JSON straight to the repo; the normal deploy workflow publishes it (~2 min).
// Needs the GITHUB_TOKEN secret: a fine-grained token for ONE repo with Contents: Read and write.
const EDITABLE = /^registry\/(apps\/[a-z0-9][a-z0-9-]{0,40}\.json|ads\.json|featured\.json|categories\.json)$/;
const repoOf = (env) => env.GITHUB_REPO || "omarchy-community/store";
const branchOf = (env) => env.GITHUB_BRANCH || "main";

async function gh(H, path, opts = {}) {
  if (!H.env.GITHUB_TOKEN) H.fail("GitHub isn't connected yet — see Settings in the admin portal", 409);
  const r = await fetch(`https://api.github.com/repos/${repoOf(H.env)}${path}`, {
    ...opts, headers: { Authorization: `Bearer ${H.env.GITHUB_TOKEN}`, "User-Agent": "omarchy-store-admin", Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28", ...(opts.body ? { "Content-Type": "application/json" } : {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(r.status === 409 ? "Someone else changed this file a moment ago — reload and try again" : `GitHub: ${j.message || r.status}`); e.status = r.status === 404 ? 404 : r.status === 409 ? 409 : 502; throw e; }
  return j;
}
const b64enc = (bytes) => { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
const b64dec = (s) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\n/g, "")), (c) => c.charCodeAt(0)));

async function ghStatus(H) {
  if (!H.env.GITHUB_TOKEN) return H.json({ connected: false, repo: repoOf(H.env) });
  try {
    const [repo, runs] = await Promise.all([gh(H, ""), gh(H, "/actions/workflows/deploy.yml/runs?per_page=5").catch(() => ({ workflow_runs: [] }))]);
    return H.json({ connected: true, repo: repo.full_name, can_push: !!repo.permissions?.push,
      runs: (runs.workflow_runs || []).map((r) => ({ id: r.id, status: r.status, conclusion: r.conclusion, title: r.display_title, sha: r.head_sha, ts: r.created_at, url: r.html_url })) });
  } catch (e) { return H.json({ connected: false, error: e.message, repo: repoOf(H.env) }); }
}

async function registryIds(H) {
  const list = await gh(H, `/contents/registry/apps?ref=${branchOf(H.env)}`);
  return list.filter((f) => f.name.endsWith(".json")).map((f) => f.name.slice(0, -5));
}

async function ghGet(url, H) {
  const path = url.searchParams.get("path") || "", ref = url.searchParams.get("ref") || branchOf(H.env);
  if (!EDITABLE.test(path)) H.fail("That file can't be edited here");
  if (!/^[\w.\/-]{1,80}$/.test(ref)) H.fail("bad ref");
  try {
    const f = await gh(H, `/contents/${path}?ref=${encodeURIComponent(ref)}`);
    return H.json({ path, sha: f.sha, text: b64dec(f.content) });
  } catch (e) { if (e.status === 404) return H.json({ path, sha: null, text: null }); throw e; }
}

async function ghHistory(url, H) {
  const path = url.searchParams.get("path") || "";
  if (!EDITABLE.test(path)) H.fail("That file can't be edited here");
  const list = await gh(H, `/commits?path=${encodeURIComponent(path)}&sha=${branchOf(H.env)}&per_page=20`);
  return H.json({ commits: list.map((c) => ({ sha: c.sha, message: c.commit.message.split("\n")[0], author: c.commit.author?.name, ts: c.commit.author?.date, url: c.html_url })) });
}

const KINDS = ["gui", "terminal"], METHODS = ["pacman", "aur", "omarchy", "release", "store"];
const PKG = /^[a-z0-9@._+-]+$/;
const RELEASE = /^https:\/\/github\.com\/(nemoclawai-tech|omarchy-community)\/[A-Za-z0-9_.-]+\/releases\/download\/[A-Za-z0-9_.+-]+\/[A-Za-z0-9_.+-]+\.pkg\.tar\.zst$/;

// Same rules as scripts/build.py validate(), so a bad edit is refused here instead of breaking the deploy.
async function validateFile(path, data, H) {
  const errs = [];
  if (path.startsWith("registry/apps/")) {
    const id = path.slice(14, -5), a = data;
    const cats = JSON.parse((await ghGet(new URL("https://x/?path=registry/categories.json"), H).then((r) => r.json())).text).map((c) => c.id);
    if (!a || typeof a !== "object" || Array.isArray(a)) return ["The listing must be a JSON object"];
    if (a.id !== id) errs.push(`"id" must be "${id}" (same as the file name)`);
    if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(a.id || "")) errs.push("id must be lowercase letters, digits and dashes");
    if (!a.name) errs.push("Name is required");
    if (!cats.includes(a.category)) errs.push(`Unknown category "${a.category}"`);
    if (!KINDS.includes(a.kind)) errs.push('Type must be "gui" or "terminal"');
    const inst = a.install || {}, m = inst.method;
    if (!METHODS.includes(m)) errs.push("Install method must be pacman, aur, omarchy or release");
    if (["pacman", "aur", "release"].includes(m) && !((inst.packages || []).length && inst.packages.every((x) => PKG.test(x)))) errs.push("Install packages must be valid package names");
    if (m === "omarchy" && !/^omarchy install [a-z0-9 '._-]+$/i.test(inst.command || "")) errs.push("Install command must be an 'omarchy install …' command");
    if (m === "store" && a.id !== "omarchy-store") errs.push("Install method 'store' is only for the Omarchy Store itself");
    if (m === "release") {
      if (!RELEASE.test(inst.url || "")) errs.push("Release URL must be a .pkg.tar.zst on an approved GitHub org");
      if (!/^[0-9a-f]{64}$/.test(inst.sha256 || "")) errs.push("Release needs a sha256");
      if (!inst.version) errs.push("Release needs a version");
    }
    if (!((a.detect || []).length && a.detect.every((x) => PKG.test(x)))) errs.push("Detect must list package names");
    if (a.cli && a.kind !== "terminal") errs.push("Command-line apps must be type terminal");
    if (!(a.github || a.flathub || a.homepage)) errs.push("Needs a GitHub repo, Flathub id or homepage");
    if (a.github && !/^[\w.-]+\/[\w.-]+$/.test(a.github)) errs.push("GitHub must be owner/repo");
    for (const u of [a.icon, a.homepage, ...(a.screenshots || [])]) if (u && !/^https:\/\//.test(u) && !/^featured\/[a-z0-9-]+\/[a-z0-9._-]+$/.test(u)) errs.push(`"${u}" must be an https:// link`);
    if (a.age && !/^\d{1,2}\+$/.test(a.age)) errs.push("Age must look like 4+, 9+, 12+ or 17+");
  } else if (path === "registry/ads.json") {
    if (!Array.isArray(data?.campaigns)) return ["ads.json needs a campaigns list"];
    const ids = new Set();
    for (const c of data.campaigns) {
      const n = c.id || "(no id)";
      if (!ID_RE.test(c.id || "")) errs.push(`${n}: id must be lowercase letters, digits and dashes`);
      if (ids.has(c.id)) errs.push(`${n}: duplicate id`); ids.add(c.id);
      if (!["banner", "search", "sponsored-app"].includes(c.slot)) errs.push(`${n}: bad slot`);
      if (!["house", "direct", "app", "artist"].includes(c.type)) errs.push(`${n}: bad type`);
      if (c.url && !/^https:\/\//.test(c.url)) errs.push(`${n}: link must be https://`);
      if (c.image && !/^https:\/\//.test(c.image) && !/^ads\/[a-z0-9-]+\.(webp|png|jpg|jpeg)$/.test(c.image)) errs.push(`${n}: image must be https:// or ads/<file>`);
      if (c.starts && !/^\d{4}-\d{2}-\d{2}$/.test(c.starts) || c.ends && !/^\d{4}-\d{2}-\d{2}$/.test(c.ends)) errs.push(`${n}: dates must be YYYY-MM-DD`);
    }
    const appIds = data.campaigns.filter((c) => c.type === "app").map((c) => c.app);
    if (appIds.length) { const have = new Set(await registryIds(H)); for (const x of appIds) if (!have.has(x)) errs.push(`Sponsored app "${x}" isn't in the store`); }
  } else if (path === "registry/featured.json") {
    if (!Array.isArray(data?.hero) || !Array.isArray(data?.collections)) return ["featured.json needs hero and collections lists"];
    const have = new Set(await registryIds(H));
    for (const h of data.hero) if (!have.has(h.app)) errs.push(`Hero app "${h.app}" isn't in the store`);
    for (const c of data.collections) for (const x of c.apps || []) if (!have.has(x)) errs.push(`"${c.title}" lists unknown app "${x}"`);
  } else if (path === "registry/categories.json") {
    if (!Array.isArray(data) || !data.every((c) => /^[a-z-]+$/.test(c.id || "") && c.name)) errs.push("Each category needs an id and a name");
  }
  return errs;
}

async function ghPut(req, H) {
  const b = await H.body(req, 400000);
  const path = H.clip(b.path, 120), msg = H.clip(b.message, 120) || `Update ${path}`;
  if (!EDITABLE.test(path)) H.fail("That file can't be edited here");
  if (b.data === undefined) H.fail("Nothing to save");
  const errs = await validateFile(path, b.data, H);
  if (errs.length) { const e = new Error(errs.join(" · ")); e.status = 422; throw e; }
  const text = JSON.stringify(b.data, null, path.startsWith("registry/apps/") ? 1 : 2) + "\n";
  const r = await gh(H, `/contents/${path}`, { method: "PUT", body: JSON.stringify({
    message: `admin: ${msg}`, branch: branchOf(H.env), content: b64enc(new TextEncoder().encode(text)), ...(b.sha ? { sha: b.sha } : {}) }) });
  await audit(H.env, b.sha ? "catalog.edit" : "catalog.create", path, msg);
  return H.json({ ok: true, sha: r.content?.sha, commit: r.commit?.sha, url: r.commit?.html_url });
}

// Copy an advertiser's image into the repo (site/ads/) so the live ad never loads from their server
// (no tracking pixels — a promise on the Advertise page).
async function ghAdImage(req, H) {
  const b = await H.body(req), id = H.clip(b.campaign_id, 64), src = H.clip(b.url, 400);
  if (!ID_RE.test(id)) H.fail("Give the campaign an id first");
  if (!HTTPS.test(src)) H.fail("Image link must start with https://");
  const r = await fetch(src, { headers: { "User-Agent": "omarchy-store-admin" }, redirect: "follow" });
  if (!r.ok) H.fail(`Couldn't download the image (${r.status})`);
  const type = (r.headers.get("Content-Type") || "").split(";")[0];
  const ext = { "image/webp": "webp", "image/png": "png", "image/jpeg": "jpg" }[type];
  if (!ext) H.fail("The image must be WebP, PNG or JPEG");
  const bytes = new Uint8Array(await r.arrayBuffer());
  if (bytes.length > 1.5e6) H.fail("The image is over 1.5 MB — ask for a smaller one");
  const path = `site/ads/${id}.${ext}`;
  let sha = null;
  try { sha = (await gh(H, `/contents/${path}?ref=${branchOf(H.env)}`)).sha; } catch {}
  await gh(H, `/contents/${path}`, { method: "PUT", body: JSON.stringify({ message: `admin: ad image for ${id}`, branch: branchOf(H.env), content: b64enc(bytes), ...(sha ? { sha } : {}) }) });
  await audit(H.env, "ad.image", path, src);
  return H.json({ ok: true, image: `ads/${id}.${ext}` });
}
