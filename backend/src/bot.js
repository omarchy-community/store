// @OmarchyStoreBot: the Omarchy Store's Telegram bot (runs inside the Cloudflare Worker, free tier).
//   Webhook:   POST /tg/<STORE_BOT_SECRET>     (Telegram also sends the secret in a header; both are checked)
//   Features:  search apps + themes, /theme (random preview), /new, /top, /get, /links, /daily opt-in,
//              inline mode (@OmarchyStoreBot obsidian in ANY chat), daily "drop" to the channel + subscribers,
//              /broadcast and /stats for the owner.
const SITE = "https://omarchystore.com";
const OWNER = 1485214924;
let CATALOG = null, CATALOG_AT = 0;

async function catalog() {
  if (CATALOG && Date.now() - CATALOG_AT < 30 * 60e3) return CATALOG;
  const r = await fetch(`${SITE}/catalog.json`, { cf: { cacheTtl: 1800, cacheEverything: true } });
  const c = await r.json();
  let plugins = 5300;
  try {
    const pj = await (await fetch("https://raw.githubusercontent.com/omarchy-community/store/data/plugins.json", { cf: { cacheTtl: 3600, cacheEverything: true } })).json();
    plugins = (pj.plugins || pj).length || plugins;
  } catch {}
  CATALOG = {
    apps: c.apps.filter((a) => a.available !== false),
    themes: c.themes.filter((t) => !t.archived),
    plugins,
  };
  // Headline number, rounded DOWN to the hundred: "6,400+"
  CATALOG.total = c.apps.length + c.themes.length + plugins;
  CATALOG.totalLabel = (Math.floor(CATALOG.total / 100) * 100).toLocaleString("en-US") + "+";
  CATALOG_AT = Date.now();
  return CATALOG;
}

const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const k = (n) => (n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "K" : String(n || 0));
const appUrl = (a) => `${SITE}/app/${a.id}/`;
const themeUrl = (t) => `${SITE}/theme/${t.id}/`;
const img = (p) => (p ? (p.startsWith("http") ? p : `${SITE}/${p}`) : null);

function installCmd(a) {
  const i = a.install || {};
  if (i.method === "aur") return `yay -S ${(i.packages || [a.id]).join(" ")}`;
  if (i.method === "pacman" || i.method === "omarchy") return `sudo pacman -S ${(i.packages || [a.id]).join(" ")}`;
  if (i.method === "flatpak") return `flatpak install flathub ${i.id || a.flathub}`;
  return null;
}
function themeCmd(t) {
  return t.builtin ? `omarchy-theme-set ${t.builtin}` : `omarchy-theme-install https://github.com/${t.repo}`;
}

function score(q, name, extra) {
  const n = name.toLowerCase();
  if (n === q) return 100;
  if (n.startsWith(q)) return 80;
  if (n.includes(q)) return 60;
  if ((extra || "").toLowerCase().includes(q)) return 30;
  return 0;
}
async function search(q, limit = 8) {
  const c = await catalog();
  q = q.toLowerCase().trim();
  const hits = [];
  for (const a of c.apps) {
    const s = score(q, a.name, `${a.summary} ${(a.tags || []).join(" ")} ${a.category}`);
    if (s) hits.push({ type: "app", s: s + Math.log10((a.stars || 0) + 10), x: a });
  }
  for (const t of c.themes) {
    const s = score(q, t.name, `${t.description} ${t.author} theme`);
    if (s) hits.push({ type: "theme", s: s - 1 + Math.log10((t.stars || 0) + 10), x: t });
  }
  return hits.sort((a, b) => b.s - a.s).slice(0, limit);
}

function appCard(a) {
  const cmd = installCmd(a);
  return {
    text: `<b>${esc(a.name)}</b>${a.stars ? `  ⭐ ${k(a.stars)}` : ""}\n${esc(a.summary || "")}\n\n` +
      (cmd ? `Install:\n<code>${esc(cmd)}</code>\n\n` : "") + `One click in the Omarchy Store 👇`,
    kb: [[{ text: "🛍️ Open in the Omarchy Store", url: appUrl(a) }]],
    photo: img(a.screenshots?.[0]),
  };
}
function themeCard(t) {
  return {
    text: `🎨 <b>${esc(t.name)}</b> by ${esc(t.author)}${t.stars ? `  ⭐ ${k(t.stars)}` : ""}\n${esc(t.description || "")}\n\n` +
      `Install:\n<code>${esc(themeCmd(t))}</code>`,
    kb: [[{ text: "🎨 See it in the Omarchy Store", url: themeUrl(t) }], [{ text: "🎲 Another theme", callback_data: "theme" }]],
    photo: img(t.image),
  };
}

async function tg(env, method, payload) {
  const r = await fetch(`https://api.telegram.org/bot${env.STORE_BOT_TOKEN}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  });
  return r.json();
}
async function sendCard(env, chat, card) {
  const base = { chat_id: chat, parse_mode: "HTML", reply_markup: { inline_keyboard: card.kb } };
  if (card.photo) {
    const r = await tg(env, "sendPhoto", { ...base, photo: card.photo, caption: card.text });
    if (r.ok) return r;
  }
  return tg(env, "sendMessage", { ...base, text: card.text, link_preview_options: { is_disabled: true } });
}
const send = (env, chat, text, kb) => tg(env, "sendMessage", {
  chat_id: chat, text, parse_mode: "HTML", link_preview_options: { is_disabled: true },
  ...(kb ? { reply_markup: { inline_keyboard: kb } } : {}),
});
// Used outside the bot module (e.g. to tell a developer their app was approved/rejected).
export const notifyUser = send;

const WELCOME = (c) => `🛍️ <b>Welcome to the Omarchy Store!</b>

<b>The largest Omarchy app store on Earth.</b> Apps, themes and plugins, one click each.

<b>Just type what you're looking for</b>, e.g. <i>obsidian</i>, <i>steam</i>, <i>tokyo night</i>.

/theme  random theme with preview
/new  newest apps
/top  most popular apps
/get  install Omarchy (keep Windows)
/daily  get one great app or theme a day

Tip: in ANY chat, type <code>@OmarchyStoreBot obsidian</code> to share an app.`;
const MENU = [
  [{ text: "🛍️ Open the store", url: SITE }, { text: "🎨 Themes", url: `${SITE}/themes/` }],
  [{ text: "🎲 Random theme", callback_data: "theme" }, { text: "🔥 Top apps", callback_data: "top" }],
  [{ text: "🐧 Get Omarchy", url: `${SITE}/get` }, { text: "💬 Discord", url: "https://discord.gg/zC5P7VtcZH" }],
];

async function db(env) {
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS tg_users (id INTEGER PRIMARY KEY, name TEXT, ts INTEGER, daily INTEGER DEFAULT 0, blocked INTEGER DEFAULT 0)").run();
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS tg_posted (item TEXT PRIMARY KEY, ts INTEGER)").run();
}

async function handleCommand(env, chat, from, text) {
  const [cmd0, ...rest] = text.trim().split(/\s+/);
  const cmd = cmd0.toLowerCase().replace(/@omarchystorebot$/, "");
  const arg = rest.join(" ");
  const c = await catalog();
  switch (cmd) {
    case "/start": case "/help": {
      // Deep link from the submit page: t.me/OmarchyStoreBot?start=dev_<id> links this chat to
      // their developer application, so we can tell them directly once it's approved/rejected.
      const m = /^dev_(\d+)$/.exec(arg);
      if (m) {
        await env.DB.prepare("UPDATE developers SET telegram_chat_id=? WHERE id=?").bind(chat, Number(m[1])).run();
        return send(env, chat, "✅ <b>You're linked!</b> I'll message you here the moment your app submission is approved (or if we need anything from you).");
      }
      return send(env, chat, WELCOME(c), MENU);
    }
    case "/search": case "/app":
      return arg ? doSearch(env, chat, arg) : send(env, chat, "Type an app name, e.g. <code>/search obsidian</code> (or just type <i>obsidian</i>).");
    case "/theme": {
      if (arg) { const h = (await search(arg, 20)).find((x) => x.type === "theme"); if (h) return sendCard(env, chat, themeCard(h.x)); }
      return sendCard(env, chat, themeCard(randomTheme(c)));
    }
    case "/new": {
      const list = [...c.apps].filter((a) => a.released_at || a.last_commit)
        .sort((a, b) => String(b.released_at || b.last_commit).localeCompare(String(a.released_at || a.last_commit))).slice(0, 10);
      return send(env, chat, "🆕 <b>Freshly updated apps</b>\n\n" + list.map((a) => `• <a href="${appUrl(a)}">${esc(a.name)}</a>: ${esc(a.summary || "")}`).join("\n"));
    }
    case "/top": return sendTop(env, chat, c);
    case "/get":
      return send(env, chat, "🐧 <b>Install Omarchy in 4 steps (about 15 minutes)</b>\nYou can keep Windows. Our free tool Ignite makes the USB stick for you.",
        [[{ text: "Step-by-step guide", url: `${SITE}/get` }]]);
    case "/links":
      return send(env, chat, `🔗 <b>Omarchy Store</b>\n🌐 ${SITE}\n🎨 ${SITE}/themes/\n🧩 ${SITE}/plugins/\n📦 Submit your app: ${SITE}/submit\n💻 Source: https://github.com/omarchy-community/store\n\n💬 Discord: https://discord.gg/zC5P7VtcZH\n▶️ YouTube: https://youtube.com/@OmarchyStore\n🎵 TikTok: https://tiktok.com/@omarchy.store\n📸 Instagram: https://instagram.com/omarchystore\n𝕏 X: https://x.com/omarchystore`);
    case "/daily": {
      const on = arg.toLowerCase() !== "off";
      await env.DB.prepare("UPDATE tg_users SET daily=? WHERE id=?").bind(on ? 1 : 0, chat).run();
      return send(env, chat, on ? "✅ You'll get one great app or theme every day. Turn off with <code>/daily off</code>." : "Daily picks turned off.");
    }
    case "/stats": {
      if (from !== OWNER) break;
      const u = await env.DB.prepare("SELECT COUNT(*) n, SUM(daily) d FROM tg_users WHERE blocked=0").first();
      return send(env, chat, `👥 Bot users: ${u.n}\n📬 Daily subscribers: ${u.d || 0}`);
    }
    case "/broadcast": {
      if (from !== OWNER || !arg) break;
      const n = await broadcast(env, { text: arg, kb: [[{ text: "🛍️ Omarchy Store", url: SITE }]] }, false);
      return send(env, chat, `Sent to ${n} people.`);
    }
    case "/drop": {
      if (from !== OWNER) break;
      return dailyDrop(env, true);
    }
  }
  return doSearch(env, chat, text.replace(/^\//, ""));
}

function randomTheme(c) {
  const good = c.themes.filter((t) => t.image);
  return good[Math.floor(Math.random() * good.length)];
}
async function sendTop(env, chat, c) {
  const list = [...c.apps].sort((a, b) => (b.stars || 0) - (a.stars || 0)).slice(0, 10);
  return send(env, chat, "🔥 <b>Most popular apps</b>\n\n" + list.map((a, i) => `${i + 1}. <a href="${appUrl(a)}">${esc(a.name)}</a> ⭐ ${k(a.stars)}`).join("\n"));
}

async function doSearch(env, chat, q) {
  if (q.length < 2) return send(env, chat, "Type at least 2 letters 🙂");
  const hits = await search(q);
  if (!hits.length)
    return send(env, chat, `Nothing found for "<b>${esc(q)}</b>". Want it in the store? Suggest it 👇`,
      [[{ text: "Suggest an app", url: "https://github.com/omarchy-community/store/issues/new" }]]);
  const top = hits[0];
  if (top.s >= 80 || hits.length === 1) return sendCard(env, chat, top.type === "app" ? appCard(top.x) : themeCard(top.x));
  return send(env, chat, `Results for "<b>${esc(q)}</b>":`, hits.map((h) => [{
    text: `${h.type === "theme" ? "🎨" : "📦"} ${h.x.name}${h.x.stars ? ` ⭐${k(h.x.stars)}` : ""}`,
    callback_data: `${h.type === "theme" ? "t" : "a"}:${h.x.id}`.slice(0, 64),
  }]));
}

async function inline(env, q) {
  const query = (q.query || "").trim();
  const c = await catalog();
  const hits = query.length >= 2 ? await search(query, 20)
    : [...c.apps].sort((a, b) => (b.stars || 0) - (a.stars || 0)).slice(0, 20).map((x) => ({ type: "app", x }));
  const results = hits.map((h) => {
    const card = h.type === "app" ? appCard(h.x) : themeCard(h.x);
    return {
      type: "article", id: `${h.type}:${h.x.id}`.slice(0, 64), title: `${h.type === "theme" ? "🎨 " : ""}${h.x.name}`,
      description: (h.x.summary || h.x.description || "").slice(0, 120),
      thumbnail_url: img(h.type === "app" ? (h.x.icon || null) : h.x.image) || undefined,
      input_message_content: { message_text: card.text.replace("One click in the Omarchy Store 👇", ""), parse_mode: "HTML", link_preview_options: { url: h.type === "app" ? appUrl(h.x) : themeUrl(h.x), prefer_large_media: true } },
      reply_markup: { inline_keyboard: [card.kb[0]] },
    };
  });
  return tg(env, "answerInlineQuery", { inline_query_id: q.id, results, cache_time: 300 });
}

// One post a day: alternates a theme (with its preview image) and a well-loved app.
export async function dailyDrop(env, force = false) {
  if (!env.STORE_BOT_TOKEN) return;
  await db(env);
  const today = new Date().toISOString().slice(0, 10);
  if (!force && await env.DB.prepare("SELECT 1 FROM tg_posted WHERE item=?").bind("day:" + today).first()) return;
  const c = await catalog();
  const posted = new Set((await env.DB.prepare("SELECT item FROM tg_posted").all()).results.map((r) => r.item));
  const themeDay = new Date().getUTCDate() % 2 === 0;
  let card, key;
  if (themeDay) {
    const t = c.themes.filter((t) => t.image && !posted.has("t:" + t.id)).sort((a, b) => (b.stars || 0) - (a.stars || 0))[0] || randomTheme(c);
    card = themeCard(t); key = "t:" + t.id;
    card.text = "🎨 <b>Theme of the day</b>\n\n" + card.text;
  } else {
    const a = c.apps.filter((a) => a.kind === "gui" && a.screenshots?.length && !posted.has("a:" + a.id) && a.stars).sort((a, b) => (b.stars || 0) - (a.stars || 0))[0];
    card = appCard(a); key = "a:" + a.id;
    card.text = "📦 <b>App of the day</b>\n\n" + card.text;
  }
  card.kb = [card.kb[0], [{ text: "🤖 Search the store with the bot", url: "https://t.me/OmarchyStoreBot" }]];
  await env.DB.prepare("INSERT OR REPLACE INTO tg_posted (item, ts) VALUES (?, ?), (?, ?)").bind(key, Date.now(), "day:" + today, Date.now()).run();
  if (env.STORE_CHANNEL) await sendCard(env, env.STORE_CHANNEL, card);
  await broadcast(env, card, true);
}

async function broadcast(env, card, dailyOnly) {
  const users = (await env.DB.prepare(`SELECT id FROM tg_users WHERE blocked=0 ${dailyOnly ? "AND daily=1" : ""} LIMIT 5000`).all()).results;
  let n = 0;
  for (const u of users) {
    const r = card.photo ? await sendCard(env, u.id, card) : await send(env, u.id, card.text, card.kb);
    if (r.ok) n++; else if (r.error_code === 403) await env.DB.prepare("UPDATE tg_users SET blocked=1 WHERE id=?").bind(u.id).run();
  }
  return n;
}

export async function storeBot(req, env, ctx, secret) {
  if (!env.STORE_BOT_TOKEN || !env.STORE_BOT_SECRET || secret !== env.STORE_BOT_SECRET ||
      req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.STORE_BOT_SECRET)
    return new Response("nope", { status: 403 });
  const u = await req.json();
  ctx.waitUntil((async () => {
    try {
      await db(env);
      if (u.inline_query) return inline(env, u.inline_query);
      if (u.callback_query) {
        const q = u.callback_query, chat = q.message?.chat?.id, d = q.data || "";
        await tg(env, "answerCallbackQuery", { callback_query_id: q.id });
        const c = await catalog();
        if (d === "theme") return sendCard(env, chat, themeCard(randomTheme(c)));
        if (d === "top") return sendTop(env, chat, c);
        const [t, id] = d.split(":");
        const x = t === "t" ? c.themes.find((y) => y.id === id) : c.apps.find((y) => y.id === id);
        if (x) return sendCard(env, chat, t === "t" ? themeCard(x) : appCard(x));
        return;
      }
      const m = u.message;
      if (!m?.text || m.chat.type !== "private" && !m.text.startsWith("/")) return;
      if (m.chat.type === "private")
        await env.DB.prepare("INSERT INTO tg_users (id, name, ts, daily) VALUES (?, ?, ?, 1) ON CONFLICT(id) DO UPDATE SET blocked=0")
          .bind(m.chat.id, (m.from?.username || m.from?.first_name || "").slice(0, 64), Date.now()).run();
      if (m.text.startsWith("/")) return handleCommand(env, m.chat.id, m.from?.id, m.text);
      return doSearch(env, m.chat.id, m.text.slice(0, 60));
    } catch (e) { console.error("bot", e.stack || e); }
  })());
  return new Response("ok");
}
