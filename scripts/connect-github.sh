#!/usr/bin/env bash
# Connect the admin portal to GitHub (one time).
# Opens GitHub's "new token" page pre-filled, takes the token from your clipboard (press Enter) or a
# hidden paste, checks it can write to omarchy-community/store, and saves it as the backend's
# GITHUB_TOKEN secret. The token is never printed or written to disk, and once saved it is wiped
# from the clipboard and from Omarchy's clipboard history.
set -euo pipefail
REPO="omarchy-community/store"
cd "$(dirname "$0")/../backend"

# GitHub's template params: https://docs.github.com/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens
URL="https://github.com/settings/personal-access-tokens/new?name=Omarchy+Store+admin+portal&description=Lets+the+admin+portal+edit+listings&target_name=omarchy-community&expires_in=none&contents=write&actions=read"

say() { printf '  %s\n' "$@"; }
looks_like_token() { [[ ${1:-} =~ ^(github_pat_[A-Za-z0-9_]{40,}|ghp_[A-Za-z0-9]{30,})$ ]]; }
clipboard() { wl-paste --no-newline 2>/dev/null || true; }

echo
say "Omarchy Store — connect the admin portal to GitHub" \
    "─────────────────────────────────────────────────" \
    "1. Your browser opens GitHub's 'new token' page (most boxes are already filled in)." \
    "2. Check: Resource owner = omarchy-community · Expiration = No expiration (or the longest offered)" \
    "   Repository access = Only select repositories → 'Select repositories' → store" \
    "   Permissions → Contents = Read and write · Actions = Read-only" \
    "3. Click 'Generate token', then the copy button next to the new token." \
    "4. Come back to this window and press Enter — the token is read from your clipboard." \
    "   (Or paste it here with Ctrl+Shift+V / right-click → Paste, then Enter. Nothing shows while you type.)"
echo
xdg-open "$URL" >/dev/null 2>&1 || say "Open this link: $URL"

TOKEN=""
for _ in 1 2 3; do
  read -rsp "  Press Enter once the token is copied (or paste it here, then Enter): " INPUT || INPUT=""
  echo
  INPUT=${INPUT//[[:space:]]/}
  if [ -z "$INPUT" ]; then
    CLIP=$(clipboard); CLIP=${CLIP//[[:space:]]/}
    if looks_like_token "$CLIP"; then TOKEN=$CLIP; say "✓ Token found in your clipboard."; break; fi
    say "✗ No token in the clipboard yet. On GitHub, click the copy button next to the token, then press Enter here."
  elif looks_like_token "$INPUT"; then
    TOKEN=$INPUT; break
  else
    say "✗ That doesn't look like a GitHub token (they start with github_pat_). Try again."
  fi
done
[ -n "$TOKEN" ] || { say "No token received — nothing changed. Run this script again when you have one."; exit 1; }

say "Checking it with GitHub…"
HDRS=$(mktemp) BODY=$(mktemp)
trap 'rm -f "$HDRS" "$BODY"' EXIT
CODE=$(curl -sS -o "$BODY" -D "$HDRS" -w '%{http_code}' \
  -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2022-11-28" \
  "https://api.github.com/repos/$REPO" || echo 000)
PUSH=$(jq -r '.permissions.push // false' "$BODY" 2>/dev/null || echo false)
EXPIRES=$(grep -i '^github-authentication-token-expiration:' "$HDRS" | cut -d' ' -f2- | tr -d '\r' || true)

if [ "$CODE" != 200 ] || [ "$PUSH" != true ]; then
  case "$CODE" in
    401) say "✗ GitHub rejected that token (wrong paste, expired, or revoked). Generate a fresh one and try again." ;;
    404) say "✗ That token can't see $REPO." \
             "  On the token page, under Repository access → Only select repositories, click 'Select repositories' and pick store." ;;
    200) say "✗ That token can read $REPO but not write to it." \
             "  Under Permissions → Repository permissions, set Contents to 'Read and write'." ;;
    000) say "✗ Couldn't reach api.github.com — check the connection and try again." ;;
    *)   say "✗ GitHub answered HTTP $CODE. Make sure the owner is omarchy-community, the store repo is selected, and Contents = Read and write." ;;
  esac
  say "  (If GitHub asks the organization to approve the token, approve it at github.com/organizations/omarchy-community/settings/personal-access-token-requests)"
  unset TOKEN; exit 1
fi

printf '%s' "$TOKEN" | npx -y wrangler secret put GITHUB_TOKEN >/dev/null
say "✓ Connected. Open omarchystore.com/admin/ → Catalog — you can now edit listings, Featured and ads."
if [ -n "$EXPIRES" ]; then
  say "⚠ This token expires on ${EXPIRES%% *}. The admin portal stops saving after that — run this script" \
      "  again before then (or regenerate the token with Expiration = No expiration)."
fi

# Leave no copies behind: clear the clipboard if the token is still in it, and drop it from Omarchy's clipboard history.
[ "$(clipboard)" = "$TOKEN" ] && { wl-copy --clear 2>/dev/null || true; }
HIST="${XDG_STATE_HOME:-$HOME/.local/state}/omarchy/clipboard-history.json"
if [ -f "$HIST" ] && grep -qF -- "$TOKEN" "$HIST"; then
  SCRUB=$(mktemp)
  if jq --indent 2 --arg t "$TOKEN" '[.[] | select((.text // "") | contains($t) | not)]' "$HIST" >"$SCRUB"; then
    cat "$SCRUB" >"$HIST"   # same inode, so the clipboard manager reloads it
  fi
  rm -f "$SCRUB"
fi
unset TOKEN
say "  The token was wiped from your clipboard and clipboard history."
