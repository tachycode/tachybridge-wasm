#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

VERSION="${1:-}"
NPM_DIST_TAG="${2:-latest}"
PACKAGE_NAME="tachybridge-wasm"
GIT_TAG="tachybridge-wasm-v${VERSION}"

if [[ -z "$VERSION" ]]; then
  echo "Usage: npm run release:wasm -- <version> [npm-dist-tag]" >&2
  echo "Example: npm run release:wasm -- 0.1.1 latest" >&2
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

if git rev-parse "$GIT_TAG" >/dev/null 2>&1; then
  echo "Tag already exists: $GIT_TAG" >&2
  exit 1
fi

if [[ ! -d node_modules ]]; then
  echo "Installing dependencies..."
  npm install
fi

export npm_config_cache="${npm_config_cache:-$ROOT_DIR/.npm-cache}"

echo "Bumping ${PACKAGE_NAME} version -> ${VERSION}"
npm version "$VERSION" --no-git-tag-version -w "$PACKAGE_NAME"

echo "Building ${PACKAGE_NAME}"
npm run build -w "$PACKAGE_NAME"

echo "Testing ${PACKAGE_NAME}"
npm run test -w "$PACKAGE_NAME"

echo "Dry-run pack check"
npm pack --dry-run -w "$PACKAGE_NAME"

echo "Committing release changes"
git add "$PACKAGE_NAME/package.json" package-lock.json
git commit -m "release(${PACKAGE_NAME}): v${VERSION}"

echo "Creating git tag ${GIT_TAG}"
git tag -a "$GIT_TAG" -m "${PACKAGE_NAME} v${VERSION}"

echo "Publishing ${PACKAGE_NAME}@${VERSION} (dist-tag: ${NPM_DIST_TAG})"
npm publish -w "$PACKAGE_NAME" --tag "$NPM_DIST_TAG"

echo "Release complete."
echo "Next: git push origin HEAD --tags"
