# Spyglass AR

Browser-only AR proof of concept: three geo-anchored 3D objects placed around the player, using the camera, compass/gyro, step detection and GPS. No WebXR required, so it runs in iOS Safari.

Live: https://kucukkanat.github.io/spyglass/

## Build

```sh
bun install
bun run build.ts   # writes the single-file app to index.html
```

`index.html` is the built, self-contained app served by GitHub Pages. Edit `src/` and `index.template.html`, then rebuild.

## Layout

- `src/ar/types.ts`: `TrackingProvider` interface (the seam for WebXR and WASM VIO providers)
- `src/ar/eighthwall-provider.ts`: 6DoF tracker on the 8th Wall XR Engine binary (default on iOS)
- `external/xr/`: the unmodified 8th Wall XR Engine binary. Closed source, © 2026 Niantic Spatial, Inc., under the XR Engine License Agreement (`external/xr/LICENSE`); not covered by this repo's own licence
- `src/ar/vio-provider.ts`: 6DoF visual-inertial tracker (visloc-rs WebAssembly in `vio/`), sparse map points, floor fit and surface hits
- `src/ar/sensor-provider.ts`: gyro + compass + step + GPS tracker (heading seed and fallback)
- `vio/`, `coi-sw.js`: vendored visloc-rs browser build, MIT OR Apache-2.0 (see `vio/NOTICE.md`)
- `src/ar/engine.ts`: rendering, anchors, sun lighting, shadows
- `src/objects/`: the three example objects
