#!/usr/bin/env python3
"""Fail the build if a registry entry asks for an icon the site can't draw.

`ico(name)` in site/app.js renders `ICONS[name] || ""` — an unknown name produces an
EMPTY <svg>, so the card shows a blank tile instead of a glyph. Nothing errors, nothing
logs, and it only shows up when someone looks at the page. This check makes that loud.

Run: python3 scripts/check_icons.py
"""
import json, os, re, sys, glob

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _map_keys(src, name):
    """Keys of a `const <name> = { ... }` object literal in app.js."""
    i = src.index(f"const {name}")
    j = src.index("{", i)
    depth = 0
    for k in range(j, len(src)):
        if src[k] == "{":
            depth += 1
        elif src[k] == "}":
            depth -= 1
            if depth == 0:
                return set(re.findall(r"^\s*([A-Za-z][\w-]*)\s*:", src[j + 1:k], re.M))
    raise SystemExit(f"check_icons: couldn't find the end of {name}")


def known_icons():
    """The site has THREE icon maps and three renderers:
         ico()  -> ICONS
         pi()   -> pIco  || ICONS
         fico() -> FICON || ICONS      (feature cards)
    A name only has to exist in the map its renderer can reach. Checking ICONS alone is
    what let `star` and `search` ship as blank feature tiles, so resolve the union here
    and let the per-context check below do the precise work."""
    src = open(os.path.join(ROOT, "site", "app.js"), encoding="utf-8").read()
    icons = _map_keys(src, "ICONS")
    out = {"ICONS": icons}
    for extra in ("FICON", "pIco"):
        try:
            out[extra] = _map_keys(src, extra) | icons   # both fall back to ICONS
        except ValueError:
            pass
    return out


def used_icons():
    """Every bare `icon` name in the registry (paths like featured/x.png are images, not glyphs)."""
    out = {}

    def walk(node, where):
        if isinstance(node, dict):
            for k, v in node.items():
                if (k == "icon" and isinstance(v, str) and "/" not in v
                        and not v.lower().endswith((".png", ".webp", ".svg", ".jpg", ".jpeg", ".gif"))):
                    out.setdefault(v, set()).add(where)
                else:
                    walk(v, where)
        elif isinstance(node, list):
            for v in node:
                walk(v, where)

    for f in sorted(glob.glob(os.path.join(ROOT, "registry", "**", "*.json"), recursive=True)):
        try:
            walk(json.load(open(f, encoding="utf-8")), os.path.basename(f))
        except (ValueError, OSError) as e:
            print(f"check_icons: skipping {os.path.basename(f)}: {e}", file=sys.stderr)
    return out


def main():
    maps, used = known_icons(), used_icons()
    # Registry `icon` fields land on feature cards, which render through fico() -> FICON||ICONS.
    reachable = maps.get("FICON", maps["ICONS"])
    missing = {n: w for n, w in used.items() if n not in reachable}
    if missing:
        print(f"✗ {len(missing)} icon name(s) would render as BLANK tiles:\n")
        for n in sorted(missing):
            files = sorted(missing[n])
            print(f"    {n:12s}  used in: {', '.join(files[:5])}{' …' if len(files) > 5 else ''}")
        print("\n  Add them to FICON or ICONS in site/app.js, or correct the name in the registry.")
        return 1
    print(f"✓ icons: all {len(used)} registry names resolve via fico() "
          f"(FICON+ICONS = {len(reachable)} available)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
