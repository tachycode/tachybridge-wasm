#!/usr/bin/env bash
set -euo pipefail

if ! command -v wasm-pack >/dev/null 2>&1; then
  echo "wasm-pack is required. Install from https://rustwasm.github.io/wasm-pack/" >&2
  exit 1
fi

rm -rf dist/wasm

wasm-pack build --release --target web --out-dir dist/wasm/web --out-name bridge_wasm
wasm-pack build --release --target nodejs --out-dir dist/wasm/node --out-name bridge_wasm

# 1) Inline the web .wasm as a base64 ES module so bundlers don't have to
#    locate the binary asset themselves.
# 2) Patch the wasm-pack web glue to remove the `new URL('bridge_wasm_bg.wasm',
#    import.meta.url)` static reference. That pattern triggers asset analysis
#    in Webpack/Turbopack/Vite and breaks consumer builds even though the code
#    path is dead when bytes are supplied explicitly.
node ./scripts/postprocess-wasm.mjs
