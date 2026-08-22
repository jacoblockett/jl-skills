#!/usr/bin/env bash
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
work="$(mktemp -d "${TMPDIR:-/tmp}/jl-skill-test.XXXXXX")"
project="$work/project"
fake_home="$work/home"
fake_home_win="$(cygpath -w "$fake_home")"
bin="$work/build/jl-skill.exe"

cleanup() {
  rm -rf "$work"
}
trap cleanup EXIT

mkdir -p "$project" "$fake_home" "$work/build"

say() { printf '\n==> %s\n' "$*"; }
fail() { printf '\nFAIL: %s\n' "$*" >&2; exit 1; }

say "Building standalone consumer jl-skill.exe"
bash "$repo/scripts/build-windows.sh" "$work/build"

version="$($bin --version)"
printf '%s\n' "$version"
[[ "$version" == "jl-skill 0.2.0 (@clack/prompts 1.7.0)" ]] || fail "unexpected consumer binary identity"

say "Static guards"
if grep -RIn --include='*.go' --exclude-dir=.git -E 'Skills to install.*comma|comma-separated|bufio\.NewReader|charmbracelet/huh' "$repo" 2>/dev/null; then
  fail "obsolete freeform/Huh installer UI code is present"
fi
grep -Fq "from '@clack/prompts'" "$repo/src/jl-skill.ts" || fail "consumer frontend is not using @clack/prompts"
grep -Fq '"@clack/prompts": "1.7.0"' "$repo/package.json" || fail "@clack/prompts is not pinned to 1.7.0"

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
printf '  consumer:        exact @clack/prompts frontend\n'
printf '  build identity:  %s\n' "$version"
printf '  runtime:         isolated Python venv verified\n'
printf '  Map DB:          validate passed\n'
printf '  idempotency:     managed block remains singular\n'
printf '  scope isolation: no Claude project install\n'

say "Opening the actual Clack wizard in a fresh temporary directory"
printf 'This is @clack/prompts, the same prompt package used by current Vite.\n'
printf 'Expected controls: arrows navigate, Space selects, Enter confirms. Ctrl+C cancels.\n'
printf 'Cancelling after visually checking it is fine.\n\n'
(
  cd "$work"
  USERPROFILE="$fake_home_win" HOME="$fake_home" "$bin"
) || status=$?
status="${status:-0}"
if [[ "$status" -ne 0 ]]; then
  printf '\nWizard exited with status %s (Ctrl+C/cancel is expected).\n' "$status"
fi

printf '\nInstaller test run complete. Temporary test project removed.\n'
