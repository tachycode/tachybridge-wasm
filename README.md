# tachybridge-wasm Monorepo

This monorepo is centered on publishing `tachybridge-wasm` to npm.

`tachybridge-wasm` is designed for tachybridge.  
`topic` and `service` flows are also compatible with rosbridge.

## Packages

- `tachybridge-wasm/`: core package, npm publish target
- `tachybridge-roslib-compat/`: optional roslib-style compatibility layer
- `mockup-rosbridge/`: optional deterministic mock server
- `mockup-web/`: optional browser demo and smoke-test UI

## Install

```bash
npm install
```

## Core Build and Test

```bash
npm run build -w tachybridge-wasm
npm run test -w tachybridge-wasm
```

## Optional Demo Flow

```bash
npm run mockup:start
npm run web:dev
```

## Publish Readiness Check

```bash
npm run pack:check -w tachybridge-wasm
npm pack --dry-run -w tachybridge-wasm
```

## Publish

```bash
npm run build -w tachybridge-wasm
npm run test -w tachybridge-wasm
npm pack --dry-run -w tachybridge-wasm
npm publish -w tachybridge-wasm
```

Or run the full release flow (version bump, build, test, dry-run pack, commit, tag, publish):

```bash
npm run release:wasm -- 0.1.1 latest
```
