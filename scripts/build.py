#!/usr/bin/env python3
"""Build site/catalog.json from registry/ + live data (GitHub, Flathub, Arch, AUR).

Usage:
  python3 scripts/build.py            # validate + fetch live data + write catalog
  python3 scripts/build.py --check    # validate registry only (no network) — used on PRs

Stdlib only. Set GITHUB_TOKEN to avoid GitHub's 60 req/hour anonymous limit.
"""
import json, os, re, subprocess, sys, time, urllib.error, urllib.request, urllib.parse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone, date

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REG = os.path.join(ROOT, "registry")
OUT = os.path.join(ROOT, "site", "catalog.json")

ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,40}$")
PKG_RE = re.compile(r"^[a-z0-9@._+-]+$")
# omarchy commands we allow in the registry: "omarchy install ..." only, plain words/quotes.
OMARCHY_RE = re.compile(r"^omarchy install [a-z0-9 '._-]+$", re.I)
KINDS = {"gui", "terminal"}
METHODS = {"pacman", "aur", "omarchy", "release", "store"}   # store = the Omarchy Store desktop app itself
# Verified developer downloads: only these GitHub owners, only pacman packages, always pinned by SHA-256.
RELEASE_RE = re.compile(r"^https://github\.com/(nemoclawai-tech|omarchy-community)/[A-Za-z0-9_.-]+/releases/download/[A-Za-z0-9_.+-]+/[A-Za-z0-9_.+-]+\.pkg\.tar\.zst$")


def load(path):
    with open(path) as f:
        return json.load(f)


def validate():
    errors = []
    cats = {c["id"] for c in load(os.path.join(REG, "categories.json"))}
    apps = {}
    adir = os.path.join(REG, "apps")
    for fn in sorted(os.listdir(adir)):
        if not fn.endswith(".json"):
            continue
        p = os.path.join(adir, fn)
        try:
            a = load(p)
        except Exception as e:
            errors.append(f"{fn}: invalid JSON ({e})"); continue
        e = lambda m: errors.append(f"{fn}: {m}")
        if a.get("id") != fn[:-5]: e("id must match filename")
        if not ID_RE.match(a.get("id", "")): e("id must be lowercase letters/digits/dashes")
        if not a.get("name"): e("name required")
        if a.get("category") not in cats: e(f"unknown category {a.get('category')!r}")
        if a.get("kind") not in KINDS: e(f"kind must be one of {sorted(KINDS)}")
        inst = a.get("install") or {}
        m = inst.get("method")
        if m not in METHODS: e(f"install.method must be one of {sorted(METHODS)}")
        if m in ("pacman", "aur"):
            pk = inst.get("packages") or []
            if not pk or not all(PKG_RE.match(x) for x in pk): e("install.packages must be valid package names")
        if m == "omarchy" and not OMARCHY_RE.match(inst.get("command", "")):
            e("install.command must be an 'omarchy install ...' command")
        if m == "store" and (a.get("id") != "omarchy-store" or inst.get("command") != "curl -fsSL https://omarchystore.com/install.sh | bash"):
            e("install.method 'store' is only for the Omarchy Store app itself")
        if m == "release":
            pk = inst.get("packages") or []
            if not pk or not all(PKG_RE.match(x) for x in pk): e("install.packages must be valid package names")
            if not RELEASE_RE.match(inst.get("url", "")): e("install.url must be an approved GitHub release .pkg.tar.zst")
            if not re.match(r"^[0-9a-f]{64}$", inst.get("sha256", "")): e("install.sha256 must be a sha256 hex digest")
            if not inst.get("version"): e("install.version required for release installs")
        det = a.get("detect") or []
        if not det or not all(PKG_RE.match(x) for x in det): e("detect must list package names")
        if a.get("open") and not re.match(r"^[A-Za-z0-9._-]+$", a["open"]): e("open must be a plain command name")
        if a.get("cli") and a.get("kind") != "terminal": e("cli apps must be kind=terminal")
        if not (a.get("github") or a.get("flathub") or a.get("homepage")): e("need github, flathub or homepage")
        if a.get("github") and not re.match(r"^[\w.-]+/[\w.-]+$", a["github"]): e("github must be owner/repo")
        for u in [a.get("icon"), a.get("homepage")] + list(a.get("screenshots") or []):
            if u and not u.startswith("https://"):
                if not (re.match(r"^featured/[a-z0-9-]+/[a-z0-9._-]+$", u) and os.path.exists(os.path.join(ROOT, "site", u))):
                    e(f"{u!r}: urls must be https:// or an existing file under site/featured/")
        apps[a.get("id")] = a
    feat = load(os.path.join(REG, "featured.json"))
    for h in feat["hero"]:
        if h["app"] not in apps: errors.append(f"featured.json: hero app {h['app']!r} not in registry")
    for c in feat["collections"]:
        for x in c["apps"]:
            if x not in apps: errors.append(f"featured.json: collection {c['title']!r} references unknown app {x!r}")
    ads = load(os.path.join(REG, "ads.json"))
    for c in ads["campaigns"]:
        if c.get("slot") not in {"banner", "search", "sponsored-app"}: errors.append(f"ads.json: {c.get('id')}: bad slot")
        if c.get("type") == "app" and c.get("app") not in apps: errors.append(f"ads.json: {c.get('id')}: unknown app")
        if c.get("url") and not c["url"].startswith("https://"): errors.append(f"ads.json: {c.get('id')}: url must be https")
        if c.get("type") not in {"house", "direct", "app", "artist"}: errors.append(f"ads.json: {c.get('id')}: bad type")
        img = c.get("image")
        if img and not img.startswith("https://"):
            if not re.match(r"^ads/[a-z0-9-]+\.(webp|png|jpg|jpeg)$", img) or not os.path.exists(os.path.join(ROOT, "site", img)):
                errors.append(f"ads.json: {c.get('id')}: image must be https:// or an existing file in site/ads/")
    errors += validate_crypto()
    return apps, cats, feat, ads, errors


CHROME_ID_RE = re.compile(r"^[a-p]{32}$")


def load_crypto():
    p = os.path.join(REG, "crypto-wallets.json")
    return load(p) if os.path.exists(p) else {"safety": "", "wallets": [], "depin": []}


def validate_crypto():
    """Crypto wallets: browser extensions linked to their official Chrome Web Store listing (never hosted)."""
    errors, seen, cids = [], set(), set()
    try:
        d = load_crypto()
    except Exception as ex:
        return [f"crypto-wallets.json: invalid JSON ({ex})"]
    if not d.get("safety"): errors.append("crypto-wallets.json: safety note required")
    for w in d.get("wallets") or []:
        e = lambda m: errors.append(f"crypto-wallets.json: {w.get('id')!r}: {m}")
        if not ID_RE.match(w.get("id") or ""): e("id must be lowercase letters/digits/dashes")
        if w.get("id") in seen: e("duplicate id")
        seen.add(w.get("id"))
        if not CHROME_ID_RE.match(w.get("chrome_store_id") or ""): e("chrome_store_id must be 32 letters a-p")
        if w.get("chrome_store_id") in cids: e("duplicate chrome_store_id")
        cids.add(w.get("chrome_store_id"))
        for f in ("name", "summary", "description"):
            if not w.get(f): e(f"{f} required")
        ch = w.get("chains")
        if not ch or not isinstance(ch, list) or not all(isinstance(x, str) and re.match(r"^[A-Za-z0-9 .-]{1,24}$", x) for x in ch): e("chains must be a list of names")
        for f in ("website", "firefox_url"):
            if w.get(f) and not re.match(r"^https://[^\s\"'<>]+$", w[f]): e(f"{f} must be an https:// url")
        if not w.get("website"): e("website required")
        ic = w.get("icon") or ""
        if not (ic.startswith("https://") or (re.match(r"^featured/crypto/[a-z0-9-]+\.(png|webp|svg)$", ic) and os.path.exists(os.path.join(ROOT, "site", ic)))):
            e("icon must be https:// or an existing file under site/featured/crypto/")
    # Validate DePIN extensions (similar to wallets but with type instead of chains)
    for w in d.get("depin") or []:
        e = lambda m: errors.append(f"crypto-wallets.json (depin): {w.get('id')!r}: {m}")
        if not ID_RE.match(w.get("id") or ""): e("id must be lowercase letters/digits/dashes")
        if w.get("id") in seen: e("duplicate id")
        seen.add(w.get("id"))
        if not CHROME_ID_RE.match(w.get("chrome_store_id") or ""): e("chrome_store_id must be 32 letters a-p")
        if w.get("chrome_store_id") in cids: e("duplicate chrome_store_id")
        cids.add(w.get("chrome_store_id"))
        for f in ("name", "summary", "description"):
            if not w.get(f): e(f"{f} required")
        if w.get("type") != "depin": e("type must be 'depin'")
        for f in ("website",):
            if w.get(f) and not re.match(r"^https://[^\s\"'<>]+$", w[f]): e(f"{f} must be an https:// url")
        if not w.get("website"): e("website required")
        ic = w.get("icon") or ""
        if not (ic.startswith("https://") or (re.match(r"^featured/crypto/[a-z0-9-]+\.(png|webp|svg)$", ic) and os.path.exists(os.path.join(ROOT, "site", ic)))):
            e("icon must be https:// or an existing file under site/featured/crypto/")
    return errors


def get(url, headers=None, tries=4):
    req = urllib.request.Request(url, headers={"User-Agent": "omarchy-store-build (+https://github.com/omarchy-community/store)", **(headers or {})})
    for i in range(tries):
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                return json.load(r)
        except urllib.error.HTTPError as ex:
            if ex.code == 404:
                return None
            err = ex
        except Exception as ex:
            err = ex
        time.sleep(2 ** i)
    print(f"  warn: {url}: {err}", file=sys.stderr)
    return None


GQL_FIELDS = """nameWithOwner stargazerCount forkCount description homepageUrl isArchived pushedAt
  licenseInfo { spdxId } owner { __typename avatarUrl } latestRelease { tagName publishedAt }"""


def gh_batch(repos):
    """Fetch many repos per request via GraphQL (needs GITHUB_TOKEN). Returns {repo: data}."""
    tok = os.environ.get("GITHUB_TOKEN")
    if not tok:
        return {}
    out = {}
    for i in range(0, len(repos), 40):
        chunk = repos[i:i + 40]
        parts = []
        for j, r in enumerate(chunk):
            o, n = r.split("/", 1)
            parts.append(f"r{j}: repository(owner:{json.dumps(o)}, name:{json.dumps(n)}) {{ {GQL_FIELDS} }}")
        body = json.dumps({"query": "query{" + " ".join(parts) + "}"}).encode()
        for t in range(4):
            try:
                req = urllib.request.Request("https://api.github.com/graphql", data=body, headers={
                    "Authorization": "bearer " + tok, "Content-Type": "application/json", "User-Agent": "omarchy-store-build"})
                with urllib.request.urlopen(req, timeout=60) as resp:
                    d = (json.load(resp).get("data") or {})
                break
            except Exception as ex:
                d = {}
                time.sleep(2 ** t)
        for j, r in enumerate(chunk):
            v = d.get(f"r{j}")
            if not v:
                continue
            rel = v.get("latestRelease") or {}
            out[r] = {
                "stars": v["stargazerCount"], "forks": v["forkCount"], "description": v["description"],
                "homepage": v["homepageUrl"] or None, "license": (v.get("licenseInfo") or {}).get("spdxId"),
                "pushed_at": v["pushedAt"], "archived": v["isArchived"],
                "owner_avatar": (v.get("owner") or {}).get("avatarUrl"),
                "owner_is_org": (v.get("owner") or {}).get("__typename") == "Organization",
                "release": rel.get("tagName"), "released_at": rel.get("publishedAt"),
            }
    return out


def gh(repo):
    h = {"Accept": "application/vnd.github+json"}
    if os.environ.get("GITHUB_TOKEN"):
        h["Authorization"] = "Bearer " + os.environ["GITHUB_TOKEN"]
    r = get(f"https://api.github.com/repos/{repo}", h)
    if not r:
        return None
    rel = get(f"https://api.github.com/repos/{repo}/releases/latest", h) or {}
    return {
        "stars": r.get("stargazers_count"), "forks": r.get("forks_count"),
        "description": r.get("description"), "homepage": r.get("homepage") or None,
        "license": (r.get("license") or {}).get("spdx_id"), "pushed_at": r.get("pushed_at"),
        "archived": r.get("archived"), "owner_avatar": (r.get("owner") or {}).get("avatar_url"),
        "release": rel.get("tag_name"), "released_at": rel.get("published_at"),
    }


def strip_html(s):
    s = re.sub(r"<li>", "• ", s or "")
    s = re.sub(r"</(p|li|ul|ol)>", "\n", s)
    s = re.sub(r"<[^>]+>", "", s)
    s = re.sub(r"[ \t]+", " ", s)
    return re.sub(r"\n\s*\n+", "\n\n", s).strip()


def flathub(fid):
    j = get(f"https://flathub.org/api/v2/appstream/{fid}")
    if not j:
        return None
    shots = []
    for s in j.get("screenshots") or []:
        sizes = s.get("sizes") or []
        pick = next((x for x in sizes if x.get("width") == "1248"), None) or (sizes[0] if sizes else None)
        if pick:
            shots.append(pick["src"])
    desc = strip_html(j.get("description"))
    desc = "\n\n".join(p for p in desc.split("\n\n") if "flatpak" not in p.lower() and "flathub" not in p.lower())
    rel = (j.get("releases") or [{}])[0]
    cr = ((j.get("content_rating_details") or {}).get("en_US") or {})
    return {
        "summary": j.get("summary"), "description": desc, "developer": j.get("developer_name"),
        "icon": j.get("icon"), "screenshots": shots[:8], "homepage": (j.get("urls") or {}).get("homepage"),
        "license": j.get("project_license"), "version": rel.get("version"),
        "age": cr.get("minimumAgeText"),
    }


def arch(pkg):
    j = get("https://archlinux.org/packages/search/json/?" + urllib.parse.urlencode({"name": pkg}))
    rs = (j or {}).get("results") or []
    if not rs:
        return None
    r = rs[0]
    return {"repo": r["repo"], "version": r["pkgver"], "size": r.get("installed_size"), "updated": r.get("last_update")}


def arch_bulk(names):
    """Look up official Arch packages by downloading Arch's repo databases from a mirror
    (3 files, ~10 MB) — fresh, exact, and immune to archlinux.org's API rate limits.
    Set ARCH_SOURCE=local to read this machine's pacman sync DB instead (offline, may be stale).
    Omarchy-repo packages aren't on Arch mirrors; those fall through to the AUR lookup or
    show without version info."""
    out = {}
    if os.environ.get("ARCH_SOURCE", "mirror") == "local":
        try:
            res = subprocess.run(["expac", "-S", "%r\t%n\t%v\t%m"], capture_output=True, text=True, timeout=60)
            for line in res.stdout.splitlines():
                r, n, v, size = (line.split("\t") + [""] * 4)[:4]
                if n in names and n not in out and r in ("core", "extra", "multilib", "omarchy"):
                    out[n] = {"repo": r, "version": v, "size": int(size) if size.isdigit() else None, "updated": None}
            return out
        except (FileNotFoundError, subprocess.TimeoutExpired):
            pass
    import tarfile, io
    mirror = os.environ.get("ARCH_MIRROR", "https://geo.mirror.pkgbuild.com")
    for repo in ("core", "extra", "multilib"):
        try:
            req = urllib.request.Request(f"{mirror}/{repo}/os/x86_64/{repo}.db", headers={"User-Agent": "omarchy-store-build"})
            with urllib.request.urlopen(req, timeout=120) as r:
                data = r.read()
            with tarfile.open(fileobj=io.BytesIO(data)) as tf:
                for m in tf.getmembers():
                    if not m.name.endswith("/desc"):
                        continue
                    desc = tf.extractfile(m).read().decode("utf-8", "replace")
                    fields, key = {}, None
                    for ln in desc.splitlines():
                        if len(ln) > 2 and ln.startswith("%") and ln.endswith("%"):
                            key = ln.strip("%")
                        elif ln and key:
                            fields.setdefault(key, ln)
                            key = None
                    n = fields.get("NAME")
                    if n in names and n not in out:
                        isize = fields.get("ISIZE", "")
                        bd = fields.get("BUILDDATE", "")
                        out[n] = {"repo": repo, "version": fields.get("VERSION"),
                                  "size": int(isize) if isize.isdigit() else None,
                                  "updated": datetime.fromtimestamp(int(bd), timezone.utc).isoformat() if bd.isdigit() else None}
        except Exception as ex:
            print(f"  warn: couldn't read {repo}.db from {mirror}: {ex}", file=sys.stderr)
    # Omarchy's own package repo (zstd-compressed database).
    try:
        req = urllib.request.Request("https://pkgs.omarchy.org/stable/x86_64/omarchy.db", headers={"User-Agent": "omarchy-store-build"})
        raw = urllib.request.urlopen(req, timeout=60).read()
        tar = subprocess.run(["zstd", "-dc"], input=raw, capture_output=True, check=True).stdout
        with tarfile.open(fileobj=io.BytesIO(tar)) as tf:
            for m in tf.getmembers():
                if not m.name.endswith("/desc"):
                    continue
                fields, key = {}, None
                for ln in tf.extractfile(m).read().decode("utf-8", "replace").splitlines():
                    if len(ln) > 2 and ln.startswith("%") and ln.endswith("%"):
                        key = ln.strip("%")
                    elif ln and key:
                        fields.setdefault(key, ln); key = None
                n = fields.get("NAME")
                if n in names and n not in out:
                    isize, bd = fields.get("ISIZE", ""), fields.get("BUILDDATE", "")
                    out[n] = {"repo": "omarchy", "version": fields.get("VERSION"), "size": int(isize) if isize.isdigit() else None,
                              "updated": datetime.fromtimestamp(int(bd), timezone.utc).isoformat() if bd.isdigit() else None}
    except Exception as ex:
        print(f"  warn: couldn't read the Omarchy package repo: {ex}", file=sys.stderr)
    return out


def _unused_arch_bulk_web(names):
    """Look up official Arch packages. archlinux.org rate-limits per-package calls,
    so page through the search API by repo instead (a few dozen requests total)."""
    out = {}
    for repo, arch_ in (("Core", "x86_64"), ("Core", "any"), ("Extra", "x86_64"), ("Extra", "any"), ("Multilib", "x86_64")):
        page = 1
        while True:
            j = get("https://archlinux.org/packages/search/json/?" + urllib.parse.urlencode({"repo": repo, "arch": arch_, "page": page, "limit": 250}))
            if not j:
                break
            for r in j.get("results", []):
                if r["pkgname"] in names and r["pkgname"] not in out:
                    out[r["pkgname"]] = {"repo": r["repo"], "version": r["pkgver"], "size": r.get("installed_size"), "updated": r.get("last_update")}
            if page >= j.get("num_pages", 1):
                break
            page += 1
            time.sleep(0.2)
    # Fallback for anything the bulk listing missed (e.g. arch=any packages).
    for n in sorted(names - set(out)):
        r = arch(n)
        if r:
            out[n] = r
        time.sleep(0.25)
    return out


def aur(pkgs):
    if not pkgs:
        return {}
    q = "&".join("arg[]=" + urllib.parse.quote(p) for p in pkgs)
    j = get("https://aur.archlinux.org/rpc/v5/info?" + q) or {}
    return {r["Name"]: {"repo": "aur", "version": r["Version"], "votes": r["NumVotes"],
                        "popularity": r["Popularity"], "out_of_date": bool(r.get("OutOfDate")),
                        "updated": datetime.fromtimestamp(r["LastModified"], timezone.utc).isoformat()}
            for r in j.get("results", [])}


ICON_TYPES = {b"\x89PNG": ".png", b"<svg": ".svg", b"<?xml": ".svg", b"\xff\xd8\xff": ".jpg", b"RIFF": ".webp"}


def mirror_icon(app_id, url):
    """Download an icon into site/icons/ so the store never depends on hotlinks.
    Returns the local relative path, or None if the URL isn't a real image."""
    if not url:
        return None
    req = urllib.request.Request(url, headers={"User-Agent": "omarchy-store-build"})
    for i in range(3):
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                data = r.read(2_000_000)
            break
        except Exception:
            time.sleep(2 ** i)
    else:
        print(f"  warn: icon download failed for {app_id}: {url}", file=sys.stderr)
        return None
    head = data[:200].lstrip()
    ext = next((e for sig, e in ICON_TYPES.items() if head.startswith(sig)), None)
    if ext == ".svg" and b"<svg" not in data[:2000]:
        ext = None
    if not ext:
        print(f"  warn: {app_id}: icon is not an image ({data[:40]!r})", file=sys.stderr)
        return None
    d = os.path.join(ROOT, "site", "icons")
    os.makedirs(d, exist_ok=True)
    for old in os.listdir(d):
        if old.rsplit(".", 1)[0] == app_id:
            os.remove(os.path.join(d, old))
    with open(os.path.join(d, app_id + ext), "wb") as f:
        f.write(data)
    return f"icons/{app_id}{ext}"


def added_dates():
    """When each app first appeared in the registry, read from git history.

    One `git log` pass rather than 886 of them. Lines come newest-first, so the LAST date
    written for an id is its first appearance.

    A day on which a huge number of apps appear is a bulk import (the repo's first commit
    seeded 851), not discovery, so those are marked bulk=True and excluded from "New Apps" —
    otherwise the shelf would show the entire catalogue as new.
    """
    try:
        out = subprocess.run(
            ["git", "log", "--diff-filter=A", "--name-only", "--pretty=format:D|%ad", "--date=short",
             "--", os.path.join("registry", "apps")],
            cwd=ROOT, capture_output=True, text=True, timeout=120, check=True).stdout
    except Exception as ex:
        print(f"  warn: add-dates unavailable ({ex}); New Apps will be empty", file=sys.stderr)
        return {}, set()
    day, first = None, {}
    for ln in out.splitlines():
        ln = ln.strip()
        if ln.startswith("D|"):
            day = ln[2:]
        elif ln.endswith(".json") and day:
            first[os.path.basename(ln)[:-5]] = day
    counts = Counter(first.values())
    bulk = {d for d, n in counts.items() if n >= 100}
    if bulk:
        print(f"  add-dates: {len(first)} apps; bulk-import days excluded from New Apps: {sorted(bulk)}")
    return first, bulk


def artwork_hashes():
    import hashlib
    base = os.path.join(ROOT, "site", "featured"); out = {}
    for d, _, files in os.walk(base):
        for f in files:
            if re.match(r"^[a-z0-9._-]+\.(png|webp|jpg|svg)$", f):
                full = os.path.join(d, f)
                out[os.path.relpath(full, os.path.join(ROOT, "site")).replace(os.sep, "/")] = hashlib.sha256(open(full, "rb").read()).hexdigest()[:16]
    return dict(sorted(out.items()))


def build(apps, cats, feat, ads):
    print(f"Fetching live data for {len(apps)} apps…")
    repos = sorted({a["github"] for a in apps.values() if a.get("github")})
    batch = gh_batch(repos)
    with ThreadPoolExecutor(8) as ex:
        missing = [r for r in repos if r not in batch]
        batch.update({r: v for r, v in zip(missing, ex.map(gh, missing)) if v})
        ghd = {k: batch.get(a["github"]) for k, a in apps.items() if a.get("github")}
        fhd = dict(zip(apps, ex.map(lambda a: flathub(a["flathub"]) if a.get("flathub") else None, apps.values())))
    main_pkg = {k: a["detect"][0] for k, a in apps.items()}
    ard = arch_bulk(set(main_pkg.values()))
    aurd = {}
    left = [p for p in main_pkg.values() if p not in ard]
    for i in range(0, len(left), 100):
        aurd.update(aur(left[i:i + 100]))

    addedd, bulkdays = added_dates()
    out = []
    for k, a in apps.items():
        g, f, pk = ghd.get(k) or {}, fhd.get(k) or {}, ard.get(main_pkg[k]) or aurd.get(main_pkg[k]) or {}
        out.append({
            **a,
            "summary": a.get("summary") or f.get("summary") or g.get("description") or "",
            "description": a.get("description") or f.get("description") or g.get("description") or "",
            "developer": a.get("developer") or f.get("developer") or (a["github"].split("/")[0] if a.get("github") else ""),
            "icon": a["icon"] if "icon" in a else (f.get("icon") or (g.get("owner_avatar") if g.get("owner_is_org", True) else None)),
            "screenshots": a.get("screenshots") or f.get("screenshots") or [],
            "homepage": a.get("homepage") or f.get("homepage") or g.get("homepage"),
            "license": g.get("license") if g.get("license") not in (None, "NOASSERTION") else f.get("license"),
            "age": a.get("age") or f.get("age"),
            "stars": g.get("stars"), "forks": g.get("forks"), "archived": g.get("archived"),
            "last_commit": g.get("pushed_at"), "release": g.get("release"), "released_at": g.get("released_at"),
            "package": {"name": main_pkg[k], **pk} if pk else {"name": main_pkg[k]},
            "added": addedd.get(k),
            # True = arrived in a bulk seed, so it is not a genuine "new app" for the shelf.
            "added_bulk": addedd.get(k) in bulkdays,
        })
    print("Mirroring icons…")
    with ThreadPoolExecutor(8) as ex:
        local = list(ex.map(lambda a: a["icon"] if (a["icon"] or "").startswith("featured/") else mirror_icon(a["id"], a["icon"]), out))
    for a, path in zip(out, local):
        a["icon_source"] = a["icon"]
        a["icon"] = path
        # A package that isn't published anywhere yet can't be installed: show "Coming soon".
        if a["install"]["method"] == "release":
            a["package"] = {**a["package"], "repo": "release", "version": a["install"]["version"],
                            **({"size": a["install"]["size"]} if a["install"].get("size") else {})}
        a["available"] = bool(a["package"].get("repo")) or a["install"]["method"] in ("omarchy", "store")
    try:
        from themes import collect as collect_themes
        themes = collect_themes()
    except Exception as ex:  # the app catalog must still publish if the theme source is down
        print(f"  warn: themes skipped: {ex}", file=sys.stderr)
        themes = []
    omarchy_iso = latest_omarchy_iso()
    today = date.today().isoformat()
    live = [c for c in ads["campaigns"] if c.get("enabled", True) and c.get("starts", "") <= today <= c.get("ends", "9999")]
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "categories": load(os.path.join(REG, "categories.json")),
        "featured": feat, "ads": {"network": ads["network"], "campaigns": live},
        "themes": themes,
        # Crypto wallets: browser extensions. GET opens the official Chrome Web Store page (desktop app: in Chromium).
        "crypto": load_crypto(),
        # Ignite's Windows helper ("Make room for Omarchy") is only offered once it has passed
        # testing on real Windows. Flip registry/ignite.json -> helper_ready: true.
        "ignite": load(os.path.join(REG, "ignite.json")) if os.path.exists(os.path.join(REG, "ignite.json")) else {"helper_ready": False},
        "omarchy_iso": omarchy_iso,
        # The desktop app compares this with its own VERSION and updates itself when it's newer.
        "desktop_version": re.search(r'^VERSION = "([^"]+)"', open(os.path.join(ROOT, "desktop", "omarchy-store")).read(), re.M).group(1),
        "themes_source": {"name": "Omarchy Themes", "url": "https://omarchythemes.com", "by": "Mubs", "by_url": "https://mubs.me"},
        # chart_rank pins an app's place at the top (the Omarchy Store app is #1); featured apps next, then GitHub stars.
        # The Omarchy Store's own listing ("store" install method) goes in its own key: desktop apps up to
        # 1.7.0 check every entry in "apps" and refuse the whole catalog if they meet a method they don't know.
        # The web page puts it back at #1 of the list (app.js boot).
        # Fingerprint of every piece of store artwork (icons, banners, screenshots). Desktop apps compare their saved
        # copies with this on every refresh and re-download anything that changed, so they always match the website.
        "artwork": artwork_hashes(),
        "store_app": next((x for x in out if x["install"]["method"] == "store"), None),
        "apps": sorted((x for x in out if x["install"]["method"] != "store"),
                       key=lambda x: (x.get("chart_rank") or (900 if x.get("featured") else 999), -(x["stars"] or 0))),
    }


UA = "omarchy-store-build (+https://github.com/omarchy-community/store)"


def latest_omarchy_iso():
    """Newest official Omarchy ISO linked from omarchy.org, with its published SHA-256 and size."""
    rx = re.compile(r"https://iso\.omarchy\.org/(omarchy-(\d+(?:\.\d+)*(?:-\d+)?)\.iso)")
    try:
        # Omarchy's official GitHub releases list the ISO link for each version (omarchy.org itself
        # sits behind a bot wall that blocks scripts).
        found = {}
        for src in ("https://api.github.com/repos/omacom/omarchy/releases?per_page=10", "https://omarchy.org/"):
            try:
                req = urllib.request.Request(src, headers={"User-Agent": UA, "Accept": "application/vnd.github+json, text/html"})
                text = urllib.request.urlopen(req, timeout=30).read().decode("utf-8", "ignore")
                found.update({m.group(2): m.group(1) for m in rx.finditer(text)})
            except Exception:
                pass
        if not found:
            raise ValueError("no ISO links found")
        v = max(found, key=lambda s: tuple(int(x) for x in re.split(r"[.-]", s)))
        fn = found[v]
        sha = urllib.request.urlopen(urllib.request.Request(f"https://iso.omarchy.org/{fn}.sha256", headers={"User-Agent": UA}), timeout=30).read().decode().split()[0].lower()
        head = urllib.request.urlopen(urllib.request.Request(f"https://iso.omarchy.org/{fn}", method="HEAD", headers={"User-Agent": UA}), timeout=30)
        assert re.match(r"^[0-9a-f]{64}$", sha)
        print(f"  Omarchy ISO: {v}")
        return {"version": v, "file": fn, "url": f"https://iso.omarchy.org/{fn}", "sha256": sha,
                "size": int(head.headers.get("Content-Length") or 0)}
    except Exception as ex:
        print(f"  warn: Omarchy ISO lookup failed: {ex}", file=sys.stderr)
        return None


def main():
    apps, cats, feat, ads, errors = validate()
    if errors:
        print("Registry errors:"); [print("  ✗", e) for e in errors]; sys.exit(1)
    print(f"✓ registry valid: {len(apps)} apps, {len(cats)} categories, {len(ads['campaigns'])} ad campaigns, {len(load_crypto()['wallets'])} crypto wallets")
    # An icon name the site can't draw renders as an EMPTY <svg> — a silent blank tile.
    # Fail the check rather than let that reach a listing page again.
    import subprocess as _sp
    _r = _sp.run([sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), "check_icons.py")],
                 capture_output=True, text=True)
    print((_r.stdout or _r.stderr).rstrip())
    if _r.returncode:
        sys.exit(1)
    if "--check" in sys.argv:
        return
    # Apps hidden from the admin portal ("hidden": true) stay in the registry but leave the store,
    # along with any Discover banner, shelf slot or sponsored-app ad that pointed at them.
    hidden = {k for k, a in apps.items() if a.get("hidden")}
    if hidden:
        print(f"Hiding {len(hidden)} app(s): {', '.join(sorted(hidden))}")
        apps = {k: a for k, a in apps.items() if k not in hidden}
        feat = {**feat, "hero": [h for h in feat["hero"] if h["app"] not in hidden],
                "collections": [{**c, "apps": [x for x in c["apps"] if x not in hidden]} for c in feat["collections"]]}
        ads = {**ads, "campaigns": [c for c in ads["campaigns"] if not (c.get("type") == "app" and c.get("app") in hidden)]}
    cat = build(apps, cats, feat, ads)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as f:
        json.dump(cat, f, indent=1)
    miss = [a["id"] for a in cat["apps"] if not a["icon"]]
    print(f"✓ wrote {OUT} ({os.path.getsize(OUT)//1024} KB). {len(miss)} apps use a generated icon.")


if __name__ == "__main__":
    main()
