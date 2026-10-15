#!/usr/bin/env python3
"""What the UPDATE button actually runs, per app shape.

Guards the Brave bug (1.8.17): a packaged app (`omarchy install browser brave`) names no
package in its recipe, so run_update used to silently turn into a whole-OS update and the
app never offered an UPDATE button at all. Nothing here touches the system: in_terminal is
replaced with a recorder, so we only inspect the command that would have been run.
"""
import importlib.machinery, importlib.util, json, os, sys, types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
spec = importlib.util.spec_from_loader("storehelper",
    importlib.machinery.SourceFileLoader("storehelper", os.path.join(ROOT, "desktop", "omarchy-store")))
S = importlib.util.module_from_spec(spec)
spec.loader.exec_module(S)

RAN = []
S.in_terminal = lambda script, title: (RAN.append(script), types.SimpleNamespace(wait=lambda: None))[1]
S.threading.Thread = lambda *a, **kw: types.SimpleNamespace(start=lambda: None)  # no watcher threads

cat = json.load(open(os.path.join(ROOT, "site", "catalog.json")))
apps = {a["id"]: a for a in (cat["apps"] if isinstance(cat, dict) else cat)}

fail = 0


def check(aid, must, must_not=()):
    global fail
    RAN.clear()
    try:
        S.run_update(apps[aid])
    except Exception as e:                      # noqa: BLE001
        print(f"FAIL {aid}: raised {e!r}")
        fail += 1
        return
    if not RAN:
        print(f"FAIL {aid}: nothing ran")
        fail += 1
        return
    script = RAN[0]
    for m in must:
        if m not in script:
            print(f"FAIL {aid}: missing {m!r} in: {script}")
            fail += 1
            return
    for m in must_not:
        if m in script:
            print(f"FAIL {aid}: should not contain {m!r}: {script}")
            fail += 1
            return
    print(f"ok   {aid}: {script}")


# Packaged apps from the Omarchy repo: must name the package and use -Syu (never a bare OS update).
check("brave", ["pacman", "-Syu", "brave-bin", "Updating Brave"], ["omarchy-update'"])
check("brave-origin", ["pacman", "-Syu", "brave-origin-bin"])
# A pacman app from Arch's own repos.
check("firefox", ["pacman", "-Syu", "firefox"])

# The UPDATE button has to be offered for packaged apps too, not just store releases.
# The UPDATE button has to be offered for packaged apps too, not just store releases:
# take a packaged app that really is installed here, pretend the catalog has a newer build,
# and the store must mark it updatable.
inst = S.installed_ids(apps)
cand = next((i for i in inst
             if (apps[i].get("install") or {}).get("method") in ("pacman", "omarchy", "aur")
             and (apps[i].get("package") or {}).get("repo") == "omarchy"), None)
if not cand:
    print("skip quick_updatable: no packaged store app installed on this machine")
else:
    fake = {cand: dict(apps[cand])}
    fake[cand]["package"] = dict(fake[cand]["package"], version="99:9.9.9-1")
    got = S.quick_updatable(fake, [cand])
    if cand not in got:
        print(f"FAIL quick_updatable: {cand} not offered an UPDATE button")
        fail += 1
    else:
        print(f"ok   quick_updatable: {cand} -> UPDATE offered")
    # and with the catalog back at the installed version it must NOT nag
    same = {cand: dict(apps[cand])}
    pkg = same[cand]["package"]["name"]
    have = S.subprocess.run(["pacman", "-Q", pkg], capture_output=True, text=True).stdout.split()
    same[cand]["package"] = dict(same[cand]["package"], version=have[1])
    if cand in S.quick_updatable(same, [cand]):
        print(f"FAIL quick_updatable: {cand} nagged while up to date")
        fail += 1
    else:
        print(f"ok   quick_updatable: {cand} quiet when up to date")

# An Arch package must NOT get an UPDATE button from the catalog alone: Omarchy serves Arch
# packages from its own pinned stable mirror, which lags archlinux.org on purpose. Offering an
# update the mirror can't deliver is the phantom button this release exists to kill.
arch = next((i for i in inst if (apps[i].get("package") or {}).get("repo") in ("extra", "core", "multilib")), None)
if not arch:
    print("skip phantom-button check: no Arch-repo store app installed")
else:
    ahead = {arch: dict(apps[arch])}
    ahead[arch]["package"] = dict(ahead[arch]["package"], version="99:9.9.9-1")
    S.UPD["data"] = {}
    if arch in S.quick_updatable(ahead, [arch]):
        print(f"FAIL phantom button: {arch} offered an update the stable mirror can't deliver")
        fail += 1
    else:
        print(f"ok   no phantom button for Arch-repo app {arch}")

print("FAILURES:", fail)
sys.exit(1 if fail else 0)
