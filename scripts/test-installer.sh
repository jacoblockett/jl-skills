#!/usr/bin/env bash
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
if [[ -d /c/Programming ]]; then
  work="${1:-/c/Programming/jl-skill-test}"
else
  work="${1:-$(cd "$repo/.." && pwd -P)/jl-skill-test}"
fi
run_root="$work/run"
project="$run_root/project"
wizard_project="$run_root/wizard-project"
fake_home="$run_root/home"
bin_dir="$run_root/bin"
bin="$bin_dir/jl-skill.exe"

say() { printf '\n==> %s\n' "$*"; }
fail() { printf '\nFAIL: %s\n' "$*" >&2; exit 1; }

rm -rf "$run_root"
mkdir -p "$project" "$wizard_project" "$fake_home" "$bin_dir"

if command -v cygpath >/dev/null 2>&1; then
  project_arg="$(cygpath -w "$project")"
  fake_home_env="$(cygpath -w "$fake_home")"
else
  project_arg="$project"
  fake_home_env="$fake_home"
fi

say "Verifying installer is Bun-only"
if find "$repo" -maxdepth 1 -type f \( -name '*.go' -o -name 'go.mod' -o -name 'go.sum' \) -print | grep -q .; then
  find "$repo" -maxdepth 1 -type f \( -name '*.go' -o -name 'go.mod' -o -name 'go.sum' \) -print
  fail "legacy Go installer files are still present"
fi

grep -Fq '"@clack/prompts": "1.7.0"' "$repo/package.json" || fail "@clack/prompts 1.7.0 is not pinned"

say "Building standalone consumer executable"
bash "$repo/scripts/build-windows.sh" "$bin_dir"

version="$($bin --version)"
printf '%s\n' "$version"
[[ "$version" == "jl-skill 0.3.0 (@clack/prompts 1.7.0)" ]] || fail "unexpected binary identity"

say "Static guards against obsolete prompt/core architecture"
if grep -RIn --exclude='catalog.generated.ts' -E 'comma-separated|bufio\.NewReader|charmbracelet/huh|jl-skill-core' \
  "$repo/src" "$repo/package.json" "$repo/scripts/build-windows.sh" 2>/dev/null; then
  fail "obsolete installer architecture/prompt code is present"
fi

say "Installing Map into isolated project for Codex"
USERPROFILE="$fake_home_env" HOME="$fake_home" "$bin" map --scope "$project_arg" --agent codex

[[ -f "$project/.agents/skills/map/SKILL.md" ]] || fail "Codex project skill missing"
[[ -f "$project/AGENTS.md" ]] || fail "project AGENTS.md missing"
[[ -f "$project/.jl-skill/runtime/map/map-state.cmd" ]] || fail "Map runtime launcher missing"
[[ -f "$project/.jl-skill/runtime/map/venv/Scripts/python.exe" ]] || fail "isolated Python venv missing"
[[ -d "$project/.map" ]] || fail ".map state was not initialized"
[[ ! -e "$project/.claude" ]] || fail "Claude project files were created during Codex-only install"
[[ ! -e "$project/CLAUDE.md" ]] || fail "CLAUDE.md was created during Codex-only install"
[[ ! -d "$project/.jl-skill/runtime/map/site-packages" ]] || fail "legacy non-isolated site-packages directory exists"

grep -Fq 'map-state.cmd' "$project/.agents/skills/map/SKILL.md" || fail "installed SKILL.md does not contain scope-local CLI"
[[ "$(grep -Fc '<!-- jl-skill:begin map -->' "$project/AGENTS.md")" -eq 1 ]] || fail "managed Map block count is not 1"
[[ "$(grep -Fc '<!-- jl-skill:end map -->' "$project/AGENTS.md")" -eq 1 ]] || fail "managed Map block end count is not 1"

say "Reinstalling to verify idempotency"
USERPROFILE="$fake_home_env" HOME="$fake_home" "$bin" map --scope "$project_arg" --agent codex
[[ "$(grep -Fc '<!-- jl-skill:begin map -->' "$project/AGENTS.md")" -eq 1 ]] || fail "reinstall duplicated managed Map block"

say "Validating Map runtime directly"
USERPROFILE="$fake_home_env" HOME="$fake_home" \
  "$project/.jl-skill/runtime/map/venv/Scripts/python.exe" \
  "$project/.jl-skill/runtime/map/runner.py" \
  --root "$project_arg" validate >/dev/null

say "Checking installer receipt isolation"
registry="$fake_home/.jl-skill/registry.json"
[[ -f "$registry" ]] || fail "installer registry missing from isolated user home"
grep -Fq '"agent": "codex"' "$registry" || fail "Codex receipt missing"
grep -Fq '"skill": "map"' "$registry" || fail "Map receipt missing"

printf '\nPASS: automated installer regression succeeded.\n'
printf '  test root:       %s\n' "$work"
printf '  build identity:  %s\n' "$version"
printf '  implementation:  Bun/TypeScript only\n'
printf '  prompt package:  @clack/prompts 1.7.0\n'
printf '  runtime:         isolated Python venv verified\n'
printf '  Map DB:          init + validation passed\n'
printf '  idempotency:     managed block remains singular\n'
printf '  scope isolation: no Claude project install\n'

say "Opening bare create-vite prompt stack"
printf 'Expected: Clack arrow-key controls; Space toggles multiselects; Enter confirms. Ctrl+C cancels.\n'
printf 'The wizard runs from %s, not the jl-skills repo.\n\n' "$wizard_project"
(
  cd "$wizard_project"
  USERPROFILE="$fake_home_env" HOME="$fake_home" "$bin"
) || status=$?
status="${status:-0}"
if [[ "$status" -ne 0 ]]; then
  printf '\nWizard exited with status %s (Ctrl+C/cancel is expected).\n' "$status"
fi

printf '\nInstaller test run complete. Test files remain at %s for inspection.\n' "$work"
