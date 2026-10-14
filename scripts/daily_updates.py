#!/usr/bin/env python3
"""Daily upstream watch: spot new releases, and say which ones need fresh screenshots.

Where each kind of app gets its version from, so this script only does what is actually
missing:

  - pacman / AUR (860 apps): build.py resolves the real package version from the Arch
    databases and the AUR on every build, so the daily deploy already keeps them current.
    Nothing to do here.
  - release-pinned (7 of our own): scripts/first_party_updates.py re-pins version, URL and
    SHA-256 from the latest GitHub release. Run that too; this script does not duplicate it.
  - the 577 apps with a GitHub repo: nothing watched their upstream at all. That is this
    script's job.

It records the newest release tag seen per app in registry/upstream-state.json, and on each
run reports the apps whose upstream has published something new since last time.

Each new release is classified so screenshots can be refreshed only when they are actually
stale: a release whose notes talk about the interface, a redesign, a theme or a new screen is
flagged needs_art, because the listing's pictures no longer match what the user will see. A
release that only mentions fixes, performance or dependencies is not flagged, so we are not
re-shooting 577 apps for a bumped library.

First run has no previous state, so it records the current tags and reports nothing new -
otherwise every app would look "updated" on day one.

Usage:
  python3 scripts/daily_updates.py              # report only
  python3 scripts/daily_updates.py --write      # also save the new state
  python3 scripts/daily_updates.py --json       # machine-readable report
Set GITHUB_TOKEN to avoid the 60 requests/hour anonymous limit.
"""
import json, os, re, sys, time, urllib.error, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APPS = os.path.join(ROOT, "registry", "apps")
STATE = os.path.join(ROOT, "registry", "upstream-state.json")

# A release that changes what the app LOOKS like makes the listing's screenshots wrong.
ART_WORDS = re.compile(
    r"\b(redesign(ed)?|rewritten|rewrite|rebuilt|new (ui|interface|look|design|theme|layout|screen)"
    r"|ui (overhaul|refresh|update)|revamp(ed)?|restyl(e|ed)|theming|dark mode|light mode"
    r"|new icons?|overhaul(ed)?|facelift|material you|appearance)\b", re.I)
# A release that is clearly internal only - never worth re-shooting.
QUIET_WORDS = re.compile(
    r"\b(bug ?fix(es)?|hotfix|patch|security|dependenc(y|ies)|bump|chore|typo|ci|build|"
    r"performance|perf|memory leak|crash fix|revert)\b", re.I)


def token():
    t = os.environ.get("GITHUB_TOKEN", "").strip()
    return t or None


def gh_json(url):
    req = urllib.request.Request(url, headers={
        "User-Agent": "omarchy-store-daily",
        "Accept": "application/vnd.github+json",
        **({"Authorization": f"Bearer {token()}"} if token() else {})})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            # 403/429 are rate limits: back off rather than hammering
            if e.code in (403, 429) and attempt < 3:
                time.sleep(2 ** attempt * 3)
                continue
            return None
        except Exception:
            if attempt < 3:
                time.sleep(2 ** attempt)
                continue
            return None
    return None


def load_apps():
    out = {}
    for fn in sorted(os.listdir(APPS)):
        if not fn.endswith(".json"):
            continue
        with open(os.path.join(APPS, fn)) as f:
            a = json.load(f)
        repo = (a.get("github") or "").strip().strip("/")
        if repo.count("/") == 1:
            out[a["id"]] = {"repo": repo, "name": a.get("name") or a["id"],
                            "method": (a.get("install") or {}).get("method", "")}
    return out


def classify(title, body):
    """needs_art when the release describes a visible change and is not purely internal."""
    text = f"{title or ''}\n{body or ''}"
    hit = ART_WORDS.search(text)
    if hit:
        return True, hit.group(0)
    return False, ("internal only" if QUIET_WORDS.search(text) else "no visual signal")


def main():
    write = "--write" in sys.argv
    as_json = "--json" in sys.argv
    apps = load_apps()
    state = {}
    if os.path.exists(STATE):
        with open(STATE) as f:
            state = json.load(f).get("apps", {})
    first_run = not state

    changed, art, checked, failed = [], [], 0, 0
    for aid, info in apps.items():
        rel = gh_json(f"https://api.github.com/repos/{info['repo']}/releases/latest")
        if rel is None:
            # no releases published, or the repo is gone/renamed: fall back to tags
            tags = gh_json(f"https://api.github.com/repos/{info['repo']}/tags?per_page=1")
            if not tags:
                failed += 1
                continue
            tag, title, body, when = tags[0].get("name"), "", "", ""
        else:
            tag = rel.get("tag_name") or rel.get("name")
            title, body, when = rel.get("name") or "", rel.get("body") or "", rel.get("published_at") or ""
        if not tag:
            failed += 1
            continue
        checked += 1
        prev = (state.get(aid) or {}).get("tag")
        if prev and prev != tag:
            needs_art, why = classify(title, body)
            rec = {"id": aid, "name": info["name"], "repo": info["repo"],
                   "from": prev, "to": tag, "published": when,
                   "needs_art": needs_art, "reason": why}
            changed.append(rec)
            if needs_art:
                art.append(rec)
        state[aid] = {"tag": tag, "seen": time.strftime("%Y-%m-%d"),
                      "published": when or (state.get(aid) or {}).get("published", "")}

    report = {"generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
              "checked": checked, "unreachable": failed, "first_run": first_run,
              "updated": changed, "needs_art": art}
    if write:
        with open(STATE, "w") as f:
            json.dump({"_comment": "Newest upstream release tag seen per app. Written by "
                                   "scripts/daily_updates.py; do not edit by hand.",
                       "updated": report["generated"], "apps": state}, f, indent=1, sort_keys=True)
            f.write("\n")
    if as_json:
        print(json.dumps(report, indent=1))
        return 0
    print(f"checked {checked} GitHub repos, {failed} unreachable")
    if first_run:
        print("first run: recorded current tags, nothing reported as new")
    elif not changed:
        print("no upstream releases since the last run")
    else:
        print(f"\n{len(changed)} app(s) released upstream:")
        for c in changed:
            flag = "  [NEEDS NEW SCREENSHOTS]" if c["needs_art"] else ""
            print(f"  {c['name']:<24} {c['from']} -> {c['to']}{flag}")
        if art:
            print(f"\n{len(art)} need fresh screenshots because the UI changed:")
            for c in art:
                print(f"  {c['name']:<24} matched {c['reason']!r}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
