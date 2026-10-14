#!/bin/bash
# Omarchy Store security lockdown: apply GitHub hardening to every repo we publish from.
# Idempotent. Re-run any time: ./scripts/lockdown.sh
# Owner (the only human allowed to push directly / approve / release): nemoclawai-tech
set -uo pipefail
OWNER_LOGIN="nemoclawai-tech"
REPOS=(
  omarchy-community/store
  omarchy-community/marquee-socials
  nemoclawai-tech/snapdock-releases
  nemoclawai-tech/touchfix
  nemoclawai-tech/omarchy-setups
  nemoclawai-tech/omarchy-store-screensaver
  nemoclawai-tech/omarchy-store-theme
  nemoclawai-tech/rabbit-ears
  nemoclawai-tech/mystify-screensaver
  nemoclawai-tech/lifeboat
  nemoclawai-tech/jettison
)

ok(){ printf '  ✓ %s\n' "$*"; }
bad(){ printf '  ✗ %s\n' "$*"; }

branch_ruleset='{
  "name": "Owner-only main",
  "target": "branch",
  "enforcement": "active",
  "bypass_actors": [{"actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always"}],
  "conditions": {"ref_name": {"include": ["~DEFAULT_BRANCH"], "exclude": []}},
  "rules": [
    {"type": "deletion"},
    {"type": "non_fast_forward"},
    {"type": "required_linear_history"},
    {"type": "pull_request", "parameters": {
      "required_approving_review_count": 1,
      "dismiss_stale_reviews_on_push": true,
      "require_code_owner_review": true,
      "require_last_push_approval": true,
      "required_review_thread_resolution": false,
      "allowed_merge_methods": ["squash", "merge"]}}
  ]
}'
tag_ruleset='{
  "name": "Owner-only releases (tags)",
  "target": "tag",
  "enforcement": "active",
  "bypass_actors": [{"actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always"}],
  "conditions": {"ref_name": {"include": ["~ALL"], "exclude": ["refs/tags/v*"]}},
  "rules": [{"type": "creation"}, {"type": "update"}, {"type": "deletion"}, {"type": "non_fast_forward"}]
}'
# refs/tags/v* is excluded on purpose: the "Release desktop app" GitHub Action cuts a v<VERSION>
# tag automatically whenever desktop/omarchy-store's VERSION changes on main. Since main itself
# is already owner-only (PR + CODEOWNERS review above), letting that CI step tag a release isn't
# a new hole — it just stops the Action from being blocked by its own ref-creation lock (as it
# was for v1.8.4/v1.8.5: "Cannot create ref due to creations being restricted").

upsert_ruleset(){ # repo name json
  local repo=$1 name=$2 json=$3 id
  if [ "$(gh api "repos/$repo" --jq .private)" = "true" ]; then ok "private repo (rulesets need Pro; only the owner can see or push anyway)"; return; fi
  id=$(gh api "repos/$repo/rulesets" --jq ".[]|select(.name==\"$name\")|.id" 2>/dev/null | head -1)
  if [ -n "$id" ]; then
    gh api -X PUT "repos/$repo/rulesets/$id" --input - <<<"$json" >/dev/null && ok "ruleset '$name' updated" || bad "ruleset '$name'"
  else
    gh api -X POST "repos/$repo/rulesets" --input - <<<"$json" >/dev/null && ok "ruleset '$name' created" || bad "ruleset '$name'"
  fi
}

for repo in "${REPOS[@]}"; do
  echo "== $repo"
  # 1. Collaborators: nobody but the owner.
  extra=$(gh api "repos/$repo/collaborators?affiliation=direct" --jq ".[]|select(.login!=\"$OWNER_LOGIN\")|.login" 2>/dev/null)
  if [ -n "$extra" ]; then for u in $extra; do gh api -X DELETE "repos/$repo/collaborators/$u" >/dev/null && ok "removed collaborator $u"; done; else ok "no outside collaborators"; fi
  # 2. Branch + tag rulesets (admins = the owner bypass; everyone else needs an approved PR, can't touch tags).
  upsert_ruleset "$repo" "Owner-only main" "$branch_ruleset"
  upsert_ruleset "$repo" "Owner-only releases (tags)" "$tag_ruleset"
  # 3. Secret scanning + push protection + dependabot alerts/updates, delete merged branches.
  gh api -X PATCH "repos/$repo" --input - >/dev/null <<'J' && ok "secret scanning + push protection + dependabot on" || bad "security_and_analysis"
{"security_and_analysis":{"secret_scanning":{"status":"enabled"},"secret_scanning_push_protection":{"status":"enabled"},"dependabot_security_updates":{"status":"enabled"}},
 "delete_branch_on_merge":true}
J
  gh api -X PUT "repos/$repo/vulnerability-alerts" >/dev/null 2>&1 && ok "dependabot alerts on"
  # 4. Actions: only GitHub-owned + verified-creator actions, read-only token, PRs from outsiders need approval.
  gh api -X PUT "repos/$repo/actions/permissions" --input - >/dev/null <<'J' && ok "actions: github-owned + verified only" || bad "actions permissions"
{"enabled":true,"allowed_actions":"selected"}
J
  gh api -X PUT "repos/$repo/actions/permissions/selected-actions" --input - >/dev/null <<'J' || bad "selected-actions"
{"github_owned_allowed":true,"verified_allowed":true,"patterns_allowed":[]}
J
  gh api -X PUT "repos/$repo/actions/permissions/workflow" --input - >/dev/null <<'J' && ok "workflow token read-only, no PR approvals by bots" || bad "workflow perms"
{"default_workflow_permissions":"read","can_approve_pull_request_reviews":false}
J
  gh api -X PUT "repos/$repo/actions/permissions/fork-pr-contributor-approval" --input - >/dev/null 2>&1 <<'J' && ok "fork PR workflows need owner approval" || true
{"approval_policy":"all_external_contributors"}
J
  # 5. Private vuln reporting so researchers tell us quietly.
  gh api -X PUT "repos/$repo/private-vulnerability-reporting" >/dev/null 2>&1 && ok "private vulnerability reporting on"
done

echo "== org omarchy-community"
gh api -X PATCH orgs/omarchy-community --input - >/dev/null <<'J' && ok "members: read-only default, can't create repos/pages, no forking of private" || bad "org settings"
{"default_repository_permission":"none","members_can_create_repositories":false,"members_can_create_public_repositories":false,
 "members_can_create_private_repositories":false,"members_can_create_pages":false,"members_can_fork_private_repositories":false,
 "members_allowed_repository_creation_type":"none"}
J
gh api -X PATCH orgs/omarchy-community/actions/permissions --input - >/dev/null 2>&1 <<'J' && ok "org actions: selected repos' policy = selected" || true
{"enabled_repositories":"all","allowed_actions":"selected"}
J
gh api -X PUT orgs/omarchy-community/actions/permissions/selected-actions --input - >/dev/null 2>&1 <<'J' && ok "org actions: github-owned + verified only" || true
{"github_owned_allowed":true,"verified_allowed":true,"patterns_allowed":[]}
J
gh api -X PUT orgs/omarchy-community/actions/permissions/workflow --input - >/dev/null 2>&1 <<'J' && ok "org workflow token read-only" || true
{"default_workflow_permissions":"read","can_approve_pull_request_reviews":false}
J
# 2FA requirement: only succeeds once the owner account has 2FA enabled.
if gh api -X PATCH orgs/omarchy-community -f two_factor_requirement_enabled=true >/dev/null 2>&1; then ok "org requires 2FA"; else bad "org 2FA requirement NOT set: enable 2FA on github.com/settings/security first, then re-run"; fi
echo "done."
