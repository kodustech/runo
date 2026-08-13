#!/bin/sh
# runo installer — run from the repo root: ./install.sh
# Installs bun if missing, links the `runo` binary and starts the guided setup.
set -e

if ! command -v bun >/dev/null 2>&1; then
  echo "- installing bun..."
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
fi

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"
bun install
bun link >/dev/null 2>&1 || bun link
export PATH="$HOME/.bun/bin:$PATH"

echo "installed: $(command -v runo || echo '~/.bun/bin/runo (add ~/.bun/bin to your PATH)')"
exec bun "$DIR/bin/runo.ts" setup
