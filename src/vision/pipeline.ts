// Runs visual anchors alongside tracking: silently remembers the surroundings of freshly
// placed objects, finds saved objects again ("lock before show"), and pulls visible
// objects back into place when tracking creeps.
import { MathUtils, Vector3 } from "three";
import type { AREngine, Anchor } from "../ar/engine";
import { intrinsics, Vision, type AnchorPack, type Features, type Frame, type Keyframe, type Resolved } from "./anchors";

export type ObjectState = "idle" | "fresh" | "searching" | "locked";
interface Tracked { anchor: Anchor; state: ObjectState; pack: AnchorPack | null; placedAt: number; lastTry: number; lastBuild: number; hits: Resolved[]; gaveUp: boolean; inliers: number; scale: number }

const GW = 360;

export class VisionPipeline {
  readonly tracked = new Map<string, Tracked>();
  /** Called when an object's state or anchor pack changes (persist, update UI). */
  onChange: ((id: string) => void) | null = null;
  info = { ready: false, ms: 0, features: 0, error: "" };

  private vision: Vision | null = null;
  private loading = false;
  private grab = document.createElement("canvas");
  private ctx = this.grab.getContext("2d", { willReadFrequently: true })!;
  private kfs: Keyframe[] = [];
  private lastTick = 0;
  private rr = 0;

  constructor(private engine: AREngine, private feed: HTMLCanvasElement | HTMLVideoElement, private cvUrl = "external/opencv.js") {}

  private get(a: Anchor) {
    let t = this.tracked.get(a.id);
    if (!t) this.tracked.set(a.id, (t = { anchor: a, state: "idle", pack: null, placedAt: 0, lastTry: 0, lastBuild: 0, hits: [], gaveUp: false, inliers: 0, scale: 1 }));
    return t;
  }
  state(a: Anchor): ObjectState { return this.tracked.get(a.id)?.state ?? "idle"; }
  pack(a: Anchor) { return this.tracked.get(a.id)?.pack ?? null; }

  /** The player just put this object down: start remembering the spot. */
  placed(a: Anchor) {
    const t = this.get(a);
    Object.assign(t, { state: "fresh", pack: null, placedAt: performance.now(), lastBuild: 0, hits: [], gaveUp: false });
    this.ensure();
  }
  /** An object known from storage or the network: hidden until its surroundings are recognised. */
  restore(a: Anchor, pack: AnchorPack, scale: number) {
    const t = this.get(a);
    Object.assign(t, { state: "searching", pack, hits: [], gaveUp: false, scale });
    a.group.visible = false;
    this.ensure();
  }
  remove(a: Anchor) {
    const t = this.get(a);
    Object.assign(t, { state: "idle", pack: null, hits: [] });
  }

  private ensure() {
    if (this.vision || this.loading) return;
    this.loading = true;
    Vision.load(this.cvUrl).then((v) => ((this.vision = v), (this.info.ready = true)), (e) => (this.info.error = String(e?.message ?? e))).finally(() => (this.loading = false));
  }

  /** One camera frame at reduced size, with the pose and lens it was rendered with. */
  private frame(): Frame | null {
    const cam = this.engine.camera, W = window.innerWidth, H = window.innerHeight;
    const gw = GW, gh = Math.round((GW * H) / W);
    if (this.grab.width !== gw || this.grab.height !== gh) (this.grab.width = gw), (this.grab.height = gh);
    const f = this.feed;
    try {
      if (f instanceof HTMLVideoElement) {
        // Same crop as object-fit: cover, so pixels line up with the virtual camera.
        const vw = f.videoWidth, vh = f.videoHeight;
        if (!vw) return null;
        const s = Math.max(W / vw, H / vh), sw = W / s, sh = H / s;
        this.ctx.drawImage(f, (vw - sw) / 2, (vh - sh) / 2, sw, sh, 0, 0, gw, gh);
      } else this.ctx.drawImage(f, 0, 0, gw, gh);
    } catch {
      return null;
    }
    const rgba = this.ctx.getImageData(0, 0, gw, gh).data;
    const gray = new Uint8Array(gw * gh);
    for (let i = 0, j = 0; i < gray.length; i++, j += 4) gray[i] = (77 * rgba[j] + 150 * rgba[j + 1] + 29 * rgba[j + 2]) >> 8;
    return { gray, w: gw, h: gh, ...intrinsics(cam.projectionMatrix.elements, gw, gh), pos: cam.position.clone(), quat: cam.quaternion.clone() };
  }

  /** Call once per rendered frame, after the camera pose is set and the feed is drawn. */
  tick() {
    const now = performance.now();
    const st = this.engine.provider.state;
    if (!this.vision || now - this.lastTick < 400 || st.dof !== 6 || st.quality !== "good") return;
    const active = [...this.tracked.values()].filter((t) => t.state !== "idle");
    if (!active.length) return;
    this.lastTick = now;
    const t0 = performance.now();
    const fr = this.frame();
    if (!fr) return;
    const f = this.vision.features(fr);
    this.info.features = f.n;
    if (f.n >= 40) {
      this.capture(active, fr, f, now);
      this.resolveOne(active, fr, f, now);
    }
    this.info.ms += 0.2 * (performance.now() - t0 - this.info.ms);
  }

  private capture(active: Tracked[], fr: Frame, f: Features, now: number) {
    const need = active.filter((t) => t.state === "fresh" && !t.pack && !t.gaveUp);
    if (!need.length) return void (this.kfs.length = 0);
    const last = this.kfs[this.kfs.length - 1];
    if (!last || last.pos.distanceTo(fr.pos) > 0.07) {
      this.kfs.push({ ...fr, f });
      if (this.kfs.length > 8) this.kfs.shift();
    }
    if (this.kfs.length < 3) return;
    for (const t of need) {
      const age = now - t.placedAt;
      if (age < 2500 || now - t.lastBuild < 3000) continue;
      t.lastBuild = now;
      const a = t.anchor;
      const pack = this.vision!.buildPack(this.kfs, a.group.position, a.group.rotation.y);
      // A good anchor as soon as there is one; a thin one after 20 s; none if the spot has no detail.
      if (pack.n >= 80 || (age > 20000 && pack.n >= 30)) (t.pack = pack), this.onChange?.(a.id);
      else if (age > 20000) (t.gaveUp = true), this.onChange?.(a.id);
      return; // at most one build per tick
    }
  }

  private resolveOne(active: Tracked[], fr: Frame, f: Features, now: number) {
    const cands = active.filter((t) => t.pack && (t.state === "searching" || now - t.lastTry > 2500));
    if (!cands.length) return;
    const t = cands[this.rr++ % cands.length];
    t.lastTry = now;
    const r = this.vision!.resolve(t.pack!, fr, f);
    if (!r) return;
    t.inliers = r.inliers;
    const a = t.anchor;
    if (t.state === "searching") {
      // Lock on one strong match, or two that agree; never show a single weak guess.
      t.hits = t.hits.filter((h) => h.pos.distanceTo(r.pos) < 0.3).concat(r).slice(-4);
      if (r.inliers < 40 && t.hits.length < 2) return;
      const pos = new Vector3();
      for (const h of t.hits) pos.addScaledVector(h.pos, 1 / t.hits.length);
      a.place(pos.x, -pos.z, -MathUtils.radToDeg(r.yaw), pos.y);
      a.setScale(t.scale);
      t.state = "locked";
      t.hits = [];
      this.onChange?.(a.id);
    } else {
      // Drift correction: ease towards where the surroundings say the object is.
      const d = a.group.position.distanceTo(r.pos);
      if (d < 0.03 || d > 1.5) return;
      a.group.position.lerp(r.pos, 0.35);
      const dy = Math.atan2(Math.sin(r.yaw - a.group.rotation.y), Math.cos(r.yaw - a.group.rotation.y));
      a.group.rotation.y += dy * 0.35;
    }
  }
}
