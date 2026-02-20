#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

VERSION="${1:-}"
NPM_DIST_TAG="${2:-latest}"
WASM_PKG="tachybridge-wasm"
COMPAT_PKG="tachybridge-roslib-compat"
WASM_TAG="${WASM_PKG}-v${VERSION}"
COMPAT_TAG="${COMPAT_PKG}-v${VERSION}"

if [[ -z "$VERSION" ]]; then
  echo "Usage: npm run release:all -- <version> [npm-dist-tag]" >&2
  echo "Example: npm run release:all -- 0.1.1 latest" >&2
  exit 1
fi

if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]]; then
  echo "Invalid version: $VERSION" >&2
  exit 1
fi

if [[ "${ALLOW_DIRTY:-0}" != "1" ]] && [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "Working tree has tracked changes. Commit or stash before release." >&2
  echo "Set ALLOW_DIRTY=1 to bypass this check." >&2
  exit 1
fi

if git rev-parse "$WASM_TAG" >/dev/null 2>&1; then
  echo "Tag already exists: $WASM_TAG" >&2
  exit 1
fi
if git rev-parse "$COMPAT_TAG" >/dev/null 2>&1; then
  echo "Tag already exists: $COMPAT_TAG" >&2
  exit 1
fi

if [[ ! -d node_modules ]]; then
  echo "Installing dependencies..."
  npm install
fi

export npm_config_cache="${npm_config_cache:-$ROOT_DIR/.npm-cache}"

echo "Bumping ${WASM_PKG} version -> ${VERSION}"
npm version "$VERSION" --no-git-tag-version -w "$WASM_PKG"

echo "Bumping ${COMPAT_PKG} version -> ${VERSION}"
npm version "$VERSION" --no-git-tag-version -w "$COMPAT_PKG"

echo "Syncing ${COMPAT_PKG} dependency on ${WASM_PKG}"
npm pkg set "dependencies.${WASM_PKG}=^${VERSION}" -w "$COMPAT_PKG"

echo "Building ${WASM_PKG}"
npm run build -w "$WASM_PKG"
echo "Testing ${WASM_PKG}"
npm run test -w "$WASM_PKG"
echo "Dry-run pack check: ${WASM_PKG}"
npm pack --dry-run -w "$WASM_PKG"

echo "Building ${COMPAT_PKG}"
npm run build -w "$COMPAT_PKG"
echo "Testing ${COMPAT_PKG}"
npm run test -w "$COMPAT_PKG"
echo "Dry-run pack check: ${COMPAT_PKG}"
npm pack --dry-run -w "$COMPAT_PKG"

echo "Committing release changes"
git add \
  "$WASM_PKG/package.json" \
  "$COMPAT_PKG/package.json" \
  package-lock.json
git commit -m "release: ${WASM_PKG} + ${COMPAT_PKG} v${VERSION}"

echo "Creating git tags"
git tag -a "$WASM_TAG" -m "${WASM_PKG} v${VERSION}"
git tag -a "$COMPAT_TAG" -m "${COMPAT_PKG} v${VERSION}"

echo "Publishing ${WASM_PKG}@${VERSION} (dist-tag: ${NPM_DIST_TAG})"
npm publish -w "$WASM_PKG" --tag "$NPM_DIST_TAG"

echo "Publishing ${COMPAT_PKG}@${VERSION} (dist-tag: ${NPM_DIST_TAG})"
npm publish -w "$COMPAT_PKG" --tag "$NPM_DIST_TAG"

echo "Release complete."
echo "Next: git push origin HEAD --tags"
