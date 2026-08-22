#!/usr/bin/env bash
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
out="${1:-$repo/build}"

command -v npm >/dev/null 2>&1 || { echo "npm is required to bootstrap pinned build dependencies" >&2; exit 1; }

mkdir -p "$out"

printf '==> Installing pinned Bun/Clack build dependencies\n'
(
  cd "$repo"
  npm install --no-audit --no-fund --no-package-lock
)

bun="$repo/node_modules/.bin/bun"
[[ -x "$bun" || -f "$bun" ]] || { echo "local Bun executable was not installed" >&2; exit 1; }

printf '==> Generating embedded skill catalog\n'
"$bun" "$repo/scripts/generate-catalog.ts"

printf '==> Compiling standalone jl-skill.exe\n'
"$bun" build "$repo/src/jl-skill.ts" \
  --compile \
  --target=bun-windows-x64-baseline \
  --outfile "$out/jl-skill.exe"

printf 'Built: %s\n' "$out/jl-skill.exe"
