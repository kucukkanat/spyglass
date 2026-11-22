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
- `src/ar/sensor-provider.ts`: gyro + compass + step + GPS tracker
- `src/ar/engine.ts`: rendering, anchors, sun lighting, shadows
- `src/objects/`: the three example objects
