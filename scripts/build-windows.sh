#!/usr/bin/env bash
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
out="${1:-$repo/build}"

command -v go >/dev/null 2>&1 || { echo "go is required to build jl-skill" >&2; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "npm is required to build the Clack frontend" >&2; exit 1; }

mkdir -p "$repo/build" "$out"

printf '==> Installing pinned build dependencies\n'
(
  cd "$repo"
  npm install --no-audit --no-fund --no-package-lock
)

printf '==> Building Go installer core\n'
(
  cd "$repo"
  go build -buildvcs=false -o "$repo/build/jl-skill-core.exe" .
)

bun="$repo/node_modules/.bin/bun"
[[ -x "$bun" || -f "$bun" ]] || { echo "local Bun executable was not installed" >&2; exit 1; }

printf '==> Compiling consumer jl-skill.exe with @clack/prompts\n'
"$bun" build "$repo/src/jl-skill.ts" \
  --compile \
  --target=bun-windows-x64-baseline \
  --outfile "$out/jl-skill.exe"

printf 'Built: %s\n' "$out/jl-skill.exe"
