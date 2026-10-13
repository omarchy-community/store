#!/usr/bin/env python3
"""Check that every package an app installs really exists (Arch repos, Omarchy repo, or AUR).

Used by the "Validate registry" workflow on pull requests. Instead of one web request per
package (archlinux.org rate-limits those), it downloads each repo's package database once
from a mirror and asks the AUR about packages in batches — about a dozen requests in total.

  - Apps installed with "omarchy", "store" or "release" are skipped (not distro packages;
    release downloads are already pinned by URL + SHA-256 in build.py --check).
  - A package that is confirmed missing FAILS the check only if its app file was changed in
    this pull request. Problems in apps the PR didn't touch are shown as warnings.
  - If a source can't be downloaded, affected packages are warnings, never failures.

Usage: python3 scripts/check_packages.py [--all]   (--all: treat every app as changed)
"""
import glob, io, json, os, subprocess, sys, tarfile, time, urllib.error, urllib.parse, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UA = {"User-Agent": "omarchy-store-validate (+https://github.com/omarchy-community/store)"}
MIRRORS = [os.environ.get("ARCH_MIRROR", "https://geo.mirror.pkgbuild.com"),
           "https://mirror.rackspace.com/archlinux", "https://mirrors.kernel.org/archlinux"]
OMARCHY_DB = "https://pkgs.omarchy.org/stable/x86_64/omarchy.db"
SKIP_METHODS = {"omarchy", "store", "release"}
AUR_BATCH = 100


def fetch(url, timeout=60, tries=3):
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as r:
                return r.read()
        except Exception as ex:
            err = ex
            time.sleep(2 ** i)
    raise err


def db_names(raw):
    """Package names (and what they provide) from a pacman sync database (gzip or zstd tar)."""
    if raw[:4] == b"\x28\xb5\x2f\xfd":  # zstd magic
        raw = subprocess.run(["zstd", "-dc"], input=raw, capture_output=True, check=True).stdout
    names = set()
    with tarfile.open(fileobj=io.BytesIO(raw)) as tf:
        for m in tf.getmembers():
            if not m.name.endswith("/desc"):
                continue
            key = None
            for ln in tf.extractfile(m).read().decode("utf-8", "replace").splitlines():
                if len(ln) > 2 and ln.startswith("%") and ln.endswith("%"):
                    key = ln.strip("%")
                elif ln and key in ("NAME", "PROVIDES"):
                    names.add(ln.split("=")[0].split(">")[0].split("<")[0])
    return names


def load_repos():
    """Return (names, problems). problems lists sources that couldn't be read."""
    names, problems = set(), []
    for repo in ("core", "extra", "multilib"):
        for mirror in MIRRORS:
            try:
                names |= db_names(fetch(f"{mirror}/{repo}/os/x86_64/{repo}.db"))
                print(f"  read {repo}.db from {mirror}", flush=True)
                break
            except Exception as ex:
                print(f"  couldn't read {repo}.db from {mirror}: {ex}", flush=True)
        else:
            problems.append(f"Arch {repo} repo")
    try:
        names |= db_names(fetch(OMARCHY_DB))
        print("  read omarchy.db", flush=True)
    except Exception as ex:
        print(f"  couldn't read omarchy.db: {ex}", flush=True)
        problems.append("Omarchy repo")
    return names, problems


def aur_lookup(pkgs):
    """Return (found, unchecked): AUR names that exist, and names whose batch couldn't be checked."""
    found, unchecked = set(), set()
    pkgs = sorted(pkgs)
    for i in range(0, len(pkgs), AUR_BATCH):
        chunk = pkgs[i:i + AUR_BATCH]
        q = "&".join("arg[]=" + urllib.parse.quote(p) for p in chunk)
        try:
            j = json.loads(fetch("https://aur.archlinux.org/rpc/v5/info?" + q, timeout=30))
            found |= {r["Name"] for r in j.get("results", [])}
        except Exception as ex:
            print(f"  couldn't query the AUR for {len(chunk)} packages: {ex}", flush=True)
            unchecked |= set(chunk)
    return found, unchecked


def changed_files():
    """Registry files changed in this PR, or None if that can't be worked out (= check everything)."""
    base = os.environ.get("BASE_REF")
    if "--all" in sys.argv or not base:
        return None
    try:
        out = subprocess.run(["git", "diff", "--name-only", f"origin/{base}...HEAD"], cwd=ROOT,
                             capture_output=True, text=True, check=True).stdout
        return {ln.strip() for ln in out.splitlines() if ln.strip()}
    except Exception as ex:
        print(f"::warning::couldn't list changed files ({ex}); reporting problems as warnings only", flush=True)
        return set()


def main():
    wanted = {}  # package -> [app files]
    for f in sorted(glob.glob(os.path.join(ROOT, "registry", "apps", "*.json"))):
        a = json.load(open(f))
        if a["install"]["method"] in SKIP_METHODS:
            continue
        for p in a["detect"]:
            wanted.setdefault(p, []).append(os.path.relpath(f, ROOT))
    print(f"Checking {len(wanted)} packages", flush=True)

    repo_names, problems = load_repos()
    left = set(wanted) - repo_names
    aur_found, aur_unchecked = aur_lookup(left)
    if problems:
        # A repo we couldn't read might hold these, so nothing can be called missing.
        unsure, missing = left - aur_found, set()
    else:
        unsure, missing = aur_unchecked, left - aur_found - aur_unchecked
    if aur_unchecked:
        problems.append("AUR")

    changed = changed_files()
    errors, warnings = [], []
    for p in sorted(missing):
        for f in wanted[p]:
            msg = f"{f}: package {p!r} not found in Arch repos, the Omarchy repo or the AUR"
            (errors if changed is None or f in changed else warnings).append(msg)
    for p in sorted(unsure):
        for f in wanted[p]:
            warnings.append(f"{f}: couldn't verify package {p!r} (couldn't read: {', '.join(problems)})")

    for w in warnings:
        print(f"::warning::{w}", flush=True)
    for e in errors:
        print(f"::error::{e}", flush=True)
    print(f"{len(wanted) - len(missing) - len(unsure)} found, {len(missing)} missing, {len(unsure)} unverified; "
          f"{len(errors)} error(s) in apps changed by this PR", flush=True)
    sys.exit(1 if errors else 0)


if __name__ == "__main__":
    main()
