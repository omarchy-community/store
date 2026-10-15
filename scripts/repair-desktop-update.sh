#!/usr/bin/env bash
# Omarchy Store — diagnose & repair a stuck desktop app update.
#
# Symptom this fixes: the store keeps showing an old version (e.g. 1.8.16) and
# never moves to the current one, with or without an UPDATE prompt.
#
# Safe by design: no sudo, no package changes, only the store's own files in
# your home folder. Run it, read the REPORT, let it repair.
#
#   bash <(curl -fsSL https://omarchystore.com/repair-desktop-update.sh)

set -uo pipefail

REMOTE="${OMARCHY_STORE_REMOTE:-https://omarchystore.com/}"
SHARE="$HOME/.local/share/omarchy-store"
OVERLAY="$HOME/.local/share/omarchy-store-overlay"
STATE="$HOME/.local/state/omarchy-store"
FILES=(omarchy-store uninstall.sh site/index.html site/app.js site/styles.css)

B=$'\033[1m'; G=$'\033[0;32m'; Y=$'\033[1;33m'; R=$'\033[0;31m'; N=$'\033[0m'
say()  { printf "%s==>%s %s\n" "$G" "$N" "$*"; }
warn() { printf "%sWARN:%s %s\n" "$Y" "$N" "$*"; }
die()  { printf "%sERROR:%s %s\n" "$R" "$N" "$*" >&2; exit 1; }

ver_of() { [ -f "$1" ] && sed -n 's/^VERSION = "\([^"]*\)".*/\1/p' "$1" | head -1; }

command -v python3 >/dev/null || die "python3 not found."
command -v curl    >/dev/null || die "curl not found."

echo
printf "%s================ OMARCHY STORE UPDATE REPORT ================%s\n" "$B" "$N"

# ---------------------------------------------------------------- 1. what the server offers
WANT=$(curl -fsSL --max-time 40 "${REMOTE}catalog.json" 2>/dev/null \
  | python3 -c 'import sys,json;print(json.load(sys.stdin).get("desktop_version",""))' 2>/dev/null)
[ -n "$WANT" ] || die "Could not read the catalog from $REMOTE (no internet, or the site is down)."
SERVED=$(curl -fsSL --max-time 40 "${REMOTE}desktop-files/omarchy-store" 2>/dev/null | sed -n 's/^VERSION = "\([^"]*\)".*/\1/p' | head -1)
echo "  catalog says newest : ${B}${WANT}${N}"
echo "  helper file served  : ${SERVED:-unreadable}"
[ "$WANT" = "$SERVED" ] || warn "catalog ($WANT) and served helper ($SERVED) disagree — server-side mismatch."

# ---------------------------------------------------------------- 2. every copy on this machine
echo
echo "  copies installed here:"
FOUND=0
for d in "$SHARE" "$OVERLAY" "/usr/share/omarchy-store" "/opt/omarchy-store"; do
  f="$d/omarchy-store"
  if [ -f "$f" ]; then
    FOUND=1
    v=$(ver_of "$f"); w="read-only"; [ -w "$d" ] && w="writable"
    printf "    %-10s %-9s %s\n" "${v:-?}" "$w" "$f"
  fi
done
# Electron bundles its own helper — a very common cause of "it never updates".
ELECTRON=$(find "$HOME" -maxdepth 6 -path '*/resources/app/omarchy-store' -not -path '*/node_modules/*' 2>/dev/null | head -5)
for f in $ELECTRON; do FOUND=1; printf "    %-10s %-9s %s\n" "$(ver_of "$f")" "electron" "$f"; done
[ "$FOUND" = 1 ] || warn "No installed copy found — the store may not be installed for this user."

# ---------------------------------------------------------------- 3. what is actually RUNNING
echo
RUNNING=$(pgrep -af "omarchy-store --serve" 2>/dev/null)
if [ -n "$RUNNING" ]; then
  echo "  running helper(s):"
  echo "$RUNNING" | sed 's/^/    /'
else
  warn "No helper is running. The store's UPDATE button does nothing without it."
fi
PORT=$(cat "$STATE/port" 2>/dev/null)
[ -n "$PORT" ] && echo "  listening port      : $PORT"

LIVE=""
if [ -n "$PORT" ]; then
  LIVE=$(curl -fsS --max-time 8 "http://127.0.0.1:$PORT/api/status" 2>/dev/null \
    | python3 -c 'import sys,json;print(json.load(sys.stdin).get("version",""))' 2>/dev/null)
  [ -n "$LIVE" ] && echo "  version in memory   : ${B}${LIVE}${N}"
fi

# ---------------------------------------------------------------- 4. diagnosis
TARGET="$SHARE"
[ -f "$OVERLAY/omarchy-store" ] && TARGET="$OVERLAY"
[ -d "$TARGET" ] || die "No writable store folder at $TARGET."
HAVE=$(ver_of "$TARGET/omarchy-store")

echo
printf "%s------------------------- DIAGNOSIS -------------------------%s\n" "$B" "$N"
if [ -n "$ELECTRON" ]; then
  warn "An Electron build is installed. It runs its OWN bundled helper, so updating"
  warn "the standalone copy will not change what the Electron window shows."
fi
if [ "$HAVE" = "$WANT" ] && [ -n "$RUNNING" ] && [ -n "$LIVE" ] && [ "$LIVE" != "$WANT" ]; then
  warn "Files are already $WANT but the running process is still $LIVE —"
  warn "the update was installed and never restarted. Restarting is the fix."
fi

# ---------------------------------------------------------------- 5. repair
echo
if [ "$HAVE" = "$WANT" ]; then
  say "Files at $TARGET are already $WANT — skipping download."
else
  say "Updating $TARGET: $HAVE -> $WANT"
  TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
  for f in "${FILES[@]}"; do
    mkdir -p "$TMP/$(dirname "$f")"
    curl -fsSL --max-time 60 "${REMOTE}desktop-files/$f" -o "$TMP/$f" \
      || die "download failed: $f"
  done
  # Verify before touching anything real.
  python3 -c "import sys;compile(open(sys.argv[1],encoding='utf-8').read(),'h','exec')" "$TMP/omarchy-store" \
    || die "downloaded helper is not valid Python — aborting, nothing changed."
  NEW=$(ver_of "$TMP/omarchy-store")
  [ "$NEW" = "$WANT" ] || warn "downloaded helper reports $NEW (expected $WANT)"
  grep -q "<head>" "$TMP/site/index.html" || die "downloaded index.html looks wrong — aborting."
  grep -q "boot()" "$TMP/site/app.js"     || die "downloaded app.js looks wrong — aborting."

  BK="$TARGET.backup-$(date +%Y%m%d-%H%M%S)"
  cp -a "$TARGET" "$BK" && say "Backup saved: $BK"
  for f in "${FILES[@]}"; do
    mkdir -p "$TARGET/$(dirname "$f")"
    install -m 0644 "$TMP/$f" "$TARGET/$f"
  done
  chmod 0755 "$TARGET/omarchy-store" "$TARGET/uninstall.sh" 2>/dev/null
  say "Installed $(ver_of "$TARGET/omarchy-store")"
fi

# ---------------------------------------------------------------- 6. restart so the new code is live
say "Restarting the helper..."
pkill -f "omarchy-store --serve" >/dev/null 2>&1 && sleep 2
rm -f "$STATE/port"
setsid nohup "$TARGET/omarchy-store" --serve >"$STATE/repair.log" 2>&1 < /dev/null &
for _ in $(seq 1 25); do
  sleep 1; P=$(cat "$STATE/port" 2>/dev/null); [ -n "$P" ] && break
done
[ -n "${P:-}" ] || { warn "Helper did not report a port. Log: $STATE/repair.log"; exit 1; }

NOWV=$(curl -fsS --max-time 8 "http://127.0.0.1:$P/api/status" 2>/dev/null \
  | python3 -c 'import sys,json;print(json.load(sys.stdin).get("version",""))' 2>/dev/null)
echo
printf "%s--------------------------- RESULT --------------------------%s\n" "$B" "$N"
echo "  on disk : $(ver_of "$TARGET/omarchy-store")"
echo "  running : ${NOWV:-unknown}  (port $P)"
if [ "${NOWV:-}" = "$WANT" ]; then
  printf "%s  Omarchy Store is now %s. Reopen the store window.%s\n" "$G" "$WANT" "$N"
else
  warn "Still not reporting $WANT. Send this whole report to info@omarchystore.com."
fi
[ -n "$ELECTRON" ] && warn "Electron build present — relaunch it from the app menu to pick this up."
echo
