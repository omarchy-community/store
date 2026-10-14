#!/usr/bin/env bash
# Connect the admin portal to GitHub (one time).
# Opens GitHub's "new token" page pre-filled, asks you to paste the token (hidden), checks it can
# write to omarchy-community/store, and saves it as the backend's GITHUB_TOKEN secret.
# The token is never printed or written to disk.
set -euo pipefail
REPO="omarchy-community/store"
cd "$(dirname "$0")/../backend"

URL="https://github.com/settings/personal-access-tokens/new?name=Omarchy+Store+admin+portal&description=Lets+the+admin+portal+edit+listings&target_name=omarchy-community&expires_in=none&contents=write&actions=read"
echo
echo "  Omarchy Store — connect the admin portal to GitHub"
echo "  ─────────────────────────────────────────────────"
echo "  1. Your browser opens GitHub's 'new token' page (most boxes are already filled in)."
echo "  2. Check: Resource owner = omarchy-community, Expiration = No expiration"
echo "     Repository access = Only select repositories → omarchy-community/store"
echo "     Permissions → Contents = Read and write, Actions = Read-only"
echo "  3. Click 'Generate token', then copy it."
echo
xdg-open "$URL" >/dev/null 2>&1 || echo "  Open this link: $URL"
read -rsp "  Paste the token here and press Enter (it stays hidden): " TOKEN; echo
[ -n "$TOKEN" ] || { echo "  No token entered — nothing changed."; exit 1; }

PUSH=$(curl -fsS -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" "https://api.github.com/repos/$REPO" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin).get("permissions",{}).get("push", False))' 2>/dev/null || echo "error")
if [ "$PUSH" != "True" ]; then
  echo "  ✗ That token can't write to $REPO."
  echo "    Make sure you picked omarchy-community as the owner, selected the store repo, and set Contents to Read and write."
  echo "    (If the organization asks to approve the token, approve it in github.com/organizations/omarchy-community/settings/personal-access-token-requests)"
  unset TOKEN; exit 1
fi
printf '%s' "$TOKEN" | npx -y wrangler secret put GITHUB_TOKEN >/dev/null
unset TOKEN
echo "  ✓ Connected. Open omarchystore.com/admin/ → Catalog — you can now edit listings, Featured and ads."
