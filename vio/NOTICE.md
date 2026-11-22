# visloc-rs browser VIO (vendored)

`worker.js`, `pkg/`, `pkg-mt/` and `../coi-sw.js` are unmodified copies from the
published build of the visloc-rs WebAssembly bindings (Basalt-derived
monocular-inertial VIO):

- Source: https://github.com/zalo/visloc-rs (branch `browser-vio`, build at commit 5df9b07a),
  upstream https://github.com/rsasaki0109/visloc-rs (PR #311)
- Licence: MIT OR Apache-2.0 (see LICENSE-MIT, LICENSE-APACHE)

`src/ar/vio-provider.ts` in this repo is a TypeScript port of the sensor and
frame-feeding logic from that project's `web/app.js` and `web/profiles.js`.
