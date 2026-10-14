#!/usr/bin/env python3
"""Keep developer-published ("release" method) apps on their latest GitHub release.

For every registry/apps/*.json with install.method == "release" (SnapDock, Jettison, Lifeboat,
Rabbit Ears, Marquee Socials, Omarchy Browser, Legal Dock ...):
  1. read the release repo from install.url (github.com/OWNER/REPO/releases/download/...)
  2. ask GitHub for that repo's latest published (non-draft, non-prerelease) release
  3. if it is newer and ships <package>-<version>-*.pkg.tar.zst, download it, hash it,
     and (with --write) update install.version / url / sha256 and prepend a changelog entry
Never switches repos, never accepts a missing package or a checksum mismatch.

Usage: python3 scripts/first_party_updates.py [--write] [--json]
"""
import hashlib, json, os, re, subprocess, sys, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
APPS = ROOT / "registry" / "apps"
URL_RE = re.compile(r"https://github\.com/([^/]+/[^/]+)/releases/download/")


def token():
    t = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if t:
        return t
    try:
        return subprocess.run(["gh", "auth", "token"], capture_output=True, text=True, timeout=10).stdout.strip()
    except Exception:
        return ""


TOKEN = token()


def get(url, raw=False):
    h = {"User-Agent": "omarchy-store-updates", "Accept": "application/vnd.github+json"}
    if TOKEN and "api.github.com" in url:
        h["Authorization"] = f"Bearer {TOKEN}"
    with urllib.request.urlopen(urllib.request.Request(url, headers=h), timeout=120) as r:
        data = r.read()
    return data if raw else json.loads(data)


def vkey(v):
    return [int(x) if x.isdigit() else x for x in re.split(r"[.\-+]", v.lstrip("v"))]


def newer(a, b):
    try:
        return vkey(a) > vkey(b)
    except TypeError:
        return a != b


def notes_to_items(body):
    items = []
    for line in (body or "").splitlines():
        m = re.match(r"\s*[-*]\s+(.*)", line)
        if m:
            t = re.sub(r"\*\*|`", "", m.group(1)).strip()
            if t and len(items) < 8:
                items.append(t)
    return items


def main():
    write = "--write" in sys.argv
    results = []
    for f in sorted(APPS.glob("*.json")):
        app = json.loads(f.read_text())
        inst = app.get("install") or {}
        if inst.get("method") != "release":
            continue
        m = URL_RE.match(inst.get("url", ""))
        if not m:
            results.append({"id": app["id"], "status": "error", "detail": "install.url is not a GitHub release"})
            continue
        repo, cur = m.group(1), inst.get("version", "0")
        pkg = (inst.get("packages") or [app["id"]])[0]
        try:
            rel = get(f"https://api.github.com/repos/{repo}/releases/latest")
        except Exception as e:
            results.append({"id": app["id"], "repo": repo, "status": "error", "detail": f"GitHub: {e}"})
            continue
        latest = rel.get("tag_name", "").lstrip("v")
        if not latest or not newer(latest, cur):
            results.append({"id": app["id"], "repo": repo, "status": "current", "version": cur})
            continue
        asset = next((a for a in rel.get("assets", [])
                      if re.fullmatch(rf"{re.escape(pkg)}-{re.escape(latest)}-\d+-(any|x86_64)\.pkg\.tar\.zst", a["name"])), None)
        if not asset:
            results.append({"id": app["id"], "repo": repo, "status": "skipped", "version": cur, "latest": latest,
                            "detail": f"release v{latest} has no {pkg}-{latest}-*.pkg.tar.zst"})
            continue
        try:
            blob = get(asset["browser_download_url"], raw=True)
        except Exception as e:
            results.append({"id": app["id"], "repo": repo, "status": "error", "detail": f"download: {e}"})
            continue
        sha = hashlib.sha256(blob).hexdigest()
        gh_digest = (asset.get("digest") or "").removeprefix("sha256:")
        if gh_digest and gh_digest != sha:
            results.append({"id": app["id"], "repo": repo, "status": "error", "detail": "checksum mismatch vs GitHub digest"})
            continue
        if blob[:4] != b"\x28\xb5\x2f\xfd":  # zstd magic
            results.append({"id": app["id"], "repo": repo, "status": "error", "detail": "asset is not a zstd package"})
            continue
        results.append({"id": app["id"], "repo": repo, "status": "updated", "from": cur, "to": latest})
        if write:
            inst.update(version=latest, url=asset["browser_download_url"], sha256=sha)
            cl = app.get("changelog")
            if isinstance(cl, list) and not any(c.get("version") == latest for c in cl):
                cl.insert(0, {"version": latest, "date": (rel.get("published_at") or "")[:10],
                              "title": rel.get("name") or f"{app['name']} {latest}",
                              "items": notes_to_items(rel.get("body"))})
            text = f.read_text()
            m2 = re.search(r"\n( +)\"", text)
            f.write_text(json.dumps(app, indent=len(m2.group(1)) if m2 else 2, ensure_ascii=False) + "\n")
    if "--json" in sys.argv:
        print(json.dumps(results, indent=2))
    else:
        for r in results:
            print(f"{r['id']:<18} {r['status']:<8} " + (f"{r.get('from')} -> {r.get('to')}" if r["status"] == "updated"
                  else r.get("version", "") + ("  " + r["detail"] if r.get("detail") else "")))
    return 1 if any(r["status"] == "error" for r in results) else 0


if __name__ == "__main__":
    sys.exit(main())
