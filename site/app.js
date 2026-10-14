/* Omarchy Store — single-page app. No framework, no build step.
 *
 * Two modes, detected at startup:
 *   web     — hosted on GitHub Pages. "GET" shows the install command to copy.
 *   desktop — served by the local helper (omarchy-store). "GET" really installs,
 *             buttons switch to OPEN once installed, and the UI wears your Omarchy theme.
 */
(() => {
  "use strict";

  const SITE = "https://omarchystore.com/";
  const REPO = "https://github.com/omarchy-community/store";
  const API = "https://omarchy-store-api.omarchystore.workers.dev";
  const INSTALLER = `curl -fsSL ${SITE}install.sh | bash`;
  // Mirrors SECURITY.md + scripts/build.py's RELEASE_RE: a "release" app only counts as a
  // verified-developer download when it's pinned to a GitHub release under our own accounts
  // with a checked SHA-256 — same rule get.sh enforces before it will install anything.
  const VERIFIED_RELEASE_RE = /^https:\/\/github\.com\/(nemoclawai-tech|omarchy-community)\/[A-Za-z0-9_.-]+\/releases\/download\/[A-Za-z0-9_.+-]+\/[A-Za-z0-9_.+-]+\.pkg\.tar\.zst$/;
  const isVerifiedDev = (a) => a.install?.method === "release" && VERIFIED_RELEASE_RE.test(a.install.url || "") && /^[0-9a-f]{64}$/.test(a.install.sha256 || "");

  const S = { catalog: null, byId: {}, themeById: {}, desktop: false, installed: new Set(), busy: new Set(), chartCat: "all",
    themeFilter: "featured", themeQ: "", themesHave: new Set(), themeNow: "",
    plugins: null, plugById: {}, plugFilter: "popular", plugCat: "all", plugQ: "", plugShown: 60, plugsHave: new Set(), cryptoChain: "all", cryptoQ: "", cryptoHave: new Set(), cryptoBusy: new Set(), savers: null, saverF: "all", saverQ: "", saverShown: 60 };
  const $ = (s, el = document) => el.querySelector(s);
  const view = $("#view");
  // Desktop helper injects a per-session token; every install/open request must carry it.
  const TOKEN = document.querySelector('meta[name="store-token"]')?.content || "";
  const post = (path, body) => fetch(path, { method: "POST", headers: { "Content-Type": "application/json", "X-Store-Token": TOKEN }, body: JSON.stringify(body) });

  // ---------- helpers ----------
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  // Links that come from outside data (plugin marketplace, GitHub, theme directory): only http(s) is allowed,
  // so a javascript:/data: URL can never end up in an href. A bare "example.com/x" gets https:// in front.
  const safeUrl = (u) => { u = String(u ?? "").trim(); return esc(/^https?:\/\//i.test(u) ? u : /^[\w-]+(\.[\w-]+)+(\/|$)/.test(u) ? "https://" + u : "#"); };
  const k = (n) => n == null ? "—" : n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M" : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(/\.0$/, "") + "K" : String(n);
  const mb = (b) => b == null ? "—" : b >= 1e9 ? (b / 1e9).toFixed(1) + " GB" : b >= 1e6 ? Math.round(b / 1e6) + " MB" : Math.max(1, Math.round(b / 1e3)) + " KB";
  const ago = (iso) => {
    if (!iso) return "—";
    const d = (Date.now() - new Date(iso)) / 864e5;
    return d < 1 ? "Today" : d < 2 ? "Yesterday" : d < 30 ? Math.floor(d) + " days ago" : d < 365 ? Math.floor(d / 30) + " mo ago" : Math.floor(d / 365) + " yr ago";
  };
  const cmdFor = (a) => {
    const i = a.install;
    if (i.method === "omarchy" || i.method === "store") return i.command;
    if (i.method === "release") return `curl -fsSL ${SITE}get.sh | bash -s ${a.id}`;
    if (i.method === "aur") return `omarchy pkg aur add ${i.packages.join(" ")}`;
    return `omarchy pkg add ${i.packages.join(" ")}`;
  };
  const sourceLabel = (a) => {
    const r = a.package?.repo;
    if (a.install.method === "omarchy") return "Omarchy installer";
    if (a.install.method === "store") return "omarchystore.com (official installer)";
    if (a.install.method === "release") return "the developer (verified download)";
    if (a.install.method === "aur" || r === "aur") return "Arch User Repository (AUR)";
    return r ? `Arch Linux (${r})` : "Arch Linux";
  };
  const toast = (msg) => {
    const t = $("#toast"); t.textContent = msg; t.hidden = false;
    clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 2400);
  };
  const copy = async (text) => {
    try { await navigator.clipboard.writeText(text); } catch {
      const ta = Object.assign(document.createElement("textarea"), { value: text });
      document.body.append(ta); ta.select(); document.execCommand("copy"); ta.remove();
    }
    toast("Copied to clipboard");
  };

  const ICONS = {
    window: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M6.5 6.5h.01M9 6.5h.01"/>',
    minimize: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M8 16h8"/>',
    resize: '<path d="M4 10V4h6M20 14v6h-6"/><path d="m4 4 6 6M20 20l-6-6"/>',
    dock: '<rect x="2" y="15" width="20" height="6" rx="2"/><path d="M6 18h.01M10 18h.01M14 18h.01M18 18h.01"/><path d="M12 3v7m0 0-3-3m3 3 3-3"/>',
    pin: '<path d="M9 3h6l-1 6 3 3v2h-5v7l-1 0v-7H6v-2l3-3z"/>',
    power: '<path d="M12 3v9"/><path d="M7.5 6.5a8 8 0 1 0 9 0"/>',
    update: '<path d="M3 12a9 9 0 0 1 15.3-6.4L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.3 6.4L3 16"/><path d="M3 21v-5h5"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
    doctor: '<path d="M6 3v5a5 5 0 0 0 10 0V3"/><path d="M6 3H4.5M16 3h1.5"/><path d="M11 13v2a5 5 0 0 0 7 4.6"/><circle cx="19" cy="17" r="2.5"/>',
    backup: '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6"/><path d="M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>',
    desktops: '<rect x="2" y="5" width="13" height="10" rx="2"/><path d="M18 8h3a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-8a1 1 0 0 1-1-1v-3"/>',
    camera: '<path d="M3 8a2 2 0 0 1 2-2h2l1.5-2h7L17 6h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><circle cx="12" cy="12.5" r="3.5"/>',
    cast: '<path d="M3 18a3 3 0 0 1 3 3M3 14a7 7 0 0 1 7 7M3 10a11 11 0 0 1 11 11"/><path d="M3 7V6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-5"/>',
    lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/><path d="M12 14.5v2.5"/>',
    language: '<path d="M3 5h11M8.5 3v2"/><path d="M12 5c0 4.5-3.5 8.5-8 10"/><path d="M6 10.5c1.6 2.6 4 4.4 7 5.5"/><path d="m13 21 4-10 4 10M14.6 17.8h4.8"/>',
    assist: '<circle cx="12" cy="12" r="9"/><path d="M9.2 9.5a3 3 0 1 1 3.8 3.4c-.6.2-1 .8-1 1.4v.5"/><path d="M12 18h.01"/>',
    drag: '<circle cx="9" cy="6" r="1.4"/><circle cx="15" cy="6" r="1.4"/><circle cx="9" cy="12" r="1.4"/><circle cx="15" cy="12" r="1.4"/><circle cx="9" cy="18" r="1.4"/><circle cx="15" cy="18" r="1.4"/>',
    infinity: '<path d="M7 12a3.2 3.2 0 1 1 3.2 3.2c-2.2 0-2.4-6.4-4.6-6.4A3.2 3.2 0 0 0 7 12z" transform="translate(1.3)"/><path d="M17 12a3.2 3.2 0 1 0-3.2 3.2c2.2 0 2.4-6.4 4.6-6.4A3.2 3.2 0 0 1 17 12z" transform="translate(-1.3)"/>',
    trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6"/>',
    puzzle: '<path d="M10 3h4v3a2 2 0 1 0 4 0V3h3v7h-3a2 2 0 1 0 0 4h3v7h-7v-3a2 2 0 1 0-4 0v3H3v-7h3a2 2 0 1 0 0-4H3V3h7z"/>',
    verified: '<path d="M12 2l2.4 1.8 3-.2.9 2.9 2.5 1.7-1 2.8 1 2.8-2.5 1.7-.9 2.9-3-.2L12 22l-2.4-1.8-3 .2-.9-2.9-2.5-1.7 1-2.8-1-2.8 2.5-1.7.9-2.9 3 .2z"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
    plus: '<rect x="3" y="3" width="18" height="18" rx="5"/><path d="M12 8v8M8 12h8"/>',
    megaphone: '<path d="M3 10v4a1 1 0 0 0 1 1h3l6 4V5L7 9H4a1 1 0 0 0-1 1z"/><path d="M17 8.5a5 5 0 0 1 0 7"/><path d="M19.5 6a8.5 8.5 0 0 1 0 12"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="m4 7 8 6 8-6"/>',
    discover: '<path d="M12 2l2.4 6.9H22l-6 4.6 2.3 7.1L12 16.2 5.7 20.6 8 13.5 2 8.9h7.6z"/>',
    // New Apps: a four-point sparkle with two small companions.
    sparkle: '<path d="M11 3l1.6 4.4L17 9l-4.4 1.6L11 15l-1.6-4.4L5 9l4.4-1.6z"/><path d="M18 13.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/><path d="M6.5 16l.5 1.3 1.3.5-1.3.5L6.5 20 6 18.3 4.7 17.8 6 17.3z"/>',
    charts: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    installed: '<path d="M12 3v12m0 0-4-4m4 4 4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18"/>',
    code: '<path d="m8 8-4 4 4 4m8-8 4 4-4 4m-6 3 4-14"/>',
    moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/><path d="M16 3v3M14.5 4.5h3M19.5 8v2M18.5 9h2"/>',
    sparkles: '<path d="M12 3l1.8 4.7L18.5 9.5 13.8 11.3 12 16l-1.8-4.7L5.5 9.5l4.7-1.8zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
    brush: '<path d="M14 4l6 6-9 9H5v-6z"/><path d="M12 6l6 6"/>',
    film: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/>',
    play: '<circle cx="12" cy="12" r="9"/><path d="m10 8 6 4-6 4z"/>',
    gamepad: '<rect x="2" y="7" width="20" height="11" rx="5"/><path d="M7 11v3M5.5 12.5h3M16 12h.01M18 14h.01"/>',
    chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>',
    check: '<rect x="3" y="3" width="18" height="18" rx="4"/><path d="m8 12 3 3 5-6"/>',
    shield: '<path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z"/>',
    terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M12 15h5"/>',
    book: '<path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2zM4 21V5M8 7h7"/>',
    palette: '<path d="M12 3a9 9 0 0 0 0 18c1.1 0 1.7-.8 1.7-1.7 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.2 0-.9.8-1.7 1.7-1.7H16a5 5 0 0 0 5-5C21 6.4 17 3 12 3z"/><circle cx="7.5" cy="11" r="1"/><circle cx="10" cy="7" r="1"/><circle cx="14.5" cy="7" r="1"/><circle cx="17" cy="10.5" r="1"/>',
    wrench: '<path d="M14.7 6.3a4 4 0 0 0 5 5L13 18a2.1 2.1 0 0 1-3-3l6.7-6.7a4 4 0 0 0-5-5z"/>',
    star: '<path d="M12 2l3 6.6 7 .8-5.2 4.8 1.4 7L12 17.8 5.8 21.2l1.4-7L2 9.4l7-.8z"/>',
    share: '<path d="M12 3v12M8 7l4-4 4 4M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/>',
    github: '<path d="M9 19c-4 1.3-4-2-6-2.5M15 21v-3.5a3 3 0 0 0-.9-2.4c3-.3 6-1.4 6-6.5a5 5 0 0 0-1.4-3.5 4.7 4.7 0 0 0-.1-3.5s-1.1-.3-3.6 1.4a12.4 12.4 0 0 0-6.5 0C5.9 1.4 4.8 1.7 4.8 1.7a4.7 4.7 0 0 0-.1 3.5A5 5 0 0 0 3.3 8.7c0 5 3 6.2 6 6.5a3 3 0 0 0-.9 2.4V21"/>',
    ok: '<path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z"/><path d="m9 12 2 2 4-4"/>',
    warn: '<path d="M12 3 2 20h20zM12 10v4M12 17h.01"/>',
    refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
    rocket: '<path d="M12 2c3 2 5 6 5 10l-2 4H9l-2-4c0-4 2-8 5-10z"/><circle cx="12" cy="10" r="1.8"/><path d="M9 16l-3 3 1-5M15 16l3 3-1-5M10 20h4"/>',
    wallet: '<path d="M4 7a2 2 0 0 1 2-2h11a1 1 0 0 1 1 1v2"/><rect x="3" y="7" width="18" height="13" rx="2.5"/><path d="M16 13.5h.01M21 11h-4a2.5 2.5 0 0 0 0 5h4"/>',
    usb: '<path d="M8 2h8v6H8z"/><path d="M6 8h12v10a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4z"/><path d="M10 4.5h.01M14 4.5h.01"/>',
  };
  // Official accounts. Fill in a link and it appears in the footer and on the Contact page.
  const CONTACT_EMAIL = "info@omarchystore.com";
  // `what` is the one-line reason to follow, shown on the big Community cards.
  const SOCIALS = [
    { id: "discord", name: "Discord", url: "https://discord.gg/zC5P7VtcZH", what: "Chat, get help, show your setup", cta: "Join" },
    { id: "youtube", name: "YouTube", url: "https://www.youtube.com/@OmarchyStore", what: "Themes and apps in action", cta: "Subscribe" },
    { id: "tiktok", name: "TikTok", url: "https://www.tiktok.com/@omarchy.store", what: "Daily themes in 20 seconds", cta: "Follow" },
    { id: "instagram", name: "Instagram", url: "https://www.instagram.com/omarchystore/", what: "Desktop setups and reels", cta: "Follow" },
    { id: "x", name: "X", url: "https://x.com/omarchystore", what: "Store news and new apps", cta: "Follow" },
    { id: "telegram", name: "Telegram", url: "https://t.me/omarchystore", what: "App of the day + search bot", cta: "Join" },
    { id: "whatsapp", name: "WhatsApp", url: "" },
  ];
  const SOC_ICO = {
    x: '<path class="fill" d="M17.8 3h3.1l-6.8 7.7L22 21h-6.2l-4.9-6.3L5.3 21H2.2l7.2-8.3L2 3h6.4l4.4 5.8zm-1.1 16.2h1.7L7.4 4.7H5.6z"/>',
    discord: '<path class="fill" d="M19.6 5.3A16.5 16.5 0 0 0 15.5 4l-.5 1a15.3 15.3 0 0 0-6 0L8.5 4a16.5 16.5 0 0 0-4.1 1.3C1.8 9.2 1.1 13 1.4 16.7A16.6 16.6 0 0 0 6.5 19.3l1.1-1.8a10.7 10.7 0 0 1-1.7-.8l.4-.3a11.8 11.8 0 0 0 11.4 0l.4.3c-.5.3-1.1.6-1.7.8l1.1 1.8a16.5 16.5 0 0 0 5.1-2.6c.4-4.3-.7-8.1-3-11.4zM8.7 14.5c-1 0-1.8-.9-1.8-2s.8-2 1.8-2 1.8.9 1.8 2-.8 2-1.8 2zm6.6 0c-1 0-1.8-.9-1.8-2s.8-2 1.8-2 1.8.9 1.8 2-.8 2-1.8 2z"/>',
    instagram: '<rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r=".6"/>',
    tiktok: '<path d="M14 3v11.5a3.5 3.5 0 1 1-3.5-3.5"/><path d="M14 3c.5 3 2.5 5 5.5 5"/>',
    youtube: '<rect x="2.5" y="5.5" width="19" height="13" rx="4"/><path d="M10 9.5v5l4.5-2.5z"/>',
    telegram: '<path d="M21 4L3 11l6 2 2 6 3-4 5 4z"/><path d="M9 13l8-6"/>',
    whatsapp: '<path d="M4 20l1.3-4A8 8 0 1 1 8 18.7z"/><path d="M9 9.5c0 3 2.5 5.5 5.5 5.5l1-1.5-2-1-1 1c-1-.5-2-1.5-2.5-2.5l1-1-1-2z"/>',
  };
  const liveSocials = () => SOCIALS.filter((s) => s.url);
  const socIcon = (s) => `<svg viewBox="0 0 24 24">${SOC_ICO[s.id]}</svg>`;
  // Prominent "Join the community" block: one coloured card per platform.
  const communityBlock = (title = "Join the Omarchy Store community") => liveSocials().length ? `<section class="shelf community">
      <div class="shelf-head"><h2>${title}</h2><a href="/contact/">All links</a></div>
      <div class="comm-grid">${liveSocials().map((s) => `<a class="comm-card soc-${s.id}" href="${s.url}" target="_blank" rel="noopener">
        <span class="comm-ico">${socIcon(s)}</span>
        <span class="comm-txt"><b>${s.name}</b><span>${esc(s.what || "")}</span></span>
        <span class="comm-cta">${s.cta || "Follow"}</span></a>`).join("")}</div>
    </section>` : "";
  const socialRow = () => liveSocials().length ? `<div class="socials"><span class="soc-label">Follow us</span>${liveSocials().map((s) => `<a class="soc-${s.id}" href="${s.url}" target="_blank" rel="noopener" aria-label="${s.name}" title="${s.name}">${socIcon(s)}</a>`).join("")}</div>` : "";
  const ico = (n) => `<svg viewBox="0 0 24 24">${ICONS[n] || ""}</svg>`;
  const CAT_COLORS = ["#0a84ff", "#5e5ce6", "#bf5af2", "#ff375f", "#ff9f0a", "#ff453a", "#30d158", "#64d2ff", "#32ade6", "#ac8e68", "#8e8e93"];

  // ---------- data ----------
  async function boot() {
    // Desktop helper answers /api/status from the same origin; GitHub Pages returns 404.
    try {
      const r = TOKEN ? await fetch("/api/status", { cache: "no-store" }) : { ok: false };
      if (r.ok) {
        const st = await r.json();
        S.desktop = true; S.status = st;
        S.installed = new Set(st.installed || []); S.removable = new Set(st.removable || []); S.updatable = new Set(st.updatable || []);
        S.themesHave = new Set(st.themes_installed || []); S.themeNow = st.theme_current || "";
        if (st.theme) applyTheme(st.theme);
      }
    } catch { /* web mode */ }

    const r = await fetch("/catalog.json", { cache: "no-cache" });
    S.catalog = await r.json();
    // The store's own listing ships separately (older desktop apps would reject it in "apps"); it's #1.
    if (S.catalog.store_app && !S.catalog.apps.some((a) => a.id === S.catalog.store_app.id)) S.catalog.apps.unshift(S.catalog.store_app);
    S.catalog.apps.forEach((a, i) => { S.byId[a.id] = a; a.rank = i + 1; });
    S.catalog.themes = S.catalog.themes || [];
    S.catalog.themes.forEach((t) => { S.themeById[t.id] = t; });
    renderNav();
    renderTitlebar();
    renderModeBadge();
    renderMigrationBanner();
    route();
    if (S.desktop) {
      // Check app updates in the background now and every hour; show a count next to "Updates".
      setTimeout(() => loadUpdates(false), 1500);
      setInterval(async () => { await refreshInstalled(); loadUpdates(false); renderSelfUpdate(); }, 3600e3);
      renderSelfUpdate();
    }
  }

  // ---------- Appearance switch (Dark · Glass · White), remembered on this device ----------
  function setLook(l, save = true) {
    document.documentElement.dataset.look = l;
    if (save) try { localStorage.setItem("os-look2", l); } catch {}   // "os-look2": Glass became the default for everyone (Oct 2026)
    document.querySelectorAll("[data-look]").forEach((b) => { const on = b.dataset.look === l; b.classList.toggle("on", on); b.setAttribute("aria-checked", on); });
  }
  document.addEventListener("click", (e) => { const b = e.target.closest("button[data-look]"); if (b) setLook(b.dataset.look); });
  setLook(document.documentElement.dataset.look || "glass", false);

  function applyTheme(t) {
    const r = document.documentElement.style;
    document.documentElement.classList.add("themed");
    const set = (v, c) => c && r.setProperty(v, c);
    set("--bg", t.background); set("--bg-2", t.lighter_background); set("--sidebar", t.dark_background);
    set("--card", t.lighter_background); set("--card-hover", t.selection);
    set("--text", t.bright_foreground || t.foreground); set("--text-2", t.foreground); set("--text-3", t.dark_foreground);
    set("--accent", t.accent); set("--accent-text", t.background); set("--pill-text", t.accent);
    set("--good", t.green); set("--line", t.selection);
    if (t.mode === "light") document.documentElement.style.colorScheme = "light";
  }

  async function refreshInstalled() {
    if (!S.desktop) return;
    try {
      const st = await (await fetch("/api/status", { cache: "no-store" })).json();
      S.status = st;
      S.installed = new Set(st.installed || []); S.removable = new Set(st.removable || []); S.updatable = new Set(st.updatable || []);
      S.themesHave = new Set(st.themes_installed || []); S.themeNow = st.theme_current || "";
    } catch {}
  }
  // You're using the desktop app right now, so the Omarchy Store listing always counts as installed.
  const isInstalled = (a) => S.installed.has(a.id) || (S.desktop && a?.install?.method === "store");

  // ---------- nav ----------
  function renderNav() {
    const cats = S.catalog.categories;
    // Browse links + categories come first. "More" (Get Omarchy, developers, ads, contact) sits
    // at the bottom of the sidebar and is hidden from the phone's category pill row
    // (on phones those live in the footer cards and the Discover banner).
    $("#nav").innerHTML = `
      <a href="/" data-r="">${ico("discover")}Discover</a>
      <a href="/charts/" data-r="charts">${ico("charts")}Top Charts</a>
      <a href="/new/" data-r="new">${ico("sparkle")}New Apps${newApps().length ? `<span class="nav-count">${newApps().length}</span>` : ""}</a>
      <a href="/categories/" data-r="categories">${ico("grid")}Categories</a>
      ${S.catalog.themes.length ? `<a class="d-hide" href="/themes/" data-r="themes">${ico("palette")}Themes</a>` : ""}
      <a class="d-hide" href="/plugins/" data-r="plugins">${ico("puzzle")}Plugins</a>
      <a class="d-hide" href="/screensavers/" data-r="screensavers">${ico("moon")}Screensavers</a>
      ${wallets().length ? `<a class="d-hide" href="/crypto/" data-r="crypto">${ico("wallet")}Crypto</a>` : ""}
      ${S.desktop ? `<a href="/installed/" data-r="installed">${ico("installed")}Installed</a>
      <a href="/updates/" data-r="updates">${ico("refresh")}Updates<span class="nav-count" id="upd-count" hidden></span></a>` : ""}
      <div class="sec">Categories</div>
      ${S.catalog.themes.length ? `<a class="m-hide" href="/themes/" data-r="themes-cat">${ico("palette")}Themes</a>` : ""}
      <a class="m-hide" href="/plugins/" data-r="plugins-cat">${ico("puzzle")}Plugins</a>
      <a class="m-hide" href="/screensavers/" data-r="screensavers-cat">${ico("moon")}Screensavers</a>
      ${wallets().length ? `<a class="m-hide" href="/crypto/" data-r="crypto-cat">${ico("wallet")}Crypto Wallets<span class="nav-new">NEW</span></a>` : ""}
      ${cats.map((c) => `<a href="/category/${c.id}/" data-r="category/${c.id}">${ico(c.icon)}${esc(c.name)}</a>`).join("")}
      <div class="sec m-hide">More</div>
      <a class="m-hide" href="/get-omarchy/" data-r="get-omarchy">${ico("rocket")}Get Omarchy</a>
      <a class="m-hide" href="/submit/" data-r="submit">${ico("plus")}Submit an app</a>
      <a class="m-hide" href="/advertise/" data-r="advertise">${ico("megaphone")}Advertise with us</a>
      <a class="m-hide" href="/contact/" data-r="contact">${ico("mail")}Contact us</a>
      <div class="sec m-hide">Community</div>
      ${liveSocials().map((s) => `<a class="m-hide nav-soc soc-${s.id}" href="${s.url}" target="_blank" rel="noopener"><svg viewBox="0 0 24 24">${SOC_ICO[s.id]}</svg>${s.name}</a>`).join("")}`;
  }
  function markNav(r) {
    document.querySelectorAll("#nav a").forEach((a) => a.classList.toggle("on", a.dataset.r === r || a.dataset.r === r + "-cat"));
  }
  // Bottom-right "Update" button when a newer Omarchy Store desktop app is out (like Windows Store's banner).
  function renderSelfUpdate() {
    let el = $("#self-upd");
    const st = S.status || {}, ready = st.restart_needed, want = st.store_update;
    if (!S.desktop || !(ready || (want && want !== st.version))) { if (el) el.remove(); return; }
    if (!el) { el = document.createElement("div"); el.id = "self-upd"; el.className = "self-upd"; document.body.appendChild(el); }
    el.innerHTML = `<span class="su-ic">${ico("refresh")}</span><div><b>Omarchy Store ${esc(want || "")} is available</b><span>You have ${esc(st.version || "")}. Takes a few seconds.</span></div>
      <button class="btn" data-self-update>${ready ? "Restart" : "Update"}</button><button class="su-x" data-self-later aria-label="Later">×</button>`;
  }

  // Migration banner for users on old webapp (Chromium/localhost)
  function renderMigrationBanner() {
    const isOldWebapp = !S.desktop && window.location.hostname === "127.0.0.1";
    let el = $("#migration-banner");
    if (!isOldWebapp) { if (el) el.remove(); return; }
    if (!el) {
      el = document.createElement("div");
      el.id = "migration-banner";
      el.className = "migration-banner";
      document.body.appendChild(el);
    }
    el.innerHTML = `
      <div class="mb-content">
        <span class="mb-ic">${ico("rocket")}</span>
        <div class="mb-text">
          <b>Upgrade to Native Desktop App</b>
          <span>You're using the old webapp. The new Electron app has no URL bar, better performance, and AI security.</span>
        </div>
        <button class="btn mb-btn" data-migrate>Get Native App</button>
        <button class="mb-x" data-migration-dismiss aria-label="Dismiss">×</button>
      </div>`;
  }

  async function migrateToNative(btn) {
    btn.disabled = true;
    btn.innerHTML = `<span class="ring"></span>`;
    try {
      // Download and install the Electron AppImage
      const response = await fetch("/api/migrate-electron", { method: "POST", headers: { "Content-Type": "application/json", "X-Store-Token": TOKEN } });
      if (!response.ok) throw new Error("Failed to start migration");
      toast("Downloading native app…");
      // Poll for completion
      for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 2000));
        const r = await fetch("/api/migrate-status", { cache: "no-store" });
        const data = await r.json().catch(() => ({}));
        if (data.done) {
          toast("Native app ready! Launching…");
          setTimeout(() => location.reload(), 1000);
          return;
        }
        if (data.error) throw new Error(data.error);
      }
      throw new Error("Migration timed out");
    } catch (e) {
      toast(e.message);
      btn.disabled = false;
      btn.textContent = "Retry";
    }
  }
  async function selfUpdate(btn) {
    btn.disabled = true; btn.innerHTML = `<span class="ring"></span>`;
    const was = S.status?.version;
    try {
      let r = await post("/api/self-update", {});
      if (r.status === 404) r = await post("/api/restart", {});          // older store app: it already downloaded the update
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "Update failed");
      toast("Updating Omarchy Store…");
      // Wait for the store to come back on the new version, then reload the page.
      for (let i = 0; i < 40; i++) {
        await new Promise((res) => setTimeout(res, 500));
        try { const st = await (await fetch("/api/status", { cache: "no-store" })).json(); if (st.version && st.version !== was) break; } catch {}
      }
      location.reload();
    } catch (e) { toast(e.message); btn.disabled = false; btn.textContent = "Update"; }
  }

  // Every desktop install shows the same top bar: "Omarchy Store vX" + the Protected badge.
  // The Electron build draws its own (with window buttons); the standard install opens as an
  // Omarchy web-app window with no title bar, so we draw it here.
  const PROTECTED_TIP = "Protected: the store only installs from the official Arch repositories, the AUR and verified developer releases (SHA-256 checked before install), and its helper only accepts commands from this window.";
  function renderTitlebar() {
    if (!S.desktop) return;
    let tb = $(".electron-titlebar");
    if (!tb) {
      tb = document.createElement("div");
      tb.className = "electron-titlebar web-titlebar";
      tb.innerHTML = `<div class="tb-side"></div>
        <div class="title">Omarchy Store <span class="version"></span></div>
        <div class="tb-side tb-right"><div class="security-badge" id="security-badge">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
          <span>Protected</span></div></div>`;
      document.body.insertBefore(tb, document.body.firstChild);
    }
    document.documentElement.classList.add("has-titlebar");
    const ver = tb.querySelector(".version");
    if (ver && S.status?.version && !ver.textContent) ver.textContent = "v" + S.status.version;
    const badge = tb.querySelector(".security-badge");
    if (badge && !badge.title) badge.title = PROTECTED_TIP;
  }

  function renderModeBadge() {
    const b = $("#mode-badge");
    const v = $("#store-version");
    if (S.desktop) {
      b.innerHTML = S.status?.restart_needed
        ? `<b><span class="dot"></span>Update ready</b>Restart the store to finish.`
        : `<b><span class="dot"></span>Desktop app${S.status?.version ? ` <span class="ver">v${esc(S.status.version)}</span>` : ""}</b>One-click installs are on.`;
      if (S.status?.restart_needed) b.setAttribute("href", "/updates/");
      b.removeAttribute("href");
      // Update sidebar version
      if (v && S.status?.version) v.textContent = `v${esc(S.status.version)}`;
    } else {
      b.innerHTML = `<b>Get the desktop app</b>Install apps with one click on Omarchy.`;
      if (v) v.textContent = S.catalog?.desktop_version ? `v${esc(S.catalog.desktop_version)}` : "";   // the current desktop app version
    }
  }

  // ---------- components ----------
  const MONO = ["#7aa2f7", "#bb9af7", "#9ece6a", "#e0af68", "#f7768e", "#7dcfff", "#ff9e64", "#2ac3de"];
  const monogram = (a, size) => {
    let h = 0; for (const c of a.id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    const bg = MONO[h % MONO.length];
    const t = a.name.replace(/[^A-Za-z0-9]/g, "").slice(0, a.kind === "terminal" ? 2 : 1) || "?";
    return `<span class="icon mono" style="width:${size}px;height:${size}px;background:linear-gradient(135deg,${bg},color-mix(in srgb,${bg} 55%,#000));font-size:${Math.round(size * (t.length > 1 ? .36 : .46))}px">${a.kind === "terminal" ? '<i>&gt;_</i>' : ""}${esc(t)}</span>`;
  };
  // Store artwork gets its fingerprint added (?v=…), so browsers and the desktop app never show an old saved copy.
  const asset = (p) => { if (!p) return ""; if (/^(https?:)?\/\//.test(p)) return p;
    const rel = p.replace(/^\//, ""), v = S.catalog?.artwork?.[rel];
    return "/" + rel + (v ? "?v=" + v : ""); };
  const iconImg = (a, size) => a.icon
    ? `<img class="icon" src="${esc(asset(a.icon))}" alt="" width="${size}" height="${size}" loading="lazy" referrerpolicy="no-referrer" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'icon mono',style:'width:${size}px;height:${size}px;background:#414868'}))">`
    : monogram(a, size);

  function getBtn(a, big = false) {
    const cls = "get" + (big ? " big" : "");
    if (a.available === false) return `<button class="${cls} soon" data-soon="${a.id}" title="Launching soon">SOON</button>`;
    if (S.busy.has(a.id)) return `<button class="${cls} busy" data-get="${a.id}"><span class="ring"></span></button>`;
    // Paid app you don't own yet: the button sells it. Once bought (or already installed)
    // it falls through to the normal GET / OPEN behaviour below.
    if (isPaid(a) && !ownsApp(a) && !(S.desktop && isInstalled(a)))
      return `<button class="${cls} buy" data-buy="${a.id}" title="Buy with USDC on Solana">${esc(priceLabel(a))}</button>`;
    if (S.desktop && a.install.method === "store") {   // the store's own listing: update it in place, or show it's current
      const st = S.status || {}, want = st.store_update;
      return st.restart_needed || (want && want !== st.version)
        ? `<button class="${cls}" data-self-update title="Omarchy Store ${esc(want || "")} is ready">UPDATE</button>`
        : `<button class="${cls} installed" disabled title="You're using it now">INSTALLED</button>`;
    }
    if (S.desktop && isInstalled(a) && S.updatable?.has(a.id)) return `<button class="${cls}" data-upd="${a.id}" title="A newer version is ready">UPDATE</button>`;
    if (S.desktop && isInstalled(a)) return a.cli
      ? `<button class="${cls} installed" data-open="${a.id}" title="Opens a terminal — run: ${esc(a.open || a.detect[0])}">INSTALLED</button>`
      : `<button class="${cls} installed" data-open="${a.id}">OPEN</button>`;
    return `<button class="${cls}" data-get="${a.id}">GET</button>`;
  }

  // ---------- Paid apps ----------
  // An app is for sale when it carries a price. We only let the Buy button charge
  // when there is also a developer_wallet to send the 90% to (see solana-pay.js).
  const isPaid = (a) => Number(a?.price_usd) > 0;
  const priceLabel = (a) => "$" + (Math.round(Number(a.price_usd) * 100) / 100).toFixed(2);
  const ownsApp = (a) => { try { return !!window.OmarchyPay?.hasPurchased(a.id); } catch (e) { return false; } };

  // Small "Remove" button shown next to OPEN on detail pages and in Installed (desktop app only).
  const rmBtn = (kind, id, label = "Remove") => `<button class="rm-btn" data-rm="${kind}:${esc(id)}" title="${label}">${ico("trash")}<span>${label}</span></button>`;
  const appRm = (a) => S.desktop && isInstalled(a) && S.removable?.has(a.id) && !S.busy.has(a.id) ? rmBtn("app", a.id) : "";
  const themeRm = (t) => S.desktop && !t.builtin && themeHave(t) && !themeIsCurrent(t) ? rmBtn("theme", t.id) : "";
  const plugRm = (x) => S.desktop && S.plugsHave.has(x.id) && !S.busy.has("plugin:" + x.id) ? rmBtn("plugin", x.id) : "";

  function lockup(a, { rank, sub } = {}) {
    return `<a class="lockup" href="/app/${a.id}/">
      ${rank ? `<span class="rank">${rank}</span>` : ""}
      ${iconImg(a, 64)}
      <div class="meta">
        <div class="name">${esc(a.name)}</div>
        <div class="sub">${esc(sub ?? a.summary)}</div>
        ${a.stars ? `<div class="stars">${ico("star")}${k(a.stars)} on GitHub</div>` : `<div class="stars">${esc(catName(a.category))}</div>`}
      </div>
      ${getBtn(a)}
    </a>`;
  }
  const catName = (id) => S.catalog.categories.find((c) => c.id === id)?.name || id;

  function shelf(title, apps, seeAll) {
    if (!apps.length) return "";
    return `<section class="shelf">
      <div class="shelf-head"><h2>${esc(title)}</h2>${seeAll ? `<a href="${seeAll}">See All</a>` : ""}</div>
      <div class="scroller rows3">${apps.map((a) => lockup(a)).join("")}</div>
    </section>`;
  }

  // ---------- ads ----------
  const ads = (slot) => (S.catalog.ads?.campaigns || []).filter((c) => c.slot === slot);
  const adUrl = (u) => u + (u.includes("?") ? "&" : "?") + "utm_source=omarchy-store&utm_medium=" + (S.desktop ? "desktop" : "web");

  // Ad images can be relative (hosted with the site). The desktop app serves a local copy
  // of the site without the ads/ folder, so point those at the live site instead.
  const adImg = (p) => !p ? "" : /^https:\/\//.test(p) ? p : (S.desktop ? SITE + p : "/" + p);

  function artistAd(c) {
    const u = esc(adUrl(c.url));
    const L = `href="${u}" target="_blank" rel="sponsored noopener" data-ad="${esc(c.id)}"`;
    return `<section class="artist-ad" aria-label="Sponsored: ${esc(c.title)}">
      <a class="aa-hero" ${L}>
        <img src="${esc(adImg(c.image))}" alt="" loading="lazy">
        <span class="ad-chip">Sponsored</span>
        <h3 class="aa-name">${esc(c.title)}</h3>
      </a>
      <div class="aa-bar">
        <a class="aa-play" ${L} title="Play on Spotify"><svg viewBox="0 0 24 24"><path d="M8 5.5v13l11-6.5z"/></svg></a>
        <a class="aa-icon" ${L} title="Shuffle"><svg viewBox="0 0 24 24"><path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/></svg></a>
        <a class="aa-follow" ${L}>Follow</a>
        <a class="aa-more" ${L} title="More">•••</a>
        <a class="aa-cta" ${L}>${esc(c.cta || "Listen on Spotify")}</a>
      </div>
    </section>`;
  }

  function bannerAd() {
    const all = ads("banner");
    const paid = all.filter((c) => c.type !== "house");
    const list = paid.length ? paid : all;
    if (list.length) {
      const c = list[Math.floor(Math.random() * list.length)];
      if (c.type === "artist") return artistAd(c);
      const [g1, g2] = c.gradient || ["#333", "#555"];
      // House ads get enhanced design with decorative elements
      if (c.type === "house") {
        return `<a class="ad-banner house" data-ad="${esc(c.id)}" href="${esc(adUrl(c.url))}" style="background:linear-gradient(135deg,${g1} 0%,${g2} 100%)">
          <div class="ab-deco"></div>
          <div class="ab-content">
            <span class="ad-chip">${c.id === "house-advertise" ? "Grow your reach" : "Join the store"}</span>
            <h3>${esc(c.title)}</h3>
            <p>${esc(c.body)}</p>
          </div>
          <div class="ab-action">
            <span class="cta">${esc(c.cta || "Learn more")}</span>
            <span class="ab-hint">No tracking · Linux-focused</span>
          </div>
        </a>`;
      }
      return `<a class="ad-banner" data-ad="${esc(c.id)}" href="${esc(adUrl(c.url))}" target="_blank" rel="sponsored noopener" style="background:linear-gradient(120deg,${g1},${g2})">
        <div><span class="ad-chip">Sponsored</span><h3>${esc(c.title)}</h3><p>${esc(c.body)}</p></div>
        <span class="cta">${esc(c.cta || "Learn more")}</span></a>`;
    }
    return networkAd();
  }
  function networkAd() {
    const n = S.catalog.ads?.network;
    if (!n?.enabled || !n.publisher_id) return "";
    // EthicalAds: privacy-friendly, developer-focused, no tracking cookies.
    if (n.provider === "ethicalads") {
      queueMicrotask(() => {
        if (!document.querySelector("script[data-ea]")) {
          const s = Object.assign(document.createElement("script"), { src: "https://media.ethicalads.io/media/client/ethicalads.min.js", async: true });
          s.dataset.ea = "1"; document.head.append(s);
        } else window.ethicalads?.reload?.();
      });
      return `<div class="ad-net"><div data-ea-publisher="${esc(n.publisher_id)}" data-ea-type="image" data-ea-style="stickybox-none"></div></div>`;
    }
    return "";
  }
  function sponsoredApp(filter = () => true) {
    const c = ads("sponsored-app").find((c) => S.byId[c.app] && filter(S.byId[c.app]));
    if (!c) return "";
    const a = S.byId[c.app];
    return `<a class="lockup ad-app" data-ad="${esc(c.id)}" href="/app/${a.id}/">
      ${iconImg(a, 64)}
      <div class="meta"><div class="name"><span class="ad-badge">Ad</span>${esc(a.name)}</div><div class="sub">${esc(a.summary)}</div>
      <div class="stars">Sponsored by ${esc(c.sponsor || a.developer)}</div></div>${getBtn(a)}</a>`;
  }
  function searchAd() {
    const c = ads("search")[0];
    if (!c) return "";
    const [g1, g2] = c.gradient || ["#333", "#555"];
    return `<a class="ad-banner" data-ad="${esc(c.id)}" href="${esc(adUrl(c.url))}" target="_blank" rel="sponsored noopener" style="background:linear-gradient(120deg,${g1},${g2});padding:18px 22px">
      <div><span class="ad-chip">Sponsored</span><h3 style="font-size:18px">${esc(c.title)}</h3><p>${esc(c.body)}</p></div><span class="cta">${esc(c.cta)}</span></a>`;
  }


  // ---------- themes (omarchythemes.com + omarchy.org/themes + omarchytheme.com, credited on every page) ----------
  const themeVia = (t, src) => ({ "omarchy.org": "Omarchy.org", "omarchytheme.com": "omarchytheme.com" })[t.via] || src.name || "Omarchy Themes";
  // In the desktop app the local site copy has no preview images, so load them from the live site.
  const themeImg = (t) => !t.image ? "" : /^https:\/\//.test(t.image) ? t.image : (S.desktop ? SITE + t.image : "/" + t.image);
  const canInstallTheme = (t) => !!(t.builtin || t.repo);
  const themeCmd = (t) => t.builtin ? `omarchy-theme-set ${t.builtin}` : `omarchy-theme-install https://github.com/${t.repo}`;
  const themeHave = (t) => S.themesHave.has(t.install_name);
  const themeIsCurrent = (t) => S.themeNow && S.themeNow === t.install_name;
  const swatches = (t, n = 8) => (t.palette || []).slice(0, n).map((c) => `<i style="background:${esc(c)}"></i>`).join("");

  function themeBtn(t, big = false) {
    const cls = "get" + (big ? " big" : "");
    if (!canInstallTheme(t)) return `<a class="${cls} ghosty" href="${safeUrl(t.source_url)}" target="_blank" rel="noopener">VIEW</a>`;
    if (S.busy.has("theme:" + t.id)) return `<button class="${cls} busy"><span class="ring"></span></button>`;
    if (S.desktop && themeIsCurrent(t)) return `<button class="${cls} installed" disabled>IN USE</button>`;
    if (S.desktop && themeHave(t)) return `<button class="${cls}" data-theme-use="${t.id}">USE</button>`;
    return `<button class="${cls}" data-theme-get="${t.id}">GET</button>`;
  }

  function themeCard(t) {
    const img = themeImg(t);
    return `<a class="theme-card" href="/theme/${t.id}/">
      <div class="tc-img" style="background:${esc(t.palette?.[0] || "var(--card)")}">${img ? `<img src="${esc(img)}" alt="${esc(t.name)} theme preview" loading="lazy">` : ""}
        ${t.builtin ? `<span class="tc-chip">Comes with Omarchy</span>` : ""}${S.desktop && themeIsCurrent(t) ? `<span class="tc-chip on">In use</span>` : ""}</div>
      <div class="tc-meta">
        <div style="min-width:0;flex:1"><div class="name">${esc(t.name)}</div><div class="sub">by ${esc(t.author || "unknown")}</div>
          ${t.palette?.length ? `<div class="swatch">${swatches(t)}</div>` : ""}</div>
        ${themeBtn(t)}
      </div>
    </a>`;
  }

  // "Featured" order for themes: the most colourful, best-looking first, with neighbouring cards in
  // different colours. Score = how vivid the palette is (saturation x a usable brightness) + a small
  // bonus for stars and a preview picture. Then we deal them out round-robin by hue (red, orange,
  // green, cyan, blue, purple, pink) so a row looks like a rainbow, not ten shades of grey.
  function hsl(hex) {
    const n = parseInt(String(hex).slice(1), 16); if (isNaN(n)) return [0, 0, 0];
    const r = (n >> 16 & 255) / 255, g = (n >> 8 & 255) / 255, b = (n & 255) / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
    if (!d) return [0, 0, l];
    const sat = d / (1 - Math.abs(2 * l - 1));
    const h = mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [h * 60, sat, l];
  }
  function themeVivid(t) {
    if (t._v !== undefined) return t._v;
    const cols = (t.palette || []).slice(1).map(hsl).filter(([, s, l]) => l > 0.18 && l < 0.88);
    const sat = cols.map(([, s]) => s).sort((a, b) => b - a);
    const vivid = sat.length ? (sat[0] + (sat[1] || 0) + (sat[2] || 0)) / 3 : 0;
    const hues = new Set(cols.filter(([, s]) => s > 0.35).map(([h]) => Math.floor(h / 45))).size;   // how many colour families
    const bg = hsl(t.palette?.[0] || "#000");
    t._hue = cols.length ? cols.reduce((best, c) => (c[1] > best[1] ? c : best))[0] : 0;
    // t.vivid = how colourful the actual preview picture is (measured at build time, ~0-150).
    const pic = t.vivid !== undefined ? Math.min(t.vivid, 110) / 30 : vivid;
    t._v = pic * 1.6 + vivid * 0.8 + hues * 0.2 + bg[1] * 0.4 + (t.image ? 0.6 : -2) + Math.min(Math.log10((t.stars || 0) + 1), 2.5) * 0.3 - (t.archived ? 2 : 0);
    return t._v;
  }
  // Themes made by the Omarchy Store itself always lead Featured and the Discover shelf.
  const ourTheme = (t) => t.via === "omarchystore.com";
  function featuredThemes(n, pool) {
    const ours = (pool || S.catalog.themes).filter(ourTheme);
    return [...ours, ...featuredRanked(n - ours.length, pool)];
  }
  function featuredRanked(n, pool) {
    const ranked = (pool || S.catalog.themes).filter((t) => !ourTheme(t) && !t.builtin && t.image && t.palette?.length >= 3)
      .sort((a, b) => themeVivid(b) - themeVivid(a)).slice(0, Math.max(n * 3, 30));
    const buckets = [[], [], [], [], [], [], [], []];
    for (const t of ranked) buckets[Math.floor(((t._hue % 360) + 360) % 360 / 45)].push(t);
    const out = [];
    while (out.length < n && buckets.some((b) => b.length)) for (const b of buckets) if (b.length && out.length < n) out.push(b.shift());
    return out;
  }
  function themeShelf(title, list, seeAll) {
    if (!list.length) return "";
    return `<section class="shelf">
      <div class="shelf-head"><h2>${esc(title)}</h2>${seeAll ? `<a href="${seeAll}">See All</a>` : ""}</div>
      <div class="scroller themes-row">${list.map(themeCard).join("")}</div>
    </section>`;
  }

  const THEME_FILTERS = [["featured", "Featured"], ["all", "All"], ["dark", "Dark"], ["light", "Light"], ["builtin", "Built into Omarchy"], ["popular", "Most starred"], ["new", "Recently updated"]];
  const notBuiltinFirst = (l) => [...l.filter((t) => !t.builtin), ...l.filter((t) => t.builtin)];
  function themeList() {
    let l = notBuiltinFirst(S.catalog.themes);
    const f = S.themeFilter, q = S.themeQ.trim().toLowerCase();
    if (f === "featured") { const top = featuredThemes(36); const seen = new Set(top); l = [...top, ...l.filter((t) => !seen.has(t)).sort((a, b) => themeVivid(b) - themeVivid(a))]; }
    if (f === "dark" || f === "light") l = l.filter((t) => t.mode === f);
    if (f === "builtin") l = l.filter((t) => t.builtin);
    if (f === "popular") l = l.filter((t) => t.stars).sort((a, b) => b.stars - a.stars);
    if (f === "new") l = l.filter((t) => t.updated).sort((a, b) => new Date(b.updated) - new Date(a.updated));
    if (f === "installed") l = l.filter(themeHave);
    if (q) l = l.filter((t) => (t.name + " " + t.author + " " + (t.description || "")).toLowerCase().includes(q));
    return l;
  }
  function themeGridHtml() {
    const l = themeList();
    return l.length ? l.map(themeCard).join("") : `<div class="empty" style="grid-column:1/-1">No themes match.</div>`;
  }
  function pageThemes() {
    const all = S.catalog.themes, src = S.catalog.themes_source || {};
    const filters = S.desktop ? [...THEME_FILTERS, ["installed", "On this computer"]] : THEME_FILTERS;
    const pick = all.filter((t) => !t.builtin && t.palette?.length && t.image && t.stars).slice(0, 3);
    return `<div class="page">
      <h1 class="page-title">Themes</h1>
      ${themesBanner(true)}
      <p class="page-sub">${all.length} community themes that recolor your whole Omarchy desktop: terminal, bar, launcher, lock screen and wallpaper. Gathered from <a style="color:var(--accent)" href="https://omarchythemes.com" target="_blank" rel="noopener">omarchythemes.com</a>, the official <a style="color:var(--accent)" href="https://omarchy.org/themes/" target="_blank" rel="noopener">Omarchy.org</a> gallery and <a style="color:var(--accent)" href="https://omarchytheme.com" target="_blank" rel="noopener">omarchytheme.com</a>.</p>
      ${false && pick.length ? `<div class="scroller theme-hero">${pick.map((t) => `<a class="th-card" href="/theme/${t.id}/"><img src="${esc(themeImg(t))}" alt="" loading="eager">
        <div class="th-over"><div class="eyebrow">Most loved</div><h3>${esc(t.name)}</h3><div class="swatch">${swatches(t)}</div></div></a>`).join("")}</div>` : ""}
      <div class="theme-tools">
        <div class="tabs">${filters.map(([id, n]) => `<button data-tfilter="${id}" class="${S.themeFilter === id ? "on" : ""}">${esc(n)}</button>`).join("")}</div>
        <input id="tq" type="search" placeholder="Search themes" value="${esc(S.themeQ)}" autocomplete="off" aria-label="Search themes">
      </div>
      <div class="theme-grid" id="tgrid">${themeGridHtml()}</div>
      <div class="trust">${ico("ok")}<div>Themes only change colors, fonts and wallpapers; they don't install programs or need your password. Installing copies the theme from its GitHub page into <code>~/.config/omarchy/themes</code> and switches to it. Switch back any time from the Omarchy menu: <b>Super + Ctrl + Shift + Space</b>.
        <div style="margin-top:6px">Themes are made by independent creators. Listing data courtesy of <a style="color:var(--accent)" href="${safeUrl(src.url)}" target="_blank" rel="noopener">${esc(src.name)}</a> by <a style="color:var(--accent)" href="${safeUrl(src.by_url)}" target="_blank" rel="noopener">${esc(src.by)}</a>, the <a style="color:var(--accent)" href="https://omarchy.org/themes/" target="_blank" rel="noopener">Omarchy.org theme gallery</a> and <a style="color:var(--accent)" href="https://omarchytheme.com" target="_blank" rel="noopener">omarchytheme.com</a> by limehawk.</div></div></div>
      ${footer()}
    </div>`;
  }

  function pageTheme(id) {
    const t = S.themeById[id];
    if (!t) return notFound();
    const src = S.catalog.themes_source || {};
    const gh = t.repo ? `https://github.com/${t.repo}` : null;
    const more = S.catalog.themes.filter((x) => x.id !== t.id && x.mode === t.mode && x.image && x.palette?.length).slice(0, 12);
    const img = themeImg(t);
    return `<div class="page">
      ${backBtn()}
      <div class="theme-big" style="background:${esc(t.palette?.[0] || "var(--card)")}">${img ? `<img src="${esc(img)}" alt="${esc(t.name)} theme on Omarchy" data-zoom>` : ""}</div>
      <div class="detail-head theme-head">
        <div style="min-width:0">
          <h1>${esc(t.name)}${t.archived ? `<span class="archived">Archived</span>` : ""}</h1>
          <div class="sub">${esc(t.description && t.description.length < 200 ? t.description : (t.mode === "light" ? "A light theme" : "A dark theme") + " for Omarchy")}</div>
          ${t.author ? `<a class="dev" href="/developer/${devSlug(t.author)}/" title="See everything by ${esc(t.author)}">${esc(t.author)}</a>` : `<span class="dev">Unknown creator</span>`}
          <div class="actions">
            ${themeBtn(t, true)}${themeRm(t)}
            ${gh ? `<a class="icon-btn" href="${esc(gh)}" target="_blank" rel="noopener" title="View on GitHub">${ico("github")}</a>` : ""}
            <button class="icon-btn" data-share-theme="${t.id}" title="Share">${ico("share")}</button>
          </div>
        </div>
      </div>
      <div class="strip">
        <div><div class="k">Style</div><div class="v">${t.mode === "light" ? "☀" : t.mode === "dark" ? "☾" : "—"}</div><div class="s">${t.mode ? (t.mode === "light" ? "Light" : "Dark") : "Unknown"}</div></div>
        <div><div class="k">GitHub Stars</div><div class="v">${t.stars != null ? k(t.stars) : "—"}</div><div class="s">${t.builtin ? "Ships with Omarchy" : "Community"}</div></div>
        <div><div class="k">Wallpapers</div><div class="v">${t.backgrounds || "—"}</div><div class="s">Included</div></div>
        <div><div class="k">Restyles</div><div class="v">${t.apps?.length || "—"}</div><div class="s">Apps</div></div>
        <div><div class="k">Updated</div><div class="v" style="font-size:16px">${ago(t.updated)}</div><div class="s">On GitHub</div></div>
        <div><div class="k">Price</div><div class="v">Free</div><div class="s">Open source</div></div>
      </div>
      ${t.gallery?.length ? `<section class="shelf"><div class="shelf-head"><h2>What's inside</h2><span class="muted small">${t.gallery.length} wallpapers · swipe</span></div>
        <div class="scroller wall-row">${t.gallery.map((w, i) => `<figure class="wall-card">
          <img src="${esc(asset(w.src))}" alt="${esc(w.title || "Wallpaper " + (i + 1))} wallpaper from the ${esc(t.name)} theme" loading="lazy" data-zoom>
          <figcaption>${esc(w.title || "Wallpaper " + (i + 1))}</figcaption>
        </figure>`).join("")}</div></section>` : ""}
      ${t.palette?.length ? `<section class="shelf"><div class="shelf-head"><h2>Color palette</h2></div>
        <div class="palette">${t.palette.map((c) => `<button data-copy="${esc(c)}" title="Copy ${esc(c)}"><i style="background:${esc(c)}"></i><span>${esc(c)}</span></button>`).join("")}</div></section>` : ""}
      ${t.apps?.length ? `<section class="shelf"><div class="shelf-head"><h2>What it recolors</h2></div>
        <div class="chips">${t.apps.map((a) => `<span>${esc(a)}</span>`).join("")}</div></section>` : ""}
      <section class="shelf"><div class="shelf-head"><h2>Information</h2></div>
        <div class="info-grid">
          <div><div class="k">Creator</div><div class="v">${esc(t.author || "—")}</div></div>
          ${gh ? `<div><div class="k">Source code</div><a class="v" href="${esc(gh)}" target="_blank" rel="noopener" style="word-break: break-all;">github.com/${esc(t.repo)}</a></div>` : ""}
          <div><div class="k">Listed on</div><a class="v" href="${safeUrl(t.source_url)}" target="_blank" rel="noopener">${esc(themeVia(t, src))}</a></div>
          ${canInstallTheme(t) ? `<div><div class="k">Install command</div><div class="v"><code class="small">${esc(themeCmd(t))}</code></div></div>` : ""}
        </div>
        <div class="trust">${ico("ok")}<div>${t.builtin ? "This theme ships with Omarchy, so nothing is downloaded: the store just switches to it." : "Installing copies this theme from its GitHub page into ~/.config/omarchy/themes and switches to it. Themes change colors and wallpapers only."}
          <div style="margin-top:6px">Theme by ${esc(t.author || "its creator")} · listed via <a style="color:var(--accent)" href="${safeUrl(t.source_url)}" target="_blank" rel="noopener">${esc(themeVia(t, src))}</a>. Third-party content, provided as-is: <a style="color:var(--accent)" href="/legal/">disclaimer</a>.</div></div></div>
      </section>
      ${themeShelf(t.mode === "light" ? "More light themes" : "More dark themes", more, "/themes/")}
      ${footer()}
    </div>`;
  }

  // ---------- Plugins (live from the official Omarchy Plugin Marketplace) ----------
  // plugins.json is refreshed every 30 minutes by a GitHub Action and published to the `data`
  // branch; we read that live copy first, so new plugins appear without rebuilding the store.
  const PLUG_LIVE = "https://raw.githubusercontent.com/omarchy-community/store/data/plugins.json";
  const PLUG_FILTERS = [["popular", "Popular"], ["verified", "Verified"], ["new", "New"], ["all", "All"]];
  const ACCENTS = { violet: "#9d7cf2", lime: "#9ece6a", amber: "#e0af68", coral: "#f7768e", cyan: "#7dcfff", blue: "#7aa2f7", teal: "#2ac3de", pink: "#ff79c6", orange: "#ff9e64", green: "#73daca", red: "#f7768e", yellow: "#e0af68", purple: "#bb9af7", indigo: "#7aa2f7", sky: "#7dcfff", rose: "#ff7a93", mint: "#73daca", slate: "#565f89" };
  let plugLoading = null;
  function loadPlugins() {
    if (S.plugins || plugLoading) return plugLoading;
    const fetchJson = (u) => fetch(u, { cache: "no-cache" }).then((r) => { if (!r.ok) throw 0; return r.json(); });
    plugLoading = (S.desktop ? fetchJson("/api/plugins") : fetchJson(PLUG_LIVE))
      .catch(() => fetchJson("/plugins.json"))
      .then((d) => {
        S.plugins = d; S.plugById = {};
        for (const x of d.plugins || []) S.plugById[x.id] = x;
        if (d.installed) S.plugsHave = new Set(d.installed);
        rerender();
      })
      .catch(() => { S.plugins = { plugins: [], source: {}, categories: [], failed: true }; rerender(); });
    return plugLoading;
  }
  // Our own plugins carry full image URLs; marketplace plugins carry a file name on the marketplace.
  const plugImg = (x, big) => !x.img ? "" : /^https:\/\//.test(x.img) ? (big && x.img_big ? x.img_big : x.img)
    : (S.plugins.source.img_base || "https://plugins.omarchy.org/assets/img/plugins/") + x.img.replace(/\.(\w+)$/, (big ? "-detail" : "-card") + ".$1");
  const plugCmd = (x) => `omarchy plugin add ${x.r}.git --enable`;
  const plugBadge = (x) => x.own ? `<span class="pv ok" title="Made by Omarchy Development Labs">${ico("verified")}Official</span>` : x.ok ? `<span class="pv ok" title="Passed the marketplace's automated security check">${ico("verified")}Verified</span>` : `<span class="pv" title="Not yet checked by the marketplace">Unverified</span>`;
  function plugTile(x) {
    if (x.icon) return `<span class="pl-ini" style="--pc:#7c3aed"><img src="${esc(x.icon)}" alt="" loading="lazy" style="object-fit:cover"></span>`;   // our own plugins: app icon
    const col = ACCENTS[x.ac] || "#7aa2f7";
    const img = x.img ? plugImg(x) : "";
    return `<span class="pl-ini" style="--pc:${col}">${img ? `<img src="${esc(img)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ""}${ico("puzzle")}</span>`;
  }
  function plugBtn(x, big = false, inCard = false) {
    const cls = "get" + (big ? " big" : "");
    // Inside a card (which is itself a link) a nested <a> breaks the layout: use a span, the card opens the plugin page.
    if (!x.i) return inCard ? `<span class="${cls} ghosty">VIEW</span>` : `<a class="${cls} ghosty" href="${safeUrl(x.r || S.plugins.source.url)}" target="_blank" rel="noopener">VIEW</a>`;
    if (S.busy.has("plugin:" + x.id)) return `<button class="${cls} busy"><span class="ring"></span></button>`;
    if (S.desktop && S.plugsHave.has(x.id)) return `<button class="${cls} installed" disabled>ADDED</button>`;
    return `<button class="${cls}" data-plug-get="${esc(x.id)}">GET</button>`;
  }
  function plugCard(x) {
    const img = plugImg(x);
    return `<a class="plug-card" href="/plugin/${encodeURIComponent(x.id)}/">
      <div class="pc-img">${img ? `<img src="${esc(img)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ""}${plugTile(x)}</div>
      <div class="pc-meta"><div style="min-width:0;flex:1"><div class="name">${esc(x.n)}</div>
        <div class="sub">${esc(x.a || "Community")}${x.s ? ` · ★ ${k(x.s)}` : ""}</div>
        <div class="pc-tags">${plugBadge(x)}</div></div>${plugBtn(x, false, true)}</div>
    </a>`;
  }
  function plugList() {
    let l = (S.plugins?.plugins || []).slice();
    const f = S.plugFilter, c = S.plugCat, q = S.plugQ.trim().toLowerCase();
    if (c !== "all") l = l.filter((x) => x.c === c);
    if (f === "popular") l.sort((a, b) => ((b.ok && b.img ? 1 : 0) - (a.ok && a.img ? 1 : 0)) || (b.s - a.s));
    if (f === "verified") l = l.filter((x) => x.ok);
    if (f === "new") l = l.filter((x) => x.add).sort((a, b) => (b.add > a.add ? 1 : b.add < a.add ? -1 : b.s - a.s));
    if (q) l = l.filter((x) => (x.n + " " + x.a + " " + x.d + " " + (x.t || []).join(" ") + " " + x.id).toLowerCase().includes(q));
    // One-click (GET) plugins always come first; VIEW-only ones (no install id) go to the bottom. Stable sort keeps the order within each group.
    l = l.map((x, i) => [x, i]).sort((a, b) => ((b[0].own ? 1 : 0) - (a[0].own ? 1 : 0)) || ((b[0].i ? 1 : 0) - (a[0].i ? 1 : 0)) || (a[1] - b[1])).map(([x]) => x);
    return l;
  }
  function plugGridHtml() {
    const l = plugList(), shown = l.slice(0, S.plugShown);
    return (shown.length ? shown.map(plugCard).join("") : `<div class="empty" style="grid-column:1/-1">No plugins match.</div>`) +
      (l.length > shown.length ? `<div style="grid-column:1/-1;text-align:center;margin-top:8px"><button class="btn ghost" data-plug-more>Show more (${(l.length - shown.length).toLocaleString()} left)</button></div>` : "");
  }
  function pagePlugins() {
    if (!S.plugins) { loadPlugins(); return `<div class="page"><h1 class="page-title">Plugins</h1><div class="empty">Loading the plugin marketplace…</div></div>`; }
    const d = S.plugins, src = d.source || {}, all = d.plugins || [];
    const ok = all.filter((x) => x.ok).length;
    const cats = [{ id: "all", name: "All categories" }, ...(d.categories || [])];
    return `<div class="page">
      <h1 class="page-title">Plugins</h1>
      <p class="page-sub">${all.length.toLocaleString()} community plugins for Omarchy's bar and desktop: widgets, tools, system controls and more. ${ok.toLocaleString()} are Verified. Live from the official <a style="color:var(--accent)" href="${safeUrl(src.url)}" target="_blank" rel="noopener">${esc(src.name || "Omarchy Plugin Marketplace")}</a>, updated every 30 minutes.</p>
      <div class="theme-tools">
        <div class="tabs">${PLUG_FILTERS.map(([id, n]) => `<button data-pfilter="${id}" class="${S.plugFilter === id ? "on" : ""}">${esc(n)}</button>`).join("")}</div>
        <div class="plug-search">
          <select id="pcat" class="sel" aria-label="Plugin category">${cats.map((c) => `<option value="${c.id}" ${S.plugCat === c.id ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select>
          <input id="pq" type="search" placeholder="Search plugins" value="${esc(S.plugQ)}" autocomplete="off" aria-label="Search plugins">
        </div>
      </div>
      <div class="plug-grid" id="pgrid">${plugGridHtml()}</div>
      <div class="trust">${ico("ok")}<div><b>Verified</b> means the plugin passed the marketplace's automated security check for the version listed. It isn't a guarantee: plugins are made by independent developers and run on your computer, so only add ones you trust. Remove any plugin with <code>omarchy plugin remove &lt;id&gt;</code>.
        <div style="margin-top:6px">Plugin listings courtesy of the <a style="color:var(--accent)" href="${safeUrl(src.url)}" target="_blank" rel="noopener">${esc(src.name || "Omarchy Plugin Marketplace")}</a> by <a style="color:var(--accent)" href="${safeUrl(src.by_url)}" target="_blank" rel="noopener">${esc(src.by || "HANCORE")}</a>.</div></div></div>
      ${footer()}
    </div>`;
  }
  function pagePlugin(id) {
    if (!S.plugins) { loadPlugins(); return `<div class="page"><div class="empty">Loading…</div></div>`; }
    const x = S.plugById[decodeURIComponent(id || "")];
    if (!x) return notFound();
    const src = S.plugins.source || {};
    const img = plugImg(x, true);
    const more = (S.plugins.plugins || []).filter((y) => y.c === x.c && y.id !== x.id).slice(0, 12);
    const market = `${src.url || "https://plugins.omarchy.org/"}plugin.html?id=${encodeURIComponent(x.id)}`;
    return `<div class="page">
      ${backBtn()}
      <div class="detail-head">
        <div class="pl-big">${plugTile(x)}</div>
        <div style="min-width:0">
          <h1>${esc(x.n)}</h1>
          <div class="sub">${esc(x.d || "A plugin for Omarchy")}</div>
          ${x.r ? `<a class="dev" href="${safeUrl(x.r)}" target="_blank" rel="noopener">${esc(x.a || "Community")}</a>` : `<span class="dev">${esc(x.a || "Community")}</span>`}
          <div class="actions">${plugBtn(x, true)}${plugRm(x)}
            ${x.r ? `<a class="icon-btn" href="${safeUrl(x.r)}" target="_blank" rel="noopener" title="Source code on GitHub">${ico("github")}</a>` : ""}
            <button class="icon-btn" data-copy="${esc(SITE + "plugin/" + encodeURIComponent(x.id) + "/")}" title="Copy link">${ico("share")}</button></div>
        </div>
      </div>
      <div class="strip">
        <div><div class="k">Status</div><div class="v" style="font-size:16px">${plugBadge(x)}</div><div class="s">Marketplace check</div></div>
        <div><div class="k">GitHub Stars</div><div class="v">${k(x.s)}</div><div class="s">Popularity</div></div>
        <div><div class="k">Category</div><div class="v" style="font-size:16px">${esc((S.plugins.categories || []).find((c) => c.id === x.c)?.name || "Other")}</div><div class="s">Plugin</div></div>
        <div><div class="k">Version</div><div class="v" style="font-size:16px">${esc(x.v || "—")}</div><div class="s">Listed</div></div>
        <div><div class="k">Updated</div><div class="v" style="font-size:16px">${x.u ? ago(x.u) : "—"}</div><div class="s">On GitHub</div></div>
        <div><div class="k">Price</div><div class="v">Free</div><div class="s">${esc(x.l || "Open source")}</div></div>
      </div>
      ${img ? `<section class="shelf"><div class="shelf-head"><h2>Preview</h2></div><div class="pl-shot"><img src="${esc(img)}" alt="${esc(x.n)} preview" loading="lazy" referrerpolicy="no-referrer" data-zoom onerror="this.closest('.shelf').remove()"></div></section>` : ""}
      <section class="shelf"><div class="shelf-head"><h2>How to add it</h2></div>
        ${x.i ? `<p class="muted small">${S.desktop ? "Click GET, or paste" : "Paste"} this into a terminal (<b>Super + Return</b>):</p>
          <div class="code"><code>${esc(plugCmd(x))}</code><button class="btn" data-copy="${esc(plugCmd(x))}">Copy</button></div>
          <p class="muted small">Remove it any time: <code>omarchy plugin remove ${esc(x.id)}</code></p>`
        : `<p>${esc(x.note || "This one needs manual setup.")} Follow the instructions on <a style="color:var(--accent)" href="${safeUrl(x.r || market)}" target="_blank" rel="noopener">its GitHub page</a>.</p>`}
        ${x.t?.length ? `<div class="chips" style="margin-top:12px">${x.t.map((t) => `<span>${esc(t)}</span>`).join("")}</div>` : ""}
        <div class="trust">${ico("ok")}<div>${x.own ? "Official: made by Omarchy Development Labs and checked by the Omarchy Store. Open source (MIT), so anyone can read the code." : x.ok ? "Verified: this plugin passed the Omarchy Plugin Marketplace's automated security check for the version listed." : "Unverified: the marketplace hasn't checked this plugin's code yet. That doesn't mean it's unsafe, but review it before adding."} Plugins run on your computer with your permissions, so only add ones you trust.
          ${x.own ? `<div style="margin-top:6px">Made by Omarchy Development Labs · <a style="color:var(--accent)" href="${safeUrl(x.r)}" target="_blank" rel="noopener">source on GitHub</a>.</div>` : `<div style="margin-top:6px">Plugin by ${esc(x.a || "its creator")} · listed on the <a style="color:var(--accent)" href="${safeUrl(market)}" target="_blank" rel="noopener">${esc(src.name || "Omarchy Plugin Marketplace")}</a>. Third-party code, provided as-is: <a style="color:var(--accent)" href="/legal/">disclaimer</a>.`}</div></div></div>
      </section>
      ${more.length ? `<section class="shelf"><div class="shelf-head"><h2>More like this</h2><a href="/plugins/">See All</a></div><div class="scroller plug-row">${more.map(plugCard).join("")}</div></section>` : ""}
      ${footer()}
    </div>`;
  }
  // ---------- Screensavers (one-click marketplace plugins + other GitHub projects) ----------
  // screensavers.json is rebuilt with plugins.json every 30 minutes (data branch). Plugin entries
  // are ids into the plugin list (same GET flow); GitHub projects are listed and linked, never hosted.
  const SAVER_LIVE = "https://raw.githubusercontent.com/omarchy-community/store/data/screensavers.json";
  const SAVER_FILTERS = [["all", "All"], ["saver", "Screensavers"], ["tool", "Controls & timing"], ["one", "One-click"]];
  let saverLoading = null;
  function loadSavers() {
    if (S.savers || saverLoading) return saverLoading;
    const fj = (u) => fetch(u, { cache: "no-cache" }).then((r) => { if (!r.ok) throw 0; return r.json(); });
    saverLoading = fj(SAVER_LIVE).catch(() => fj(S.desktop ? "https://omarchystore.com/screensavers.json" : "/screensavers.json"))
      .then((d) => { S.savers = d; rerender(); })
      .catch(() => { S.savers = { count: 0, plugins: [], repos: [], failed: true }; rerender(); });
    return saverLoading;
  }
  function saverCard(x) {
    const img = x.img || "";
    return `<a class="plug-card" href="https://github.com/${esc(x.id)}" target="_blank" rel="noopener">
      <div class="pc-img">${img ? `<img src="${esc(img)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ""}<span class="pl-ini" style="--pc:#565f89">${x.av ? `<img src="${esc(x.av)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ""}${ico("moon")}</span></div>
      <div class="pc-meta"><div style="min-width:0;flex:1"><div class="name">${esc(x.n)}</div>
        <div class="sub">${esc(x.a)}${x.s ? ` · ★ ${k(x.s)}` : ""}</div>
        <div class="pc-tags"><span class="pv" title="Listed from GitHub: install by following the project's instructions">GitHub</span></div></div><span class="get ghosty">VIEW</span></div>
    </a>`;
  }
  function saverList() {
    const d = S.savers || {}, f = S.saverF, q = S.saverQ.trim().toLowerCase();
    // Anything with a GET button (one-click install) comes first; VIEW-only ones go to the bottom.
    let l = (d.plugins || []).map((p) => ({ p: S.plugById[p.id], k: p.k })).filter((x) => x.p)
      .sort((a, b) => ((b.p.own ? 1 : 0) - (a.p.own ? 1 : 0)) || ((b.p.i ? 1 : 0) - (a.p.i ? 1 : 0)) || ((b.p.ok && b.p.img ? 1 : 0) - (a.p.ok && a.p.img ? 1 : 0)) || (b.p.s - a.p.s));
    if (f !== "one") l = l.concat((d.repos || []).map((r) => ({ r, k: r.k })));
    if (f === "saver" || f === "tool") l = l.filter((x) => x.k === f);
    if (q) l = l.filter((x) => { const o = x.p || x.r; return (o.n + " " + o.a + " " + o.d + " " + o.id).toLowerCase().includes(q); });
    return l;
  }
  function saverGridHtml() {
    const l = saverList(), shown = l.slice(0, S.saverShown);
    return (shown.length ? shown.map((x) => x.p ? plugCard(x.p) : saverCard(x.r)).join("") : `<div class="empty" style="grid-column:1/-1">No screensavers match.</div>`) +
      (l.length > shown.length ? `<div style="grid-column:1/-1;text-align:center;margin-top:8px"><button class="btn ghost" data-saver-more>Show more (${(l.length - shown.length).toLocaleString()} left)</button></div>` : "");
  }
  function pageScreensavers() {
    if (!S.plugins) loadPlugins();
    if (!S.savers) loadSavers();
    if (!S.savers || !S.plugins) return `<div class="page"><h1 class="page-title">Screensavers</h1><div class="empty">Loading screensavers…</div></div>`;
    const d = S.savers, one = (d.plugins || []).filter((p) => S.plugById[p.id]).length, gh = (d.repos || []).length;
    return `<div class="page">
      <h1 class="page-title">Screensavers</h1>
      <p class="page-sub">${(one + gh).toLocaleString()} screensavers for Omarchy, plus tools to control when they start. ${one} install in one click from the Omarchy Plugin Marketplace; ${gh} more are community projects on GitHub (VIEW opens the project with its install steps). Updated automatically.</p>
      <div class="theme-tools">
        <div class="tabs">${SAVER_FILTERS.map(([id, n]) => `<button data-sfilter="${id}" class="${S.saverF === id ? "on" : ""}">${esc(n)}</button>`).join("")}</div>
        <div class="plug-search"><input id="sq" type="search" placeholder="Search screensavers" value="${esc(S.saverQ)}" autocomplete="off" aria-label="Search screensavers"></div>
      </div>
      <div class="plug-grid" id="sgrid">${saverGridHtml()}</div>
      <div class="trust">${ico("ok")}<div><b>Try it:</b> Omarchy's screensaver starts on its own after you've been idle a while, or open it any time from <b>Omarchy menu › Style › Screensaver</b>.
        <div style="margin-top:6px">Screensavers are made by independent developers and run on your computer, so only add ones you trust. One-click ones come from the <a style="color:var(--accent)" href="https://plugins.omarchy.org/" target="_blank" rel="noopener">Omarchy Plugin Marketplace</a> (Verified = passed its automated security check); GitHub projects are listed as found and aren't checked by us.</div></div></div>
      ${footer()}
    </div>`;
  }
  function saverShelf() {
    if (!S.savers) { loadSavers(); return ""; }
    if (!S.plugins) return "";
    // Plugin objects carry their own "r" (repo) field, so tag each entry explicitly instead of guessing by shape.
    // Discover shows only one-click (GET) screensavers; VIEW-only ones stay on the Screensavers page.
    const l = (S.savers.plugins || []).filter((p) => p.k === "saver").map((p) => S.plugById[p.id]).filter((x) => x && x.img && x.i)
      .sort((a, b) => (b.own ? 1 : 0) - (a.own ? 1 : 0)).slice(0, 12).map((p) => ({ p }));   // our own screensaver first
    if (!l.length) return "";
    return `<section class="shelf"><div class="shelf-head"><h2>Screensavers</h2><a href="/screensavers/">See All ${S.savers.count}</a></div>
      <div class="scroller plug-row">${l.map((x) => x.repo ? saverCard(x.repo) : plugCard(x.p)).join("")}</div></section>`;
  }
  // ---------- Crypto wallets (browser extensions, linked to their official Chrome Web Store page) ----------
  // Web: GET opens the official Chrome Web Store listing in a new tab. Desktop app: GET opens that listing in
  // the user's Chromium, so all that's left is "Add to Chrome"; the helper then sees the extension and shows OPEN.
  const CWS = "https://chromewebstore.google.com/detail/";
  const wallets = () => S.catalog?.crypto?.wallets || [];
  const depins = () => S.catalog?.crypto?.depin || [];
  const walletById = (id) => wallets().find((w) => w.id === id) || depins().find((d) => d.id === id);
  const cwsUrl = (w) => CWS + (/^[a-p]{32}$/.test(w.chrome_store_id) ? w.chrome_store_id : "");
  const walletImg = (w, size) => `<img class="icon" src="${esc(asset(w.icon))}" alt="" width="${size}" height="${size}" loading="lazy" referrerpolicy="no-referrer">`;
  const CHAIN_ORDER = ["Solana", "Ethereum", "Bitcoin", "Base", "XRP", "Cosmos", "Polygon", "Arbitrum", "BNB Chain", "Optimism", "Stacks", "Sui"];
  function walletChains() {
    const n = {}; wallets().forEach((w) => w.chains.forEach((c) => { n[c] = (n[c] || 0) + 1; }));
    return Object.keys(n).sort((a, b) => ((CHAIN_ORDER.indexOf(a) + 1 || 99) - (CHAIN_ORDER.indexOf(b) + 1 || 99)) || n[b] - n[a]);
  }
  function walletBtn(w, big = false) {
    const cls = "get" + (big ? " big" : "");
    if (S.cryptoBusy.has(w.id)) return `<button class="${cls} busy" data-crypto-get="${esc(w.id)}"><span class="ring"></span></button>`;
    if (S.desktop && S.cryptoHave.has(w.id)) return `<button class="${cls} installed" data-crypto-get="${esc(w.id)}" title="Installed in your browser. Opens its Chrome Web Store page">OPEN</button>`;
    return `<button class="${cls}" data-crypto-get="${esc(w.id)}" title="${S.desktop ? "Opens in Chromium: press Add to Chrome" : "Opens the official Chrome Web Store page"}">GET</button>`;
  }
  const chainLine = (w) => w.chains.slice(0, 3).join(" · ") + (w.chains.length > 3 ? ` +${w.chains.length - 3}` : "");
  function walletCard(w) {
    const img = asset(w.icon);
    const isDepin = w.type === "depin";
    return `<a class="crypto-card" href="/crypto/${esc(w.id)}/">
      <div class="cc-img">${img ? `<img src="${esc(img)}" alt="${esc(w.name)} icon" loading="lazy">` : ""}
        ${isDepin ? `<span class="cc-chip depin">Earn Crypto</span>` : ""}${S.desktop && S.cryptoHave.has(w.id) ? `<span class="cc-chip on">Installed</span>` : ""}</div>
      <div class="cc-meta">
        <div class="meta"><div class="name">${esc(w.name)}</div><div class="sub">${esc(w.summary)}</div>
          ${isDepin ? `<div class="cc-chains"><span class="cc-type">${esc(w.category || "DePIN")}</span></div>` : w.chains?.length ? `<div class="cc-chains">${w.chains.slice(0, 3).map((c) => `<span>${esc(c)}</span>`).join("")}${w.chains.length > 3 ? `<span>+${w.chains.length - 3}</span>` : ""}</div>` : ""}</div>
        ${walletBtn(w)}
      </div>
    </a>`;
  }
  // Same row format as Top Charts: logo, name, what it is, GET.
  function walletLockup(w) {
    const img = asset(w.icon), isDepin = w.type === "depin";
    const line = isDepin ? (w.category || "Earn Crypto") : (w.chains?.length ? chainLine(w) : "Browser wallet");
    return `<a class="lockup wallet-lockup" href="/crypto/${esc(w.id)}/">
      ${img ? `<img class="icon" src="${esc(img)}" alt="${esc(w.name)} logo" width="64" height="64" loading="lazy">` : `<span class="icon mono" style="width:64px;height:64px;background:#414868"></span>`}
      <div class="meta">
        <div class="name">${esc(w.name)}</div>
        <div class="sub">${esc(w.summary)}</div>
        <div class="stars">${esc(line)}${S.desktop && S.cryptoHave.has(w.id) ? ` · <span class="wl-on">Installed</span>` : ""}</div>
      </div>
      ${walletBtn(w)}
    </a>`;
  }
  let cryptoLoaded = 0;
  async function loadCryptoInstalled(force) {
    if (!S.desktop || (!force && Date.now() - cryptoLoaded < 4000)) return;
    cryptoLoaded = Date.now();
    try {
      const r = await fetch("/api/crypto/installed", { cache: "no-store" });
      if (!r.ok) return;
      const have = new Set((await r.json()).installed || []);
      const changed = have.size !== S.cryptoHave.size || [...have].some((x) => !S.cryptoHave.has(x));
      S.cryptoHave = have;
      if (changed) rerender();
    } catch {}
  }
  async function cryptoGet(w) {
    trackEvent("get", "crypto:" + w.id);
    if (!S.desktop) { window.open(cwsUrl(w), "_blank", "noopener"); return; }
    S.cryptoBusy.add(w.id); rerender();
    try {
      const r = await post("/api/crypto/install", { id: w.id });
      if (r.status === 404 && !(await r.clone().json().catch(() => ({}))).error?.includes("wallet")) { window.open(cwsUrl(w), "_blank", "noopener"); throw new Error("update the store app for one-click installs"); }
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
      if (S.cryptoHave.has(w.id)) { toast(`Opening ${w.name} in your browser`); return; }
      toast(`${w.name} opened in Chromium: press “Add to Chrome”`);
      S.cryptoBusy.delete(w.id); rerender();
      // Watch for the extension to appear in the browser profile (up to 5 minutes).
      const t0 = Date.now();
      while (Date.now() - t0 < 300e3 && !S.cryptoHave.has(w.id)) {
        await new Promise((res) => setTimeout(res, 3000));
        await loadCryptoInstalled(true);
      }
      if (S.cryptoHave.has(w.id)) toast(`${w.name} is installed. Find it under the puzzle icon in Chromium`);
    } catch (e) { toast("Couldn't open the browser: " + e.message); }
    finally { S.cryptoBusy.delete(w.id); rerender(); }
  }
  function cryptoList() {
    const c = S.cryptoChain, q = S.cryptoQ.trim().toLowerCase();
    let l = wallets();
    if (c !== "all") l = l.filter((w) => w.chains.includes(c));
    if (q) l = l.filter((w) => (w.name + " " + w.chains.join(" ") + " " + w.summary + " " + w.description).toLowerCase().includes(q));
    return l;
  }
  function depinList() {
    const q = S.cryptoQ.trim().toLowerCase();
    let l = depins();
    if (q) l = l.filter((w) => (w.name + " " + (w.category || "") + " " + w.summary + " " + w.description).toLowerCase().includes(q));
    return l;
  }
  function cryptoGridHtml() {
    const l = cryptoList();
    return l.length ? l.map(walletLockup).join("") : `<div class="empty" style="grid-column:1/-1">No wallets match.</div>`;
  }
  function depinGridHtml() {
    const l = depinList();
    return l.length ? l.map(walletLockup).join("") : "";
  }
  const cryptoSafety = () => `<div class="trust warn crypto-safety">${ico("shield")}<div><b>Keep your crypto safe.</b> ${esc(S.catalog.crypto?.safety || "")}
    <div style="margin-top:6px">Wallets are made by independent companies; the Omarchy Store isn't affiliated with any of them and never holds your coins. <a style="color:var(--accent)" href="/legal/">Disclaimer</a>.</div></div></div>`;
  function cryptoHero() {
    const icons = wallets().slice(0, 9);
    return `<div class="crypto-hero">
      <div class="ch-copy">
        <div class="spot-badge">${ico("wallet")}Crypto Wallets</div>
        <h2>Crypto Wallets</h2>
        <p>Phantom, MetaMask and more — straight into your browser.</p>
        <div class="ch-sub">${wallets().length} trusted wallet extensions · ${S.desktop ? "one click into Chromium" : "official Chrome Web Store links"}</div>
      </div>
      <div class="ch-icons" aria-hidden="true">${icons.map((w, i) => `<img src="${esc(asset(w.icon))}" alt="" style="--i:${i}">`).join("")}</div>
    </div>`;
  }
  function pageCrypto() {
    loadCryptoInstalled();
    const chains = walletChains();
    const showDepins = depins().length > 0 && S.cryptoChain === "all";
    return `<div class="page">
      <h1 class="page-title">Crypto</h1>
      ${cryptoHero()}
      <p class="page-sub">Browser wallets let you hold coins, tokens and NFTs and use crypto websites. ${S.desktop
        ? "Press GET and the wallet's official Chrome Web Store page opens in Chromium: just click <b>Add to Chrome</b>."
        : "GET opens the wallet's official Chrome Web Store page. They work in Chromium (Omarchy's browser), Chrome and Brave."}</p>
      <div class="theme-tools">
        <div class="tabs">${[["all", "All"], ...chains.map((c) => [c, c])].map(([id, n]) => `<button data-cchain="${esc(id)}" class="${S.cryptoChain === id ? "on" : ""}">${esc(n)}</button>`).join("")}</div>
        <div class="plug-search"><input id="cq" type="search" placeholder="Search wallets" value="${esc(S.cryptoQ)}" autocomplete="off" aria-label="Search wallets"></div>
      </div>
      <section class="shelf"><div class="shelf-head"><h2>Wallets</h2></div>
        <div class="grid wallet-grid" id="cgrid">${cryptoGridHtml()}</div>
      </section>
      ${showDepins && depinList().length ? `<section class="shelf"><div class="shelf-head"><h2>Earn Crypto</h2></div>
        <p class="page-sub" style="margin-top:-8px;margin-bottom:18px">DePIN extensions let you earn crypto by sharing bandwidth, compute, or other resources. They run in your browser while you're online.</p>
        <div class="grid wallet-grid" id="dgrid">${depinGridHtml()}</div>
      </section>` : ""}
      ${cryptoSafety()}
      ${footer()}
    </div>`;
  }
  function pageWallet(id) {
    const w = walletById(id);
    if (!w) return notFound();
    loadCryptoInstalled();
    const host = (u) => { try { return new URL(u).host.replace(/^www\./, ""); } catch { return u; } };
    const more = wallets().filter((x) => x.id !== w.id && x.chains.some((c) => w.chains.includes(c))).slice(0, 9);
    return `<div class="page">
      ${backBtn()}
      <div class="detail-head">
        ${walletImg(w, 80)}
        <div style="min-width:0">
          <h1>${esc(w.name)}</h1>
          <div class="sub">${esc(w.summary)}</div>
          <a class="dev" href="${safeUrl(w.website)}" target="_blank" rel="noopener">${esc(host(w.website))}</a>
          <div class="actions">
            ${walletBtn(w, true)}
            <a class="icon-btn" href="${safeUrl(w.website)}" target="_blank" rel="noopener" title="Official website">${ico("globe")}</a>
            <button class="icon-btn" data-copy="${esc(SITE + "crypto/" + w.id + "/")}" title="Copy link">${ico("share")}</button>
          </div>
        </div>
      </div>
      <div class="strip">
        <div><div class="k">Price</div><div class="v">Free</div><div class="s">Extension</div></div>
        <div><div class="k">Networks</div><div class="v">${w.chains.length}</div><div class="s">${esc(w.chains[0])}${w.chains.length > 1 ? " +" + (w.chains.length - 1) : ""}</div></div>
        <div><div class="k">Works in</div><div class="v" style="font-size:16px">Chromium</div><div class="s">Chrome · Brave</div></div>
        <div><div class="k">Install</div><div class="v" style="font-size:16px">${S.desktop ? "1 click" : "Web Store"}</div><div class="s">Official listing</div></div>
        <div><div class="k">Your keys</div><div class="v" style="font-size:16px">Yours</div><div class="s">Self-custody</div></div>
        <div><div class="k">Firefox</div><div class="v" style="font-size:16px">${w.firefox_url ? "Yes" : "—"}</div><div class="s">${w.firefox_url ? "Add-on too" : "Chromium only"}</div></div>
      </div>
      <section class="shelf"><div class="desc">${esc(w.description)}</div></section>
      <section class="shelf"><div class="shelf-head"><h2>Networks</h2></div>
        <div class="chips">${w.chains.map((c) => `<span>${esc(c)}</span>`).join("")}</div></section>
      <section class="shelf"><div class="shelf-head"><h2>How to install</h2></div>
        <ol class="wl-steps">
          <li>Press <b>GET</b>. ${S.desktop ? "The official Chrome Web Store page opens in Chromium." : "The official Chrome Web Store page opens in a new tab (use Chromium, Chrome or Brave)."}</li>
          <li>Click <b>Add to Chrome</b>, then <b>Add extension</b>.</li>
          <li>Open it from the puzzle-piece icon next to the address bar, and pin it. Create a new wallet or import yours.</li>
        </ol>
        ${cryptoSafety()}</section>
      <section class="shelf"><div class="shelf-head"><h2>Information</h2></div>
        <div class="info-grid">
          <div><div class="k">Official website</div><a class="v" href="${safeUrl(w.website)}" target="_blank" rel="noopener">${esc(host(w.website))}</a></div>
          <div><div class="k">Chrome Web Store</div><a class="v" href="${esc(cwsUrl(w))}" target="_blank" rel="noopener">Official listing</a></div>
          ${w.firefox_url ? `<div><div class="k">Firefox</div><a class="v" href="${safeUrl(w.firefox_url)}" target="_blank" rel="noopener">Firefox Add-ons</a></div>` : ""}
          <div><div class="k">Extension ID</div><div class="v"><code class="small" style="word-break: break-all;">${esc(w.chrome_store_id)}</code></div></div>
        </div></section>
      ${more.length ? `<section class="shelf"><div class="shelf-head"><h2>More wallets</h2><a href="/crypto/">See All</a></div>
        <div class="scroller rows3">${more.map(walletLockup).join("")}</div></section>` : ""}
      ${footer()}
    </div>`;
  }
  function cryptoShelf() {
    if (!wallets().length) return "";
    loadCryptoInstalled();
    return `<section class="shelf"><div class="shelf-head"><h2>Crypto Wallets</h2><a href="/crypto/">See All</a></div>
      <div class="scroller rows3">${wallets().slice(0, 12).map(walletLockup).join("")}</div></section>`;
  }
  function plugShelf() {
    if (!S.plugins) { loadPlugins(); return ""; }
    const l = (S.plugins.plugins || []).filter((x) => x.ok && x.img && x.i && !x.own).slice(0, 14);   // our screensaver has its own shelf   // Discover: one-click (GET) plugins only
    if (!l.length) return "";
    return `<section class="shelf"><div class="shelf-head"><h2>Plugins: supercharge your bar</h2><a href="/plugins/">See All ${(S.plugins.plugins.length).toLocaleString()}</a></div>
      <div class="scroller plug-row">${l.map(plugCard).join("")}</div></section>`;
  }
  async function desktopPlugin(x) {
    const key = "plugin:" + x.id;
    S.busy.add(key); rerender();
    try {
      const r = await post("/api/plugin/add", { id: x.id });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
      toast(`Adding ${x.n}… follow the terminal window`);
      const t0 = Date.now();
      while (Date.now() - t0 < 5 * 60e3) {
        await new Promise((res) => setTimeout(res, 2500));
        const st = await (await fetch("/api/plugins/installed", { cache: "no-store" })).json().catch(() => ({}));
        S.plugsHave = new Set(st.installed || []);
        if (S.plugsHave.has(x.id)) { toast(`${x.n} added`); break; }
      }
    } catch (e) { toast("Plugin failed: " + e.message); }
    S.busy.delete(key); rerender();
  }
  function webPluginGet(x) {
    const cmd = plugCmd(x);
    showSheet(`<div class="sheet-card" role="dialog" aria-label="Get ${esc(x.n)}">
      <div class="row">${plugTile(x)}<div><h3>Add ${esc(x.n)}</h3><div class="muted small">${x.ok ? "Verified by the Omarchy Plugin Marketplace" : "Unverified: review the code first"}</div></div></div>
      <div class="small muted">Paste this into a terminal (<b>Super + Return</b>):</div>
      <div class="code"><code>${esc(cmd)}</code><button class="btn" data-copy="${esc(cmd)}">Copy</button></div>
      <div class="small muted">Want one-click plugins? <a style="color:var(--accent)" href="/get-desktop/" data-close>Get the desktop app</a>.</div>
      <div style="text-align:right;margin-top:16px"><button class="btn ghost" data-close>Done</button></div>
    </div>`);
  }

  function webThemeGet(t) {
    const cmd = themeCmd(t);
    showSheet(`<div class="sheet-card" role="dialog" aria-label="Get ${esc(t.name)}">
      <div class="row"><div class="swatch big">${swatches(t, 6)}</div><div><h3>Get ${esc(t.name)}</h3><div class="muted small">${t.builtin ? "Built into Omarchy" : "From github.com/" + esc(t.repo)}</div></div></div>
      <div class="small muted">Paste this into a terminal (<b>Super + Return</b>). It installs the theme and switches to it:</div>
      <div class="code"><code>${esc(cmd)}</code><button class="btn" data-copy="${esc(cmd)}">Copy</button></div>
      <div class="small muted">Want one-click themes? <a style="color:var(--accent)" href="/get-desktop/" data-close>Get the desktop app</a>.</div>
      <div style="text-align:right;margin-top:16px"><button class="btn ghost" data-close>Done</button></div>
    </div>`);
  }

  async function desktopTheme(t, path) {
    const key = "theme:" + t.id;
    S.busy.add(key); rerender();
    try {
      const r = await post(path, { id: t.id });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
      toast(path.endsWith("use") ? `Switching to ${t.name}…` : `Installing ${t.name}… follow the terminal window`);
      const t0 = Date.now();
      while (Date.now() - t0 < 5 * 60e3) {
        await new Promise((res) => setTimeout(res, 2000));
        const st = await (await fetch("/api/status", { cache: "no-store" })).json();
        S.themesHave = new Set(st.themes_installed || []); S.themeNow = st.theme_current || "";
        if (S.themeNow === t.install_name) { if (st.theme) applyTheme(st.theme); toast(`${t.name} is now your theme`); break; }
      }
    } catch (e) { toast("Theme failed: " + e.message); }
    S.busy.delete(key); rerender();
  }


  // ---------- Featured App + App of the Week: picked automatically from downloads ----------
  // Downloads = different people who installed with the desktop app or copied the install command on the
  // website (counted by the store's backend, no personal data). Featured App = most downloaded in the last
  // 2 days; App of the Week = most downloaded last week (changes every Monday). With no downloads yet, both
  // rotate through well-loved apps (daily / weekly) so Discover never looks frozen.
  S.trending = null;
  let trendLoading = false;
  function loadTrending() {
    if (S.trending || trendLoading) return;
    trendLoading = true;
    fetch(`${API}/trending`).then((r) => r.json()).then((d) => { S.trending = d; if (!currentPath()) rerender(); })
      .catch(() => { S.trending = { failed: true }; });
  }
  const HERO_GRADS = [["#2aabee", "#0b3d63"], ["#f5792a", "#6b2d0f"], ["#1f2335", "#7aa2f7"], ["#2b1a4a", "#bb9af7"], ["#0e0e14", "#449dab"], ["#14532d", "#9ece6a"], ["#4a1d2f", "#f7768e"], ["#3b2f0b", "#e0af68"]];
  const strHash = (x) => [...String(x)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
  function autoHero(hero) {
    loadTrending();
    const T = S.trending || {}, used = new Set(S.catalog.apps.filter((a) => a.featured).map((a) => a.id));
    const ok = (id) => { const a = S.byId[id]; return a && !used.has(id) && a.available !== false; };
    const top = (list) => (list || []).find((x) => ok(x.id));
    // Fallback pool: the editors' picks + Essentials + the 40 most-starred apps.
    const pool = [...new Set([...hero.map((h) => h.app), ...(S.catalog.featured.collections[0]?.apps || []), ...S.catalog.apps.slice(0, 40).map((a) => a.id)])];
    const week = Math.floor((Date.now() / 864e5 + 3) / 7), dayN = Math.floor(Date.now() / 864e5);
    const rot = (n, salt) => { const l = pool.filter(ok); return l[(n + salt) % l.length]; };
    const card = (id, eyebrow, why) => {
      used.add(id);
      const a = S.byId[id], ed = hero.find((h) => h.app === id);
      return { app: id, eyebrow, why, headline: ed?.headline || a.summary, gradient: ed?.gradient || HERO_GRADS[strHash(id) % HERO_GRADS.length] };
    };
    const n = (x) => `${x.n} download${x.n === 1 ? "" : "s"}`;
    // Week first: it's the steadier pick, the Featured App must then be a different app.
    const w = top(T.last_week) || top(T.this_week);
    const weekCard = w ? card(w.id, "APP OF THE WEEK", `#1 last week · ${n(w)}`) : card(rot(week, 0), "APP OF THE WEEK", "");
    const f = top(T.last_2_days);
    const featCard = f ? card(f.id, "FEATURED APP", `Trending · ${n(f)} in 2 days`) : card(rot(dayN, 17), "FEATURED APP", "");
    const rest = hero.filter((h) => !/FEATURED APP|APP OF THE WEEK/.test(h.eyebrow) && !used.has(h.app));
    return [featCard, weekCard, ...rest];
  }

  // ---------- pages ----------
  function pageDiscover() {
    const { hero, collections } = S.catalog.featured;
    const apps = S.catalog.apps;
    const fresh = [...apps].filter((a) => a.released_at).sort((x, y) => new Date(y.released_at) - new Date(x.released_at)).slice(0, 12);
    const games = apps.filter((a) => a.category === "games");
    // Featured billboards in the order set in each app's "featured.order" (1 = first: SnapDock), then Get Omarchy.
    const spots = apps.filter((a) => a.featured).sort((x, y) => (x.featured.order || 99) - (y.featured.order || 99));
    const dots = [...spots.map((a) => a.name), "Get Omarchy"];
    return `<div class="page">
      <h1 class="page-title">Discover</h1>
      <div class="spot-row">${spots.map(spotlight).join("")}${igniteBanner()}</div>
      <div class="spot-dots">${dots.map((n, i) => `<i class="${i ? "" : "on"}" data-spot="${i}" role="button" aria-label="${esc(n)}"></i>`).join("")}</div>
      <div class="scroller hero">${autoHero(hero).map((h) => {
        const a = S.byId[h.app];
        const [g1, g2] = h.gradient;
        const shot = a.screenshots[0];
        return `<a class="hero-card" href="/app/${a.id}/" style="background:linear-gradient(135deg,${g1},${g2})">
          <div class="shot">${shot ? `<img src="${esc(shot)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<img class="glyph" src="${esc(asset(a.icon))}" alt="">`}</div>
          <div><div class="eyebrow">${esc(h.eyebrow)}${h.why ? ` <span class="why">· ${esc(h.why)}</span>` : ""}</div><h3>${esc(h.headline)}</h3></div>
          <div class="lockup">${iconImg(a, 48)}<div class="meta"><div class="name">${esc(a.name)}</div><div class="sub">${esc(a.summary)}</div></div>${getBtn(a)}</div>
        </a>`;
      }).join("")}</div>
      ${shelf(collections[0].title, collections[0].apps.map((id) => S.byId[id]))}
      ${bannerAd()}
      ${plugShelf()}
      ${saverShelf()}
      ${themeShelf("Make it yours: Themes", featuredThemes(14), "/themes/")}
      <section class="shelf">
        <div class="shelf-head"><h2>Top Charts</h2><a href="/charts/">See All</a></div>
        <div class="scroller rows3">${apps.slice(0, 12).map((a, i) => lockup(a, { rank: i + 1 })).join("")}</div>
      </section>
      ${cryptoShelf()}
      ${collections.slice(1).map((c) => shelf(c.title, c.apps.map((id) => S.byId[id]))).join("")}
      ${shelf("Fresh Updates", fresh)}
      ${shelf("Games", games, "/category/games/")}
      ${shelf("Terminal power tools", apps.filter((a) => a.category === "terminal"), "/category/terminal/")}
      ${footer()}
    </div>`;
  }

  // ---------- Featured spotlight (billboard on Discover) ----------
  const FICON = {
    dock: '<rect x="3" y="15" width="18" height="5" rx="2.5"/><rect x="5" y="4" width="14" height="8" rx="2"/>',
    grid: '<rect x="3" y="3" width="8" height="18" rx="2"/><rect x="13" y="3" width="8" height="8" rx="2"/><rect x="13" y="13" width="8" height="8" rx="2"/>',
    window: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M15 6.5h.01M18 6.5h.01"/>',
    minimize: '<rect x="3" y="3" width="18" height="12" rx="2"/><path d="M8 20h8M12 11v6M9.5 14.5 12 17l2.5-2.5"/>',
    desktops: '<rect x="2" y="4" width="9" height="7" rx="1.5"/><rect x="13" y="4" width="9" height="7" rx="1.5"/><rect x="2" y="13" width="9" height="7" rx="1.5"/><rect x="13" y="13" width="9" height="7" rx="1.5"/><path d="M6.5 7.5h0"/>',
    language: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
    camera: '<path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13" r="3.5"/>',
    backup: '<path d="M12 3v10m0 0-4-4m4 4 4-4"/><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
    drag: '<rect x="3" y="4" width="18" height="16" rx="2"/><rect x="3" y="4" width="9" height="16" rx="2" fill="currentColor" opacity=".35"/><path d="M15 12h4m-2-2 2 2-2 2"/>',
    assist: '<rect x="3" y="4" width="8" height="16" rx="2"/><rect x="13" y="4" width="8" height="7" rx="1.5"/><rect x="13" y="13" width="8" height="7" rx="1.5" stroke-dasharray="2 2"/>',
    pin: '<path d="M9 4h6l-1 5 3 3H7l3-3zM12 12v8"/>',
    resize: '<path d="M4 9V4h5M20 15v5h-5M4 4l6 6M20 20l-6-6"/>',
    palette: '<path d="M12 3a9 9 0 0 0 0 18c1.1 0 1.7-.8 1.7-1.7 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.2 0-.9.8-1.7 1.7-1.7H16a5 5 0 0 0 5-5C21 6.4 17 3 12 3z"/>',
    power: '<path d="M12 3v9M6.3 6.3a8 8 0 1 0 11.4 0"/>',
    doctor: '<path d="M12 21s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 11c0 5.6-7 10-7 10z"/><path d="M9 12h2l1-2 1 4 1-2h1"/>',
    update: '<path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5"/>',
    infinity: '<path d="M18.2 8.4c-2.4 0-4 3.6-6.2 3.6S8.2 8.4 5.8 8.4a3.6 3.6 0 0 0 0 7.2c2.4 0 4-3.6 6.2-3.6s3.8 3.6 6.2 3.6a3.6 3.6 0 0 0 0-7.2z"/>',
  };
  // What's New: the newest version's changes in full, older versions folded away.
  function changelogSection(a, ghUrl) {
    const fmt = (d) => { const t = new Date(d + "T12:00:00"); return isNaN(t) ? esc(d || "") : t.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }); };
    const entry = (c, open) => `<details class="cl-entry"${open ? " open" : ""}>
        <summary><span class="cl-ver">Version ${esc(c.version)}</span><span class="cl-title">${esc(c.title || "")}</span><span class="cl-date">${fmt(c.date)}</span></summary>
        ${c.note ? `<p class="cl-note">${esc(c.note)}</p>` : ""}
        <ul>${(c.items || []).map((i) => `<li>${esc(i)}</li>`).join("")}</ul>
      </details>`;
    const [first, ...rest] = a.changelog;
    return `<section class="shelf" id="whats-new">
        <div class="shelf-head"><h2>What’s New</h2>${ghUrl ? `<a href="${esc(ghUrl)}/releases" target="_blank" rel="noopener">Version History</a>` : ""}</div>
        <div class="changelog">${entry(first, true)}${rest.length ? `<div class="cl-older">${rest.map((c) => entry(c, false)).join("")}</div>` : ""}</div>
      </section>`;
  }
  // The version you would actually install. Release-pinned apps carry it in install.version;
  // repo apps get it from the resolved package. Shown next to the app name because nothing on
  // the page previously told you WHICH version Get would give you.
  function appVersion(a) {
    const v = a.install && a.install.method === "release"
      ? a.install.version
      : (a.package && a.package.version) || (a.install && a.install.version);
    return v ? String(v).replace(/^v/i, "") : "";
  }

  // Feature-card icons: prefer the richer FICON drawing, else fall back to the shared ICONS
  // set. Without the fallback a name that exists in ICONS (star, search, shield…) renders as
  // an EMPTY <svg> — a silent blank tile, which is how three of them shipped unnoticed.
  const fico = (n) => `<svg viewBox="0 0 24 24">${FICON[n] || ICONS[n] || ""}</svg>`;
  function themesBanner(onPage = false) {
    const pick = featuredThemes(12, S.catalog.themes.filter((t) => t.mode !== "light"));
    if (pick.length < 12) return "";
    const creators = new Set(S.catalog.themes.map((t) => t.author).filter(Boolean)).size;
    const tag = onPage ? "div" : "a";
    return `<${tag} class="spot full theme-spot${onPage ? " on-page" : ""}" ${onPage ? `role="button" tabindex="0" onclick="document.getElementById('tgrid')?.scrollIntoView({behavior:'smooth'})"` : `href="/themes/"`}>
      <div class="ts-wall" aria-hidden="true">${pick.map((t) => `<img src="${esc(themeImg(t))}" alt="" loading="lazy">`).join("")}</div>
      <div class="spot-copy">
        <div class="spot-badge rainbow">${ico("palette")}Themes</div>
        <h2>${S.catalog.themes.length} themes.<br>One click.</h2>
        <p>Change your whole desktop in a click: terminal, bar, launcher, lock screen and wallpaper.${creators > 20 ? ` Free, from ${creators} creators.` : " Free."}</p>
        <div class="spot-lock"><span class="ts-ico">${ico("palette")}</span><div><div class="name">Omarchy Themes</div><div class="sub">Free · preview every one</div></div><span class="get big">${onPage ? "SEE ALL" : "BROWSE"}</span></div>
      </div>
    </${tag}>`;
  }
  function igniteBanner() {
    const iso = S.catalog.omarchy_iso;
    return `<a class="spot full ignite-spot" href="${S.desktop ? "/ignite/" : "/get-omarchy/"}">
      <img class="spot-bg" src="${asset("featured/ignite/billboard.webp")}" alt="Get Omarchy: make an installer USB with Ignite" loading="lazy">
      <div class="spot-copy">
        <div class="spot-badge fire"><svg viewBox="0 0 24 24"><path d="M12 2l2.6 6.3 6.9.6-5.2 4.6 1.6 6.8L12 16.8 6.1 20.3l1.6-6.8L2.5 8.9l6.9-.6z"/></svg>New to Omarchy?</div>
        <h2>Get Omarchy. Free.</h2>
        <p>The beautiful Linux desktop everyone's talking about. Make the installer USB with Ignite, keep Windows if you like, and have the Omarchy Store ready in minutes.</p>
        <div class="spot-lock"><img class="icon" src="${asset("featured/ignite/icon-128.png")}" width="64" height="64" alt=""><div><div class="name">Ignite for Omarchy</div><div class="sub">Free${iso ? ` · installs Omarchy ${esc(iso.version)}` : ""} · about 15 minutes</div></div><span class="get big">START</span></div>
      </div>
      <img class="ig-phone-art" src="${asset("featured/ignite/phone-art.webp")}" alt="" loading="lazy">
    </a>`;
  }
  function spotlight(a) {
    const f = a.featured;
    const [g1, g2, g3] = f.gradient;
    if (f.billboard) return `<a class="spot full" href="/app/${a.id}/" style="--g1:${g1};--g2:${g2};--g3:${g3 || g2}">
      <img class="spot-bg" src="${esc(asset(f.billboard))}" alt="${esc(a.name)}: ${esc(f.headline)}" loading="eager">
      <div class="spot-copy">
        <div class="spot-badge"><svg viewBox="0 0 24 24"><path d="M12 2l2.6 6.3 6.9.6-5.2 4.6 1.6 6.8L12 16.8 6.1 20.3l1.6-6.8L2.5 8.9l6.9-.6z"/></svg>${esc(f.badge)}</div>
        <h2>${esc(f.headline)}</h2>
        <p>${esc(f.tagline)}</p>
        ${f.chips ? `<div class="spot-chips">${f.chips.map((c) => `<span>${esc(c)}</span>`).join("")}</div>` : ""}
        <div class="spot-lock">${iconImg(a, 64)}<div><div class="name">${esc(a.name)}</div><div class="sub">${esc(f.launch_offer || f.price)}</div></div>${getBtn(a, true)}</div>
      </div>
    </a>`;
    return `<a class="spot" href="/app/${a.id}/" style="--g1:${g1};--g2:${g2};--g3:${g3 || g2}">
      <div class="spot-copy">
        <div class="spot-badge"><svg viewBox="0 0 24 24"><path d="M12 2l2.6 6.3 6.9.6-5.2 4.6 1.6 6.8L12 16.8 6.1 20.3l1.6-6.8L2.5 8.9l6.9-.6z"/></svg>${esc(f.badge)}</div>
        <h2>${esc(f.headline)}</h2>
        <p>${esc(f.tagline)}</p>
        <div class="spot-lock">${iconImg(a, 64)}<div><div class="name">${esc(a.name)}</div><div class="sub">${esc(f.launch_offer || f.price)}</div></div>${getBtn(a, true)}</div>
      </div>
      <div class="spot-art"><img src="${esc(asset(f.art))}" alt="${esc(a.name)} on Omarchy" loading="eager"></div>
    </a>`;
  }

  // "How to install": the traditional step-by-step, three ways.
  function installWays(a, ins) {
    const cmd = cmdFor(a);
    return `<section class="shelf" id="install"><div class="shelf-head"><h2>How to install ${esc(a.name)}</h2></div>
      <div class="install-ways">
        <div><span class="tag">Easiest</span><h3>With the Omarchy Store app</h3><ol>
          <li>Get the Omarchy Store app: <a style="color:var(--accent)" href="/get-desktop/">instructions</a> (one time only).</li>
          <li>Open it (<b>Super + Space</b>, type <b>Omarchy Store</b>) and find ${esc(a.name)}.</li>
          <li>Press <b>GET</b>. A window opens: type your computer's password and press Enter.</li>
          <li>Done. Open ${esc(a.name)} from the app launcher.</li></ol></div>
        <div><span class="tag">One command</span><h3>In a terminal</h3><ol>
          <li>Open a terminal: <b>Super + Enter</b>.</li>
          <li>Copy this line, paste it (<b>Ctrl + Shift + V</b>) and press Enter:
            <div class="code"><code>${esc(cmd)}</code><button class="btn ghost" data-copy="${esc(cmd)}">Copy</button></div></li>
          <li>Type your password when asked (nothing shows while you type) and press Enter.</li>
          <li>When it says <b>installed</b>, open ${esc(a.name)} from the app launcher.</li></ol></div>
        <div><span class="tag">Download</span><h3>Installer file</h3><ol>
          <li><a style="color:var(--accent)" href="${esc(ins.file)}" download>Download the installer</a> (${esc(ins.file_name)}). It goes to your Downloads folder.</li>
          <li>Open a terminal: <b>Super + Enter</b>.</li>
          <li>Type <code>bash ~/Downloads/${esc(ins.file_name)}</code> and press Enter.</li>
          <li>When it says <b>Done!</b>, open ${esc(a.name)} from the app launcher. This way doesn't need your password.</li></ol></div>
      </div>
      ${ins.note ? `<div class="trust">${ico("ok")}<div>${esc(ins.note)}</div></div>` : ""}
    </section>`;
  }

  function featuredSections(a) {
    const f = a.featured;
    return `
      ${f.heads_up ? `<section class="trust warn" style="margin:22px 0 6px">${ico("warn")}<div><b>${esc(f.heads_up.title)}</b><div style="margin-top:4px">${esc(f.heads_up.body)}</div></div></section>` : ""}
      ${f.promise ? `<section class="promise"><span class="feat-ic">${fico("infinity")}</span><div><h3>${esc(f.promise.title)}</h3><p>${esc(f.promise.body)}</p></div></section>` : ""}
      ${f.features.length > 4 ? `<section class="shelf"><div class="shelf-head"><h2>Everything ${esc(a.name)} does</h2></div></section>` : ""}
      <section class="shelf feat-grid ${f.features.length > 4 ? "many" : ""}">${f.features.map((x, i) => `<div class="feat ${x.hero ? "hero-feat" : ""}"><span class="feat-ic">${fico(x.icon)}</span><div><h3>${esc(x.title)}${x.new ? `<span class="new-tag">NEW</span>` : ""}</h3><p>${esc(x.body)}</p></div></div>`).join("")}</section>
      ${f.install ? installWays(a, f.install) : ""}
      ${f.steps?.length ? `<section class="shelf"><div class="shelf-head"><h2>Get started in ${f.steps.length} steps</h2></div>
        <ol class="steps">${f.steps.map((s, i) => `<li><span class="n">${i + 1}</span><div><h3>${esc(s.title)}</h3><p>${esc(s.body)}</p></div></li>`).join("")}</ol></section>` : ""}
      ${f.shortcuts?.length ? `<section class="shelf"><div class="shelf-head"><h2>Keyboard shortcuts</h2></div>
        <div class="kbd-table">${f.shortcuts.map((s) => `<div class="row"><div class="keys">${s.keys.map((k) => `<kbd>${esc(k)}</kbd>`).join('<span class="plus">+</span>')}</div><div class="does">${esc(s.does)}</div></div>`).join("")}</div></section>` : ""}
      ${f.faq?.length ? `<section class="shelf"><div class="shelf-head"><h2>Questions</h2></div>
        <div class="faq">${f.faq.map((x) => `<details><summary>${esc(x.q)}</summary><p>${esc(x.a)}</p></details>`).join("")}</div></section>` : ""}`;
  }

  function pageCharts() {
    const cats = [{ id: "all", name: "All Apps" }, ...S.catalog.categories];
    const list = S.catalog.apps.filter((a) => S.chartCat === "all" || a.category === S.chartCat);
    return `<div class="page">
      <h1 class="page-title">Top Charts</h1>
      <p class="page-sub">${S.catalog.apps.length} apps ranked by GitHub stars. Updated weekly.</p>
      <div class="tabs">${cats.map((c) => `<button data-chart="${c.id}" class="${S.chartCat === c.id ? "on" : ""}">${esc(c.name)}</button>`).join("")}</div>
      <div class="chart">${list.map((a, i) => lockup(a, { rank: i + 1, sub: catName(a.category) })).join("")}</div>
      ${footer()}
    </div>`;
  }

  function pageCategories() {
    return `<div class="page">
      <h1 class="page-title">Categories</h1>
      <div class="cat-tiles">${S.catalog.themes.length ? `
        <a class="cat-tile cat-themes" href="/themes/">
          <span class="ci" style="background:linear-gradient(135deg,#ff5f6d,#ffc371 35%,#47cf73 65%,#3a7bd5)">${ico("palette")}</span>
          <span>Themes<div class="muted small">${S.catalog.themes.length} themes</div></span>
        </a>` : ""}
        <a class="cat-tile" href="/plugins/">
          <span class="ci" style="background:linear-gradient(135deg,#9ece6a,#2ac3de)">${ico("puzzle")}</span>
          <span>Plugins<div class="muted small">${S.plugins ? S.plugins.plugins.length.toLocaleString() : "5,000+"} plugins</div></span>
        </a>
        <a class="cat-tile" href="/screensavers/">
          <span class="ci" style="background:linear-gradient(135deg,#1a1b26,#7aa2f7 60%,#bb9af7)">${ico("moon")}</span>
          <span>Screensavers<div class="muted small">${S.savers ? S.savers.count : "100+"} screensavers</div></span>
        </a>${wallets().length ? `
        <a class="cat-tile" href="/crypto/">
          <span class="ci" style="background:linear-gradient(135deg,#ab9ff2,#7c5cff 45%,#f6851b)">${ico("wallet")}</span>
          <span>Crypto Wallets<div class="muted small">${wallets().length} wallets</div></span>
        </a>` : ""}${S.catalog.categories.map((c, i) => `
        <a class="cat-tile" href="/category/${c.id}/">
          <span class="ci" style="background:${CAT_COLORS[i % CAT_COLORS.length]}">${ico(c.icon)}</span>
          <span>${esc(c.name)}<div class="muted small">${S.catalog.apps.filter((a) => a.category === c.id).length} apps</div></span>
        </a>`).join("")}</div>
      ${footer()}
    </div>`;
  }

  // "New Apps": everything that has entered the catalogue recently, newest first.
  //
  // `added` is the date an app's registry file first appeared in git, computed at build time.
  // `added_bulk` marks apps that arrived in a bulk seed (the first commit brought in 851), so
  // they are excluded here — otherwise the whole catalogue would read as new forever.
  const NEW_DAYS = 30;
  function isNewApp(a) {
    if (!a.added || a.added_bulk) return false;
    const days = (Date.now() - new Date(a.added + "T12:00:00").getTime()) / 86400000;
    return days <= NEW_DAYS;
  }
  function newApps() {
    return S.catalog.apps.filter(isNewApp).sort((x, y) =>
      y.added.localeCompare(x.added) || (y.stars || 0) - (x.stars || 0));
  }
  function pageNewApps() {
    const list = newApps();
    if (!list.length) return `<div class="page"><h1 class="page-title">New Apps</h1>
      <p class="page-sub">Fresh listings land here as we add them. Nothing in the last ${NEW_DAYS} days yet.</p>
      ${footer()}</div>`;
    const days = [...new Set(list.map((a) => a.added))];
    const label = (d) => {
      const n = Math.round((Date.now() - new Date(d + "T12:00:00").getTime()) / 86400000);
      const nice = new Date(d + "T12:00:00").toLocaleDateString(undefined, { month: "long", day: "numeric" });
      return n <= 0 ? `Today · ${nice}` : n === 1 ? `Yesterday · ${nice}` : nice;
    };
    return `<div class="page">
      <h1 class="page-title">New Apps</h1>
      <p class="page-sub">Added in the last ${NEW_DAYS} days · newest first</p>
      ${days.map((d) => `<section class="shelf">
        <div class="shelf-head"><h2>${esc(label(d))}</h2><span class="muted small">${list.filter((a) => a.added === d).length} added</span></div>
        <div class="grid">${list.filter((a) => a.added === d).map((a) => lockup(a)).join("")}</div>
      </section>`).join("")}
      ${footer()}
    </div>`;
  }
  // Developer pages: clicking a developer's name used to leave the store for GitHub. It now
  // opens their page here, listing everything they have in the store, with the outbound links
  // (GitHub, website) offered from there instead.
  // Hostname for a link's tooltip. The existing `host` helper is scoped inside another
  // function, so this is its own small version rather than widening that one.
  const hostOf = (u) => { try { return new URL(u).host.replace(/^www\./, ""); } catch { return String(u || ""); } };
  function devSlug(name) {
    return String(name || "").toLowerCase().trim()
      .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
  }
  function devApps(slug) {
    return S.catalog.apps.filter((a) => devSlug(a.developer) === slug)
      .sort((x, y) => (y.stars || 0) - (x.stars || 0) || x.name.localeCompare(y.name));
  }
  // Theme makers are creators too. Many publish only on omarchythemes.com and never appear as
  // an app developer, so a profile that only knew about apps would miss most of the people
  // making things for Omarchy.
  function devThemes(slug) {
    return (S.catalog.themes || []).filter((t) => devSlug(t.author) === slug)
      .sort((x, y) => (y.stars || 0) - (x.stars || 0) || x.name.localeCompare(y.name));
  }
  function devName(slug) {
    const a = S.catalog.apps.find((x) => devSlug(x.developer) === slug);
    if (a) return a.developer;
    const t = (S.catalog.themes || []).find((x) => devSlug(x.author) === slug);
    return t ? t.author : "";
  }
  function pageDeveloper(slug) {
    slug = (slug || "").replace(/\/$/, "");
    const list = devApps(slug), themes = devThemes(slug);
    if (!list.length && !themes.length) return notFound();
    const name = devName(slug);
    // Their GitHub org/user, from app repos or from a theme's repo/source link.
    const owners = [...new Set([
      ...list.map((a) => (a.github || "").split("/")[0]),
      ...themes.map((t) => (t.repo || "").split("/")[0]),
      ...themes.map((t) => ((String(t.source_url || "").match(/github\.com\/([^/]+)/) || [])[1]) || ""),
    ].filter(Boolean))];
    // Many apps list their GitHub repo as "homepage". The GitHub mark already covers that, so
    // a globe pointing back at github.com is a duplicate link pretending to be a website.
    const sites = [...new Set(list.map((a) => a.homepage).filter(Boolean))]
      .filter((u) => !/^https?:\/\/(www\.)?github\.com\//i.test(u));
    const stars = list.reduce((n, a) => n + (a.stars || 0), 0) + themes.reduce((n, t) => n + (t.stars || 0), 0);
    const cats = [...new Set(list.map((a) => a.category).filter(Boolean))];
    const catName = (id) => (S.catalog.categories.find((c) => c.id === id) || {}).name || id;
    const made = [list.length ? (list.length === 1 ? "1 app" : list.length + " apps") : "",
                  themes.length ? (themes.length === 1 ? "1 theme" : themes.length + " themes") : ""].filter(Boolean).join(" · ");
    return `<div class="page">
      ${backBtn()}
      <div class="dev-head">
        ${list.length ? iconImg(list[0], 96)
          : `<div class="dev-avatar" aria-hidden="true">${esc((name || "?").trim().charAt(0).toUpperCase())}</div>`}
        <div style="min-width:0">
          <h1>${esc(name)}</h1>
          <div class="sub">${made} in the store${cats.length ? ` · ${cats.slice(0, 3).map((c) => esc(catName(c))).join(", ")}` : ""}</div>
          <div class="dev-links">
            ${owners.map((o) => `<a class="dev-ico" href="https://github.com/${esc(o)}" target="_blank" rel="noopener" title="${esc(o)} on GitHub" aria-label="${esc(o)} on GitHub">${ico("github")}</a>`).join("")}
            ${sites.slice(0, 1).map((u) => `<a class="dev-ico" href="${safeUrl(u)}" target="_blank" rel="noopener" title="${esc(hostOf(u))}" aria-label="Website">${ico("globe")}</a>`).join("")}
          </div>
        </div>
      </div>
      ${list.length ? `<section class="shelf">
        <div class="shelf-head"><h2>Apps by ${esc(name)}</h2>${stars ? `<span class="muted small">${stars.toLocaleString()} GitHub stars combined</span>` : ""}</div>
        <div class="grid">${list.map((a) => lockup(a)).join("")}</div>
      </section>` : ""}
      ${themes.length ? `<section class="shelf">
        <div class="shelf-head"><h2>Themes by ${esc(name)}</h2><a href="/themes/">All themes</a></div>
        <div class="theme-grid">${themes.map((t) => themeCard(t)).join("")}</div>
      </section>` : ""}
      ${footer()}
    </div>`;
  }
  function pageCategory(id) {
    const c = S.catalog.categories.find((c) => c.id === id);
    if (!c) return notFound();
    const list = S.catalog.apps.filter((a) => a.category === id);
    return `<div class="page">
      <h1 class="page-title">${esc(c.name)}</h1>
      <p class="page-sub">${list.length} apps · sorted by GitHub stars</p>
      ${sponsoredApp((a) => a.category === id)}
      <div class="grid">${list.map((a) => lockup(a)).join("")}</div>
      ${footer()}
    </div>`;
  }

  function pageInstalled() {
    const list = S.catalog.apps.filter(isInstalled);
    const themes = S.catalog.themes.filter((t) => !t.builtin && themeHave(t));
    if (!S.plugins) loadPlugins();
    const plugs = S.plugins ? [...S.plugsHave].map((id) => S.plugById[id]).filter(Boolean) : [];
    const row = (icon, name, sub, href, actions) => `<div class="inst-row"><a class="inst-main" href="${href}">${icon}<div class="meta"><div class="name">${esc(name)}</div><div class="sub">${esc(sub)}</div></div></a><div class="inst-act">${actions}</div></div>`;
    return `<div class="page">
      <h1 class="page-title">Installed</h1>
      <p class="page-sub">Everything from the store on this computer. Remove anything with one click: you'll be asked to confirm first.</p>
      <section class="shelf"><div class="shelf-head"><h2>Apps <span class="muted">${list.length}</span></h2></div>
        ${list.length ? `<div class="inst-list">${list.map((a) => row(iconImg(a, 48), a.name, a.summary, `/app/${a.id}/`, getBtn(a) + appRm(a))).join("")}</div>` : `<div class="empty">No store apps yet.</div>`}</section>
      <section class="shelf"><div class="shelf-head"><h2>Themes <span class="muted">${themes.length}</span></h2></div>
        ${themes.length ? `<div class="inst-list">${themes.map((t) => row(`<span class="swatch big">${swatches(t, 4)}</span>`, t.name, themeIsCurrent(t) ? "In use now" : "by " + (t.author || "community"), `/theme/${t.id}/`, themeBtn(t) + themeRm(t))).join("")}</div>` : `<div class="empty">No extra themes yet.</div>`}</section>
      <section class="shelf"><div class="shelf-head"><h2>Plugins <span class="muted">${plugs.length}</span></h2></div>
        ${plugs.length ? `<div class="inst-list">${plugs.map((x) => row(plugTile(x), x.n, x.a || "Community", `/plugin/${encodeURIComponent(x.id)}/`, plugRm(x))).join("")}</div>` : `<div class="empty">${S.plugins ? "No plugins yet." : "Loading…"}</div>`}</section>
    </div>`;
  }

  // ---------- Remove (one click + "Are you sure?") ----------
  function confirmRemove(kind, id) {
    const it = kind === "app" ? S.byId[id] : kind === "theme" ? S.themeById[id] : S.plugById[id];
    if (!it) return;
    const name = it.name || it.n;
    if (kind === "app" && id === "omarchy-store") {
      showSheet(`<div class="sheet-card" role="dialog" aria-label="Remove Omarchy Store">
        <h3>Remove the Omarchy Store from this computer?</h3>
        <p class="small muted" style="margin-top:8px">A terminal opens and removes the store, its launcher entry, icons, state and hooks. Apps you installed through the store stay installed. Nothing else in your home folder is touched.</p>
        <label class="small" style="display:flex;gap:10px;align-items:flex-start;margin-top:14px;cursor:pointer"><input type="checkbox" id="rm-store-all" style="margin-top:3px"><span>Also remove the apps that came with it: <b>SnapDock</b>, <b>Lifeboat</b>, <b>Omarchy Browser</b>, the <b>Omarchy Store screensaver</b> and <b>theme</b>, and switch back to Omarchy's default theme. SnapDock puts back your dock, keys and title bars first.</span></label>
        <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:18px">
          <button class="btn ghost" data-close>Cancel</button>
          <button class="btn danger" data-rm-store>Remove</button>
        </div></div>`);
      return;
    }
    const what = kind === "app" ? `This removes ${esc(name)} from your computer. A terminal opens so you can type your password. Your own files and settings are kept.`
      : kind === "theme" ? `This deletes the ${esc(name)} theme from your computer. You can install it again any time.`
      : `This removes the ${esc(name)} plugin from your bar and desktop. You can add it again any time.`;
    showSheet(`<div class="sheet-card" role="dialog" aria-label="Remove ${esc(name)}">
      <h3>Are you sure you want to remove ${esc(name)}?</h3>
      <p class="small muted" style="margin-top:8px">${what}</p>
      <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:18px">
        <button class="btn ghost" data-close>Cancel</button>
        <button class="btn danger" data-rm-yes="${kind}:${esc(id)}">Remove</button>
      </div></div>`);
  }
  async function doRemove(kind, id) {
    closeSheet();
    const it = kind === "app" ? S.byId[id] : kind === "theme" ? S.themeById[id] : S.plugById[id];
    const name = it.name || it.n, key = kind === "plugin" ? "plugin:" + id : kind === "theme" ? "theme:" + id : id;
    S.busy.add(key); rerender();
    try {
      const r = await post(`/api/${kind === "app" ? "uninstall" : kind + "/remove"}`, { id });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
      toast(kind === "app" ? `Removing ${name}… follow the terminal window` : `Removing ${name}…`);
      const t0 = Date.now();
      while (Date.now() - t0 < (kind === "app" ? 15 : 1) * 60e3) {
        await new Promise((res) => setTimeout(res, 2000));
        await refreshInstalled();
        if (kind === "plugin") { const st = await (await fetch("/api/plugins/installed", { cache: "no-store" })).json().catch(() => ({})); S.plugsHave = new Set(st.installed || []); }
        const gone = kind === "app" ? !S.installed.has(id) : kind === "theme" ? !themeHave(it) : !S.plugsHave.has(id);
        if (gone) { toast(`${name} removed`); break; }
      }
    } catch (e) { toast("Couldn't remove: " + e.message); }
    S.busy.delete(key); rerender();
  }

  // ---------- updates (desktop app) ----------
  S.upd = null; S.updLoading = false; S.updOnlyBusy = false;
  async function loadUpdates(force) {
    if (!S.desktop || S.updLoading) return;
    S.updLoading = true; if (force && currentPath() === "updates") rerender();
    try {
      S.upd = await (await fetch("/api/updates" + (force ? "?refresh=1" : ""), { cache: "no-store" })).json();
    } catch { S.upd = S.upd || { apps: [], system: 0, aur: 0, running: [], error: true }; }
    S.updLoading = false;
    // Count store apps AND pending system/Omarchy/AUR updates, so the nav badge lights up
    // even when only an OS-level (Omarchy) update is waiting and no store app needs one.
    // (system/aur counts are already de-duped against apps server-side.)
    const n = (S.upd.apps || []).length + (S.upd.system || 0) + (S.upd.aur || 0), c = $("#upd-count");
    if (c) { c.textContent = n; c.hidden = !n; }
    if (currentPath() === "updates") rerender();
  }
  function pageUpdates() {
    if (!S.desktop) return `<div class="page"><h1 class="page-title">Updates</h1><div class="empty">Updates are managed by the <a href="/get-desktop/" style="color:var(--accent)">desktop app</a>.</div></div>`;
    if (!S.upd) { loadUpdates(false); }
    const u = S.upd, apps = (u?.apps || []).map((x) => ({ ...x, a: x.via === "plugin" ? { id: x.id, name: x.name, icon: x.icon, plugin: 1 } : S.byId[x.id] })).filter((x) => x.a);
    const running = new Set(u?.running || []);
    const sysList = u?.sys_list || [], aurList = u?.aur_list || [];
    const others = sysList.length + aurList.length;
    // "Store apps" that can update on their own (release/aur/plugin). Ones tied to pacman's own
    // repo (via "system") can't be updated in isolation — Arch only allows that as part of a full
    // Omarchy OS update — so they're excluded from the "Only Update Store Apps" bulk action.
    const storeOnly = apps.filter((x) => x.via !== "system");
    const storeOnlyBusy = storeOnly.some((x) => running.has(x.a.id)) || S.updOnlyBusy;
    const when = u?.checked ? new Date(u.checked * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
    const storeBanner = S.status?.restart_needed
      ? `<div class="upd-store"><div><b>A new version of Omarchy Store is ready</b><span>Version ${esc(S.status.store_update || "")} has been downloaded.</span></div><button class="btn" data-self-update>Restart store</button></div>` : "";
    return `<div class="page">
      <div class="upd-head">
        <div><h1 class="page-title">Updates</h1>
        <p class="page-sub">${S.updLoading && !u ? "Checking for updates…" : u ? `Last checked ${esc(when)} · Omarchy Store ${esc(S.status?.version || "")}` : ""}</p></div>
        <div class="upd-actions">
          <button class="btn ghost" data-upd-refresh ${S.updLoading ? "disabled" : ""}>${S.updLoading ? '<span class="ring"></span> Checking' : "Check now"}</button>
        </div>
      </div>
      ${storeBanner}
      ${!u ? `<div class="empty"><span class="ring big"></span><br>Checking your apps…</div>` :
        !apps.length && !others ? `<div class="upd-ok">${ico("installed")}<div><b>Everything is up to date</b><span>Your store apps and Omarchy are on the latest versions.</span></div></div>` : ""}
      ${apps.length ? `<div class="upd-sec-head"><h2 class="upd-sec">Omarchy Store apps <span>${apps.length}</span></h2>
          <button class="btn ghost small" data-upd-store-only ${storeOnlyBusy ? "disabled" : ""}>${storeOnlyBusy ? '<span class="ring"></span> Updating…' : "Update All Store Apps"}</button></div>
        <p class="small muted" style="margin:-4px 0 10px">Apps listed in the Omarchy Store. Each updates on its own, with no password needed for plugins.${storeOnly.length ? "" : " All of the apps below happen to come bundled with Omarchy's own packages right now, so they only update together with Omarchy OS."}</p>
        <div class="upd-list">${apps.map(({ a, installed, latest, via }) => `
          <div class="upd-row">
            <a href="${a.plugin ? "/plugins/" : `/app/${a.id}/`}">${a.plugin ? `<img class="upd-plug-ico" src="${esc(a.icon)}" alt="" width="56" height="56" loading="lazy">` : iconImg(a, 56)}</a>
            <div class="upd-meta"><a href="${a.plugin ? "/plugins/" : `/app/${a.id}/`}" class="name">${esc(a.name)}</a>
              <span class="ver">${esc(installed.split("-")[0])} → <b>${esc(latest.split("-")[0])}</b></span>
              ${via === "system" ? `<span class="note">Updates with Omarchy OS, below</span>` : via === "plugin" ? `<span class="note">Plugin · no password needed</span>` : ""}</div>
            ${via === "system" ? "" : `<button class="get ${running.has(a.id) ? "busy" : ""}" ${a.plugin ? `data-upd-plug="${esc(a.id)}"` : `data-upd="${esc(a.id)}"`} ${running.has(a.id) ? "disabled" : ""}>${running.has(a.id) ? '<span class="ring"></span>' : "UPDATE"}</button>`}
          </div>`).join("")}</div>` : ""}
      ${others ? `<div class="upd-sec-head"><h2 class="upd-sec">Omarchy OS Updates <span>${others}</span></h2>
          <button class="get ${running.has("__all__") ? "busy" : ""}" data-upd-all ${running.has("__all__") ? "disabled" : ""}>${running.has("__all__") ? '<span class="ring"></span>' : "Update Omarchy OS"}</button></div>
        <p class="small muted" style="margin:-4px 0 10px">Pieces of Omarchy itself — the OS, kernel, desktop and built-in tools — plus any AUR apps you installed yourself. Arch doesn't allow updating one of these alone, so <b>Update Omarchy OS</b> updates all of them together and takes a safety snapshot first.</p>
        <div class="upd-list">${[...sysList.map((p) => ({ ...p, kind: "Omarchy / system package" })), ...aurList.map((p) => ({ ...p, kind: "AUR package" }))].map((p) => `
          <div class="upd-row">
            <span class="upd-sys-ico">${ico("grid")}</span>
            <div class="upd-meta"><span class="name">${esc(p.name)}</span>
              <span class="ver">${esc(p.installed)} → <b>${esc(p.latest)}</b></span>
              <span class="note">${esc(p.kind)}</span></div>
          </div>`).join("")}</div>` : ""}
      <p class="small muted" style="margin-top:28px">Updates open a terminal window so you can see what's happening and type your password. Omarchy Store checks for new apps and for a newer version of itself every hour.</p>
    </div>`;
  }
  async function doUpdate(path, body, label) {
    const r = await post(path, body);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return toast(j.error || "Update failed");
    toast(label + " — follow the terminal window");
    loadUpdates(false);
    const t0 = Date.now();
    const tick = setInterval(async () => {
      await loadUpdates(false);
      if (!(S.upd?.running || []).length || Date.now() - t0 > 30 * 60e3) { clearInterval(tick); refreshInstalled(); }
    }, 8000);
  }
  async function doUpdateStoreOnly() {
    // Updates every store app that can update on its own (release/aur/plugin), one at a time,
    // and leaves anything tied to the Omarchy OS update alone.
    const u = S.upd, apps = (u?.apps || []).map((x) => ({ ...x, a: x.via === "plugin" ? { id: x.id, name: x.name, icon: x.icon, plugin: 1 } : S.byId[x.id] })).filter((x) => x.a);
    const targets = apps.filter((x) => x.via !== "system");
    if (!targets.length) return toast("These apps update together with Omarchy OS — use Update Omarchy OS below");
    S.updOnlyBusy = true; rerender();
    toast(`Updating ${targets.length} store app${targets.length === 1 ? "" : "s"} — follow the terminal window(s)`);
    for (const t of targets) {
      try {
        if (t.a.plugin) await post("/api/plugin/update", { id: t.a.id });
        else await post("/api/update", { id: t.a.id });
      } catch {}
      await loadUpdates(false);
    }
    S.updOnlyBusy = false;
    const t0 = Date.now();
    const tick = setInterval(async () => {
      await loadUpdates(false);
      if (!(S.upd?.running || []).length || Date.now() - t0 > 30 * 60e3) { clearInterval(tick); refreshInstalled(); }
    }, 8000);
  }



  // ---------- Submit an app / Advertise (own pages, not GitHub file links) ----------
  function pageContact() {
    const soc = liveSocials();
    return `<div class="page info-page" style="max-width:860px">
      <h1 class="page-title">Contact us</h1>
      <p class="page-sub">Questions, partnerships, press or problems with a listing: we'd love to hear from you.</p>
      <div class="info-cards">
        <a class="info-card" href="mailto:${CONTACT_EMAIL}"><span class="go-n">${ico("mail")}</span><div><h3>Email</h3><p>${CONTACT_EMAIL}<br><span class="muted small">We usually reply within 1–2 days.</span></p></div></a>
        <a class="info-card" href="/submit/"><span class="go-n">${ico("plus")}</span><div><h3>Developers</h3><p>List your app for free, or ask about selling it.</p></div></a>
        <a class="info-card" href="/advertise/"><span class="go-n">${ico("megaphone")}</span><div><h3>Advertisers</h3><p>Banners and sponsored listings, clearly labelled.</p></div></a>
      </div>

      <section class="shelf"><div class="shelf-head"><h2>Report a problem with an app</h2></div>
        <p>Something wrong with a listing (broken install, wrong info, unsafe)? Email us with the app's name, or <a style="color:var(--accent)" href="${REPO}/issues" target="_blank" rel="noopener">open an issue on GitHub</a>.</p></section>
      ${footer()}
    </div>`;
  }
  // =====================================================================================
  // Portal v2 — Developers (/submit/), Advertisers (/advertise/), Donate (/donate/)
  // Private status links (?status=<id>&t=<token>) stand in for accounts until real log-ins exist.
  // =====================================================================================
  const qs = (k) => new URLSearchParams(location.search).get(k);
  const P = { draft: "os-dev-draft", links: "os-portal-links", step: 0 };
  const pGet = async (path) => { const r = await fetch(API + path, { cache: "no-store" }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || "Something went wrong"); return j; };
  const pPost = async (path, b) => { const r = await apiPost(path, b); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || "Something went wrong"); return j; };
  const myLinks = () => { try { return JSON.parse(localStorage.getItem(P.links) || "[]"); } catch { return []; } };
  const saveLink = (kind, id, url, name) => { try { localStorage.setItem(P.links, JSON.stringify([{ kind, id, url, name, ts: Date.now() }, ...myLinks().filter((l) => !(l.kind === kind && l.id === id))].slice(0, 20))); } catch {} };
  const fmtDate = (ts) => new Date(ts).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
  const fmtWhen = (ts) => new Date(ts).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const httpsOk = (u) => /^https:\/\/[^\s"'<>]+$/.test(u || "");
  const pIco = {
    heart: '<path d="M12 20.5s-7.5-4.6-9.3-9.4C1.4 7.6 3.6 4 7.2 4c2 0 3.6 1.1 4.8 2.8C13.2 5.1 14.8 4 16.8 4c3.6 0 5.8 3.6 4.5 7.1-1.8 4.8-9.3 9.4-9.3 9.4z"/>',
    bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>', coin: '<circle cx="12" cy="12" r="9"/><path d="M14.5 9.2c-.5-.8-1.4-1.2-2.5-1.2-1.6 0-2.7.8-2.7 2s1 1.6 2.7 2 2.8.9 2.8 2.1-1.2 2-2.8 2c-1.2 0-2.2-.5-2.7-1.4M12 6.5V8m0 8v1.5"/>',
    eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>', send: '<path d="M22 2 11 13M22 2l-7 20-4-9-9-4z"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.5-3.6 3.2-5.5 6.5-5.5s6 1.9 6.5 5.5M16 4.8a3.3 3.3 0 0 1 0 6.4M18 14.6c2 .6 3.3 2.4 3.5 5.4"/>',
    lock: '<rect x="4" y="10" width="16" height="11" rx="2.5"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>', edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
    link: '<path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/>', search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
  };
  const pi = (n) => `<svg viewBox="0 0 24 24">${pIco[n] || ICONS[n] || ""}</svg>`;
  const tracker = (steps, at, bad) => `<ol class="p-track">${steps.map(([k, label], i) => {
    const idx = steps.findIndex(([x]) => x === at);
    return `<li class="${i < idx ? "done" : i === idx ? (bad ? "bad" : "now") : ""}"><i>${i < idx ? "✓" : i + 1}</i><span>${label}</span></li>`; }).join("")}</ol>`;
  const thread = (msgs, mine) => `<div class="p-thread">${msgs.length ? msgs.map((m) => `<div class="p-msg ${m.sender === "store" ? "them" : "me"}">
      <div class="p-bubble">${esc(m.body)}</div><div class="p-meta">${m.sender === "store" ? "Omarchy Store" : mine} · ${fmtWhen(m.ts)}</div></div>`).join("")
    : `<p class="muted small">No messages yet. We'll post updates here.</p>`}</div>`;
  const pField = (label, input, hint = "", wide = false) => `<label class="${wide ? "wide" : ""}">${label}${hint ? ` <span class="muted">${hint}</span>` : ""}${input}</label>`;

  // ---------------------------------------------------------------- Developers
  const DEV_STEPS = [["you", "You"], ["app", "Your app"], ["page", "Store page"], ["price", "Pricing"], ["send", "Review & send"]];
  const LICENSES = ["MIT", "GPL-3.0", "GPL-2.0", "LGPL-3.0", "Apache-2.0", "BSD-3-Clause", "BSD-2-Clause", "MPL-2.0", "AGPL-3.0", "ISC", "Unlicense", "Proprietary (paid)", "Other"];
  const INSTALLS = [["aur", "AUR package"], ["pacman", "Official Arch package"], ["release", "GitHub release (.pkg.tar.zst)"], ["none", "Not packaged yet — help me"]];
  const draft = () => { try { return JSON.parse(localStorage.getItem(P.draft) || "{}"); } catch { return {}; } };
  const devVal = (k) => esc(draft()[k] ?? "");

  function pageSubmit() {
    if (qs("status")) return `<div class="page p-page" id="p-status" data-kind="dev"><div class="p-loading">Loading your submission…</div></div>`;
    const links = myLinks().filter((l) => l.kind === "dev");
    return `<div class="page p-page">
      <section class="p-hero dev">
        <div class="p-hero-copy">
          <div class="eyebrow">OMARCHY STORE FOR DEVELOPERS</div>
          <h1>Ship your app to every Omarchy desktop.</h1>
          <p>List it free in the world's largest app store for Omarchy. One-click install, a beautiful store page, real reviews, and the option to sell it for crypto — you keep 90%.</p>
          <div class="p-cta"><a class="btn big" href="#dev-wizard" data-p-jump="dev-wizard">Start your submission</a>
            ${links.length ? `<a class="btn ghost" href="${esc(links[0].url)}">Check my submission</a>` : `<span class="p-hint">Takes about 5 minutes · saves as you go</span>`}</div>
        </div>
        <div class="p-hero-art" aria-hidden="true">
          <div class="p-mock-card">
            <div class="p-mock-row"><div class="p-mock-ico" id="pv-hero-ico"></div><div><b id="pv-hero-name">Your App</b><span id="pv-hero-tag">Your one-line tagline lives here</span></div><span class="p-mock-get">GET</span></div>
            <div class="p-mock-shots"><i></i><i></i><i></i></div>
            <div class="p-mock-stars">★★★★★ <span>Reviews from real Omarchy users</span></div>
          </div>
        </div>
      </section>

      <div class="p-benefits">
        <div><span>${ico("plus")}</span><b>Free to list</b><p>No fees, no contracts. Your app gets its own store page.</p></div>
        <div><span>${pi("bolt")}</span><b>One-click install</b><p>People press GET in the desktop app and it's installed.</p></div>
        <div><span>${pi("coin")}</span><b>Sell it, keep 90%</b><p>Paid in crypto straight to your wallet. Apple and Google take up to 30%.</p></div>
        <div><span>${ico("ok")}</span><b>Reviewed by a person</b><p>Every app is checked for safety before it goes live.</p></div>
      </div>

      ${links.length ? `<section class="shelf"><div class="shelf-head"><h2>Your submissions</h2><span class="muted small">Saved in this browser</span></div>
        <div class="p-mine">${links.map((l) => `<a class="p-mine-row" href="${esc(l.url)}">${ico("code")}<b>${esc(l.name)}</b><span class="muted small">Submitted ${fmtDate(l.ts)}</span><span class="p-go">Open status →</span></a>`).join("")}</div></section>` : ""}

      <section class="shelf"><div class="shelf-head"><h2>How it works</h2></div>
        <ol class="p-steps">
          <li><i>1</i><b>Submit</b><p>Tell us about your app and add your logo, screenshots and write-up.</p></li>
          <li><i>2</i><b>Review</b><p>A person checks the license, the package and the code. Usually 1–2 days.</p></li>
          <li><i>3</i><b>Go live</b><p>Your page goes up with a GET button, reviews and automatic updates.</p></li>
          <li><i>4</i><b>Grow</b><p>Great apps get picked for Featured, Essentials and our socials.</p></li>
        </ol></section>

      <section class="shelf" id="dev-wizard"><div class="shelf-head"><h2>Submit your app</h2><button class="p-link" type="button" data-p-clear>Start over</button></div>
        <div class="p-wizard">
          <form id="dev-form" class="p-form" novalidate>
            <ol class="p-stepper">${DEV_STEPS.map(([k, l], i) => `<li data-p-step="${i}" class="${i === P.step ? "on" : i < P.step ? "done" : ""}"><i>${i + 1}</i><span>${l}</span></li>`).join("")}</ol>
            ${devStepHtml()}
          </form>
          <aside class="p-preview" id="dev-preview">${devPreviewHtml(draft())}</aside>
        </div></section>

      <section class="shelf"><div class="shelf-head"><h2>Listing rules</h2></div>
        <ul class="info-list">
          <li><b>Installs through a package manager:</b> Arch repos, the AUR, or a signed GitHub release package. No <code>curl | bash</code>, AppImages or custom scripts. Not packaged yet? Pick "help me" and we'll talk.</li>
          <li><b>Open about what it is:</b> a real license, a public source repository, and screenshots of the app actually running.</li>
          <li><b>Marketing assets:</b> a square logo (PNG or SVG, at least 256×256), a one-line tagline, a write-up of at least 200 characters and 1–6 screenshots.</li>
          <li><b>No malware</b>, cracked software, or apps mainly for piracy. Apps that stop being maintained are removed.</li>
          <li>Top Charts are ranked by GitHub stars only — nobody can buy a ranking.</li>
        </ul>
        <p class="small muted" style="margin-top:12px">Technical people can also open a pull request directly: <a style="color:var(--accent)" href="https://raw.githubusercontent.com/omarchy-community/store/main/CONTRIBUTING.md" target="_blank" rel="noopener">contributor guide</a>.</p></section>
      ${footer()}
    </div>`;
  }

  function devStepHtml() {
    const d = draft(), v = (k) => esc(d[k] ?? ""), cats = S.catalog.categories || [];
    const sel = (name, opts, cur) => `<select name="${name}">${opts.map(([k, l]) => `<option value="${esc(k)}" ${k === cur ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
    const step = [
      `<div class="p-step-h"><h3>About you</h3><p>Who's behind the app. Your email stays private.</p></div>
       <div class="fgrid">
        ${pField("Company or studio", `<input name="company" maxlength="80" value="${v("company")}" placeholder="Independent? Use your own name">`)}
        ${pField("Your name", `<input name="name" maxlength="80" value="${v("name")}">`)}
        ${pField("Email", `<input name="email" type="email" maxlength="120" value="${v("email")}">`)}
        ${pField("Website", `<input name="website" type="url" maxlength="200" placeholder="https://" value="${v("website")}">`, "(optional)")}
        ${pField("GitHub username", `<input name="github" maxlength="39" value="${v("github")}">`, "(optional)")}
        ${pField("Telegram", `<input name="telegram" maxlength="40" placeholder="@yourname" value="${v("telegram")}">`, "(optional)")}
       </div>`,
      `<div class="p-step-h"><h3>Your app</h3><p>The basics people see first.</p></div>
       <div class="fgrid">
        ${pField("App name", `<input name="app_name" maxlength="80" value="${v("app_name")}">`)}
        ${pField("Category", sel("category", [["", "Choose…"], ...cats.map((c) => [c.id, c.name])], d.category))}
        ${pField("Tagline", `<input name="tagline" minlength="10" maxlength="90" value="${v("tagline")}" placeholder="A Mac-style dock for Hyprland with a real minimize button"><span class="p-count" data-count="tagline" data-min="10" data-max="90"></span>`, "(one line, 10–90 characters)", true)}
        ${pField("Source repository", `<input name="repo_url" type="url" maxlength="200" value="${v("repo_url")}" placeholder="https://github.com/you/your-app">`, "(GitHub, GitLab or Codeberg)", true)}
        ${pField("License", sel("license", [["", "Choose…"], ...LICENSES.map((l) => [l, l])], d.license))}
        ${pField("How it installs", sel("install_kind", [["", "Choose…"], ...INSTALLS], d.install_kind))}
        ${pField("Package name", `<input name="install_pkg" maxlength="80" value="${v("install_pkg")}" placeholder="e.g. my-app or my-app-bin">`, "(AUR / Arch package)")}
        ${pField("App website", `<input name="app_url" type="url" maxlength="300" placeholder="https://" value="${v("app_url")}">`, "(optional)")}
       </div>`,
      `<div class="p-step-h"><h3>Your store page</h3><p>We build your page from these. Real screenshots of the app running work best.</p></div>
       <div class="fgrid">
        ${pField("Logo link", `<input name="logo_url" type="url" maxlength="400" value="${v("logo_url")}" placeholder="https://raw.githubusercontent.com/you/app/main/icon.png">`, "(square PNG or SVG, at least 256×256)", true)}
        ${pField("Screenshot links", `<textarea name="screenshots" rows="4" placeholder="https://…/screenshot-1.png&#10;https://…/screenshot-2.png">${v("screenshots")}</textarea>`, "(1–6, one per line, 16:10 or 16:9)", true)}
        <div class="wide p-shots" id="pv-shots"></div>
        ${pField("Write-up", `<textarea name="app_desc" rows="8" maxlength="3000" placeholder="What it does, who it's for, and its best features.">${v("app_desc")}</textarea><span class="p-count" data-count="app_desc" data-min="200" data-max="3000"></span>`, "(at least 200 characters)", true)}
       </div>`,
      `<div class="p-step-h"><h3>Pricing</h3><p>Most apps are free. If you sell yours, buyers pay in crypto and your share goes straight to your wallet.</p></div>
       <div class="p-choice">
        <label class="p-opt ${d.wants_paid ? "" : "on"}"><input type="radio" name="wants_paid" value="" ${d.wants_paid ? "" : "checked"}><b>Free</b><span>Anyone can install it.</span></label>
        <label class="p-opt ${d.wants_paid ? "on" : ""}"><input type="radio" name="wants_paid" value="1" ${d.wants_paid ? "checked" : ""}><b>Paid</b><span>You keep 90%. The store's fee is 10%.</span></label>
       </div>
       <div class="paid-box" ${d.wants_paid ? "" : "hidden"}>
        <p class="small">Enter the PUBLIC addresses you want to be paid to. <b>Never enter a seed phrase or private key.</b> Payment for third-party apps settles in USDC on Solana with an automatic 90/10 split.</p>
        <div class="fgrid">
          ${pField("Price (USD)", `<input name="price_usd" type="number" min="0.99" max="999" step="0.01" placeholder="4.99" value="${v("price_usd")}">`)}
          ${pField("Solana address", `<input name="p_sol" maxlength="44" value="${v("p_sol")}">`, "(recommended)")}
          ${pField("Base / Ethereum address", `<input name="p_evm" maxlength="42" placeholder="0x…" value="${v("p_evm")}">`)}
          ${pField("Bitcoin address", `<input name="p_btc" maxlength="74" placeholder="bc1…" value="${v("p_btc")}">`)}
          ${pField("XRP address", `<input name="p_xrp" maxlength="35" placeholder="r…" value="${v("p_xrp")}">`)}
        </div></div>`,
      `<div class="p-step-h"><h3>Review & send</h3><p>This is roughly how your page will look. Go back to change anything.</p></div>
       ${devReviewHtml(d)}
       <label class="check"><input type="checkbox" name="agree" ${d.agree ? "checked" : ""}> My app is mine to publish, contains no malware, and I accept the <a href="/legal/" style="color:var(--accent)">store terms</a>.</label>
       <div class="ts-box"></div>`,
    ][P.step];
    return `<div class="p-step">${step}</div>
      <div class="form-err" hidden></div>
      <div class="p-nav">${P.step ? `<button class="btn ghost" type="button" data-p-back>Back</button>` : "<span></span>"}
        <span class="p-saved muted small">${pi("lock")} Draft saved in this browser</span>
        ${P.step < DEV_STEPS.length - 1 ? `<button class="btn" type="button" data-p-next>Continue</button>` : `<button class="btn big" type="submit">Submit for review</button>`}</div>`;
  }

  function devReviewHtml(d) {
    const shots = String(d.screenshots || "").split(/\s+/).filter(httpsOk).slice(0, 6);
    const cat = (S.catalog.categories || []).find((c) => c.id === d.category);
    return `<div class="p-review">
      <div class="p-rv-head">${httpsOk(d.logo_url) ? `<img src="${esc(d.logo_url)}" alt="" referrerpolicy="no-referrer">` : `<div class="p-mock-ico"></div>`}
        <div><h3>${esc(d.app_name || "Your app")}</h3><p>${esc(d.tagline || "")}</p><span class="muted small">${esc(d.company || "")}${cat ? ` · ${esc(cat.name)}` : ""}${d.license ? ` · ${esc(d.license)}` : ""}</span></div>
        <span class="p-mock-get">${d.wants_paid && d.price_usd ? "$" + esc(d.price_usd) : "GET"}</span></div>
      ${shots.length ? `<div class="p-rv-shots">${shots.map((s) => `<img src="${esc(s)}" alt="" referrerpolicy="no-referrer" loading="lazy" onerror="this.outerHTML='<span class=p-badimg>Image link is broken</span>'">`).join("")}</div>` : ""}
      <p class="p-rv-desc">${esc(d.app_desc || "")}</p>
      <dl class="p-rv-facts"><div><dt>Source</dt><dd>${esc(d.repo_url || "—")}</dd></div><div><dt>Installs from</dt><dd>${esc((INSTALLS.find(([k]) => k === d.install_kind) || [, "—"])[1])}${d.install_pkg ? ` · ${esc(d.install_pkg)}` : ""}</dd></div>
        <div><dt>Contact</dt><dd>${esc(d.name || "")} · ${esc(d.email || "")}</dd></div></dl>
    </div>`;
  }

  function devPreviewHtml(d) {
    const shots = String(d.screenshots || "").split(/\s+/).filter(httpsOk).slice(0, 3);
    return `<div class="p-pv-label">${pi("eye")} Live preview</div>
      <div class="p-pv-card">
        <div class="p-mock-row">${httpsOk(d.logo_url) ? `<img class="p-pv-ico" src="${esc(d.logo_url)}" alt="" referrerpolicy="no-referrer">` : `<div class="p-mock-ico"></div>`}
          <div><b>${esc(d.app_name || "Your App")}</b><span>${esc(d.tagline || "Your one-line tagline")}</span></div><span class="p-mock-get">${d.wants_paid && d.price_usd ? "$" + esc(d.price_usd) : "GET"}</span></div>
        <div class="p-pv-shots">${shots.length ? shots.map((s) => `<img src="${esc(s)}" alt="" referrerpolicy="no-referrer" loading="lazy" onerror="this.outerHTML='<span class=p-badimg>Image link is broken</span>'">`).join("") : "<i></i><i></i>"}</div>
      </div>
      <ul class="p-check">${[
        ["Tagline", (d.tagline || "").length >= 10], ["Source repository", /^https:\/\/(github\.com|gitlab\.com|codeberg\.org)\/[\w.-]+\/[\w.-]+\/?$/.test(d.repo_url || "")],
        ["Logo", httpsOk(d.logo_url)], ["Screenshots", String(d.screenshots || "").split(/\s+/).some(httpsOk)], ["Write-up (200+ characters)", (d.app_desc || "").length >= 200],
      ].map(([l, ok]) => `<li class="${ok ? "ok" : ""}"><i>${ok ? "✓" : ""}</i>${l}</li>`).join("")}</ul>`;
  }

  // Save every keystroke to the draft and refresh the preview.
  function devCapture(f) {
    const d = draft();
    for (const el of f.elements) {
      if (!el.name || el.name === "cf-turnstile-response") continue;
      if (el.type === "radio") { if (el.checked) d[el.name] = el.value; }
      else if (el.type === "checkbox") d[el.name] = el.checked;
      else d[el.name] = el.value;
    }
    try { localStorage.setItem(P.draft, JSON.stringify(d)); } catch {}
    return d;
  }
  function devRefresh(d) {
    const pv = $("#dev-preview"); if (pv) pv.innerHTML = devPreviewHtml(d);
    const sh = $("#pv-shots"); if (sh) sh.innerHTML = String(d.screenshots || "").split(/\s+/).filter(httpsOk).slice(0, 6).map((s) => `<img src="${esc(s)}" alt="" referrerpolicy="no-referrer" loading="lazy" onerror="this.outerHTML='<span class=p-badimg>Image link is broken</span>'">`).join("");
    document.querySelectorAll("[data-count]").forEach((c) => { const n = (d[c.dataset.count] || "").length; c.textContent = `${n} / ${c.dataset.max}`; c.classList.toggle("bad", n > 0 && n < Number(c.dataset.min)); });
    const box = $("#dev-form .paid-box"); if (box) box.hidden = !d.wants_paid;
    document.querySelectorAll("#dev-form .p-opt").forEach((o) => o.classList.toggle("on", o.querySelector("input").checked));
  }
  // Client-side checks per step (the server checks everything again).
  function devCheck(step, d) {
    const email = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
    if (step === 0) {
      if (!d.company?.trim()) return "Enter your company or studio name (or your own name)";
      if (!d.name?.trim()) return "Enter your name";
      if (!email.test(d.email || "")) return "Enter a valid email";
      if (d.website && !httpsOk(d.website)) return "Your website must start with https://";
    }
    if (step === 1) {
      if (!d.app_name?.trim()) return "Enter your app's name";
      if (!d.category) return "Pick a category";
      if ((d.tagline || "").trim().length < 10) return "Your tagline needs at least 10 characters";
      if (!/^https:\/\/(github\.com|gitlab\.com|codeberg\.org)\/[\w.-]+\/[\w.-]+\/?$/.test(d.repo_url || "")) return "Add your source repository, like https://github.com/you/your-app";
      if (!d.license) return "Pick a license";
      if (!d.install_kind) return "Tell us how it installs";
      if (["aur", "pacman"].includes(d.install_kind) && !/^[a-z0-9@._+-]+$/.test(d.install_pkg || "")) return "Enter the package name";
    }
    if (step === 2) {
      if (!httpsOk(d.logo_url)) return "Add a link to your logo (https://…)";
      const s = String(d.screenshots || "").split(/\s+/).filter(Boolean);
      if (!s.length || !s.every(httpsOk)) return "Add 1–6 screenshot links, each starting with https://";
      if (s.length > 6) return "Use at most 6 screenshots";
      if ((d.app_desc || "").trim().length < 200) return `Your write-up needs at least 200 characters (you have ${(d.app_desc || "").trim().length})`;
    }
    if (step === 3 && d.wants_paid) {
      const p = Number(d.price_usd);
      if (!(p >= 0.99 && p <= 999)) return "Set a price between $0.99 and $999";
      if (!(d.p_sol || d.p_evm || d.p_btc || d.p_xrp)) return "Add at least one wallet address so you can be paid";
    }
    return "";
  }
  function devGoto(step) {
    const f = $("#dev-form"); if (!f) return;
    P.step = Math.max(0, Math.min(DEV_STEPS.length - 1, step));
    f.innerHTML = `<ol class="p-stepper">${DEV_STEPS.map(([k, l], i) => `<li data-p-step="${i}" class="${i === P.step ? "on" : i < P.step ? "done" : ""}"><i>${i < P.step ? "✓" : i + 1}</i><span>${l}</span></li>`).join("")}</ol>${devStepHtml()}`;
    devRefresh(draft());
    if (P.step === DEV_STEPS.length - 1) { const b = $("#dev-form .ts-box"); if (b) turnstileMount(b); }
    $("#dev-wizard")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  function devSubmit(f) {
    const d = devCapture(f);
    for (let i = 0; i < DEV_STEPS.length - 1; i++) { const m = devCheck(i, d); if (m) { devGoto(i); const e = $("#dev-form .form-err"); e.textContent = m; e.hidden = false; return; } }
    if (!d.agree) { const e = f.querySelector(".form-err"); e.textContent = "Please accept the store terms"; e.hidden = false; return; }
    const hint = d.install_kind === "aur" || d.install_kind === "pacman" ? `${d.install_kind}:${d.install_pkg}` : d.install_kind;
    submitForm(f, "/developers", {
      company: d.company, name: d.name, email: d.email, website: d.website, github: d.github, telegram: d.telegram,
      app_name: d.app_name, category: d.category, tagline: d.tagline, repo_url: (d.repo_url || "").replace(/\/+$/, ""), license: d.license, install_hint: hint, app_url: d.app_url,
      logo_url: d.logo_url, screenshots: String(d.screenshots || "").split(/\s+/).filter(Boolean), app_desc: d.app_desc,
      wants_paid: !!d.wants_paid, price_usd: d.wants_paid ? Number(d.price_usd) : null, p_evm: d.p_evm, p_sol: d.p_sol, p_btc: d.p_btc, p_xrp: d.p_xrp, agree: true,
    }, (j) => {
      saveLink("dev", j.id, j.url.replace(/^https:\/\/omarchystore\.com/, ""), d.app_name);
      try { localStorage.removeItem(P.draft); } catch {}
      P.step = 0;
      $("#dev-wizard").innerHTML = `<div class="p-done">${ico("ok")}<div>
        <h3>${esc(d.app_name)} is in the review queue</h3>
        <p>Your private status page shows where it is, our messages, and lets you send fixes. <b>Save this link</b> — it's the key to your submission.</p>
        <div class="p-linkbox"><code>${esc(j.url)}</code><button class="btn" type="button" data-copy="${esc(j.url)}">Copy link</button></div>
        <div class="p-cta"><a class="btn" href="${esc(j.url.replace(/^https:\/\/omarchystore\.com/, ""))}">Open my status page</a>
          <a class="btn ghost" href="https://t.me/OmarchyStoreBot?start=dev_${j.id}" target="_blank" rel="noopener">Get updates on Telegram</a></div>
      </div></div>`;
    });
  }

  async function loadDevStatus(el) {
    const id = qs("status"), t = qs("t");
    try {
      const d = await pGet(`/dev/status?id=${encodeURIComponent(id)}&t=${encodeURIComponent(t)}`);
      saveLink("dev", d.id, location.pathname + location.search, d.app_name);
      const ST = { pending: ["In review", "We're checking your app. Usually 1–2 days."], changes: ["Changes needed", "We need a few fixes — see the message below, then send an update."],
        approved: ["Approved", "Approved! We're preparing your store page."], live: ["Live", "Your app is live in the store."], rejected: ["Not approved", "Your app wasn't approved this time. See our message below."] }[d.status] || [d.status, ""];
      const at = d.status === "changes" ? "review" : d.status === "pending" ? "review" : d.status === "rejected" ? "review" : d.status;
      const editable = ["pending", "changes"].includes(d.status);
      el.innerHTML = `${backBtn()}
        <section class="p-status-head">
          ${httpsOk(d.logo_url) ? `<img src="${esc(d.logo_url)}" alt="" referrerpolicy="no-referrer">` : `<div class="p-mock-ico"></div>`}
          <div><div class="eyebrow">SUBMISSION #${d.id}</div><h1>${esc(d.app_name)}</h1><p>${esc(d.tagline || "")}</p></div>
          <span class="p-pill ${d.status}">${ST[0]}</span>
        </section>
        ${tracker([["sent", "Submitted"], ["review", d.status === "changes" ? "Changes needed" : d.status === "rejected" ? "Not approved" : "In review"], ["approved", "Approved"], ["live", "Live"]], at, ["changes", "rejected"].includes(d.status))}
        <p class="p-status-note">${ST[1]}${d.listing ? ` <a href="${esc(d.listing.replace(/^https:\/\/omarchystore\.com/, ""))}">Open your store page →</a>` : ""}</p>
        <div class="p-cols">
          <section class="p-card"><h2>Messages</h2>${thread(d.messages, "You")}
            <form class="p-reply" data-p-reply="dev"><textarea name="body" rows="3" maxlength="2000" placeholder="Write to the Omarchy Store team…"></textarea>
              <div class="form-err" hidden></div><button class="btn" type="submit">${pi("send")} Send</button></form>
            ${d.telegram_linked ? `<p class="small muted">${ico("ok")} You get Telegram alerts for this submission.</p>` : `<a class="btn ghost" href="https://t.me/OmarchyStoreBot?start=dev_${d.id}" target="_blank" rel="noopener">Get updates on Telegram</a>`}
          </section>
          <section class="p-card"><h2>Your submission</h2>
            <dl class="p-rv-facts">
              <div><dt>Company</dt><dd>${esc(d.company || "—")}</dd></div><div><dt>Submitted</dt><dd>${fmtDate(d.ts)}</dd></div>
              <div><dt>Source</dt><dd>${httpsOk(d.repo_url) ? `<a href="${esc(d.repo_url)}" target="_blank" rel="noopener">${esc(d.repo_url.replace(/^https:\/\//, ""))}</a>` : "—"}</dd></div>
              <div><dt>License</dt><dd>${esc(d.license || "—")}</dd></div><div><dt>Installs from</dt><dd>${esc(d.install_hint || "—")}</dd></div>
              <div><dt>Price</dt><dd>${d.wants_paid ? `$${esc(d.price_usd)}` : "Free"}</dd></div>
            </dl>
            ${d.screenshots?.length ? `<div class="p-rv-shots">${d.screenshots.map((s) => httpsOk(s) ? `<img src="${esc(s)}" alt="" referrerpolicy="no-referrer" loading="lazy" onerror="this.outerHTML='<span class=p-badimg>Image link is broken</span>'">` : "").join("")}</div>` : ""}
            ${editable ? `<button class="btn ghost" type="button" data-p-edit>${pi("edit")} Edit and resend</button>` : ""}
          </section>
        </div>
        ${editable ? `<form class="p-card p-form" id="dev-update" hidden><h2>Update your submission</h2>
          <div class="fgrid">
            ${pField("Tagline", `<input name="tagline" maxlength="90" value="${esc(d.tagline || "")}">`, "", true)}
            ${pField("Source repository", `<input name="repo_url" value="${esc(d.repo_url || "")}">`, "", true)}
            ${pField("Logo link", `<input name="logo_url" value="${esc(d.logo_url || "")}">`, "", true)}
            ${pField("Screenshot links", `<textarea name="screenshots" rows="4">${esc((d.screenshots || []).join("\n"))}</textarea>`, "(one per line)", true)}
            ${pField("Write-up", `<textarea name="app_desc" rows="8" maxlength="3000">${esc(d.app_desc || "")}</textarea>`, "", true)}
            ${pField("App website", `<input name="app_url" value="${esc(d.app_url || "")}">`)}
            ${pField("Installs from", `<input name="install_hint" value="${esc(d.install_hint || "")}" placeholder="aur:my-app">`)}
            ${pField("What changed?", `<input name="note" maxlength="300" placeholder="Added two screenshots">`, "(optional)", true)}
          </div><div class="form-err" hidden></div>
          <div class="p-nav"><button class="btn ghost" type="button" data-p-edit>Cancel</button><button class="btn" type="submit">Send update</button></div>
          <input type="hidden" name="category" value="${esc(d.category || "")}"><input type="hidden" name="license" value="${esc(d.license || "")}"></form>` : ""}
        <p class="small muted">${pi("lock")} This page is private. Anyone with this link can see it, so only share it with your team.</p>
        ${footer()}`;
      el.dataset.d = JSON.stringify({ id: d.id });
    } catch (e) {
      el.innerHTML = `<div class="p-card" style="max-width:620px;margin:40px auto;text-align:center"><h2>We couldn't open that submission</h2><p class="muted">${esc(e.message)}. Check the link from your confirmation, or <a style="color:var(--accent)" href="/contact/">contact us</a> and we'll send a new one.</p><a class="btn" href="/submit/">Go to Submit an app</a></div>`;
    }
  }

  // ---------------------------------------------------------------- Advertisers
  // Every slot carries the EXACT artwork spec. Advertisers supply finished artwork at these
  // sizes — we do not redraw or re-crop it. Artwork at the wrong aspect has to be either
  // letterboxed (black bars) or cropped (cutting someone's logo off), and both look bad.
  const SLOTS = [
    { id: "banner", name: "Discover billboard", where: "A wide banner between shelves on the store's front page — the first thing people see.", best: "Brand launches, products, services",
      w: 2400, h: 900, safe: "Keep logos and text inside the middle 80% — the edges are trimmed on narrow screens." },
    { id: "sponsored-app", name: "Sponsored listing", where: "Your app at the top of its category and in search results, with a small Ad badge.", best: "Apps already in the store",
      w: 512, h: 512, safe: "Square app icon. No rounded corners or drop shadows — the store adds those." },
    { id: "search", name: "Search banner", where: "A compact banner under search results, shown when people are looking for something.", best: "Tools and services people search for",
      w: 1600, h: 400, safe: "Short headline only. Anything smaller than 24px at this size is unreadable on a phone." },
    { id: "artist", name: "Artist spotlight", where: "A full-width music feature with your artwork, play and follow buttons.", best: "Musicians, labels, podcasts",
      w: 1920, h: 560, safe: "Put the face or focal point left of centre; the right third carries your logo." },
  ];
  const ART_RULES = [
    "PNG, JPG or WebP. Under 2 MB.",
    "Exact pixel size please — we don't resize, stretch or crop artwork.",
    "No watermarks, and no AI-generator sparkle marks.",
    "Supply it at 2x if you have it (e.g. 3840×1120); we'll downscale cleanly.",
  ];
  const slotSpec = (s) => !s.w ? "" : `<div class="p-spec">
      <div class="p-spec-dim"><b>${s.w} × ${s.h}</b><span>pixels${s.w === s.h ? " (square)" : ` · ${ratio(s.w, s.h)}`}</span></div>
      <p class="small muted">${esc(s.safe)}</p>
    </div>`;
  function ratio(w, h) {           // smallest whole-number aspect, e.g. 1920×560 -> 24:7
    const g = (a, b) => (b ? g(b, a % b) : a), d = g(w, h);
    return `${w / d}:${h / d}`;
  }
  const BUDGETS = ["Not sure yet", "Under $250", "$250–$1,000", "$1,000–$5,000", "$5,000+"];
  function slotMock(id) {
    const shelf = `<div class="sm-shelf"><i></i><i></i><i></i><i></i></div>`;
    if (id === "banner") return `<div class="sm"><div class="sm-hero"></div>${shelf}<div class="sm-ad wide">Your brand</div>${shelf}</div>`;
    if (id === "sponsored-app") return `<div class="sm"><div class="sm-title"></div><div class="sm-row ad"><b></b><span>Ad</span></div><div class="sm-row"><b></b></div><div class="sm-row"><b></b></div></div>`;
    if (id === "search") return `<div class="sm"><div class="sm-search">${pi("search")}</div><div class="sm-row"><b></b></div><div class="sm-row"><b></b></div><div class="sm-ad slim">Your banner</div></div>`;
    return `<div class="sm"><div class="sm-ad art"><span>▶</span>Your music</div>${shelf}</div>`;
  }
  function adPreview(d) {
    const slot = d.slot || "banner", title = d.headline || "Your headline here", body = d.body || "One short line about what you offer.", cta = d.cta || "Learn more";
    if (slot === "sponsored-app") {
      const a = S.byId[d.app];
      return a ? `<div class="lockup ad-app">${iconImg(a, 64)}<div class="meta"><div class="name"><span class="ad-badge">Ad</span>${esc(a.name)}</div><div class="sub">${esc(a.summary)}</div><div class="stars">Sponsored by ${esc(d.company || a.developer)}</div></div></div>`
        : `<p class="muted small">Pick your app above to see the preview.</p>`;
    }
    if (slot === "artist") return `<div class="p-ad-artist" style="${httpsOk(d.image_url) ? `background-image:url('${esc(d.image_url)}')` : ""}"><span class="ad-chip">Sponsored</span><h3>${esc(title)}</h3><span class="cta">${esc(cta)}</span></div>`;
    return `<div class="ad-banner p-ad-pv" style="${httpsOk(d.image_url) ? `background:linear-gradient(90deg,rgba(0,0,0,.65),rgba(0,0,0,.1)),url('${esc(d.image_url)}') center/cover` : "background:linear-gradient(120deg,#1a1b26,#7aa2f7)"}${slot === "search" ? ";padding:18px 22px" : ""}">
      <div><span class="ad-chip">Sponsored</span><h3 ${slot === "search" ? 'style="font-size:18px"' : ""}>${esc(title)}</h3><p>${esc(body)}</p></div><span class="cta">${esc(cta)}</span></div>`;
  }

  function pageAdvertise() {
    if (qs("status")) return `<div class="page p-page" id="p-status" data-kind="ad"><div class="p-loading">Loading your campaign…</div></div>`;
    const links = myLinks().filter((l) => l.kind === "ad");
    const d = { slot: "banner" };
    return `<div class="page p-page">
      <section class="p-hero ads">
        <div class="p-hero-copy">
          <div class="eyebrow">ADVERTISE WITH US</div>
          <h1>Put your brand where Omarchy users discover software.</h1>
          <p>Reach the developers, creators and power users who chose their own desktop — on the web and inside the Omarchy Store app. Clearly labelled, no tracking, and you pay in crypto.</p>
          <div class="p-cta"><a class="btn big" href="#ad-book" data-p-jump="ad-book">Plan a campaign</a>
            ${links.length ? `<a class="btn ghost" href="${esc(links[0].url)}">Check my campaign</a>` : `<span class="p-hint">Request a quote · we reply in 1–2 days</span>`}</div>
        </div>
        <div class="p-hero-art" aria-hidden="true"><div class="p-hero-ad">${adPreview({ headline: "Your brand, front and center", body: "Seen by Linux power users every day.", cta: "Learn more" })}</div></div>
      </section>

      <div class="p-benefits">
        <div><span>${pi("users")}</span><b>A rare audience</b><p>Developers and Linux power users who are hard to reach anywhere else.</p></div>
        <div><span>${ico("globe")}</span><b>Web + desktop app</b><p>Your ad shows on omarchystore.com and inside the desktop store.</p></div>
        <div><span>${ico("shield")}</span><b>Trusted, not creepy</b><p>No tracking pixels, no third-party cookies. Every ad is labelled.</p></div>
        <div><span>${pi("coin")}</span><b>Pay in crypto</b><p>USDC, ETH, SOL, Bitcoin or XRP. No card fees, no middlemen.</p></div>
      </div>

      <section class="shelf"><div class="shelf-head"><h2>Placements</h2><span class="muted small">Pick one to start</span></div>
        <div class="p-slots">${SLOTS.map((s) => `<button type="button" class="p-slot" data-p-slot="${s.id}">${slotMock(s.id)}<b>${s.name}</b><p>${s.where}</p><span class="muted small">Best for: ${s.best}</span>${slotSpec(s)}<span class="p-go">Choose →</span></button>`).join("")}</div>
        <div class="p-card p-artrules"><h3>Artwork we need from you</h3>
          <p class="muted small">Send finished artwork at the exact size for your slot. We place it as supplied — we don't redraw, stretch or crop it, so a wrong-sized file either gets bars down the sides or has part of your logo cut off.</p>
          <ul class="usb-list">${ART_RULES.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>
        </div></section>

      ${links.length ? `<section class="shelf"><div class="shelf-head"><h2>Your campaigns</h2><span class="muted small">Saved in this browser</span></div>
        <div class="p-mine">${links.map((l) => `<a class="p-mine-row" href="${esc(l.url)}">${ico("megaphone")}<b>${esc(l.name)}</b><span class="muted small">Requested ${fmtDate(l.ts)}</span><span class="p-go">Open status →</span></a>`).join("")}</div></section>` : ""}

      <section class="shelf" id="ad-book"><div class="shelf-head"><h2>Request a quote</h2><span class="muted small">No payment now — we reply with price and availability</span></div>
        <div class="p-wizard">
          <form id="ad-form" class="p-form" novalidate>
            <div class="p-step-h"><h3>1 · Placement and dates</h3></div>
            <div class="p-choice four">${SLOTS.map((s) => `<label class="p-opt ${s.id === d.slot ? "on" : ""}"><input type="radio" name="slot" value="${s.id}" ${s.id === d.slot ? "checked" : ""}><b>${s.name}</b></label>`).join("")}</div>
            ${(() => { const s = SLOTS.find((x) => x.id === d.slot); return s && s.w
              ? `<p class="p-spec-line">Artwork for <b>${esc(s.name)}</b>: <b>${s.w} × ${s.h}</b> pixels${s.w === s.h ? "" : ` (${ratio(s.w, s.h)})`}, PNG/JPG/WebP, under 2 MB. ${esc(s.safe)}</p>` : ""; })()}
            <div class="fgrid">
              <label class="wide p-app-pick" hidden>App to sponsor <input name="app" list="p-apps" placeholder="Start typing an app name…" autocomplete="off"><datalist id="p-apps">${S.catalog.apps.slice(0, 2000).map((a) => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join("")}</datalist></label>
              ${pField("Start date", `<input name="starts" type="date">`)}
              ${pField("End date", `<input name="ends" type="date">`)}
              ${pField("Budget", `<select name="budget">${BUDGETS.map((b) => `<option>${b}</option>`).join("")}</select>`, "(helps us suggest the right slot)", true)}
            </div>
            <div class="p-step-h"><h3>2 · Your ad</h3><p>We'll polish it with you before it goes live.</p></div>
            <div class="fgrid p-creative">
              ${pField("Headline", `<input name="headline" maxlength="60" placeholder="Linux-native hosting with a free tier">`, "", true)}
              ${pField("One line of copy", `<input name="body" maxlength="140" placeholder="Deploy in seconds. No credit card needed.">`, "", true)}
              ${pField("Button text", `<input name="cta" maxlength="24" placeholder="Try it free">`)}
              ${pField("Link", `<input name="url" type="url" maxlength="300" placeholder="https://">`)}
              ${pField("Artwork link", `<input name="image_url" type="url" maxlength="400" placeholder="https://… (2400×900 for billboards)">`, "(optional — we copy it to our server, so no tracking)", true)}
            </div>
            <div class="p-pv-label">${pi("eye")} Live preview</div>
            <div class="p-ad-preview" id="ad-preview">${adPreview(d)}</div>
            <div class="p-step-h"><h3>3 · About you</h3></div>
            <div class="fgrid">
              ${pField("Company or brand", `<input name="company" maxlength="80">`)}
              ${pField("Your name", `<input name="name" maxlength="80">`)}
              ${pField("Email", `<input name="email" type="email" maxlength="120">`)}
              ${pField("Website", `<input name="website" type="url" maxlength="200" placeholder="https://">`, "(optional)")}
              ${pField("Telegram", `<input name="telegram" maxlength="40" placeholder="@yourname">`, "(optional)")}
              ${pField("Anything else?", `<textarea name="notes" rows="3" maxlength="1500" placeholder="Goals, audience, questions…"></textarea>`, "(optional)", true)}
            </div>
            <label class="check"><input type="checkbox" name="agree"> My ad follows the policy below, and I understand every ad is labelled Sponsored.</label>
            <div class="ts-box"></div>
            <div class="form-err" hidden></div>
            <div class="p-nav"><span></span><button class="btn big" type="submit">Request a quote</button></div>
          </form>
          <aside class="p-preview p-faq-side">
            <div class="p-pv-label">${pi("clock")} What happens next</div>
            <ol class="p-mini-steps"><li><b>We reply with a quote</b>Price and available dates, usually within 1–2 days.</li><li><b>You approve and pay</b>In crypto, from your private campaign page.</li><li><b>Your ad goes live</b>On the dates you picked. We send you click numbers.</li></ol>
          </aside>
        </div></section>

      <section class="shelf"><div class="shelf-head"><h2>Ad policy</h2></div>
        <div class="p-policy"><div><h3>${ico("ok")} We accept</h3><p>Developer tools, hardware, hosting, VPNs and privacy tools, Linux-friendly software and services, courses, conferences, and music.</p></div>
          <div><h3>${ico("warn")} We don't accept</h3><p>Gambling, malware or "PC cleaner" software, token promotions, or misleading claims.</p></div>
          <div><h3>${ico("shield")} Respectful by design</h3><p>Every ad is labelled <b>Sponsored</b> or <b>Ad</b>. Ads never change Top Charts or search ranking. No tracking pixels and no third-party cookies.</p></div></div></section>
      ${footer()}
    </div>`;
  }

  async function loadAdStatus(el) {
    const id = qs("status"), t = qs("t");
    try {
      const a = await pGet(`/ads/status?id=${encodeURIComponent(id)}&t=${encodeURIComponent(t)}`);
      saveLink("ad", a.id, location.pathname + location.search, `${a.company} — ${(SLOTS.find((s) => s.id === a.slot) || {}).name || a.slot}`);
      const ST = { new: ["Received", "We're looking at your request and will reply with a quote."], quoted: ["Quote ready", "Your quote is below. Pay when you're ready and we'll book your dates."],
        approved: ["Approved", "Approved — pay below to lock in your dates."], paid: ["Paid", "Payment received. We're setting up your ad."], live: ["Live", "Your ad is live!"],
        declined: ["Declined", "We can't run this campaign. See our message below."], done: ["Finished", "This campaign has ended. Thanks for advertising with us!"] }[a.status] || [a.status, ""];
      const at = { new: "new", quoted: "quoted", approved: "quoted", paid: "paid", live: "live", done: "live", declined: "quoted" }[a.status];
      const canPay = ["quoted", "approved"].includes(a.status) && a.quote_usd > 0;
      el.innerHTML = `${backBtn()}
        <section class="p-status-head"><div class="p-mock-ico p-ad-ico">${ico("megaphone")}</div>
          <div><div class="eyebrow">CAMPAIGN #${a.id}</div><h1>${esc(a.company)}</h1><p>${esc((SLOTS.find((s) => s.id === a.slot) || {}).name || a.slot)} · ${esc(a.starts)} → ${esc(a.ends)}</p></div>
          <span class="p-pill ${a.status}">${ST[0]}</span></section>
        ${tracker([["new", "Request received"], ["quoted", "Quote"], ["paid", "Paid"], ["live", "Live"]], at, a.status === "declined")}
        <p class="p-status-note">${ST[1]}</p>
        ${a.quote_usd ? `<section class="p-card p-quote"><div><div class="eyebrow">YOUR QUOTE</div><div class="p-price">$${Number(a.quote_usd).toLocaleString()}</div><p class="muted small">${esc((SLOTS.find((s) => s.id === a.slot) || {}).name)} · ${esc(a.starts)} → ${esc(a.ends)}</p></div>
          ${canPay ? `<div class="p-pay"><label>Pay with<select id="ad-chain">${(a.payments || []).map((m) => `<option value="${m.id}" ${m.recommended ? "selected" : ""}>${esc(m.name)}</option>`).join("")}</select></label><button class="btn big" type="button" data-p-adpay>Pay now</button></div>`
            : a.order?.status === "paid" || a.status === "paid" || a.status === "live" ? `<span class="p-pill live">Paid ✓</span>` : ""}
          <div id="ad-invoice"></div></section>` : ""}
        <div class="p-cols">
          <section class="p-card"><h2>Messages</h2>${thread(a.messages, "You")}
            <form class="p-reply" data-p-reply="ad"><textarea name="body" rows="3" maxlength="2000" placeholder="Write to the Omarchy Store team…"></textarea>
              <div class="form-err" hidden></div><button class="btn" type="submit">${pi("send")} Send</button></form></section>
          <section class="p-card"><h2>Your ad</h2><div class="p-ad-preview">${adPreview({ ...a, body: a.body })}</div>
            <dl class="p-rv-facts"><div><dt>Link</dt><dd>${esc(a.url || "—")}</dd></div><div><dt>Budget</dt><dd>${esc(a.budget || "—")}</dd></div><div><dt>Contact</dt><dd>${esc(a.name)} · ${esc(a.email)}</dd></div></dl></section>
        </div>
        <p class="small muted">${pi("lock")} This page is private. Anyone with this link can see it, so only share it with your team.</p>
        ${footer()}`;
    } catch (e) {
      el.innerHTML = `<div class="p-card" style="max-width:620px;margin:40px auto;text-align:center"><h2>We couldn't open that campaign</h2><p class="muted">${esc(e.message)}. Check the link from your confirmation, or <a style="color:var(--accent)" href="/contact/">contact us</a>.</p><a class="btn" href="/advertise/">Go to Advertise</a></div>`;
    }
  }
  function adCapture(f) {
    const d = {}; for (const el of f.elements) if (el.name && (el.type !== "radio" || el.checked)) d[el.name] = el.type === "checkbox" ? el.checked : el.value.trim();
    return d;
  }
  function adRefresh(f) {
    const d = adCapture(f);
    f.querySelectorAll(".p-opt").forEach((o) => o.classList.toggle("on", o.querySelector("input").checked));
    f.querySelector(".p-app-pick").hidden = d.slot !== "sponsored-app";
    f.querySelector(".p-creative").hidden = d.slot === "sponsored-app";
    $("#ad-preview").innerHTML = adPreview(d);
  }
  async function adInvoice(btn) {
    const box = $("#ad-invoice"), chain = $("#ad-chain").value;
    btn.disabled = true; btn.textContent = "Creating invoice…";
    try {
      const o = await pPost("/ads/pay", { id: qs("status"), t: qs("t"), chain });
      box.innerHTML = `<div class="p-invoice"><p>Send <b>exactly</b> this amount. The extra digits identify your payment.</p>
        <div class="p-linkbox"><span class="muted small">Amount</span><code>${esc(o.amount)} ${esc(o.coin)}</code><button class="btn ghost" type="button" data-copy="${esc(o.amount)}">Copy</button></div>
        <div class="p-linkbox"><span class="muted small">To (${esc(o.network)})</span><code>${esc(o.address)}</code><button class="btn ghost" type="button" data-copy="${esc(o.address)}">Copy</button></div>
        ${o.tag ? `<div class="p-linkbox"><span class="muted small">Destination tag</span><code>${esc(o.tag)}</code><button class="btn ghost" type="button" data-copy="${esc(o.tag)}">Copy</button></div>` : ""}
        <div class="p-cta"><a class="btn" href="${esc(o.uri)}">Open in wallet</a><span class="muted small" id="ad-paystate">Waiting for payment… this page checks automatically.</span></div></div>`;
      btn.hidden = true;
      const poll = async () => {
        if (!document.body.contains(box)) return;
        try { const s = await pGet(`/orders/${o.id}`); if (s.status === "paid") { $("#ad-paystate").textContent = "Paid ✓ — thank you!"; setTimeout(route, 1500); return; } if (s.status === "seen") $("#ad-paystate").textContent = "Payment seen — waiting for confirmations…"; } catch {}
        setTimeout(poll, 20000);
      };
      setTimeout(poll, 20000);
    } catch (e) { box.innerHTML = `<p class="form-err">${esc(e.message)}</p>`; btn.disabled = false; btn.textContent = "Pay now"; }
  }

  // ---------------------------------------------------------------- Donate
  const COINS = [
    { id: "btc", name: "Bitcoin", sym: "BTC", net: "Bitcoin network", addr: "", uri: (a) => `bitcoin:${a}`, color: "#f7931a",
      glyph: '<circle cx="16" cy="16" r="16" fill="#f7931a"/><path fill="#fff" d="M22.6 14c.3-2-1.2-3.1-3.3-3.8l.7-2.7-1.6-.4-.7 2.6-1.3-.3.7-2.7-1.7-.4-.6 2.7-1-.3-2.3-.5-.4 1.7s1.2.3 1.2.3c.7.2.8.6.8 1l-.8 3.1.2.1-.2-.1-1.1 4.4c-.1.2-.3.5-.8.4l-1.2-.3-.8 1.9 2.2.5 1.2.3-.7 2.8 1.7.4.7-2.7 1.3.3-.7 2.7 1.7.4.7-2.8c2.8.5 5 .3 5.9-2.3.7-2.1 0-3.3-1.5-4.1 1.1-.3 1.9-1 2.1-2.5zm-3.8 5.3c-.5 2.1-4 1-5.2.7l.9-3.7c1.2.3 4.8.9 4.3 3zm.5-5.4c-.5 1.9-3.4.9-4.3.7l.8-3.4c1 .2 4 .7 3.5 2.7z"/>' },
    { id: "evm", name: "Ethereum & Base", sym: "ETH · USDC", net: "Ethereum or Base", addr: "", uri: (a) => `ethereum:${a}`, color: "#627eea",
      glyph: '<circle cx="16" cy="16" r="16" fill="#627eea"/><path fill="#fff" fill-opacity=".6" d="M16.5 4v8.9l7.5 3.3z"/><path fill="#fff" d="M16.5 4 9 16.2l7.5-3.3z"/><path fill="#fff" fill-opacity=".6" d="M16.5 22v6L24 17.6z"/><path fill="#fff" d="M16.5 28v-6L9 17.6z"/><path fill="#fff" fill-opacity=".2" d="m16.5 20.6 7.5-4.4-7.5-3.3z"/><path fill="#fff" fill-opacity=".6" d="m9 16.2 7.5 4.4v-7.7z"/>' },
    { id: "sol", name: "Solana", sym: "SOL · USDC", net: "Solana", addr: "", uri: (a) => `solana:${a}`, color: "#9945ff",
      glyph: '<defs><linearGradient id="solg" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#9945ff"/><stop offset="1" stop-color="#14f195"/></linearGradient></defs><circle cx="16" cy="16" r="16" fill="#111"/><path fill="url(#solg)" d="M10.3 19.6a.6.6 0 0 1 .4-.2h12.6c.3 0 .4.3.2.5l-2.5 2.5a.6.6 0 0 1-.4.2H8c-.3 0-.4-.3-.2-.5zm0-9.4a.6.6 0 0 1 .4-.2h12.6c.3 0 .4.3.2.5L21 13a.6.6 0 0 1-.4.2H8c-.3 0-.4-.3-.2-.5zm11.4 4.7a.6.6 0 0 0-.4-.2H8.7c-.3 0-.4.3-.2.5l2.5 2.5c.1.1.3.2.4.2h12.6c.3 0 .4-.3.2-.5z"/>' },
    { id: "xrp", name: "XRP", sym: "XRP", net: "XRP Ledger", addr: "", uri: null, color: "#23292f",
      glyph: '<circle cx="16" cy="16" r="16" fill="#23292f"/><path fill="#fff" d="M23 8h2.9l-6 5.9a5.6 5.6 0 0 1-7.8 0L6.1 8H9l4.6 4.5a3.5 3.5 0 0 0 4.8 0zM9 24H6.1l6-6a5.6 5.6 0 0 1 7.8 0l6 6H23l-4.6-4.5a3.5 3.5 0 0 0-4.8 0z"/>' },
  ];
  const coinIcon = (c, s = 40) => `<svg viewBox="0 0 32 32" width="${s}" height="${s}" aria-hidden="true">${c.glyph}</svg>`;

  function pageDonate() {
    return `<div class="page p-page">
      <section class="p-hero donate">
        <div class="p-hero-copy">
          <div class="eyebrow">SUPPORT THE PROJECT</div>
          <h1>Keep Omarchy Store free.</h1>
          <p>No paywalls, no tracking, no selling your data. The world's largest app store for Omarchy is built by its founder and the community — your donation keeps it running, growing and independent.</p>
          <div class="p-cta"><a class="btn big p-heart-btn" href="#coins" data-p-jump="coins">${pi("heart")} Donate with crypto</a><span class="p-hint">Goes straight to the founder's wallet</span></div>
        </div>
        <div class="p-hero-art" aria-hidden="true"><div class="p-coin-orbit">${COINS.map((c, i) => `<span style="--i:${i}">${coinIcon(c, 64)}</span>`).join("")}<b>${pi("heart")}</b></div></div>
      </section>

      <section class="shelf" id="coins"><div class="shelf-head"><h2>Choose a coin</h2><span class="muted small">${COINS.some((c) => c.addr) ? "Any amount helps" : "Back shortly"}</span></div>
        ${COINS.some((c) => c.addr) ? "" : `<div class="p-card" style="padding:28px;text-align:center">
          <h3 style="margin:0 0 8px">Donations are paused</h3>
          <p class="muted" style="margin:0">We're moving to new donation addresses. Nothing is being collected right now — please check back soon.</p></div>`}
        ${!COINS.some((c) => c.addr) ? "" : `<div class="p-coins">${COINS.filter((c) => c.addr).map((c) => `<article class="p-coin" style="--c:${c.color}">
          <header>${coinIcon(c)}<div><b>${c.name}</b><span>${c.sym}</span></div></header>
          <img class="p-qr" src="${S.desktop ? SITE : "/"}assets/donate/${c.id}.svg" alt="QR code for the ${c.name} address" width="168" height="168">
          <div class="p-addr"><code>${c.addr}</code></div>
          <div class="p-coin-acts"><button class="btn" type="button" data-copy="${c.addr}" data-p-donate="${c.id}">Copy address</button>${c.uri ? `<a class="btn ghost" href="${c.uri(c.addr)}" data-p-donate="${c.id}">Open in wallet</a>` : ""}</div>
          <p class="p-warn">${ico("warn")}<span>Send only on <b>${c.net}</b>. Other networks can lose your coins.</span></p>
        </article>`).join("")}</div>`}
        <p class="small muted" style="margin-top:12px">${ico("ok")} Every address is checksum-verified. Donations go directly to the founder's own wallet — the store never holds your money. Crypto donations aren't refundable and aren't tax-deductible.</p></section>

      <section class="shelf"><div class="shelf-head"><h2>Where your support goes</h2></div>
        <div class="p-benefits three">
          <div><span>${ico("code")}</span><b>New features</b><p>The desktop app, Ignite, SnapDock, the browser — and what comes next.</p></div>
          <div><span>${ico("shield")}</span><b>Safety reviews</b><p>Checking every submitted app before it reaches your desktop.</p></div>
          <div><span>${ico("globe")}</span><b>Staying free</b><p>Hosting, domains and services, so the store never needs a paywall.</p></div>
        </div></section>

      <section class="shelf"><div class="shelf-head"><h2>Supporters</h2><button class="p-link" type="button" data-p-wall>Add your name</button></div>
        <div id="p-wall" class="p-wall"><p class="muted small">Loading…</p></div>
        <form id="sup-form" class="p-card p-form" hidden><h3>Add your name to the wall</h3><p class="muted small">Thank you! Names appear after a quick check. No links, please.</p>
          <div class="fgrid">${pField("Name or nickname", `<input name="name" maxlength="40">`)}${pField("Coin you sent", `<select name="chain"><option value="">Prefer not to say</option>${COINS.map((c) => `<option value="${c.id}">${c.name}</option>`).join("")}</select>`)}
          ${pField("Short message", `<input name="message" maxlength="140" placeholder="Keep it going!">`, "(optional)", true)}</div>
          <div class="ts-box"></div><div class="form-err" hidden></div><div class="p-nav"><span></span><button class="btn" type="submit">Add me</button></div></form></section>

      <section class="shelf"><div class="shelf-head"><h2>Other ways to help</h2></div>
        <div class="info-cards">
          <a class="info-card" href="${REPO}" target="_blank" rel="noopener"><span class="go-n">${ico("star")}</span><div><h3>Star us on GitHub</h3><p>It helps more people find the store.</p></div></a>
          <a class="info-card" href="/submit/"><span class="go-n">${ico("plus")}</span><div><h3>Submit an app</h3><p>Made something great? List it for free.</p></div></a>
          <a class="info-card" href="/advertise/"><span class="go-n">${ico("megaphone")}</span><div><h3>Advertise</h3><p>Reach Omarchy users and support the store.</p></div></a>
        </div></section>
      ${footer()}
    </div>`;
  }
  async function loadWall() {
    const el = $("#p-wall"); if (!el) return;
    try {
      const d = await pGet("/donate");
      el.innerHTML = d.supporters.length ? d.supporters.map((s) => { const c = COINS.find((x) => x.id === s.chain);
        return `<div class="p-sup">${c ? coinIcon(c, 22) : `<span class="p-sup-h">${pi("heart")}</span>`}<div><b>${esc(s.name)}</b>${s.message ? `<span>${esc(s.message)}</span>` : ""}</div></div>`; }).join("")
        : `<p class="muted small">Be the first name on the wall. ${pi("heart")}</p>`;
    } catch { el.innerHTML = `<p class="muted small">Couldn't load the wall right now.</p>`; }
  }

  // ---------------------------------------------------------------- events
  function portalAfter(p) {
    if (p === "submit") { const s = $("#p-status"); if (s) loadDevStatus(s); else devRefresh(draft()); if (P.step === DEV_STEPS.length - 1) { const b = $("#dev-form .ts-box"); if (b) turnstileMount(b); } }
    if (p === "advertise") { const s = $("#p-status"); if (s) loadAdStatus(s); else { const b = $("#ad-form .ts-box"); if (b) turnstileMount(b); const f = $("#ad-form"); if (f) adRefresh(f); } }
    if (p === "donate") loadWall();
    if (location.hash && ["submit", "advertise", "donate"].includes(p)) setTimeout(() => document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: "start" }), 50);
  }
  document.addEventListener("input", (e) => {
    const f = e.target.closest("#dev-form"); if (f) devRefresh(devCapture(f));
    const a = e.target.closest("#ad-form"); if (a) adRefresh(a);
  });
  document.addEventListener("change", (e) => {
    const f = e.target.closest("#dev-form"); if (f) devRefresh(devCapture(f));
    const a = e.target.closest("#ad-form"); if (a) adRefresh(a);
  });
  document.addEventListener("click", (e) => {
    const t = e.target.closest("[data-p-next],[data-p-back],[data-p-step],[data-p-clear],[data-p-jump],[data-p-slot],[data-p-edit],[data-p-wall],[data-p-adpay],[data-p-donate],[data-ad]");
    if (!t) return;
    if (t.matches("[data-ad]")) { trackEvent("ad", t.dataset.ad); return; }
    if (t.matches("[data-p-donate]")) { trackEvent("donate", t.dataset.pDonate); return; }
    if (t.matches("[data-p-jump]")) { e.preventDefault(); document.getElementById(t.dataset.pJump)?.scrollIntoView({ behavior: "smooth", block: "start" }); return; }
    const f = $("#dev-form");
    if (t.matches("[data-p-next]") && f) {
      const d = devCapture(f), m = devCheck(P.step, d);
      if (m) { const er = f.querySelector(".form-err"); er.textContent = m; er.hidden = false; return; }
      devGoto(P.step + 1);
    } else if (t.matches("[data-p-back]") && f) { devCapture(f); devGoto(P.step - 1); }
    else if (t.matches("[data-p-step]") && f) {
      const want = Number(t.dataset.pStep), d = devCapture(f);
      for (let i = 0; i < want; i++) { const m = devCheck(i, d); if (m) { devGoto(i); const er = $("#dev-form .form-err"); er.textContent = m; er.hidden = false; return; } }
      devGoto(want);
    } else if (t.matches("[data-p-clear]")) { if (confirm("Clear the form and start over?")) { try { localStorage.removeItem(P.draft); } catch {} P.step = 0; devGoto(0); } }
    else if (t.matches("[data-p-slot]")) {
      const r = document.querySelector(`#ad-form input[name="slot"][value="${t.dataset.pSlot}"]`);
      if (r) { r.checked = true; adRefresh($("#ad-form")); }
      $("#ad-book")?.scrollIntoView({ behavior: "smooth", block: "start" });
    } else if (t.matches("[data-p-edit]")) { const u = $("#dev-update"); if (u) { u.hidden = !u.hidden; if (!u.hidden) u.scrollIntoView({ behavior: "smooth" }); } }
    else if (t.matches("[data-p-wall]")) { const s = $("#sup-form"); s.hidden = !s.hidden; if (!s.hidden && !s.dataset.ts) { s.dataset.ts = 1; turnstileMount(s.querySelector(".ts-box")); } }
    else if (t.matches("[data-p-adpay]")) adInvoice(t);
  });
  document.addEventListener("submit", async (e) => {
    const f = e.target;
    if (f.matches("#dev-form")) { e.preventDefault(); devSubmit(f); }
    else if (f.matches("#ad-form")) {
      e.preventDefault();
      const d = adCapture(f), er = f.querySelector(".form-err");
      const bad = !d.starts || !d.ends ? "Pick a start and end date" : d.ends < d.starts ? "The end date is before the start date"
        : d.slot === "sponsored-app" && !S.byId[d.app] ? "Pick the app you want to sponsor from the list"
        : d.slot !== "sponsored-app" && d.headline.length < 3 ? "Add a headline for your ad" : d.slot !== "sponsored-app" && !httpsOk(d.url) ? "Add the link your ad should open (https://…)"
        : !d.company ? "Enter your company or brand" : !d.name ? "Enter your name" : !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(d.email) ? "Enter a valid email" : !d.agree ? "Please accept the ad policy" : "";
      if (bad) { er.textContent = bad; er.hidden = false; return; }
      submitForm(f, "/ads/request", d, (j) => {
        const path = j.url.replace(/^https:\/\/omarchystore\.com/, "");
        saveLink("ad", j.id, path, `${d.company} — ${(SLOTS.find((s) => s.id === d.slot) || {}).name}`);
        $("#ad-book").innerHTML = `<div class="p-done">${ico("ok")}<div><h3>Thanks, ${esc(d.name.split(" ")[0])} — your request is in</h3>
          <p>We'll reply with a quote and available dates, usually within 1–2 days. Everything happens on your private campaign page. <b>Save this link.</b></p>
          <div class="p-linkbox"><code>${esc(j.url)}</code><button class="btn" type="button" data-copy="${esc(j.url)}">Copy link</button></div>
          <div class="p-cta"><a class="btn" href="${esc(path)}">Open my campaign page</a></div></div></div>`;
      });
    } else if (f.matches("[data-p-reply]")) {
      e.preventDefault();
      const kind = f.dataset.pReply, body = f.body.value.trim(), er = f.querySelector(".form-err"), btn = f.querySelector("button");
      if (body.length < 2) { er.textContent = "Write a message first"; er.hidden = false; return; }
      btn.disabled = true;
      try { await pPost(kind === "dev" ? "/dev/message" : "/ads/message", { id: qs("status"), t: qs("t"), body }); toast("Message sent"); route(); }
      catch (x) { er.textContent = x.message; er.hidden = false; btn.disabled = false; }
    } else if (f.matches("#dev-update")) {
      e.preventDefault();
      const v = (n) => (f.elements[n]?.value || "").trim(), er = f.querySelector(".form-err"), btn = f.querySelector('[type="submit"]');
      btn.disabled = true; btn.textContent = "Sending…";
      try {
        await pPost("/dev/update", { id: qs("status"), t: qs("t"), tagline: v("tagline"), repo_url: v("repo_url"), logo_url: v("logo_url"), screenshots: v("screenshots").split(/\s+/).filter(Boolean),
          app_desc: v("app_desc"), app_url: v("app_url"), install_hint: v("install_hint"), category: v("category"), license: v("license"), note: v("note") });
        toast("Update sent — it's back in the review queue"); route();
      } catch (x) { er.textContent = x.message; er.hidden = false; btn.disabled = false; btn.textContent = "Send update"; }
    } else if (f.matches("#sup-form")) {
      e.preventDefault();
      submitForm(f, "/supporters", { name: f.elements.name.value, message: f.elements.message.value, chain: f.elements.chain.value }, () => {
        f.outerHTML = `<div class="p-done">${pi("heart")}<div><h3>Thank you!</h3><p>Your name will appear on the wall shortly.</p></div></div>`;
      });
    }
  });

  // ---------- Get Omarchy: the landing page for people who don't have Omarchy yet ----------
  function pageGetOmarchy() {
    const iso = S.catalog.omarchy_iso;
    const inst = `curl -fsSL ${SITE}install.sh | bash`;
    const shots = (S.catalog.themes || []).filter((t) => t.image && t.stars).slice(0, 6);
    const step = (n, title, body) => `<li class="go-step"><span class="go-n">${n}</span><div><h3>${title}</h3>${body}</div></li>`;
    return `<div class="page go">
      <section class="go-hero">
        <div class="go-copy">
          <div class="eyebrow">THE LINUX DESKTOP EVERYONE'S TALKING ABOUT</div>
          <h1>Get Omarchy.</h1>
          <p>Omarchy is a free, fast and beautiful desktop for your PC, made by DHH (creator of Ruby on Rails). It replaces Windows, or lives right next to it. Here's the whole thing, step by step, in about 15 minutes.</p>
          <div class="go-cta">
            ${S.desktop ? `<a class="btn big" href="/ignite/">Start: make the USB</a>` : `<a class="btn big" href="#step1">Start: make the USB</a>`}
            ${iso ? `<span class="muted small">Latest: Omarchy ${esc(iso.version)} · free · ${gb(iso.size)}</span>` : ""}
          </div>
        </div>
        <div class="go-mosaic">${shots.map((t) => `<img src="${esc(themeImg(t))}" alt="Omarchy with the ${esc(t.name)} theme" loading="eager">`).join("")}</div>
      </section>

      <section class="go-need">
        <div><b>A PC</b><span>Any 64-bit PC or laptop from the last ~10 years</span></div>
        <div><b>A USB stick</b><span>8 GB or bigger. It will be erased</span></div>
        <div><b>15 minutes</b><span>Most of it is waiting</span></div>
        <div><b>Keep Windows?</b><span>Yes, if you want. <a href="/ignite/#windows">How</a></span></div>
      </section>

      <ol class="go-steps">
        ${step(1, `<span id="step1"></span>Make the installer USB`, `
          <div class="go-two">
            <div class="go-opt">
              <div class="go-tag">On Windows or Mac</div>
              <ol class="usb-list">
                <li>${iso ? `<a class="btn" href="${esc(iso.url)}">Download Omarchy ${esc(iso.version)}</a>` : `<a class="btn" href="https://omarchy.org/" target="_blank" rel="noopener">Download Omarchy</a>`}</li>
                <li>Get free <a href="https://rufus.ie" target="_blank" rel="noopener">Rufus</a> (Windows) or <a href="https://etcher.balena.io" target="_blank" rel="noopener">balenaEtcher</a> (Windows &amp; Mac).</li>
                <li>Choose the Omarchy file, choose your USB stick, press <b>Start</b> / <b>Flash</b>. In Rufus pick <b>GPT</b>.</li>
              </ol></div>
            <div class="go-opt ignite-opt">
              <div class="go-tag"><img src="${asset("featured/ignite/icon-64.png")}" alt="">Already on Omarchy or Linux?</div>
              <p class="small">Use <b>Ignite</b> in the Omarchy Store app: it downloads the newest Omarchy, checks it's genuine and writes the USB in one click. Great for setting up a friend's PC.</p>
              <a class="btn ghost" href="/ignite/">Open Ignite</a></div>
          </div>`)}
        ${step(2, "Choose: replace Windows, or keep it", `
          <div class="go-two">
            <div class="go-opt"><div class="go-tag">Simplest</div><h4>Omarchy only</h4><p class="small">The installer uses the whole drive. <b>Everything on it is erased</b>, so back up your files first.</p></div>
            <div class="go-opt"><div class="go-tag">Keep Windows</div><h4>Omarchy next to Windows</h4><p class="small">Make some empty space on the drive first (about 2 minutes in Windows), then choose <b>Free space install</b>. You pick Windows or Omarchy every time you start the PC.</p><a class="btn ghost" href="/ignite/#windows">Show me how</a></div>
          </div>`)}
        ${step(3, "Install Omarchy", `<ol class="usb-list">
            <li>Plug in the USB stick and restart. Open the boot menu: usually <b>F12</b>, <b>F11</b>, <b>F8</b> or <b>Esc</b> right after power-on, and pick the USB stick.</li>
            <li>If it won't start, turn off <b>Secure Boot</b> in the BIOS settings.</li>
            <li>Answer a few questions (name, password, keyboard). Omarchy installs itself in a few minutes.</li></ol>`)}
        ${step(4, "Get the Omarchy Store", `<p class="small">Your new desktop is ready. Add the store to install apps, themes and SnapDock with one click:</p>
          <ol class="usb-list">
            <li>Press <b>Super + Enter</b> to open a terminal. (Super is the Windows key.)</li>
            <li>Paste this and press Enter:
              <div class="code"><code>${esc(inst)}</code><button class="btn" data-copy="${esc(inst)}">Copy</button></div></li>
            <li>Open <b>Omarchy Store</b> from the app launcher (<b>Super + Space</b>). Done.</li></ol>`)}
      </ol>

      <section class="shelf"><div class="shelf-head"><h2>Questions</h2></div>
        <div class="faq">
          <details><summary>Is Omarchy really free?</summary><p>Yes. Omarchy is free and open source. So is the Omarchy Store, and almost every app in it.</p></details>
          <details><summary>Will it erase my computer?</summary><p>Only if you choose to use the whole drive. To keep Windows and your files, follow "Keep Windows" in step 2 and choose Free space install. Always back up important files first.</p></details>
          <details><summary>Can I play games?</summary><p>Yes. Steam runs most Windows games on Omarchy, and the store has Steam, Heroic (Epic &amp; GOG), Lutris and more.</p></details>
          <details><summary>I'm coming from Windows. Will I feel lost?</summary><p>Install <a href="/app/snapdock/">SnapDock</a> from the store: a frosted glass dock and Windows-style window snapping, so it feels familiar from day one.</p></details>
          <details><summary>Who makes Omarchy?</summary><p>Omarchy is made by DHH and the Omarchy community. The Omarchy Store is an independent community project; we link to the official Omarchy download and don't change it.</p></details>
        </div></section>
      ${footer()}
    </div>`;
  }

  // ---------- USB maker ----------
  S.usb = null;
  const gb = (n) => (n / 1e9).toFixed(n >= 1e10 ? 0 : 1) + " GB";
  async function loadUsb() {
    try { S.usb = await (await fetch("/api/usb", { cache: "no-store" })).json(); } catch { S.usb = { error: true }; }
    if (["usb", "ignite"].includes(currentPath())) rerender();
    const st = S.usb?.download?.state;
    clearTimeout(loadUsb.t);
    if (["usb", "ignite"].includes(currentPath())) loadUsb.t = setTimeout(loadUsb, st === "downloading" || st === "verifying" ? 1000 : 4000);
  }
  function usbSteps(n) {
    const L = ["Get Omarchy", "Pick your USB", "Make installer"];
    return `<ol class="usb-steps">${L.map((t, i) => `<li class="${i < n ? "done" : i === n ? "on" : ""}"><span>${i < n ? "✓" : i + 1}</span>${t}</li>`).join("")}</ol>`;
  }
  function pageUsb() {
    const iso = S.desktop ? S.usb?.iso : S.catalog.omarchy_iso;
    const hero = `<section class="usb-hero ignite">
        <img class="ignite-icon" src="${asset("featured/ignite/icon-256.png")}" alt="Ignite for Omarchy">
        <div><div class="eyebrow">FEATURED · FREE TOOL</div>
          <h1>Ignite <span>for Omarchy</span></h1>
          <p>Turn any USB stick into an Omarchy installer in one click. Ignite always downloads the newest official Omarchy${iso ? `, right now <b>${esc(iso.version)}</b>,` : ""} and checks it's genuine before writing.</p>
          <div class="ignite-chips"><span>✓ Always the newest Omarchy</span><span>✓ Checked genuine (SHA-256)</span><span>✓ Only shows USB sticks</span><span>✓ Verifies after writing</span></div></div>
      </section>`;
    if (!S.desktop) {
      return `<div class="page">${hero}
        <div class="usb-grid">
          <div class="usb-card"><h3>The one-click way (on Omarchy)</h3>
            <p>Get the Omarchy Store desktop app, open <b>Ignite</b>, plug in a USB stick and press <b>Make Installer</b>. The app downloads the latest Omarchy, verifies it and writes the stick for you.</p>
            <a class="btn" href="/get-desktop/">Get the desktop app</a></div>
          <div class="usb-card"><h3>On Windows</h3>
            <ol class="usb-list">
              <li>Download the latest Omarchy${iso ? ` (${esc(iso.version)}, ${gb(iso.size)})` : ""}:<br>${iso ? `<a class="btn" href="${esc(iso.url)}" download>Download Omarchy ${esc(iso.version)}</a>` : `<a class="btn" href="https://iso.omarchy.org/omarchy-4.0.4.iso" download>Download Omarchy 4.0.4</a>`}</li>
              <li>Download Rufus (Windows): <a href="https://github.com/pbatard/rufus/releases/download/v4.15/rufus-4.15.exe" download>rufus-4.15.exe</a></li>
              <li>Open Rufus, choose the Omarchy ISO, choose your USB stick, press <b>Start</b>.</li>
            </ol>
            ${iso ? `<p class="small muted">Check the download is genuine — SHA-256: <code class="small">${esc(iso.sha256)}</code></p>` : ""}</div>
          <div class="usb-card"><h3>On Mac</h3>
            <ol class="usb-list">
              <li>Download the latest Omarchy${iso ? ` (${esc(iso.version)}, ${gb(iso.size)})` : ""}:<br>${iso ? `<a class="btn" href="${esc(iso.url)}" download>Download Omarchy ${esc(iso.version)}</a>` : `<a class="btn" href="https://iso.omarchy.org/omarchy-4.0.4.iso" download>Download Omarchy 4.0.4</a>`}</li>
              <li>Download balenaEtcher (Mac):
                <ul style="margin-top:8px;margin-bottom:8px;padding-left:20px">
                  <li>Apple Silicon (M1/M2/M3): <a href="https://github.com/balena-io/etcher/releases/download/v2.1.7/balenaEtcher-2.1.7-arm64.dmg" download>balenaEtcher-2.1.7-arm64.dmg</a></li>
                  <li>Intel Mac: <a href="https://github.com/balena-io/etcher/releases/download/v2.1.7/balenaEtcher-2.1.7-x64.dmg" download>balenaEtcher-2.1.7-x64.dmg</a></li>
                </ul>
              </li>
              <li>Open balenaEtcher, choose the Omarchy ISO, choose your USB stick, press <b>Flash</b>.</li>
            </ol>
            <p class="small muted">On Mac, you may need to allow the app in System Settings → Privacy & Security after the first launch attempt.</p>
            ${iso ? `<p class="small muted">Check the download is genuine — SHA-256: <code class="small">${esc(iso.sha256)}</code></p>` : ""}</div>
        </div>
        ${usbAfter()}
      </div>`;
    }
    if (!S.usb) { loadUsb(); return `<div class="page">${hero}<div class="empty"><span class="ring big"></span><br>Looking for the latest Omarchy…</div></div>`; }
    if (!S.usb.iso) return `<div class="page">${hero}<div class="empty">Couldn't reach Omarchy's download server. Check your internet connection and try again.<br><br><button class="btn" data-usb-refresh>Try again</button></div></div>`;
    const u = S.usb, dl = u.download || {}, drives = u.drives || [];
    const step = !u.ready ? 0 : !S.usbPick ? 1 : 2;
    const pct = dl.total ? Math.floor((dl.done / dl.total) * 100) : 0;
    const eta = dl.started && dl.done ? Math.max(0, Math.round(((Date.now() / 1000 - dl.started) / dl.done) * (dl.total - dl.done))) : null;
    const pick = drives.find((d) => d.path === S.usbPick);
    if (S.usbPick && !pick) S.usbPick = null;
    const writing = S.jobUsb;
    return `<div class="page">${hero}${usbSteps(step)}
      <div class="usb-card">
        <div class="usb-row"><span class="usb-n">1</span><div class="grow"><h3>Get Omarchy ${esc(u.iso.version)}</h3>
          <p class="muted small">${gb(u.iso.size)} · official download from iso.omarchy.org · checked against Omarchy's SHA-256</p>
          ${dl.state === "downloading" ? `<div class="bar"><i style="width:${pct}%"></i></div><p class="small muted">${pct}% · ${gb(dl.done)} of ${gb(dl.total)}${eta != null ? ` · about ${eta > 90 ? Math.round(eta / 60) + " min" : eta + " s"} left` : ""}</p>` : ""}
          ${dl.state === "verifying" ? `<p class="small"><span class="ring"></span> Checking it's genuine…</p>` : ""}
          ${dl.state === "failed" ? `<p class="small err">${esc(dl.error || "Download failed")}</p>` : ""}
          ${u.ready ? `<p class="small ok">✓ Downloaded and verified · saved in your Downloads folder</p>` : ""}
        </div>
        ${u.ready ? "" : `<button class="btn" data-usb-dl ${["downloading", "verifying"].includes(dl.state) ? "disabled" : ""}>${dl.state === "downloading" ? "Downloading…" : dl.state === "verifying" ? "Verifying…" : dl.state === "failed" ? "Try again" : "Download"}</button>`}
        </div>
      </div>
      <div class="usb-card ${u.ready ? "" : "dim"}">
        <div class="usb-row"><span class="usb-n">2</span><div class="grow"><h3>Plug in a USB stick</h3>
          <p class="muted small">At least 8 GB. Everything on it will be erased. Only USB drives are shown — never your computer's own drives.</p></div>
          <button class="btn ghost" data-usb-refresh>Refresh</button></div>
        ${drives.length ? `<div class="usb-drives">${drives.map((d) => `<button class="usb-drive ${S.usbPick === d.path ? "on" : ""}" data-usb-pick="${esc(d.path)}" ${d.size < 7e9 ? "disabled" : ""}>
            ${ico("usb")}<div><b>${esc(d.name)}</b><span>${gb(d.size)} · ${esc(d.path)}${d.size < 7e9 ? " · too small" : ""}</span></div></button>`).join("")}</div>`
          : `<div class="usb-empty">No USB stick found. Plug one in — it appears here automatically.</div>`}
      </div>
      <div class="usb-card ${pick && u.ready ? "" : "dim"}">
        <div class="usb-row"><span class="usb-n">3</span><div class="grow"><h3>Make the installer</h3>
          <p class="muted small">${pick ? `Writes Omarchy ${esc(u.iso.version)} to <b>${esc(pick.name)}</b> (${gb(pick.size)}). A terminal asks for your password, then shows progress. Takes about 2–10 minutes.` : "Pick a USB stick above first."}</p></div>
          <button class="btn danger" data-usb-write ${pick && u.ready && !writing ? "" : "disabled"}>Make Installer</button></div>
      </div>
      ${usbAfter()}
    </div>`;
  }
  function igniteOS() {
    if (!S.ignitePlatform) {
      let saved = null;
      try { saved = localStorage.getItem("ignite-os"); } catch {}
      const ua = navigator.userAgent || "", plat = navigator.platform || "";
      S.ignitePlatform = saved === "mac" || saved === "win" ? saved : (/Mac|iPhone|iPad/i.test(plat) || /Macintosh/i.test(ua)) ? "mac" : "win";
    }
    return S.ignitePlatform;
  }
  function igniteOSToggle() {
    const p = igniteOS();
    return `<div class="look-switch ignite-os-switch" role="radiogroup" aria-label="Your computer">
      <button data-ignite-os="win" class="${p === "win" ? "on" : ""}" role="radio" aria-checked="${p === "win"}">${ico("grid")}<span>Windows</span></button>
      <button data-ignite-os="mac" class="${p === "mac" ? "on" : ""}" role="radio" aria-checked="${p === "mac"}">⌘<span>Mac</span></button>
    </div>`;
  }
  // ---------- First-party app bundle (offered after Omarchy installs) ----------
  const IGNITE_BUNDLE = [
    { id: "touchfix", why: "Fixes trackpad/touch input quirks — handy on Mac hardware especially" },
    { id: "snapdock", why: "Mac/Windows-style dock, Launchpad and Task Manager" },
    { id: "omarchy-browser", why: "The browser built for Omarchy, with the store built in" },
    { id: "lifeboat", why: "Back up your whole Omarchy setup to Google Drive" },
    { id: "rabbit-ears", why: "Free live TV, hundreds of channels, no account" },
    { id: "marquee-socials", why: "All your social accounts in one app" },
  ];
  function igniteBundleOn() {
    if (S.igniteBundleOn == null) {
      let saved = null; try { saved = localStorage.getItem("ignite-bundle-on"); } catch {}
      S.igniteBundleOn = saved !== "off";
    }
    return S.igniteBundleOn;
  }
  function igniteBundleExcluded() {
    if (!S.igniteBundleExcl) {
      let saved = null; try { saved = JSON.parse(localStorage.getItem("ignite-bundle-excl") || "[]"); } catch { saved = []; }
      S.igniteBundleExcl = new Set(Array.isArray(saved) ? saved : []);
    }
    return S.igniteBundleExcl;
  }
  function igniteBundleCmd() {
    const excl = igniteBundleExcluded();
    const ids = IGNITE_BUNDLE.filter((b) => !excl.has(b.id)).map((b) => b.id);
    if (!ids.length) return "";
    const parts = [`curl -fsSL ${SITE}install.sh | bash`];
    ids.forEach((id) => { const a = S.byId?.[id]; parts.push(a ? cmdFor(a) : `curl -fsSL ${SITE}get.sh | bash -s ${id}`); });
    return parts.join(" && ");
  }
  function igniteBundleSection() {
    const on = igniteBundleOn(), excl = igniteBundleExcluded(), cmd = igniteBundleCmd();
    return `<section class="usb-card ignite-bundle">
      <div class="usb-row"><span class="usb-n">+</span><div class="grow"><h3>Also set up our free apps</h3>
        <p class="muted small">Once Omarchy is running, one command installs the Omarchy Store plus the free first-party apps you pick below — TouchFix included, since Mac trackpads often need it.</p></div>
        <button class="btn ${on ? "" : "ghost"}" data-bundle-toggle aria-pressed="${on}">${on ? "On" : "Off"}</button></div>
      ${on ? `<div class="bundle-list">${IGNITE_BUNDLE.map((b) => { const a = S.byId?.[b.id]; const checked = !excl.has(b.id);
        return `<label class="bundle-item"><input type="checkbox" data-bundle-app="${b.id}" ${checked ? "checked" : ""}>
          <span class="grow"><b>${esc(a ? a.name : b.id)}</b><span class="muted small">${esc(b.why)}</span></span></label>`; }).join("")}</div>
      ${cmd ? `<div class="usb-cmd"><code class="small">${esc(cmd)}</code><button class="btn ghost" data-copy="${esc(cmd)}">Copy</button></div>
        <p class="small muted">Run this in a terminal (Super + Return) after Omarchy's first boot. Asks for your password; nothing is launched automatically.</p>`
      : `<p class="small muted">Nothing picked — turn on an app above to get its install command.</p>`}` : ""}
    </section>`;
  }
  function igniteWindows() {
    const w = S.catalog.ignite || {};
    const p = igniteOS();
    const winBody = `<div class="ignite-cols">
        <div><h4>The easy way: Make room for Omarchy</h4>
          ${w.helper_ready ? `<ol class="usb-list">
            <li>On the Windows PC, download <a href="/ignite/Make-room-for-Omarchy.zip" download><b>Make room for Omarchy</b></a> and unzip it.</li>
            <li>Right-click <b>Make-room-for-Omarchy.cmd</b> → <b>Run as administrator</b>.</li>
            <li>Pick <b>50</b>, <b>100</b> or <b>200 GB</b>. It checks BitLocker, makes a restore point, and shrinks Windows with Windows' own tool. Nothing is deleted.</li></ol>`
          : `<p class="small"><span class="soon-pill">Coming soon</span> A one-click Windows helper that checks everything, makes a restore point and frees the space for you. It's being tested on real Windows PCs first. Until then, use the steps on the right: they take about 2 minutes.</p>`}
        </div>
        <div><h4>${w.helper_ready ? "Or by hand" : "By hand"} (Windows Disk Management)</h4>
          <ol class="usb-list">
            <li><b>Turn off BitLocker</b> if it's on: Settings → Privacy &amp; security → Device encryption → Off. Wait for it to finish.</li>
            <li>Press <b>Win + R</b>, type <code>diskmgmt.msc</code>, press Enter.</li>
            <li>Right-click your <b>C:</b> drive → <b>Shrink Volume</b>. Enter <b>51200</b> for 50 GB, <b>102400</b> for 100 GB or <b>204800</b> for 200 GB → <b>Shrink</b>.</li>
            <li>Leave the new black <b>Unallocated</b> space empty. Don't format it.</li></ol></div>
      </div>
      <div class="ignite-then"><b>Then:</b> start the computer from your Ignite USB stick, pick your drive, and choose <b>Free space install</b>. <span class="warn-t">Don't pick the whole-drive option: that erases Windows.</span> After Omarchy starts, type <code>limine-scan</code> in a terminal to add Windows to the start-up menu.</div>
      <p class="small muted">Back up anything important first. Shrinking a drive is safe, but not risk-free.</p>`;
    const macBody = `<div class="ignite-cols">
        <div><h4>Apple Silicon Macs (M1–M4)</h4>
          <p class="small">These Macs can't boot Omarchy's USB stick at all — Apple's firmware only starts macOS and Apple-signed systems. Dual-boot the way Windows PCs do isn't possible here, even with Disk Utility.</p>
          <p class="small muted">Your options: run Omarchy in a free VM app like <a href="https://mac.getutm.app/" target="_blank" rel="noopener">UTM</a> alongside macOS, or install it on a separate PC. <a href="https://asahilinux.org/" target="_blank" rel="noopener">Asahi Linux</a> is the only native-boot Linux project for this hardware, and Omarchy isn't it (yet).</p>
        </div>
        <div><h4>Intel Macs (2020 and earlier)</h4>
          <ol class="usb-list">
            <li>Back up your Mac first (Time Machine). This is more advanced than the Windows path.</li>
            <li>Open <b>Disk Utility</b>, select your main volume, click <b>Partition</b> and shrink it to free up 50–200 GB of unformatted space.</li>
            <li>Turn off <b>FileVault</b> first if it's on (System Settings → Privacy &amp; Security).</li>
            <li>You'll need a third-party boot manager such as <a href="https://www.rodsbooks.com/refind/" target="_blank" rel="noopener">rEFInd</a> to choose Omarchy or macOS at startup — Apple's own boot picker won't list it.</li>
          </ol>
          <p class="small muted">This path isn't officially supported by Omarchy and can be finicky on some Mac models. If in doubt, use a VM or a spare PC instead.</p>
        </div>
      </div>
      <p class="small muted">Ignite itself is a Windows app — there's no Mac build yet. On a Mac, make the USB stick with balenaEtcher using the download card above.</p>`;
    return `<section class="usb-card ignite-win" id="windows">
      <div class="usb-row"><span class="usb-n win">${p === "mac" ? "⌘" : ico("grid")}</span><div class="grow"><h3>Keep ${p === "mac" ? "macOS" : "Windows"}: install Omarchy next to it</h3>
        <p class="muted small">${p === "mac" ? "On a Mac, dual-booting Omarchy works very differently than on a PC — see below." : "Omarchy 4 can install into empty space on your drive and leave Windows alone. You choose Windows or Omarchy each time you start the computer. You just need to make that empty space first, on the Windows computer."}</p></div></div>
      ${igniteOSToggle()}
      ${p === "mac" ? macBody : winBody}
    </section>`;
  }
  function usbAfter() {
    return igniteWindows() + `<section class="usb-card"><h3>Then install Omarchy</h3>
      <ol class="usb-list">
        <li>Plug the stick into the computer you want to install on and restart it.</li>
        <li>Open the boot menu — usually <b>F12</b>, <b>F11</b>, <b>F8</b> or <b>Esc</b> right after power-on — and choose the USB stick.</li>
        <li>Turn off <b>Secure Boot</b> in the BIOS if it won't start.</li>
        <li>Answer five questions. Omarchy installs in a few minutes. <a href="https://omarchy.org/manual/getting-started/" target="_blank" rel="noopener">Full guide</a></li>
      </ol>
      <p class="small muted">Ignite for Omarchy is a free community tool from the Omarchy Store, not an official Omarchy product. Omarchy is made by DHH and the Omarchy team; Ignite downloads it from the official server and does not change it. Writing a USB stick erases it — you're responsible for picking the right drive.</p></section>`
      + igniteBundleSection();
  }

  function pageSearch(q) {
    const t = q.trim().toLowerCase();
    const score = (a) => {
      const n = a.name.toLowerCase();
      if (n === t) return 100;
      if (n.startsWith(t)) return 80;
      if (n.includes(t)) return 60;
      if (a.tags?.some((x) => x.includes(t))) return 40;
      if (catName(a.category).toLowerCase().includes(t)) return 30;
      if ((a.summary + " " + a.developer).toLowerCase().includes(t)) return 20;
      if (a.description?.toLowerCase().includes(t)) return 10;
      return 0;
    };
    const res = S.catalog.apps.map((a) => [score(a), a]).filter(([s]) => s > 0).sort((x, y) => y[0] - x[0] || (y[1].stars || 0) - (x[1].stars || 0)).map(([, a]) => a);
    const tres = t.length < 2 ? [] : S.catalog.themes.filter((x) => (x.name + " " + x.author).toLowerCase().includes(t) || (t.includes("theme") && t.replace(/themes?/, "").trim() === ""));
    return `<div class="page">
      <h1 class="page-title">Results for “${esc(q)}”</h1>
      ${sponsoredApp((a) => res.includes(a))}
      ${themeShelf("Themes", tres.slice(0, 20), tres.length ? "/themes/" : "")}
      ${(() => { const wr = t.length < 2 ? [] : wallets().filter((w) => (w.name + " " + w.chains.join(" ") + " " + w.summary + (/(crypto|wallet)/.test(t) ? " crypto wallet" : "")).toLowerCase().includes(t));
        return wr.length ? `<section class="shelf"><div class="shelf-head"><h2>Crypto Wallets</h2><a href="/crypto/">See All</a></div><div class="scroller rows3">${wr.map(walletLockup).join("")}</div></section>` : ""; })()}
      ${(() => { if (!S.plugins) { loadPlugins(); return ""; } const ql = q.toLowerCase(); const pr = (S.plugins.plugins || []).filter((x) => (x.n + " " + x.d + " " + (x.t || []).join(" ")).toLowerCase().includes(ql)).sort((a, b) => ((b.i ? 1 : 0) - (a.i ? 1 : 0)) || (b.s - a.s)).slice(0, 20);
        return pr.length ? `<section class="shelf"><div class="shelf-head"><h2>Plugins</h2><a href="/plugins/" data-plug-search="${esc(q)}">See All</a></div><div class="scroller plug-row">${pr.map(plugCard).join("")}</div></section>` : ""; })()}
      ${res.length ? `<div class="grid">${res.map((a) => lockup(a)).join("")}</div>`
        : tres.length ? "" : `<div class="empty">No apps match “${esc(q)}”.<br><br><a class="btn ghost" href="${REPO}/issues/new?template=app-request.yml&title=${encodeURIComponent("App request: " + q)}" target="_blank" rel="noopener">Request this app</a></div>`}
      ${searchAd()}
    </div>`;
  }

  function pageApp(id) {
    const a = S.byId[id];
    if (!a) return notFound();
    const p = a.package || {};
    const cat = S.catalog.categories.find((c) => c.id === a.category);
    const related = S.catalog.apps.filter((x) => x.category === a.category && x.id !== a.id).slice(0, 6);
    const ghUrl = a.github ? `https://github.com/${a.github}` : null;
    const stale = a.archived || p.out_of_date;
    const verifiedDev = isVerifiedDev(a);
    const verifiedPill = `<span class="pv ok">${ico("verified")}Verified</span>`;
    const strip = a.install.method === "store" ? [
      ["Price", "Free", "Open source (MIT)"],
      ["Top Charts", "#1", "in the store"],
      ["Category", `<span style="color:var(--accent)">${ico(cat?.icon)}</span>`, esc(cat?.name)],
      ["Developer", `<span style="font-size:16px">${esc(a.developer || "—")}</span>`, "Official"],
      ["Apps", `${Math.floor(S.catalog.apps.length / 50) * 50}+`, "one click"],
      ["Age", "4+", "Rating"],
    ] : a.featured ? [
      ["Price", esc(a.featured.price), esc(a.featured.price_note || a.featured.launch_offer || "")],
      ["Award", '<span style="color:#ffd60a">★</span>', esc(a.featured.badge)],
      ["Category", `<span style="color:var(--accent)">${ico(cat?.icon)}</span>`, esc(cat?.name)],
      ["Developer", `<span style="font-size:16px">${esc(a.developer || "—")}</span>`, verifiedDev ? verifiedPill : ""],
      ["Works with", "Omarchy", "Hyprland"],
      ["Age", esc(a.age || "4+"), "Rating"],
    ] : [
      ["GitHub Stars", a.stars != null ? k(a.stars) : "—", a.stars != null ? `#${a.rank} in store` : "Closed source"],
      [p.repo === "aur" ? "AUR Votes" : "Source", p.repo === "aur" ? k(p.votes) : (a.install.method === "omarchy" ? "Omarchy" : "Arch"), p.repo === "aur" ? "Community" : (p.repo || "Official")],
      ["Category", `<span style="color:var(--accent)">${ico(cat?.icon)}</span>`, esc(cat?.name)],
      ["Developer", `<span style="font-size:16px">${esc(a.developer || "—")}</span>`, verifiedDev ? verifiedPill : (a.github ? esc(a.github.split("/")[0]) : "")],
      ["Size", p.size ? mb(p.size) : "—", "Installed"],
      ["Age", esc(a.age ? a.age.replace("Early Childhood", "3+").replace("Everyone", "4+").replace("Teen", "13+").replace("Mature", "17+") : "—"), "Rating"],
    ];
    const F = a.featured;
    return `<div class="page">
      ${backBtn()}
      ${F ? `<div class="feat-hero${F.billboard ? " with-copy" : ""}" style="--g1:${F.gradient[0]};--g2:${F.gradient[1]};--g3:${F.gradient[2] || F.gradient[1]}"><img src="${esc(asset(F.billboard || F.art))}" alt="">
        ${F.billboard ? `<div class="fh-copy"><span class="spot-badge">${esc(F.badge)}</span><h2>${esc(F.headline)}</h2>${F.chips ? `<div class="spot-chips">${F.chips.slice(0, 4).map((c) => `<span>${esc(c)}</span>`).join("")}</div>` : ""}</div>` : `<span class="spot-badge">${esc(F.badge)}</span>`}</div>` : ""}
      <div class="detail-head">
        ${iconImg(a, 128)}
        <div style="min-width:0">
          <h1>${esc(a.name)}${appVersion(a) ? `<span class="ver-badge" title="The version you'll get">v${esc(appVersion(a))}</span>` : ""}${a.archived ? `<span class="archived">Archived</span>` : ""}</h1>
          <div class="sub">${esc(a.summary)}</div>
          <a class="dev" href="/developer/${devSlug(a.developer)}/" title="See everything by ${esc(a.developer)}">${esc(a.developer)}</a>
          ${verifiedDev ? `<span class="pv ok" style="margin-left:8px" title="Downloads directly from ${esc(a.developer)}'s GitHub releases under ${esc(a.github || "")}, SHA-256 checked before install">${ico("verified")}Verified</span>` : ""}
          <div class="actions">
            ${getBtn(a, true)}${appRm(a)}
            ${ghUrl ? `<a class="icon-btn" href="${esc(ghUrl)}" target="_blank" rel="noopener" title="View on GitHub">${ico("github")}</a>` : ""}
            <button class="icon-btn" data-share="${a.id}" title="Share">${ico("share")}</button>
          </div>
        </div>
      </div>

      <div class="strip">${strip.map(([kk, v, s]) => `<div><div class="k">${kk}</div><div class="v">${v}</div><div class="s">${s}</div></div>`).join("")}</div>

      ${a.screenshots.length ? `<div class="gallery">
        <div class="scroller shots" id="shots">${a.screenshots.map((s, i) => `<img src="${esc(asset(s))}" alt="Screenshot ${i + 1} of ${esc(a.name)}" loading="lazy" referrerpolicy="no-referrer" data-zoom data-shot="${i}">`).join("")}</div>
        ${a.screenshots.length > 1 ? `<button class="g-nav g-prev" data-gal="-1" aria-label="Previous picture">‹</button><button class="g-nav g-next" data-gal="1" aria-label="Next picture">›</button>
        <div class="g-dots">${a.screenshots.map((_, i) => `<i data-gal-to="${i}"${i ? "" : ' class="on"'}></i>`).join("")}</div>` : ""}</div>` : ""}
      ${F ? featuredSections(a) : ""}

      <section class="shelf">
        <div class="desc clamp" id="desc">${esc(a.description || a.summary)}</div>
        <button class="more" id="more" hidden>more</button>
      </section>

      ${reviewsSection(a)}

      ${a.changelog?.length ? changelogSection(a, ghUrl) : a.release || p.version ? `<section class="shelf">
        <div class="shelf-head"><h2>What’s New</h2>${ghUrl ? `<a href="${esc(ghUrl)}/releases" target="_blank" rel="noopener">Version History</a>` : ""}</div>
        <div class="whatsnew"><span>Version ${esc(a.release || p.version)}</span><span>${ago(a.released_at || p.updated)}</span></div>
      </section>` : ""}

      <section class="shelf">
        <div class="shelf-head"><h2>Information</h2></div>
        <div class="info-grid">
          <div><div class="k">Provider</div><div class="v">${esc(a.developer || "—")}</div></div>
          <div><div class="k">Installs from</div><div class="v">${esc(sourceLabel(a))}</div></div>
          <div><div class="k">Package</div><div class="v">${esc(p.name)} ${p.version ? `<span class="muted">${esc(p.version)}</span>` : ""}</div></div>
          ${a.license || !a.featured ? `<div><div class="k">License</div><div class="v">${esc(a.license || "Proprietary")}</div></div>` : ""}
          ${a.last_commit ? `<div><div class="k">Last code change</div><div class="v">${ago(a.last_commit)}</div></div>` : ""}
          <div><div class="k">Runs in</div><div class="v">${a.kind === "terminal" ? "Terminal" : "Desktop window"}</div></div>
          ${a.homepage ? `<div><div class="k">Website</div><a class="v" href="${safeUrl(a.homepage)}" target="_blank" rel="noopener">${esc(a.homepage.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, ""))}</a></div>` : ""}
          ${ghUrl ? `<div><div class="k">Source code</div><a class="v" href="${esc(ghUrl)}" target="_blank" rel="noopener" style="word-break: break-all;">github.com/${esc(a.github)}</a></div>` : ""}
          <div><div class="k">Install command</div><div class="v"><code class="small">${esc(cmdFor(a))}</code></div></div>
        </div>
        <div class="trust ${stale ? "warn" : ""}"><span class="trust-icon">${ico(stale ? "warn" : "shield")}</span><div><b>${stale
          ? "⚠️ Warning"
          : a.install.method === "store" ? "✓ Security checked"
          : a.install.method === "aur" ? "✓ Community verified"
          : "✓ Official source"}</b><br>${stale
          ? (a.archived ? "This project's GitHub repository is archived and no longer maintained." : "This AUR package is flagged out of date by the community.")
          : a.install.method === "store"
            ? "The official Omarchy Store app, open source on GitHub. It installs to your home folder only and updates itself from omarchystore.com."
          : a.install.method === "aur"
            ? "Installs from the AUR, Arch's community repository. Builds are community-maintained; the store only lists packages with an active maintainer and good standing."
          : a.install.method === "release"
            ? "Downloads directly from the developer's signed release. The store verifies the SHA-256 checksum before installing."
            : "Installs from a signed, official Arch package source. The store never runs code from a web page — it only calls your system package manager."}
          <div style="margin-top:6px">Third-party software, provided as-is. Install at your own risk — <a style="color:var(--accent)" href="/legal/">disclaimer</a>.</div></div></div>
      </section>

      ${related.length ? `<section class="shelf"><div class="shelf-head"><h2>More ${esc(cat?.name)}</h2><a href="/category/${a.category}/">See All</a></div>
        <div class="scroller rows3">${related.map((x) => lockup(x)).join("")}</div></section>` : ""}
      ${footer()}
    </div>`;
  }

  // ---------- backend: analytics, reviews, developer sign-up ----------
  const apiPost = (path, b) => fetch(API + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
  function track() {
    // Privacy-friendly page count: no cookies, no IP stored (see /legal/).
    const path = location.pathname;
    if (track.last === path) return; track.last = path;
    apiPost("/hit", { path, ref: document.referrer || "", desktop: !!S.desktop }).catch(() => {});
  }
  const trackEvent = (kind, item) => apiPost("/event", { kind, item }).catch(() => {});
  S.reviews = {};
  async function loadReviews(id, fresh = false) {
    try { S.reviews[id] = await (await fetch(`${API}/reviews?app=${encodeURIComponent(id)}${fresh ? "&t=" + Date.now() : ""}`, fresh ? { cache: "no-store" } : {})).json(); }
    catch { S.reviews[id] = { error: true, reviews: [], count: 0 }; }
    if (currentPath() === "app/" + id) { const el = $("#reviews"); if (el) el.outerHTML = reviewsSection(S.byId[id]); }
  }
  const starRow = (n, size = 14) => `<span class="stars-row" style="--s:${size}px">${[1, 2, 3, 4, 5].map((i) => `<i class="${i <= Math.round(n) ? "on" : ""}">★</i>`).join("")}</span>`;
  function reviewsSection(a) {
    const R = S.reviews[a.id];
    if (!R) { setTimeout(() => loadReviews(a.id)); }
    const n = R?.count || 0, avg = R?.average || 0;
    const bars = [5, 4, 3, 2, 1].map((s) => { const c = R?.stars?.[s] || 0; return `<div class="rv-bar"><span>${s}</span><i><b style="width:${n ? (c / n) * 100 : 0}%"></b></i></div>`; }).join("");
    return `<section class="shelf" id="reviews">
      <div class="shelf-head"><h2>Ratings & Reviews</h2><a href="#" data-review="${a.id}">Write a Review</a></div>
      ${!R ? `<div class="muted small">Loading reviews…</div>` : `
      <div class="rv-sum">
        <div class="rv-big"><b>${n ? avg.toFixed(1) : "—"}</b><span>out of 5</span></div>
        <div class="rv-bars">${bars}</div>
        <div class="rv-count">${n ? `${n} rating${n === 1 ? "" : "s"}` : "No ratings yet"}</div>
      </div>
      ${R.reviews?.length ? `<div class="scroller rv-cards">${R.reviews.map((r) => `<article class="rv-card">
          <div class="rv-top"><b>${esc(r.title || (r.rating >= 4 ? "Great app" : r.rating === 3 ? "It's okay" : "Not for me"))}</b><span class="muted small">${ago(new Date(r.ts).toISOString())}</span></div>
          <div class="rv-meta">${starRow(r.rating, 13)}<span class="muted small">${esc(r.name)}</span></div>
          ${r.body ? `<p>${esc(r.body)}</p>` : ""}</article>`).join("")}</div>`
        : `<div class="rv-empty">Be the first to review ${esc(a.name)}. <a href="#" data-review="${a.id}">Write a review</a></div>`}`}
    </section>`;
  }
  // Cloudflare Turnstile (privacy-friendly spam check) — loaded only when a form opens.
  let tsReady;
  function turnstileLoad() {
    return tsReady ||= new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"; s.async = true;
      s.onload = () => res(window.turnstile); s.onerror = () => rej(new Error("spam check didn't load"));
      document.head.appendChild(s);
    });
  }
  async function turnstileMount(el) {
    try {
      const ts = await turnstileLoad();
      el.dataset.token = "";
      ts.render(el, { sitekey: TURNSTILE_KEY, theme: "dark", callback: (t) => (el.dataset.token = t), "expired-callback": () => (el.dataset.token = "") });
    } catch (e) { el.textContent = "Couldn't load the spam check — check your connection."; }
  }
  const TURNSTILE_KEY = "0x4AAAAAAFTiarDYb1tekwRe";
  function openReview(a) {
    showSheet(`<form class="sheet-card rv-form" role="dialog" aria-label="Review ${esc(a.name)}" data-review-form="${a.id}">
      <div class="row">${iconImg(a, 56)}<div><h3>Review ${esc(a.name)}</h3><div class="muted small">Your review is public. Please be kind and specific.</div></div></div>
      <div class="rv-pick" role="radiogroup" aria-label="Your rating">${[1, 2, 3, 4, 5].map((i) => `<button type="button" data-rate="${i}" aria-label="${i} star${i > 1 ? "s" : ""}">★</button>`).join("")}</div>
      <input name="title" maxlength="80" placeholder="Title (optional)">
      <textarea name="body" maxlength="2000" rows="4" placeholder="What did you like or dislike? (optional)"></textarea>
      <input name="name" maxlength="40" placeholder="Your name or nickname (optional)">
      <div class="ts-box"></div>
      <div class="form-err" hidden></div>
      <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:6px">
        <button type="button" class="btn ghost" data-close>Cancel</button><button class="btn" type="submit">Submit</button></div>
    </form>`);
    turnstileMount($(".rv-form .ts-box"));
  }
  async function submitForm(form, path, payload, done) {
    const err = form.querySelector(".form-err"), btn = form.querySelector('[type="submit"]');
    err.hidden = true;
    const token = form.querySelector(".ts-box")?.dataset.token;
    if (!token) { err.textContent = "Please complete the anti-spam check (the box above)."; err.hidden = false; return; }
    const label = btn.textContent;
    btn.disabled = true; btn.textContent = "Sending…";
    try {
      const r = await apiPost(path, { ...payload, turnstile: token });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "Something went wrong");
      done(j);
    } catch (e) {
      err.textContent = e.message; err.hidden = false; btn.disabled = false; btn.textContent = label;
      try { window.turnstile?.reset(form.querySelector(".ts-box")); } catch {}
    }
  }
  document.addEventListener("submit", (e) => {
    const f = e.target;
    if (f.matches("[data-review-form]")) {
      e.preventDefault();
      const id = f.dataset.reviewForm, rating = Number(f.dataset.rating || 0);
      if (!rating) { const er = f.querySelector(".form-err"); er.textContent = "Tap the stars to rate it."; er.hidden = false; return; }
      submitForm(f, "/reviews", { app: id, rating, title: f.title.value, body: f.body.value, name: f.name.value }, (j) => {
        closeSheet(); toast(j.updated ? "Thanks — your review was updated" : "Thanks — your review is live"); loadReviews(id, true);
      });
    }
  });
  function pageGetDesktop() {
    return `<div class="page" style="max-width:760px">
      <h1 class="page-title">Get the desktop app</h1>
      <p class="muted" style="font-size:16px">The desktop app installs apps for you with one click, shows which ones you already have, and matches your Omarchy theme.</p>
      <p>Open a terminal (<b>Super + Return</b>) and paste:</p>
      <div class="code"><code>${esc(INSTALLER)}</code><button class="btn ghost" data-copy="${esc(INSTALLER)}">Copy</button></div>
      <p class="muted small">Prefer GitHub? Download the latest release from <a style="color:var(--accent)" href="${REPO}/releases/latest" target="_blank" rel="noopener">github.com/omarchy-community/store/releases</a>, unzip it and run <code>bash omarchy-store-*/install.sh</code>.</p>
      <p class="muted small">Then launch <b>Omarchy Store</b> from your app launcher (<b>Super + Space</b>). It installs to your home folder only. To remove it, open its own listing in the store and press <b>Remove</b>, or run <code>omarchy-store --uninstall</code> (add <code>--all</code> to also remove SnapDock, Lifeboat, the screensaver and theme and go back to Omarchy's defaults).
      Read the script first: <a style="color:var(--accent)" href="${SITE}install.sh" target="_blank" rel="noopener">install.sh</a>.</p>
      ${footer()}
    </div>`;
  }

  const DISCLAIMER_SHORT = "Apps in this store are third-party software made by other people. Omarchy Store does not create, own, review the code of, or control them, and provides them as-is with no warranty. You install and use them at your own risk.";

  function pageLegal() {
    return `<div class="page legal" style="max-width:780px">
      <h1 class="page-title">Disclaimer</h1>
      <p class="muted small">Last updated October 10, 2026</p>
      <h3>Third-party software</h3>
      <p>Every app listed in Omarchy Store is created, owned and maintained by independent third parties. Omarchy Store is a directory: it shows public information about those apps and, in the desktop app, asks your computer's own package manager (pacman, or an AUR helper) to install them from Arch Linux, the Arch User Repository (AUR), or Omarchy's package sources. Omarchy Store does not write, build, host, audit or control any of that software.</p>
      <h3>No warranty</h3>
      <p>Omarchy Store, its listings, and the software installed through it are provided <b>"AS IS" and "AS AVAILABLE", without warranty of any kind</b>, express or implied, including merchantability, fitness for a particular purpose, security, and non-infringement. We do not guarantee that any app is free of viruses, malware, spyware, bugs or other harmful components, or that listing information is accurate or current.</p>
      <h3>Limitation of liability</h3>
      <p>To the maximum extent permitted by law, the operators, maintainers and contributors of Omarchy Store <b>are not liable for any damage or loss</b> of any kind arising from your use of the store or of any software you install through it, including viruses or malware, data loss, system damage, security breaches, lost profits, or any direct, indirect, incidental or consequential damages, even if advised of the possibility of such damage.</p>
      <h3>Your responsibility</h3>
      <p>You are solely responsible for deciding what to install. Before installing, review the app's source code, package, license and reputation, and keep backups of important data. Packages from the AUR are community-maintained and are not reviewed or signed by Arch Linux. Installing system software requires administrator access; only proceed if you trust the app.</p>
      <h3>Privacy</h3>
      <p>We count page views and installs to improve the store, without cookies and without storing your IP address. Each visit is counted with a one-way code that changes every day, so we can't follow anyone over time. Reviews, app submissions, advertising requests, messages and supporter-wall entries you submit are stored on Cloudflare. Anyone who has a private status link can see that submission, so keep it to yourself and your team. Forms use Cloudflare Turnstile to block spam.</p>
      <h3>Paid apps and payments</h3>
      <p>Paid apps are sold by their developers and paid for in cryptocurrency, sent directly from your wallet to the developer's and the store's public addresses. Blockchain payments can't be reversed, so check the app page, the amount and the network before you pay. Refunds are at the developer's discretion.</p>
      <h3>Advertising</h3>
      <p>Sponsored content is labelled "Sponsored" or "Ad" and links to third-party websites. Advertisers are solely responsible for their content, products and services. An ad is not an endorsement, and we are not responsible for anything on sites you visit through it.</p>
      <h3>Donations</h3>
      <p>Donations are voluntary gifts sent in cryptocurrency directly to the founder's own public wallet addresses listed on the <a style="color:var(--accent)" href="/donate/">Donate</a> page. They don't buy any product, service or special treatment, can't be refunded (blockchain payments are final), and aren't tax-deductible. Always check the network before sending: coins sent on the wrong network can be lost for good. The store reads the public blockchain to see that a donation arrived; it never holds your money or keys.</p>
      <h3>Trademarks</h3>
      <p>App names, logos, icons and screenshots belong to their respective owners and are shown only to identify the software. Omarchy Store is an unofficial community project and is not affiliated with Omarchy, Basecamp, 37signals, Arch Linux, GitHub, Flathub or any listed developer.</p>
      <h3>Removal requests</h3>
      <p>If you own an app or trademark and want a listing changed or removed, <a style="color:var(--accent)" href="${REPO}/issues/new" target="_blank" rel="noopener">open an issue</a> and we will act promptly.</p>
      <p class="muted small">By using Omarchy Store you agree to this disclaimer. If you do not agree, do not use the store.</p>
      ${footer()}
    </div>`;
  }

  // Back button for detail pages (app, theme, plugin)
  const backBtn = () => `<a class="back-btn" href="javascript:history.back()" title="Go back"><svg viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6"/></svg><span>Back</span></a>`;

  const notFound = () => `<div class="page"><div class="empty">That page doesn't exist. <a style="color:var(--accent)" href="/">Back to Discover</a></div></div>`;
  const footer = () => `${footerInner()}${communityBlock()}`;
  const footerInner = () => `<div class="footer-cta">
    <a class="fc" href="/submit/"><span class="fc-i">${ico("plus")}</span><span><b>Made an app?</b>List it in the store for free</span></a>
    <a class="fc" href="/advertise/"><span class="fc-i">${ico("megaphone")}</span><span><b>Advertise with us</b>Reach Omarchy users</span></a>
    <a class="fc" href="/contact/"><span class="fc-i">${ico("mail")}</span><span><b>Contact us</b>${CONTACT_EMAIL}</span></a>
    <a class="fc fc-donate" href="/donate/"><span class="fc-i"><svg viewBox="0 0 24 24"><path d="M12 20.5s-7.5-4.6-9.3-9.4C1.4 7.6 3.6 4 7.2 4c2 0 3.6 1.1 4.8 2.8C13.2 5.1 14.8 4 16.8 4c3.6 0 5.8 3.6 4.5 7.1-1.8 4.8-9.3 9.4-9.3 9.4z"/></svg></span><span><b>Donate</b>Keep the store free</span></a>
  </div>
  <div class="footer">
    <span class="disclaim">${DISCLAIMER_SHORT} <a href="/legal/">Full disclaimer</a></span>
    <span>Omarchy Store — unofficial, community-run. Not affiliated with Omarchy or Basecamp.</span>
    <a href="${REPO}" target="_blank" rel="noopener">GitHub</a>
    <a href="/submit/">Submit an app</a>
    <a href="/advertise/">Advertise</a>
    <a href="/contact/">Contact</a>
    <a href="/donate/">Donate</a>
    <span>Data updated ${ago(S.catalog.generated_at).toLowerCase()}</span>
  </div>`;

  // ---------- router ----------
  // Real URLs (/app/krita/) so every page can be indexed by search engines.
  // Old #/ links are upgraded in place so shared links keep working.
  function currentPath() {
    if (location.hash.startsWith("#/")) {
      const p = "/" + location.hash.slice(2).replace(/\/?$/, "/").replace(/^\/$/, "");
      history.replaceState(null, "", p || "/");
    }
    return decodeURIComponent(location.pathname).replace(/^\/+|\/+$/g, "");
  }
  function go(path) {
    if (path === location.pathname) return;
    history.pushState(null, "", path);
    closeSheet(); route();
  }

  // Renamed apps: old links keep working.
  const APP_MOVED = { "omarchy-backup": "lifeboat" };
  // After a successful purchase, re-render so the Buy button turns into GET.
  document.addEventListener("omarchy:purchased", () => { try { route(); } catch (e) {} });

  function route() {
    const h = currentPath();
    const [p, arg] = h.split(/\/(.*)/s);
    let html, nav = p;
    if (!p) html = pageDiscover(), nav = "";
    else if (p === "charts") html = pageCharts();
    else if (p === "categories") html = pageCategories();
    else if (p === "new") html = pageNewApps();
    else if (p === "developer") html = pageDeveloper(arg);
    else if (p === "themes") html = pageThemes();
    else if (p === "theme") html = pageTheme(arg), nav = "themes";
    else if (p === "plugins") html = pagePlugins();
    else if (p === "screensavers") html = pageScreensavers();
    else if (p === "crypto") { const w = (arg || "").replace(/\/$/, ""); html = w ? pageWallet(w) : pageCrypto(); nav = "crypto"; }
    else if (p === "plugin") html = pagePlugin((arg || "").replace(/\/$/, "")), nav = "plugins";
    else if (p === "category") html = pageCategory(arg), nav = "category/" + arg;
    else if (p === "app" && APP_MOVED[(arg || "").replace(/\/$/, "")]) { history.replaceState(null, "", `/app/${APP_MOVED[arg.replace(/\/$/, "")]}/`); return route(); }
    else if (p === "app") html = pageApp(arg), nav = "category/" + (S.byId[arg]?.category || "");
    else if (p === "search") html = pageSearch(arg || "");
    else if (p === "installed") html = pageInstalled();
    else if (p === "updates") html = pageUpdates();
    else if (p === "usb" || p === "ignite") { if (p === "usb") history.replaceState(null, "", "/ignite/"); html = pageUsb(); nav = "get-omarchy"; }
    else if (p === "submit") html = pageSubmit();
    else if (p === "advertise") html = pageAdvertise();
    else if (p === "donate") html = pageDonate();
    else if (p === "contact") html = pageContact();
    else if (p === "get-omarchy" || p === "get") { if (p === "get") history.replaceState(null, "", "/get-omarchy/"); html = pageGetOmarchy(); nav = "get-omarchy"; }
    else if (p === "get-desktop") html = pageGetDesktop();
    else if (p === "legal") html = pageLegal();
    else html = notFound();
    // Stop any running auto-scrollers from the previous page before rendering new content
    stopAutoScrollers();
    clearInterval(shotTimer);
    view.innerHTML = html;
    addRowArrows();  // Sets up new auto-scrollers for spot-row and hero
    markNav(nav);
    if (p !== "search") $("#q").value = "";
    if (route.last !== h) view.scrollTop = 0;
    route.last = h;
    const d = $("#desc"), m = $("#more");
    if (d && m && d.scrollHeight > d.clientHeight + 4) m.hidden = false;
    document.title = pageTitle(p, arg);
    track();
    if (p === "app") initShotAutoScroll();
    portalAfter(p);
  }
  const TITLES = { submit: "Submit an App – List Your App Free", advertise: "Advertise on the Omarchy Store", donate: "Donate – Keep Omarchy Store Free", themes: "Omarchy Themes – Browse & Install Desktop Themes", charts: "Top Charts – Most Popular Omarchy Apps", categories: "App Categories", legal: "Disclaimer", "get-desktop": "Get the Desktop App", search: "Search", installed: "Installed", updates: "Updates", usb: "Ignite for Omarchy – Make an Omarchy Installer USB in One Click", ignite: "Ignite for Omarchy – Make an Omarchy Installer USB in One Click", "get-omarchy": "Get Omarchy – How to Install Omarchy Linux (Free, Step by Step)", get: "Get Omarchy – How to Install Omarchy Linux (Free, Step by Step)" };
  function pageTitle(p, arg) {
    const a = p === "app" && S.byId[arg];
    if (a) return `${a.name} for Omarchy Linux – Install ${a.name} | Omarchy Store`;
    const c = p === "category" && S.catalog.categories.find((c) => c.id === arg);
    if (c) return `Best ${c.name} Apps for Omarchy Linux | Omarchy Store`;
    const th = p === "theme" && S.themeById[arg];
    if (th) return `${th.name} Theme for Omarchy – by ${th.author} | Omarchy Store`;
    const pl = p === "plugin" && S.plugById[decodeURIComponent((arg || "").replace(/\/$/, ""))];
    if (pl) return `${pl.n} – Omarchy Plugin | Omarchy Store`;
    const cw = p === "crypto" && walletById((arg || "").replace(/\/$/, ""));
    if (cw) return `${cw.name} Wallet Extension for Chromium on Omarchy | Omarchy Store`;
    if (p === "crypto") return "Crypto Wallets – Phantom, MetaMask & More for Omarchy | Omarchy Store";
    if (p === "screensavers") return "Omarchy Screensavers – Custom Screensavers & Idle Tools | Omarchy Store";
    if (p === "plugins") return "Omarchy Plugins – Bar Widgets & Desktop Add-ons | Omarchy Store";
    return TITLES[p] ? `${TITLES[p]} | Omarchy Store` : "Omarchy Store – The App Store for Omarchy Linux";
  }
  const rerender = () => { const top = view.scrollTop; route(); view.scrollTop = top; };

  // ---------- ‹ › buttons on every sideways row (mouse users can't swipe; the scrollbar is hidden) ----------
  // Also: auto-scroll carousels for engagement (pauses on hover/touch)
  const autoScrollers = new Set();
  function addRowArrows() {
    view.querySelectorAll(".scroller:not(#shots), .spot-row").forEach((sc) => {
      if (sc.parentElement.classList.contains("rowwrap")) return;
      const w = document.createElement("div"); w.className = "rowwrap";
      sc.parentNode.insertBefore(w, sc); w.appendChild(sc);
      w.insertAdjacentHTML("beforeend", `<button class="row-nav row-prev" aria-label="Scroll left" hidden>‹</button><button class="row-nav row-next" aria-label="Scroll right" hidden>›</button>`);
      const upd = () => { const max = sc.scrollWidth - sc.clientWidth;
        w.querySelector(".row-prev").hidden = sc.scrollLeft <= 4; w.querySelector(".row-next").hidden = sc.scrollLeft >= max - 4; };
      sc.addEventListener("scroll", upd, { passive: true });
      w.querySelector(".row-prev").onclick = (e) => { e.preventDefault(); sc.scrollBy({ left: -sc.clientWidth * 0.9, behavior: "smooth" }); };
      w.querySelector(".row-next").onclick = (e) => { e.preventDefault(); sc.scrollBy({ left: sc.clientWidth * 0.9, behavior: "smooth" }); };
      requestAnimationFrame(upd); setTimeout(upd, 600);   // re-check after images load

      // Auto-scroll: spot-row = 5s, hero = 6s, app rows = disabled. Pause on hover/focus.
      const isSpot = sc.classList.contains("spot-row");
      const isHero = sc.classList.contains("hero");
      if (!isSpot && !isHero) return;  // Only auto-scroll featured banners
      const interval = isSpot ? 5000 : 6000;
      let paused = false, timer;
      let lastAdvance = 0;
      const autoStep = () => {
        if (paused || sc.scrollWidth <= sc.clientWidth + 10) return;
        const max = sc.scrollWidth - sc.clientWidth;
        const cardW = sc.firstElementChild?.getBoundingClientRect().width || sc.clientWidth;
        const step = sc.children[1] ? sc.children[1].offsetLeft - sc.children[0].offsetLeft : cardW;
        const currentIdx = Math.round(sc.scrollLeft / (step || cardW));
        const cards = sc.children.length;
        const nextIdx = (currentIdx + 1) % cards;
        // When wrapping from last to first, wait an extra interval (so Ignite banner gets full time)
        if (nextIdx === 0 && lastAdvance !== 0) {
          lastAdvance = 0;
          return; // Skip this tick, advance on the next one
        }
        lastAdvance = Date.now();
        const targetLeft = nextIdx === 0 ? 0 : sc.children[nextIdx].offsetLeft - sc.children[0].offsetLeft;
        sc.scrollTo({ left: targetLeft, behavior: "smooth" });
        // Update dots for spot-row
        if (isSpot) {
          view.querySelectorAll(".spot-dots i").forEach((d, n) => d.classList.toggle("on", n === nextIdx));
        }
      };
      const start = () => { clearInterval(timer); timer = setInterval(autoStep, interval); };
      const pause = () => { paused = true; };
      const resume = () => { paused = false; };
      w.addEventListener("mouseenter", pause); w.addEventListener("mouseleave", resume);
      w.addEventListener("touchstart", pause, { passive: true }); w.addEventListener("touchend", () => setTimeout(resume, 2000), { passive: true });
      start();
      autoScrollers.add({ el: sc, stop: () => clearInterval(timer) });
    });
  }
  function stopAutoScrollers() { autoScrollers.forEach((a) => a.stop()); autoScrollers.clear(); }
  addEventListener("resize", () => view.querySelectorAll(".rowwrap .scroller, .rowwrap .spot-row").forEach((sc) => sc.dispatchEvent(new Event("scroll"))));

  // ---------- screenshot gallery: arrows, dots, full-size viewer with left/right ----------
  // Auto-scrolling screenshots: 4s per image, pauses on hover/touch
  let shotTimer, shotPaused = false;
  function initShotAutoScroll() {
    clearInterval(shotTimer);
    const sc = $("#shots"); if (!sc || sc.children.length <= 1) return;
    const gal = sc.closest(".gallery");
        const step = () => {
      if (shotPaused) return;
      const imgs = galImgs();
      if (imgs.length <= 1) return;
      const w = imgs[0]?.getBoundingClientRect().width || sc.clientWidth;
      const now = Math.round(sc.scrollLeft / (w + 20));
      const next = (now + 1) % imgs.length;
      requestAnimationFrame(() => {
        galGo(0, next);
      });
    };;
    shotTimer = setInterval(step, 4000);
    if (gal) {
      gal.onmouseenter = () => { shotPaused = true; };
      gal.onmouseleave = () => { shotPaused = false; };
      gal.ontouchstart = () => { shotPaused = true; };
      gal.ontouchend = () => { setTimeout(() => { shotPaused = false; }, 2000); };
    }
  }
  const galImgs = () => [...document.querySelectorAll("#shots img")];
  function galGo(dir, to) {
    const sc = $("#shots"); if (!sc) return;
    const imgs = galImgs(), w = imgs[0]?.getBoundingClientRect().width || sc.clientWidth;
    const now = Math.round(sc.scrollLeft / (w + 20));
    const n = to != null ? to : Math.max(0, Math.min(imgs.length - 1, now + dir));
    sc.scrollTo({ left: imgs[n].offsetLeft - sc.offsetLeft, behavior: "smooth" });
  }
  document.addEventListener("scroll", (e) => {
    if (e.target?.id !== "shots") return;
    const sc = e.target, imgs = galImgs(), w = imgs[0]?.getBoundingClientRect().width || 1;
    const n = Math.round(sc.scrollLeft / (w + 20));
    document.querySelectorAll(".g-dots i").forEach((d, i) => d.classList.toggle("on", i === n));
  }, true);
  // The lightbox used to navigate galImgs(), i.e. ONLY the #shots screenshot scroller. Open a
  // theme page's wallpaper and that list was empty, so no arrows were drawn and the viewer was
  // a dead end — you had to close it, scroll, and click the next one. It now works on whatever
  // group of zoomable images you clicked inside, and cycles on its own if you leave it alone.
  let lbIndex = 0, lbList = [], lbTimer = null, lbHold = false;
  const LB_DELAY = 5000;

  function lbGroup(img) {
    // Nearest ancestor holding more than one zoomable image — the row/scroller it belongs to.
    for (let el = img.parentElement; el && el !== document.body; el = el.parentElement) {
      const found = [...el.querySelectorAll("img[data-zoom]")];
      if (found.length > 1) return found;
    }
    return [img];
  }
  function lbRender() {
    const im = $("#lb-img"); if (!im) return;
    im.src = lbList[lbIndex].src;
    im.alt = lbList[lbIndex].alt || "";
    const c = $("#lb-count"); if (c) c.textContent = `${lbIndex + 1} / ${lbList.length}`;
  }
  function lbAuto(on) {
    clearInterval(lbTimer); lbTimer = null;
    if (on && lbList.length > 1) lbTimer = setInterval(() => { if (!lbHold) lbStep(1); }, LB_DELAY);
  }
  function openLightbox(img) {
    lbList = lbGroup(img);
    lbIndex = Math.max(0, lbList.indexOf(img));
    const many = lbList.length > 1;
    showSheet(`<img id="lb-img" src="${esc(img.src)}" alt="${esc(img.alt || "")}">
      ${many ? `<button class="lb-nav lb-prev" data-lb="-1" aria-label="Previous image">‹</button><button class="lb-nav lb-next" data-lb="1" aria-label="Next image">›</button>
      <div class="lb-count" id="lb-count">${lbIndex + 1} / ${lbList.length}</div>` : ""}`, "lightbox");
    lbRender();
    // Pause the auto-cycle while the pointer is over the image, so it can be studied.
    const sheet = $(".sheet.lightbox");
    if (sheet && many) {
      sheet.addEventListener("mouseenter", () => { lbHold = true; }, true);
      sheet.addEventListener("mouseleave", () => { lbHold = false; }, true);
      let x0 = null;
      sheet.addEventListener("touchstart", (e) => { x0 = e.touches[0].clientX; lbHold = true; }, { passive: true });
      sheet.addEventListener("touchend", (e) => {
        if (x0 != null) { const dx = e.changedTouches[0].clientX - x0; if (Math.abs(dx) > 40) lbStep(dx < 0 ? 1 : -1); }
        x0 = null; setTimeout(() => { lbHold = false; }, 2000);
      }, { passive: true });
    }
    lbAuto(many);
  }
  function lbStep(d) {
    if (!lbList.length || !$("#lb-img")) return;
    lbIndex = (lbIndex + d + lbList.length) % lbList.length;
    lbRender();
  }
  document.addEventListener("keydown", (e) => {
    if (!$(".sheet.lightbox:not([hidden])")) return;
    if (e.key === "ArrowRight") lbStep(1); else if (e.key === "ArrowLeft") lbStep(-1); else if (e.key === "Escape") closeSheet();
  });

  // ---------- actions ----------
  function showSheet(html, cls = "") {
    const s = $("#sheet");
    s.className = "sheet " + cls;
    s.innerHTML = html; s.hidden = false;
  }
  const closeSheet = () => {
    lbAuto(false); lbList = []; lbHold = false;   // never leave the lightbox cycling in the background
    $("#sheet").hidden = true; $("#sheet").innerHTML = "";
  };

  function webGet(a) {
    const cmd = cmdFor(a);
    showSheet(`<div class="sheet-card" role="dialog" aria-label="Install ${esc(a.name)}">
      <div class="row">${iconImg(a, 56)}<div><h3>Get ${esc(a.name)}</h3><div class="muted small">Installs from ${esc(sourceLabel(a))}</div></div></div>
      <div class="small muted">Paste this into a terminal (<b>Super + Return</b>):</div>
      <div class="code"><code>${esc(cmd)}</code><button class="btn" data-copy="${esc(cmd)}" data-track-get="${esc(a.id)}">Copy</button></div>
      ${a.install.method === "store" ? `<div class="small muted">Installs to your home folder only, no password needed. Then open <b>Omarchy Store</b> from your app launcher (<b>Super + Space</b>). <a style="color:var(--accent)" href="${SITE}install.sh" target="_blank" rel="noopener">Read the script</a>.</div>` : ""}
      ${a.install.method === "release" ? `<div class="small muted">${esc(a.name)} isn't in the Arch repos or the AUR, so <code>omarchy pkg add ${esc(a.id)}</code> won't find it. This command downloads it from the developer, checks its fingerprint (SHA-256) against the store, then installs it. It asks for your password. <a style="color:var(--accent)" href="${SITE}get.sh" target="_blank" rel="noopener">Read the script</a>.</div>` : ""}
      ${a.featured?.heads_up ? `<div class="trust warn" style="margin-top:10px">${ico("warn")}<div>${esc(a.featured.heads_up.body)}</div></div>` : ""}
      ${a.install.method === "store" ? "" : `<div class="small muted">Want one-click installs? <a style="color:var(--accent)" href="/get-desktop/" data-close>Get the desktop app</a>.</div>`}
      <p class="small muted sheet-legal">${esc(DISCLAIMER_SHORT)} <a style="color:var(--accent)" href="/legal/" data-close>Disclaimer</a></p>
      <div style="text-align:right;margin-top:16px"><button class="btn ghost" data-close>Done</button></div>
    </div>`);
  }

  const ACCEPT_KEY = "omarchy-store-disclaimer-accepted-v1";
  function confirmThenGet(a) {
    if (localStorage.getItem(ACCEPT_KEY) && !a.featured?.heads_up) return desktopGet(a);
    showSheet(`<div class="sheet-card" role="dialog" aria-label="Before you install">
      <div class="row">${iconImg(a, 56)}<div><h3>Before you install</h3><div class="muted small">${esc(a.name)} · from ${esc(sourceLabel(a))}</div></div></div>
      ${a.featured?.heads_up ? `<div class="trust warn" style="margin:0 0 12px">${ico("warn")}<div><b>${esc(a.featured.heads_up.title)}</b><div style="margin-top:4px">${esc(a.featured.heads_up.body)}</div></div></div>` : ""}
      <p>${esc(DISCLAIMER_SHORT)}</p>
      <p class="small muted">Omarchy Store and its maintainers are not responsible for viruses, malware, data loss or any other damage caused by installed software. Read the <a style="color:var(--accent)" href="/legal/" data-close>full disclaimer</a>.</p>
      <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:18px">
        <button class="btn ghost" data-close>Cancel</button>
        <button class="btn" data-accept="${a.id}">I understand — install</button>
      </div>
    </div>`);
  }

  async function desktopGet(a) {
    S.busy.add(a.id); rerender();
    try {
      const r = await post("/api/install", { id: a.id });
      trackEvent("install", a.id);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
      toast(`Installing ${a.name} — follow the terminal window`);
      // Poll until the package shows up (install runs in a floating terminal and may ask for your password).
      const t0 = Date.now();
      while (Date.now() - t0 < 20 * 60e3) {
        await new Promise((res) => setTimeout(res, 2500));
        const st = await (await fetch("/api/job/" + a.id, { cache: "no-store" })).json();
        if (st.installed) { S.installed.add(a.id); toast(`${a.name} installed`); break; }
        if (st.state === "done" || st.state === "failed") { await refreshInstalled(); if (!isInstalled(a)) toast(`${a.name} was not installed`); break; }
      }
    } catch (e) {
      toast("Install failed: " + e.message);
    }
    S.busy.delete(a.id); rerender();
  }

  async function desktopOpen(a) {
    const r = await post("/api/open", { id: a.id });
    const j = await r.json().catch(() => ({}));
    toast(r.ok ? `Opening ${a.name}` : (j.error || "Could not open"));
  }

  document.addEventListener("click", (e) => {
    const t = e.target.closest("[data-gal],[data-gal-to],[data-lb],[data-usb-confirm],[data-usb-dl],[data-usb-refresh],[data-usb-pick],[data-usb-write],[data-ignite-os],[data-bundle-toggle],[data-bundle-app],[data-upd],[data-upd-plug],[data-upd-all],[data-upd-store-only],[data-upd-refresh],[data-restart],[data-get],[data-buy],[data-soon],[data-accept],[data-open],[data-copy],[data-close],[data-share],[data-chart],[data-zoom],[data-theme-get],[data-theme-use],[data-tfilter],[data-plug-get],[data-pfilter],[data-plug-more],[data-plug-search],[data-sfilter],[data-saver-more],[data-cchain],[data-crypto-get],[data-self-update],[data-self-later],[data-rm],[data-rm-yes],[data-share-theme],#more,.sheet");
    if (!t) return;
    if (t.matches("[data-usb-dl]")) {
      post("/api/usb/download", {}).then(async (r) => { if (!r.ok) toast((await r.json().catch(() => ({}))).error || "Download failed"); loadUsb(); });
    } else if (t.matches("[data-usb-refresh]")) {
      loadUsb();
    } else if (t.matches("[data-usb-pick]")) {
      S.usbPick = t.dataset.usbPick; rerender();
    } else if (t.matches("[data-ignite-os]")) {
      S.ignitePlatform = t.dataset.igniteOs; try { localStorage.setItem("ignite-os", S.ignitePlatform); } catch {} rerender();
    } else if (t.matches("[data-bundle-toggle]")) {
      S.igniteBundleOn = !igniteBundleOn(); try { localStorage.setItem("ignite-bundle-on", S.igniteBundleOn ? "on" : "off"); } catch {} rerender();
    } else if (t.matches("[data-bundle-app]")) {
      const excl = igniteBundleExcluded(), id = t.dataset.bundleApp;
      if (excl.has(id)) excl.delete(id); else excl.add(id);
      try { localStorage.setItem("ignite-bundle-excl", JSON.stringify([...excl])); } catch {}
      rerender();
    } else if (t.matches("[data-usb-write]")) {
      const d = (S.usb?.drives || []).find((x) => x.path === S.usbPick);
      if (!d) return;
      showSheet(`<div class="sheet-card" role="dialog" aria-label="Erase USB drive">
        <div class="row"><span class="usb-art small">${ico("usb")}</span><div><h3>Erase ${esc(d.name)}?</h3><div class="muted small">${gb(d.size)} · ${esc(d.path)}</div></div></div>
        <p>Everything on this USB stick will be <b>permanently erased</b> and replaced with the Omarchy installer.</p>
        <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:18px">
          <button class="btn ghost" data-close>Cancel</button>
          <button class="btn danger" data-usb-confirm="${esc(d.path)}">Erase and make installer</button></div></div>`);
    } else if (t.matches("[data-usb-confirm]")) {
      const dev = t.dataset.usbConfirm; closeSheet();
      post("/api/usb/write", { device: dev }).then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (!r.ok) return toast(j.error || "Couldn't start");
        S.jobUsb = true; rerender(); toast("Writing the USB — follow the terminal window");
        setTimeout(() => { S.jobUsb = false; rerender(); }, 60e3);
      });
    } else if (t.matches("[data-upd]")) {
      e.preventDefault(); e.stopPropagation();
      const a = S.byId[t.dataset.upd]; doUpdate("/api/update", { id: a.id }, `Updating ${a.name}`);
    } else if (t.matches("[data-upd-plug]")) {
      e.preventDefault(); e.stopPropagation();
      post("/api/plugin/update", { id: t.dataset.updPlug }).then(() => { toast("Updating plugin…"); setTimeout(() => loadUpdates(true), 4000); setTimeout(() => loadUpdates(true), 15000); });
    } else if (t.matches("[data-upd-all]")) {
      doUpdate("/api/update-all", {}, "Updating Omarchy OS");
    } else if (t.matches("[data-upd-store-only]")) {
      doUpdateStoreOnly();
    } else if (t.matches("[data-upd-refresh]")) {
      loadUpdates(true);
    } else if (t.matches("[data-restart]")) {
      post("/api/restart", {}).then(() => { toast("Restarting Omarchy Store…"); setTimeout(() => location.reload(), 2500); });
    } else if (t.matches("[data-theme-get],[data-theme-use]")) {
      e.preventDefault(); e.stopPropagation();
      const th = S.themeById[t.dataset.themeGet || t.dataset.themeUse];
      if (!S.desktop) webThemeGet(th);
      else desktopTheme(th, t.dataset.themeUse ? "/api/theme/use" : "/api/theme/install");
    } else if (t.matches("[data-rm]")) {
      e.preventDefault(); e.stopPropagation();
      const [kind, ...rest] = t.dataset.rm.split(":"); confirmRemove(kind, rest.join(":"));
    } else if (t.closest("[data-rm-store]")) {
      const all = !!$("#rm-store-all")?.checked; closeSheet();
      post("/api/uninstall-store", { id: "omarchy-store", all }).then(() => toast("Removing the Omarchy Store… follow the terminal window")).catch((e) => toast("Couldn't remove: " + e.message));
    } else if (t.matches("[data-rm-yes]")) {
      e.preventDefault(); e.stopPropagation();
      const [kind, ...rest] = t.dataset.rmYes.split(":"); doRemove(kind, rest.join(":"));
    } else if (t.matches("[data-plug-get]")) {
      e.preventDefault(); e.stopPropagation();
      const x = S.plugById[t.dataset.plugGet];
      if (x) { if (S.desktop) desktopPlugin(x); else webPluginGet(x); }
    } else if (t.matches("[data-plug-search]")) {
      S.plugQ = t.dataset.plugSearch; S.plugShown = 60;
    } else if (t.matches("[data-self-update]")) {
      e.preventDefault(); e.stopPropagation();   // the button can sit inside an app row link
      selfUpdate(t);
    } else if (t.matches("[data-self-later]")) {
      $("#self-upd")?.remove();
    } else if (t.matches("[data-migrate]")) {
      e.preventDefault(); e.stopPropagation();
      migrateToNative(t);
    } else if (t.matches("[data-migration-dismiss]")) {
      $("#migration-banner")?.remove();
      localStorage.setItem("migration-dismissed", "1");
    } else if (t.matches("[data-cchain]")) {
      S.cryptoChain = t.dataset.cchain; rerender();
    } else if (t.matches("[data-crypto-get]")) {
      e.preventDefault(); e.stopPropagation();
      const w = walletById(t.dataset.cryptoGet);
      if (w) cryptoGet(w);
    } else if (t.matches("[data-sfilter]")) {
      S.saverF = t.dataset.sfilter; S.saverShown = 60; rerender();
    } else if (t.matches("[data-saver-more]")) {
      S.saverShown += 60; const g = $("#sgrid"); if (g) g.innerHTML = saverGridHtml();
    } else if (t.matches("[data-pfilter]")) {
      S.plugFilter = t.dataset.pfilter; S.plugShown = 60; rerender();
    } else if (t.matches("[data-plug-more]")) {
      S.plugShown += 120; const g = $("#pgrid"); if (g) g.innerHTML = plugGridHtml();
    } else if (t.matches("[data-tfilter]")) {
      S.themeFilter = t.dataset.tfilter; rerender();
    } else if (t.matches("[data-share-theme]")) {
      copy(SITE + "theme/" + t.dataset.shareTheme + "/");
    } else if (t.matches("[data-buy]")) {
      // Paid app: run the Solana checkout, then re-render so the button becomes GET.
      const a = S.byId[t.dataset.buy];
      if (a) {
        if (!window.OmarchyPay) { toast("Checkout is still loading — try again in a second"); return; }
        window.OmarchyPay.buy(a);
      }
    } else if (t.matches("[data-get]")) {
      e.preventDefault(); e.stopPropagation();
      const a = S.byId[t.dataset.get];
      S.desktop ? confirmThenGet(a) : webGet(a);
    } else if (t.matches("[data-soon]")) {
      e.preventDefault(); e.stopPropagation();
      toast(`${S.byId[t.dataset.soon].name} is launching soon — check back shortly`);
    } else if (t.matches("[data-accept]")) {
      localStorage.setItem(ACCEPT_KEY, new Date().toISOString());
      closeSheet(); desktopGet(S.byId[t.dataset.accept]);
    } else if (t.matches("[data-open]")) {
      e.preventDefault(); e.stopPropagation(); desktopOpen(S.byId[t.dataset.open]);
    } else if (t.matches("[data-copy]")) {
      e.preventDefault(); copy(t.dataset.copy);
      if (t.dataset.trackGet && !copy.sent?.[t.dataset.trackGet]) { (copy.sent ||= {})[t.dataset.trackGet] = 1; trackEvent("get", t.dataset.trackGet); }
    } else if (t.matches("[data-close]")) {
      closeSheet();
    } else if (t.matches("[data-share]")) {
      copy(SITE + "app/" + t.dataset.share + "/");
    } else if (t.matches("[data-chart]")) {
      S.chartCat = t.dataset.chart; rerender();
    } else if (t.matches("[data-gal]")) {
      e.preventDefault(); galGo(+t.dataset.gal);
    } else if (t.matches("[data-gal-to]")) {
      e.preventDefault(); galGo(0, +t.dataset.galTo);
    } else if (t.matches("[data-lb]")) {
      e.preventDefault(); e.stopPropagation(); lbStep(+t.dataset.lb);
    } else if (t.matches("[data-zoom]")) {
      openLightbox(t);
    } else if (t.id === "more") {
      $("#desc").classList.remove("clamp"); t.remove();
    } else if (t.matches(".sheet") && (e.target === t
               || (t.classList.contains("lightbox") && !e.target.closest("#lb-img,.lb-nav,.lb-count")))) {
      // Backdrop click closes. Clicking the photo itself must NOT close it now that the
      // lightbox is a navigable gallery — you'd dismiss it while reaching for the arrows.
      closeSheet();
    }
  });
  document.addEventListener("click", (e) => {
    const r = e.target.closest("[data-review],[data-rate]");
    if (!r) return;
    e.preventDefault();
    if (r.matches("[data-review]")) return openReview(S.byId[r.dataset.review]);
    const f = r.closest("form"); f.dataset.rating = r.dataset.rate;
    f.querySelectorAll("[data-rate]").forEach((b) => b.classList.toggle("on", Number(b.dataset.rate) <= Number(r.dataset.rate)));
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeSheet();
    if (e.key === "/" && document.activeElement !== $("#q")) { e.preventDefault(); $("#q").focus(); }
  });
  // Theme search box filters the grid in place (no re-render, so the cursor stays put).
  document.addEventListener("input", (e) => {
    if (e.target.id === "cq") { S.cryptoQ = e.target.value; const g = $("#cgrid"); if (g) g.innerHTML = cryptoGridHtml(); return; }
    if (e.target.id === "sq") { S.saverQ = e.target.value; S.saverShown = 60; const g = $("#sgrid"); if (g) g.innerHTML = saverGridHtml(); return; }
    if (e.target.id === "pq") { S.plugQ = e.target.value; S.plugShown = 60; const g = $("#pgrid"); if (g) g.innerHTML = plugGridHtml(); return; }
    if (e.target.id !== "tq") return;
    S.themeQ = e.target.value;
    const g = $("#tgrid"); if (g) g.innerHTML = themeGridHtml();
  });
  document.addEventListener("change", (e) => {
    if (e.target.id === "pcat") { S.plugCat = e.target.value; S.plugShown = 60; const g = $("#pgrid"); if (g) g.innerHTML = plugGridHtml(); }
  });
  document.addEventListener("click", (e) => {
    const d = e.target.closest("[data-spot]"); if (!d) return;
    const row = view.querySelector(".spot-row"), card = row?.children[+d.dataset.spot];
    if (card) row.scrollTo({ left: card.offsetLeft - row.children[0].offsetLeft, behavior: "smooth" });
  });
  // macOS-style bounce on icon click
  document.addEventListener("click", (e) => {
    const icon = e.target.closest(".icon");
    if (icon) {
      icon.classList.remove("bounce");
      void icon.offsetWidth; // reflow to restart animation
      icon.classList.add("bounce");
    }
  });
  document.addEventListener("scroll", (e) => {
    const row = e.target;
    if (!(row instanceof Element) || !row.classList.contains("spot-row")) return;
    const i = Math.round(row.scrollLeft / Math.max(1, row.firstElementChild.getBoundingClientRect().width));
    view.querySelectorAll(".spot-dots i").forEach((d, n) => d.classList.toggle("on", n === i));
  }, true);
  let qt;
  $("#q").addEventListener("input", (e) => {
    clearTimeout(qt);
    const v = e.target.value;
    qt = setTimeout(() => {
      const path = v.trim() ? "/search/" + encodeURIComponent(v) + "/" : "/";
      if (location.pathname.startsWith("/search/")) { history.replaceState(null, "", path); route(); } else go(path);
    }, 180);
  });
  // Intercept in-store links so navigation is instant (no page reload).
  document.addEventListener("click", (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest("a[href]");
    if (!a || a.target === "_blank" || a.hasAttribute("download")) return;
    const url = new URL(a.href, location.href);
    if (url.origin !== location.origin || url.pathname.startsWith("/api/") || /\.[a-z0-9]+$/i.test(url.pathname)) return;
    e.preventDefault();
    if (a.hasAttribute("data-close")) closeSheet();
    go(url.pathname);
    // "#step1"-style links: same page → just scroll there; other page → scroll once it has rendered
    if (url.hash && url.hash.length > 1 && !url.hash.startsWith("#/")) {
      const id = decodeURIComponent(url.hash.slice(1));
      requestAnimationFrame(() => setTimeout(() => {
        const el = document.getElementById(id);
        if (el) (el.closest(".go-step") || el).scrollIntoView({ behavior: "smooth", block: "start" });
      }, 60));
    }
  });
  window.addEventListener("popstate", () => { closeSheet(); route(); });
  window.addEventListener("hashchange", () => { if (location.hash.startsWith("#/")) { closeSheet(); route(); } });
  window.addEventListener("focus", async () => { if (S.desktop) { await refreshInstalled(); rerender(); } });

  boot().catch((e) => {
    view.innerHTML = `<div class="page"><div class="empty">Couldn’t load the store catalog.<br><span class="small">${esc(e.message)}</span></div></div>`;
  });
})();
