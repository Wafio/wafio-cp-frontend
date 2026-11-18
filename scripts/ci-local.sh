#!/usr/bin/env bash
# Every gate of this repo: the check for agent material, the secret scan, the
# fixture copies, the advisory check, then install, svelte-check, unit tests and the production build. Keeps going
# after a failure, prints a summary and exits nonzero if any gate failed. It runs
# on Linux, from anywhere in the repo.
#
# It checks the working tree for the build and the tests, and the tracked files
# for the agent-material check (hosted CI checks only the commit).
set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 1

failed=()
step() {
  local name=$1 start=$SECONDS
  shift
  printf '\n== %s\n' "$name"
  if "$@"; then
    printf -- '-- ok: %s (%ds)\n' "$name" $((SECONDS - start))
  else
    printf -- '-- FAILED: %s (%ds)\n' "$name" $((SECONDS - start))
    failed+=("$name")
  fi
}

# No agent files, no tracker IDs (finding, wave, work-package, plan unit) and no
# planning-doc references in code or strings. Markdown is excluded so a doc may
# cite a spec section. Needs a git checkout (git ls-files, git grep).
# No \b (macOS git grep -E matches nothing with it) and no grep -q after a pipe
# (SIGPIPE under pipefail). -I skips binary files (a PNG can match by chance on
# the Linux host). The doc names are written with a bracket (PORTIN[G])
# and the self-test samples are built with printf, so this file does not match
# its own patterns.
agent_material() {
  # Outside a checkout git grep fails and every check below would pass without looking.
  git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo 'ai check: needs a git checkout' >&2; return 1; }
  local ai_files='(^|/)(CLAUDE|GEMINI)\.md$|/AGENT[S]\.md$|(^|/)\.claude/|copilot-instructions|port-statu[s]|PORTIN[G]\.md'
  local ai_ids='(^|[^A-Za-z0-9_])(K-[0-9]{2,3}|[Ww]ave[- ]?[0-9]+|WP-[0-9]+|DEC-[0-9]+|FSD-[0-9]+|BR-[0-9]+|ADR-[0-9]+|CF-[0-9]+|SP-[0-9]+|TG-[0-9]+|OD-[0-9]+|CU-[0-9]+|RK-[0-9]+|POC-[A-Z]+|SEC-[0-9]+|INV-[0-9]+|LOW-[0-9]+|[NISXMDV]-[0-9]{1,2}|U[0-9]\.[0-9]+)([^0-9]|$)'
  local ai_docs='(^|[^A-Za-z0-9_])(PORTIN[G]|port-statu[s]|docs/plan[s]/|[Pp]lan §[0-9]|[Ss]pec §[0-9]|split-pre[p]|[Oo]wner decision|ui-guideline[s]|AGENTS\.md|[0-9]{4}-[0-9]{2}-[0-9]{2}-[a-z])'
  hits() { [ "$(printf '%s\n' "$2" | grep -cE "$1")" = "$3" ] || { echo 'ai check: pattern self-test failed' >&2; return 1; }; }
  hits "$ai_ids" "$(printf 'x K-%s y' 12)" 1 || return 1
  hits "$ai_ids" "$(printf 'x POC-%s y' FCGI)" 1 || return 1
  hits "$ai_ids" "$(printf 'x N-%s y' 05)" 1 || return 1
  hits "$ai_ids" "$(printf 'x U%s.3 y' 2)" 1 || return 1
  hits "$ai_ids" 'AES-256 SHA-256 UTF-8 X-Forwarded-For WEB-01 2.3 U+0041' 0 || return 1
  hits "$ai_docs" "$(printf 'see %s/plans/x' docs)" 1 || return 1
  hits "$ai_docs" "$(printf 'the %s decision' owner)" 1 || return 1
  if git ls-files | grep -E "$ai_files"; then echo 'ai check: agent files tracked' >&2; return 1; fi
  if git grep -nIE "$ai_ids" -- ':!*.md'; then echo 'ai check: IDs in code or strings' >&2; return 1; fi
  if git grep -nIE "$ai_docs" -- ':!*.md'; then echo 'ai check: planning docs referenced in code or strings' >&2; return 1; fi
}

# tests/fixtures/backend holds copies of wafio-cp-backend test/frontend-fixtures. With that
# repository next to this one (WAFIO_BACKEND_DIR overrides), both sets must be identical.
backend_fixtures() {
  local dir=${WAFIO_BACKEND_DIR:-../wafio-cp-backend}/test/frontend-fixtures f
  if [ ! -d "$dir" ]; then
    echo "note: $dir not found, fixture copies not compared"
    return 0
  fi
  for f in "$dir"/*.json; do
    cmp "$f" "tests/fixtures/backend/$(basename "$f")" || return 1
  done
}

secrets() {
  command -v gitleaks >/dev/null || { echo "gitleaks not installed (pinned to 8.30.1)"; return 1; }
  gitleaks git --redact --exit-code 1 --config .gitleaks.toml .
}

# Asks OSV about the locked packages; offline it warns and passes (scripts/advisories.py).
advisories() {
  python3 scripts/test_advisories.py && python3 scripts/advisories.py bun.lock
}

web() {
  bun install --frozen-lockfile && bun run check && bun run test && bun run build
}

step "agent material" agent_material
step "secret scan" secrets
step "backend fixture copies" backend_fixtures
step "advisories (OSV)" advisories
step "frontend (install, check, test, build)" web

printf '\n== summary\n'
if [ ${#failed[@]} -gt 0 ]; then
  for n in "${failed[@]}"; do echo "FAILED: $n"; done
  exit 1
fi
echo "all gates passed"
