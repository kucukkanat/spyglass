import { Euler, MathUtils, Quaternion, Vector3 } from "three";
import { wrap360 } from "./geo";
import type { ProviderConfig, TrackingProvider, TrackingState } from "./types";

/** Drag-to-look provider for desktop previews and devices without sensors. */
export class DemoTrackingProvider implements TrackingProvider {
  readonly name = "demo (drag to look)";
  readonly state: TrackingState = {
    position: new Vector3(0, 1.5, 0),
    quaternion: new Quaternion(),
    heading: 0,
    headingAccuracy: null,
    geoOrigin: { lat: 52.4026, lon: 5.2085 },
    gpsAccuracy: null,
    steps: 0,
    quality: "limited",
    dof: 3,
  };
  private yaw = 0;
  private pitch = -0.12;
  private drag: { x: number; y: number } | null = null;
  private euler = new Euler(0, 0, 0, "YXZ");

  constructor(public cfg: ProviderConfig, private el: HTMLElement) {}

  async start() {
    const m = location.hash.match(/^#preview:(-?[\d.]+):(-?[\d.]+)/);
    if (m) (this.yaw = (-+m[1] * Math.PI) / 180), (this.pitch = +m[2]);
    this.el.addEventListener("pointerdown", (e) => (this.drag = { x: e.clientX, y: e.clientY }));
    window.addEventListener("pointerup", () => (this.drag = null));
    window.addEventListener("pointermove", (e) => {
      if (!this.drag) return;
      this.yaw += (e.clientX - this.drag.x) * 0.005;
      this.pitch = MathUtils.clamp(this.pitch + (e.clientY - this.drag.y) * 0.005, -1.3, 1.3);
      this.drag = { x: e.clientX, y: e.clientY };
    });
  }
  stop() {}
  recenter() {}
  update() {
    this.euler.set(this.pitch, this.yaw, 0);
    this.state.quaternion.setFromEuler(this.euler);
    this.state.heading = wrap360(-this.yaw * MathUtils.RAD2DEG);
    this.state.position.y = this.cfg.eyeHeight;
  }
}
