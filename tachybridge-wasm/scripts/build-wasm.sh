#!/usr/bin/env bash
set -euo pipefail

if ! command -v wasm-pack >/dev/null 2>&1; then
  echo "wasm-pack is required. Install from https://rustwasm.github.io/wasm-pack/" >&2
  exit 1
fi

rm -rf dist/wasm

wasm-pack build --release --target web --out-dir dist/wasm/web --out-name bridge_wasm
wasm-pack build --release --target nodejs --out-dir dist/wasm/node --out-name bridge_wasm
