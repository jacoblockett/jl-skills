#!/usr/bin/env bash
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
work="$(mktemp -d "${TMPDIR:-/tmp}/jl-skill-test.XXXXXX")"
project="$work/project"
fake_home="$work/home"
fake_home_win="$(cygpath -w "$fake_home")"
bin="$work/jl-skill.exe"

cleanup() {
  rm -rf "$work"
}
trap cleanup EXIT

mkdir -p "$project" "$fake_home"

say() { printf '\n==> %s\n' "$*"; }
fail() { printf '\nFAIL: %s\n' "$*" >&2; exit 1; }

say "Building current jl-skill source"
(
  cd "$repo"
  go build -buildvcs=false -o "$bin" .
)

version="$($bin --version)"
printf '%s\n' "$version"
[[ "$version" == "jl-skill 0.1.1-tui (keyboard wizard)" ]] || fail "unexpected binary identity; stale/non-TUI build suspected"

say "Static guard: obsolete freeform installer prompt must not exist"
if grep -RIn --exclude-dir=.git --exclude='*.exe' -E 'Skills to install.*comma|comma-separated|bufio\.NewReader' "$repo"/*.go "$repo"/tui.go "$repo"/installer.go 2>/dev/null; then
  fail "obsolete freeform installer prompt/code is present"
fi

say "Installing Map into an isolated project for Codex"
USERPROFILE="$fake_home_win" HOME="$fake_home" "$bin" map --scope "$project" --agent codex

[[ -f "$project/.agents/skills/map/SKILL.md" ]] || fail "Codex project skill missing"
[[ -f "$project/AGENTS.md" ]] || fail "project AGENTS.md missing"
[[ -f "$project/.jl-skill/runtime/map/map-state.cmd" ]] || fail "Map runtime launcher missing"
[[ -f "$project/.jl-skill/runtime/map/venv/Scripts/python.exe" ]] || fail "isolated Python venv missing"
[[ -d "$project/.map" ]] || fail ".map state was not initialized"
[[ ! -e "$project/.claude" ]] || fail "Claude project files were created during Codex-only install"
[[ ! -e "$project/CLAUDE.md" ]] || fail "CLAUDE.md was created during Codex-only install"
[[ ! -d "$project/.jl-skill/runtime/map/site-packages" ]] || fail "legacy non-isolated site-packages directory exists"

grep -Fq "$project" "$project/.agents/skills/map/SKILL.md" || fail "installed SKILL.md does not contain scope-local CLI path"
[[ "$(grep -Fc '<!-- jl-skill:begin map -->' "$project/AGENTS.md")" -eq 1 ]] || fail "managed Map block count is not 1"
[[ "$(grep -Fc '<!-- jl-skill:end map -->' "$project/AGENTS.md")" -eq 1 ]] || fail "managed Map block end count is not 1"

say "Reinstalling to verify idempotency"
USERPROFILE="$fake_home_win" HOME="$fake_home" "$bin" map --scope "$project" --agent codex
[[ "$(grep -Fc '<!-- jl-skill:begin map -->' "$project/AGENTS.md")" -eq 1 ]] || fail "reinstall duplicated managed Map block"

say "Validating installed Map database/runtime"
USERPROFILE="$fake_home_win" HOME="$fake_home" \
  "$project/.jl-skill/runtime/map/venv/Scripts/python.exe" \
  "$project/.jl-skill/runtime/map/runner.py" \
  --root "$project" validate >/dev/null

say "Checking installer receipt isolation"
registry="$fake_home/.jl-skill/registry.json"
[[ -f "$registry" ]] || fail "installer registry missing from isolated user home"
grep -Fq '"agent": "codex"' "$registry" || fail "Codex receipt missing"
grep -Fq '"skill": "map"' "$registry" || fail "Map receipt missing"

printf '\nPASS: automated installer regression succeeded.\n'
printf '  build identity: %s\n' "$version"
printf '  project scope:   %s\n' "$project"
printf '  runtime:         isolated venv verified\n'
printf '  Map DB:          validate passed\n'
printf '  idempotency:     managed block remains singular\n'
printf '  scope isolation: no Claude project install\n'

say "Opening the bare keyboard wizard in a fresh temporary directory"
printf 'Expected: arrow-key list controls; Space toggles; Enter proceeds. Ctrl+C cancels.\n'
printf 'This final visual check is intentionally interactive. Cancelling is fine.\n\n'
(
  cd "$work"
  USERPROFILE="$fake_home_win" HOME="$fake_home" "$bin"
) || status=$?
status="${status:-0}"
if [[ "$status" -ne 0 ]]; then
  printf '\nWizard exited with status %s (Ctrl+C/cancel is expected).\n' "$status"
fi

printf '\nInstaller test run complete. Temporary files will now be removed.\n'
