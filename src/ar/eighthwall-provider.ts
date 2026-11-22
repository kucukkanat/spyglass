// 6DoF world tracking from the 8th Wall XR Engine binary (closed source, self-hosted in
// external/xr under the XR Engine License Agreement). The engine owns the camera and draws
// the feed into its own canvas; this provider only reads its pose and runs our renderer
// from its frame loop, so the overlay is drawn for exactly the frame on screen.
import { Quaternion, Vector3 } from "three";
import { wrap180, wrap360 } from "./geo";
import type { SensorTrackingProvider } from "./sensor-provider";
import type { ProviderConfig, TrackingProvider, TrackingState } from "./types";

const DEG = Math.PI / 180;
const UP = new Vector3(0, 1, 0);

export class EighthWallProvider implements TrackingProvider {
  readonly name = "8th Wall XR Engine (SLAM)";
  readonly state: TrackingState;
  readonly drivesLoop = true;
  /** Called once per engine frame, after the camera feed is drawn. */
  onRender: (() => void) | null = null;
  projectionMatrix: number[] | null = null;
  settled = false;
  info = { version: "", status: "LOADING", reason: "", scale: "responsive", camera: "" };

  private XR8: any = null;
  private fatal: string | null = null;
  private rot = new Quaternion();
  private pos = new Vector3();
  private hasPose = false;
  private aligned = false;
  private yaw = 0;
  private qYaw = new Quaternion();
  private fwd = new Vector3();
  private resizeHandler = () => this.sizeCanvas();

  constructor(
    public cfg: ProviderConfig,
    private canvas: HTMLCanvasElement,
    private compass: SensorTrackingProvider,
    private absoluteScale = false,
    private base = "external/xr/",
  ) {
    this.state = { ...compass.state, position: new Vector3(0, cfg.eyeHeight, 0), quaternion: new Quaternion(), dof: 3, quality: "none" };
    this.info.scale = absoluteScale ? "absolute" : "responsive";
  }

  get statusText() {
    if (this.fatal) return "Tracker error";
    if (!this.hasPose) return "Loading tracker";
    return this.info.status === "NORMAL" ? "Tracking" : "Limited tracking";
  }
  get coach() {
    if (this.fatal) return this.fatal;
    if (!this.hasPose) return "Loading the tracker…";
    if (!this.settled) return this.absoluteScale ? "Move the phone slowly side to side to measure the room" : "Move the phone slowly to start tracking";
    return null;
  }

  private loadEngine() {
    return new Promise<any>((resolve, reject) => {
      const w = window as any;
      if (w.XR8) return resolve(w.XR8);
      const timer = setTimeout(() => reject(new Error("the 8th Wall engine did not load")), 30000);
      window.addEventListener("xrloaded", () => (clearTimeout(timer), resolve(w.XR8)), { once: true });
      const s = document.createElement("script");
      s.src = this.base + "xr.js";
      s.async = true;
      s.setAttribute("data-preload-chunks", "slam");
      s.onerror = () => (clearTimeout(timer), reject(new Error("the 8th Wall engine script failed to load")));
      document.head.appendChild(s);
    });
  }

  private sizeCanvas() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(window.innerWidth * dpr);
    this.canvas.height = Math.round(window.innerHeight * dpr);
  }

  async start() {
    const XR8 = (this.XR8 = await this.loadEngine());
    try { this.info.version = String(XR8.version?.() ?? ""); } catch {}
    this.sizeCanvas();
    window.addEventListener("resize", this.resizeHandler);
    XR8.XrController.configure({ scale: this.absoluteScale ? "absolute" : "responsive", enableLighting: false, enableWorldPoints: false });
    XR8.addCameraPipelineModules([XR8.GlTextureRenderer.pipelineModule(), XR8.XrController.pipelineModule(), this.module()]);
    XR8.run({ canvas: this.canvas });
    await new Promise<void>((resolve, reject) => {
      const t0 = performance.now();
      const tick = () => (this.fatal ? reject(new Error(this.fatal)) : this.hasPose ? resolve() : performance.now() - t0 > 25000 ? reject(new Error("the tracker produced no camera pose")) : setTimeout(tick, 100));
      tick();
    });
  }

  private module() {
    const XR8 = this.XR8;
    return {
      name: "spyglass",
      onStart: () => {
        // Responsive scale: the engine treats the start height as this many units above the floor at y = 0.
        XR8.XrController.updateCameraProjectionMatrix({ origin: { x: 0, y: this.cfg.eyeHeight, z: 0 }, facing: { w: 1, x: 0, y: 0, z: 0 } });
      },
      onUpdate: ({ processCpuResult }: any) => {
        const r = processCpuResult?.reality;
        if (!r) return;
        if (r.intrinsics) this.projectionMatrix = Array.from(r.intrinsics as ArrayLike<number>);
        if (r.rotation) this.rot.set(r.rotation.x, r.rotation.y, r.rotation.z, r.rotation.w);
        if (r.position) this.pos.set(r.position.x, r.position.y, r.position.z);
        if (r.trackingStatus) this.info.status = r.trackingStatus;
        if (r.trackingReason) this.info.reason = r.trackingReason;
        if (r.rotation && r.position) this.hasPose = true;
      },
      onRender: () => this.onRender?.(),
      onCameraStatusChange: ({ status, video }: any) => {
        this.info.camera = status + (video?.videoWidth ? ` ${video.videoWidth}x${video.videoHeight}` : "");
        if (status === "failed") this.fatal = "Camera access failed";
      },
      onException: (e: any) => {
        console.warn("[8thwall]", e);
        if (!this.hasPose) this.fatal = `Tracker error: ${String(e?.message ?? e).slice(0, 120)}`;
      },
    };
  }

  stop() {
    window.removeEventListener("resize", this.resizeHandler);
    try { this.XR8?.stop(); } catch {}
    try { this.XR8?.clearCameraPipelineModules(); } catch {}
  }

  private headingOf(q: Quaternion) {
    this.fwd.set(0, 0, -1).applyQuaternion(q);
    return wrap360(Math.atan2(this.fwd.x, -this.fwd.z) / DEG);
  }

  update(dt: number) {
    const c = this.compass, st = this.state;
    c.update(dt);
    st.geoOrigin = c.state.geoOrigin;
    st.gpsAccuracy = c.state.gpsAccuracy;
    st.headingAccuracy = c.state.headingAccuracy;
    if (!this.hasPose) {
      st.quaternion.copy(c.state.quaternion);
      st.heading = c.state.heading;
      st.dof = 3;
      st.quality = c.state.quality === "none" ? "none" : "limited";
      return;
    }
    const normal = this.info.status === "NORMAL";
    if (normal && !this.aligned && c.state.quality !== "none") {
      // Turn the engine's world once so that -z is north (as far as the compass knows), then never again.
      this.yaw = -wrap180(c.state.heading - this.headingOf(this.rot)) * DEG;
      this.qYaw.setFromAxisAngle(UP, this.yaw);
      this.aligned = true;
    }
    if (normal) this.settled = true;
    st.quaternion.copy(this.qYaw).multiply(this.rot);
    st.position.copy(this.pos).applyQuaternion(this.qYaw);
    st.heading = this.headingOf(st.quaternion);
    st.dof = 6;
    st.quality = normal ? "good" : "limited";
  }

  /** A feature point on a real surface under the screen centre (table top, wall, kerb), if the engine has one. */
  surfacePoint(origin: Vector3) {
    try {
      const hits = this.XR8?.XrController.hitTest(0.5, 0.5, ["FEATURE_POINT"]) as any[] | undefined;
      const h = hits?.[0];
      if (!h?.position) return null;
      const point = new Vector3(h.position.x, h.position.y, h.position.z).applyQuaternion(this.qYaw);
      const depth = point.distanceTo(origin);
      return depth > 0.2 && depth < 15 ? { point, depth } : null;
    } catch {
      return null;
    }
  }

  recenter() {}
}
