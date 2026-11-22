// 6DoF tracking for browsers without WebXR: visloc-rs (Basalt-derived monocular-inertial
// VIO) running as WebAssembly in a worker. The sensor timing, frame feeding, calibration
// and pose prediction below are a TypeScript port of that project's web/app.js and
// web/profiles.js (MIT OR Apache-2.0, see vio/NOTICE.md).
import { MathUtils, Matrix4, Quaternion, Vector3 } from "three";
import { wrap180, wrap360 } from "./geo";
import type { SensorTrackingProvider } from "./sensor-provider";
import type { ProviderConfig, TrackingProvider, TrackingState } from "./types";

const DEG = Math.PI / 180;
type Q4 = [number, number, number, number]; // w, x, y, z
type V3 = [number, number, number];

const IMU_DEFAULT = { accelNoise: 0.0144, gyroNoise: 0.0072, accelBiasWalk: 2.1e-5, gyroBiasWalk: 5.1e-6 };
const CAMERA_OFFSET: V3 = [0.02, 0.06, -0.005];
const DEFAULT_TIME_OFFSET_MS = -25;
// iPhones by CSS screen size and pixel ratio -> 35 mm-equivalent focal length of the main camera.
const IPHONES: [number, number, number, number][] = [
  [440, 956, 3, 24], [402, 874, 3, 24], [420, 912, 3, 26], [430, 932, 3, 24], [393, 852, 3, 26], [428, 926, 3, 26],
  [390, 844, 3, 26], [375, 812, 3, 26], [414, 896, 3, 26], [414, 896, 2, 26], [414, 736, 3, 28], [375, 667, 2, 28],
];
const GYRO_AXES: Record<string, number[][]> = {
  w3c: [[0, 1, 0], [0, 0, 1], [1, 0, 0]],
  webkit: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
};

const quatMul = (a: number[], b: number[]): Q4 => [
  a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
  a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
  a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
  a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
];
function quatFromRotvec(v: V3): Q4 {
  const angle = Math.hypot(v[0], v[1], v[2]);
  if (angle < 1e-12) return [1, 0.5 * v[0], 0.5 * v[1], 0.5 * v[2]];
  const s = Math.sin(angle / 2) / angle;
  return [Math.cos(angle / 2), v[0] * s, v[1] * s, v[2] * s];
}
function quatRotate(q: number[], v: number[]): V3 {
  const [w, x, y, z] = q;
  const tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + y * tz - z * ty, v[1] + w * ty + z * tx - x * tz, v[2] + w * tz + x * ty - y * tx];
}
function quatMatrix([w, x, y, z]: number[]) {
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
    [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
    [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
  ];
}
const matMul = (a: number[][], b: number[][]) => a.map((r) => [0, 1, 2].map((j) => r[0] * b[0][j] + r[1] * b[1][j] + r[2] * b[2][j]));
const transpose = (a: number[][]) => [0, 1, 2].map((i) => [a[0][i], a[1][i], a[2][i]]);
const rotationDeg = (m: number[][]) => Math.acos(Math.max(-1, Math.min(1, (m[0][0] + m[1][1] + m[2][2] - 1) / 2))) / DEG;

/** T_imu_cam rotation for the rear camera with the screen turned `angle` degrees. */
function imuFromCameraRotation(angle: number): Q4 {
  const c = Math.cos(angle * DEG), s = Math.sin(angle * DEG);
  const q = new Quaternion().setFromRotationMatrix(new Matrix4().set(c, -s, 0, 0, -s, -c, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1));
  return [q.w, q.x, q.y, q.z];
}
const screenAngle = () => {
  const a = (screen.orientation?.angle ?? (window as any).orientation ?? 0) as number;
  return (((Math.round(a / 90) * 90) % 360) + 360) % 360;
};
const posed = (s: string) => s !== "init" && s !== "wait" && !s.startsWith("reset");

function detectDevice() {
  const ua = navigator.userAgent;
  const ios = /iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const w = Math.min(screen.width, screen.height), h = Math.max(screen.width, screen.height);
  const dpr = Math.round(window.devicePixelRatio || 1);
  const hit = ios ? IPHONES.find((p) => p[0] === w && p[1] === h && p[2] === dpr) : undefined;
  const firefoxAndroid = /Android/.test(ua) && /Firefox\//.test(ua);
  return { key: `${ios ? "ios" : "other"}-${w}x${h}@${dpr}`, focal35: hit?.[3] ?? 26, gyroAxes: firefoxAndroid ? "w3c" : "webkit" };
}

/** Opens the rear main camera the calibration describes (not a virtual multi-lens device). */
export async function openVioCamera(video: HTMLVideoElement, sharp: boolean) {
  const size = sharp ? { width: { ideal: 1280 }, height: { ideal: 960 } } : { width: { ideal: 640 }, height: { ideal: 480 } };
  const constraints = { ...size, frameRate: { ideal: 60, max: 60 } };
  let stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: "environment" }, ...constraints } });
  try {
    const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
    const backId = (label: string) => {
      const m = /facing back.*?(\d+)|(\d+).*facing back/i.exec(label);
      return m ? Number(m[1] ?? m[2]) : null;
    };
    const androidBacks = cams.filter((d) => backId(d.label) !== null).sort((a, b) => backId(a.label)! - backId(b.label)!);
    const main = cams.find((d) => d.label === "Back Camera") ?? androidBacks[0];
    const track = stream.getVideoTracks()[0];
    if (main && track && track.label !== main.label) {
      stream.getTracks().forEach((t) => t.stop());
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { deviceId: { exact: main.deviceId }, ...constraints } });
      } catch {
        stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: "environment" }, ...constraints } });
      }
    }
  } catch {}
  video.srcObject = stream;
  await video.play();
  return stream;
}

const waitFor = (cond: () => unknown, ms: number, what: string) =>
  new Promise<void>((resolve, reject) => {
    const t0 = performance.now();
    const tick = () => (cond() ? resolve() : performance.now() - t0 > ms ? reject(new Error(what)) : setTimeout(tick, 50));
    tick();
  });

interface ImuEntry { t: number; g: V3; a: V3 }

export class VioTrackingProvider implements TrackingProvider {
  readonly name = "visloc-rs VIO (camera + IMU, WebAssembly)";
  readonly state: TrackingState;
  landmarks: { positions: Float32Array; count: number; version: number } | null = null;
  status = "loading";
  info = { threads: 0, gpu: null as string | null, fps: 0, ms: 0, points: 0, resets: 0, timeOffsetMs: 0, floor: false, frame: "", scale: 1, mapPoints: 0, layers: "" };
  /** True once scale and floor have had a chance to settle; objects should not be placed before. */
  settled = false;
  /** Heights (local y) of horizontal surfaces found in the map: floor first, then table tops etc. */
  layers: number[] = [];
  /** Long-side field of view of the camera stream implied by the calibration, degrees. */
  cameraFov = 67;

  private worker!: Worker;
  private ready: any = null;
  private rig: any = null;
  private calib: { focal35: number; timeOffsetMs: number; gyroAxes: string };
  private device = detectDevice();
  private running = false;
  private accelSign = 1;
  private lastAccel: V3 = [0, 0, 9.81];
  private orientation: { beta: number; gamma: number } | null = null;
  private imuBatch: number[] = [];
  private imuHistory: ImuEntry[] = [];
  private lastMotion: { t: number; raw: number } | null = null;
  private motionPeriod = 0;
  private motionClock: "event" | "receipt" | null = null;
  private latest: any = null;
  private frameW = 0;
  private frameH = 0;
  private capture = document.createElement("canvas");
  private ctx = this.capture.getContext("2d", { willReadFrequently: true })!;
  private inflight = 0;
  private frameClock = 0;
  private lastClockT = -Infinity;
  private lastFrameKey = "";
  private repeated = 0;
  private skipRepeats = true;
  private lastFrameTime = 0;
  private lastPosted = -Infinity;
  private videoLatencyMs = 15;
  private recentSync: number[] = [];
  private syncApplied = 0;
  private axesSwitches = 0;
  private results = 0;
  private resultsWindow = performance.now();
  private fatal: string | null = null;

  // local <- VIO world: yaw about up, then translation.
  private yaw = 0;
  private offset = new Vector3();
  private aligned = false;
  private wasPosed = false;
  static MAP_MAX = 20000;
  // World scale correction (monocular scale comes from the IMU alone and can be off).
  private scale = 1;
  private scaleFixes = 0;
  private pvRaw = new Vector3();
  private path = 0;
  private lastPathPos: Vector3 | null = null;
  private trackedSince = 0;
  // Persistent map in the tracker's own world (unscaled), one point per 5 cm voxel.
  private mapRaw = new Float32Array(3 * VioTrackingProvider.MAP_MAX);
  private mapCount = 0;
  private mapKeys = new Set<number>();
  private fallbackYaw = 0; // degrees added to the compass heading while not tracking
  private everTracked = false;
  private qYaw = new Quaternion();
  private qv = new Quaternion();
  private pv = new Vector3();
  private fwd = new Vector3();
  private static Q_CONV = new Quaternion(-Math.SQRT1_2, 0, 0, Math.SQRT1_2); // VIO z-up -> y-up
  private static Q_FLIP = new Quaternion(1, 0, 0, 0); // OpenCV camera -> three.js camera
  private static UP = new Vector3(0, 1, 0);

  constructor(public cfg: ProviderConfig, private video: HTMLVideoElement, private compass: SensorTrackingProvider, private base = "vio/") {
    this.state = { ...compass.state, position: new Vector3(0, cfg.eyeHeight, 0), quaternion: new Quaternion(), dof: 3, quality: "none" };
    let saved: any = {};
    try { saved = JSON.parse(localStorage.getItem(`spyglass.vio.calib:${this.device.key}`) || "{}"); } catch {}
    this.calib = { focal35: this.device.focal35, timeOffsetMs: DEFAULT_TIME_OFFSET_MS, gyroAxes: this.device.gyroAxes, ...saved };
    this.cameraFov = (2 * Math.atan(0.5 / ((this.calib.focal35 / 43.27) * 1.25))) / DEG;
  }

  private saveCalib() {
    try {
      const c = this.calib;
      const focal = c.focal35 !== this.device.focal35 ? { focal35: c.focal35 } : {};
      localStorage.setItem(`spyglass.vio.calib:${this.device.key}`, JSON.stringify({ timeOffsetMs: c.timeOffsetMs, gyroAxes: c.gyroAxes, ...focal }));
    } catch {}
  }

  /** Recalibrates the lens from a long-side field of view (degrees) and restarts tracking with it. */
  setFov(fov: number) {
    this.cameraFov = fov;
    this.calib.focal35 = (43.27 * 0.5) / (1.25 * Math.tan((fov * DEG) / 2));
    this.saveCalib();
    if (this.ready && !this.fatal) this.beginSession();
  }

  get statusText() {
    const s = this.status;
    if (this.fatal) return "Tracker error";
    if (s === "track") return `Tracking · ${this.info.points} pts`;
    if (s === "coast") return "Coasting";
    if (s === "wait") return "Hold still";
    if (s === "init") return "Initialising";
    if (s.startsWith("reset")) return "Recovering";
    return "Loading tracker";
  }
  get coach() {
    const s = this.status;
    if (this.fatal) return this.fatal;
    if (s === "loading") return "Loading the tracker…";
    if (s === "wait") return "Hold the phone still for a moment";
    if (s === "init") return "Now move the phone slowly side to side";
    if (s.startsWith("reset")) return "Lost tracking. Hold still to recover";
    if (s === "coast") return "Too fast or too plain. Point at something with detail";
    if (s === "track" && !this.settled) return "Keep moving side to side, and look at the floor";
    return null;
  }

  async start() {
    this.worker = new Worker(new URL(this.base + "worker.js", location.href), { type: "module" });
    this.worker.onmessage = (e) => this.onWorker(e.data);
    this.worker.onerror = (e) => (this.fatal = `Tracker failed to load: ${e.message || "worker error"}`);
    this.worker.postMessage({ type: "init", threads: true });
    window.addEventListener("devicemotion", this.onMotion);
    window.addEventListener("deviceorientation", this.onOrientation);
    document.addEventListener("visibilitychange", this.onVisibility);
    await waitFor(() => this.video.videoWidth > 0, 4000, "the camera did not start");
    await waitFor(() => this.imuHistory.length > 10, 10000, "no motion events arrived");
    await waitFor(() => this.ready || this.fatal, 20000, "the WebAssembly tracker did not load");
    if (this.fatal) throw new Error(this.fatal);
    this.beginSession();
  }

  stop() {
    this.running = false;
    window.removeEventListener("devicemotion", this.onMotion);
    window.removeEventListener("deviceorientation", this.onOrientation);
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.worker?.postMessage({ type: "stop" });
    this.worker?.terminate();
  }

  private onVisibility = () => {
    if (document.visibilityState === "visible" && this.ready && !this.fatal) this.beginSession();
  };

  private onWorker(m: any) {
    switch (m.type) {
      case "ready":
        this.ready = m;
        this.info.threads = m.threaded ? m.threads : 1;
        break;
      case "started":
        this.info.gpu = m.gpu ?? null;
        break;
      case "dropped":
        this.inflight = Math.max(0, this.inflight - 1);
        break;
      case "result":
        this.inflight = Math.max(0, this.inflight - 1);
        this.onResult(m);
        break;
      case "error":
        if (m.frameT != null) this.inflight = Math.max(0, this.inflight - 1);
        else if (m.during === "init" || m.during === "start") this.fatal = `Tracker error: ${String(m.message).slice(0, 120)}`;
        console.warn("[vio]", m.message);
        break;
      case "log":
        console.log("[vio]", m.message);
        break;
    }
  }

  // ---- sensors -------------------------------------------------------------------------

  private onOrientation = (e: DeviceOrientationEvent) => {
    if (e.beta != null && e.gamma != null) this.orientation = { beta: e.beta, gamma: e.gamma };
  };

  private onMotion = (e: DeviceMotionEvent) => {
    const a = e.accelerationIncludingGravity, r = e.rotationRate;
    const now = performance.now();
    if (!a || !r || a.x == null || a.y == null || a.z == null || r.alpha == null || r.beta == null || r.gamma == null) return;
    if (this.motionClock === null) {
      this.motionClock = Math.abs(e.timeStamp - now) < 1000 ? "event" : "receipt";
      this.motionPeriod = e.interval > 0 ? (e.interval < 1 ? e.interval * 1000 : e.interval) : 16.67; // iOS reports seconds
    }
    const raw = this.motionClock === "event" ? e.timeStamp : now;
    // Smooth timestamp jitter towards the learned event period.
    let t = raw;
    if (this.lastMotion) {
      const gap = raw - this.lastMotion.raw;
      if (gap > 0 && gap < 200) this.motionPeriod += 0.02 * (gap - this.motionPeriod);
      const model = this.lastMotion.t + this.motionPeriod;
      t = model + 0.1 * (raw - model);
      if (Math.abs(t - raw) > 40) t = raw;
      t = Math.max(t, this.lastMotion.t + 0.25 * this.motionPeriod);
    }
    this.lastMotion = { t, raw };
    const rows = GYRO_AXES[this.calib.gyroAxes] ?? GYRO_AXES.w3c;
    const g = rows.map((row) => (row[0] * r.alpha! + row[1] * r.beta! + row[2] * r.gamma!) * DEG) as V3;
    this.lastAccel = [a.x, a.y, a.z];
    const s = this.accelSign;
    const acc: V3 = [s * a.x, s * a.y, s * a.z];
    this.imuHistory.push({ t, g, a: acc });
    if (this.imuHistory.length > 240) this.imuHistory.splice(0, this.imuHistory.length - 240);
    if (!this.running) return;
    this.imuBatch.push(Math.round(t * 1e6), g[0], g[1], g[2], acc[0], acc[1], acc[2]);
    if (this.imuBatch.length >= 21) this.flushImu();
  };

  private flushImu() {
    if (!this.imuBatch.length) return;
    const buf = new Float64Array(this.imuBatch);
    this.imuBatch = [];
    this.worker.postMessage({ type: "imu", samples: buf.buffer }, [buf.buffer]);
  }

  /** +1 if the accelerometer reports specific force (+g up), -1 if it reports gravity. */
  private decideAccelSign() {
    const a = this.lastAccel;
    let up: V3;
    if (this.orientation) {
      const b = this.orientation.beta * DEG, g = this.orientation.gamma * DEG;
      up = [-Math.cos(b) * Math.sin(g), Math.sin(b), Math.cos(b) * Math.cos(g)];
    } else up = Math.abs(a[1]) > Math.abs(a[2]) ? [0, 1, 0] : [0, 0, 1];
    return a[0] * up[0] + a[1] * up[1] + a[2] * up[2] >= 0 ? 1 : -1;
  }

  // ---- session -------------------------------------------------------------------------

  private beginSession() {
    this.recentSync.length = 0;
    const v = this.video;
    const vw = v.videoWidth, vh = v.videoHeight;
    const scale = 360 / Math.min(vw, vh);
    this.frameW = Math.round(vw * scale);
    this.frameH = Math.round(vh * scale);
    this.accelSign = this.decideAccelSign();
    const f = (this.calib.focal35 / 43.27) * 1.25 * Math.max(this.frameW, this.frameH);
    const fps = (v.srcObject as MediaStream | null)?.getVideoTracks()[0]?.getSettings?.().frameRate ?? 30;
    this.rig = {
      width: this.frameW, height: this.frameH,
      fx: f, fy: f, cx: (this.frameW - 1) / 2, cy: (this.frameH - 1) / 2,
      distortion: [0, 0, 0, 0],
      imuFromCamera: [...imuFromCameraRotation(screenAngle()), ...CAMERA_OFFSET],
      imuRateHz: Math.max(20, Math.round(this.motionPeriod > 0 ? 1000 / this.motionPeriod : 60)),
      ...IMU_DEFAULT,
      // The camera runs at 60 fps for short exposures, but only every other frame is tracked:
      // half the load, and a phone that stays cool drops fewer frames.
      frameRateHz: 30,
    };
    this.info.frame = `${this.frameW}x${this.frameH} @ ${Math.round(fps)} fps`;
    this.info.timeOffsetMs = this.calib.timeOffsetMs;
    this.capture.width = this.frameW;
    this.capture.height = this.frameH;
    this.worker.postMessage({ type: "start", rig: this.rig, gpu: true, overrides: undefined, estimateEvery: 1, watchdog: { enabled: true, stillStart: true } });
    // Replay the last 0.6 s of motion: the first frame's attitude averages the half second before it.
    const since = (this.lastMotion?.t ?? 0) - 600;
    const recent = this.imuHistory.filter((s) => s.t > since);
    this.imuBatch = [...recent.flatMap((s) => [Math.round(s.t * 1e6), ...s.g, ...s.a]), ...this.imuBatch];
    this.flushImu();
    this.latest = null;
    // A new session is a new tracker world: the old map no longer lines up.
    this.mapCount = 0;
    this.mapKeys.clear();
    if (this.landmarks) (this.landmarks.count = 0), this.landmarks.version++;
    this.status = "wait";
    this.inflight = 0;
    this.lastPosted = -Infinity;
    if (!this.running) {
      this.running = true;
      this.scheduleFrame();
    }
  }

  private scheduleFrame() {
    if (!this.running) return;
    const v = this.video as any;
    if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(this.onVideoFrame);
    else requestAnimationFrame((now) => this.onVideoFrame(now, null));
  }

  private frameTime(now: number, meta: any) {
    const perf = performance.now();
    for (;;) {
      const t = this.frameClock === 0 ? meta?.captureTime : this.frameClock === 1 ? meta?.presentationTime : now;
      if (this.frameClock === 2 || (Number.isFinite(t) && Math.abs(t - perf) < 1000 && t > this.lastClockT)) {
        this.lastClockT = t;
        return t as number;
      }
      this.frameClock++;
    }
  }

  private onVideoFrame = (now: number, meta: any) => {
    if (!this.running) return;
    this.scheduleFrame();
    if (meta && this.skipRepeats) {
      const key = `${meta.presentedFrames}/${meta.mediaTime}`;
      if (key === this.lastFrameKey) {
        if (++this.repeated > 30) this.skipRepeats = false;
        return;
      }
      this.lastFrameKey = key;
      this.repeated = 0;
    }
    const t = this.frameTime(now, meta) + this.calib.timeOffsetMs;
    this.lastFrameTime = t;
    if (Number.isFinite(meta?.captureTime)) {
      const latency = performance.now() - meta.captureTime;
      if (latency > 0 && latency < 200) this.videoLatencyMs += 0.05 * (latency - this.videoLatencyMs);
    }
    if (t - this.lastPosted < 25) return; // track at 30 Hz
    if (this.inflight >= 2 || !this.rig) return; // the worker is behind
    this.lastPosted = t;
    this.ctx.drawImage(this.video, 0, 0, this.frameW, this.frameH);
    const rgba = this.ctx.getImageData(0, 0, this.frameW, this.frameH).data;
    const gray = new Uint8Array(this.frameW * this.frameH);
    for (let i = 0, j = 0; i < gray.length; i++, j += 4) gray[i] = (77 * rgba[j] + 150 * rgba[j + 1] + 29 * rgba[j + 2]) >> 8;
    this.flushImu();
    this.inflight++;
    this.worker.postMessage({ type: "frame", t: Math.round(t * 1e6), gray: gray.buffer, width: this.frameW, height: this.frameH }, [gray.buffer]);
  };

  private onResult(m: any) {
    this.latest = m;
    this.status = m.status;
    this.info.points = m.connected;
    this.info.resets = m.resets;
    this.info.ms += 0.1 * (m.ms - this.info.ms);
    this.results++;
    const now = performance.now();
    if (now - this.resultsWindow > 1000) {
      this.info.fps = (1000 * this.results) / (now - this.resultsWindow);
      this.results = 0;
      this.resultsWindow = now;
    }
    if (m.landmarks && this.aligned && posed(m.status)) this.onLandmarks(m.landmarks as Float32Array);
    if (m.sync) this.onSync(m.sync);
  }

  /** Applies solid camera-IMU time-offset measurements and fixes swapped gyro axes (both restart the session). */
  private onSync(e: any) {
    if (this.axesSwitches < 2 && e.correlation > 0.9 && e.axisSpread >= 0.3 && e.intervals >= 200 && e.rotationErrorDeg > 45) {
      const measured = quatMatrix(Array.from(e.imuFromCamera as number[]));
      const assumed = quatMatrix(this.rig.imuFromCamera.slice(0, 4));
      const current = GYRO_AXES[this.calib.gyroAxes] ?? GYRO_AXES.w3c;
      for (const [name, rows] of Object.entries(GYRO_AXES)) {
        if (rows === current) continue;
        const predicted = matMul(matMul(rows, transpose(current)), measured);
        if (rotationDeg(matMul(transpose(assumed), predicted)) > 30) continue;
        this.calib.gyroAxes = name;
        this.saveCalib();
        this.axesSwitches++;
        this.imuBatch = [];
        this.beginSession();
        return;
      }
    }
    this.recentSync.push(e.offsetMs);
    if (this.recentSync.length > 3) this.recentSync.shift();
    const steady = this.recentSync.length === 3 && Math.max(...this.recentSync) - Math.min(...this.recentSync) < 4;
    const solid = e.correlation > 0.93 && e.intervals >= 250 && e.rateRadS > 0.15 && steady;
    if (!solid || Math.abs(e.offsetMs) < 15 || this.syncApplied >= 2) return;
    this.calib.timeOffsetMs = Math.round(this.calib.timeOffsetMs + e.offsetMs);
    this.saveCalib();
    this.syncApplied++;
    this.beginSession();
  }

  // ---- pose ----------------------------------------------------------------------------

  /** Last VIO pose carried forward to time `t` by the gyroscope and the estimated velocity. */
  private predicted(t: number): { q: Q4; p: V3 } {
    const m = this.latest;
    const tf = m.t / 1e6;
    const target = Math.max(tf, Math.min(t, tf + 250));
    let qi: Q4 = [m.imu[0], m.imu[1], m.imu[2], m.imu[3]];
    const bg = m.gyroBias;
    const turn = (g: V3, h: number) => (qi = quatMul(qi, quatFromRotvec([(g[0] - bg[0]) * h, (g[1] - bg[1]) * h, (g[2] - bg[2]) * h])));
    let covered = tf;
    const H = this.imuHistory;
    for (let k = 1; k < H.length; k++) {
      const a = H[k - 1], b = H[k];
      if (b.t <= tf || a.t >= target) continue;
      const t0 = Math.max(a.t, tf), t1 = Math.min(b.t, target);
      turn(b.g, (t1 - t0) / 1000);
      covered = t1;
    }
    const newest = H[H.length - 1];
    if (newest && covered < target) turn(newest.g, (target - covered) / 1000);
    const dt = (target - tf) / 1000;
    const ic = this.rig.imuFromCamera;
    const qc = quatMul(qi, ic.slice(0, 4));
    const off = quatRotate(qi, ic.slice(4, 7));
    return { q: qc, p: [m.imu[4] + m.velocity[0] * dt + off[0], m.imu[5] + m.velocity[1] * dt + off[1], m.imu[6] + m.velocity[2] * dt + off[2]] };
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
    const m = this.latest;
    if (m && posed(m.status) && this.rig) {
      const now = performance.now();
      const { q, p } = this.predicted(now + 16.7 - this.videoLatencyMs + this.calib.timeOffsetMs);
      // VIO world (z up, OpenCV camera) -> y-up scene, three.js camera.
      this.qv.set(q[1], q[2], q[3], q[0]).premultiply(VioTrackingProvider.Q_CONV).multiply(VioTrackingProvider.Q_FLIP);
      this.pvRaw.set(p[0], p[2], -p[1]);
      this.pv.copy(this.pvRaw).multiplyScalar(this.scale);
      if (!this.wasPosed) {
        // (Re)anchor the tracker's world so the camera continues exactly where the view was.
        const wantHeading = this.everTracked ? st.heading : c.state.heading;
        this.yaw = -wrap180(wantHeading - this.headingOf(this.qv)) * DEG;
        this.qYaw.setFromAxisAngle(VioTrackingProvider.UP, this.yaw);
        const rp = this.pv.clone().applyQuaternion(this.qYaw);
        if (!this.everTracked) st.position.set(0, this.cfg.eyeHeight, 0);
        this.offset.copy(st.position).sub(rp);
        this.aligned = this.wasPosed = this.everTracked = true;
        this.trackedSince = now;
        this.lastPathPos = null;
      }
      if (!this.settled) {
        if (this.lastPathPos) this.path += this.lastPathPos.distanceTo(this.pv);
        (this.lastPathPos ??= new Vector3()).copy(this.pv);
        const secs = (now - this.trackedSince) / 1000;
        // Enough sideways travel for the IMU to fix scale, then the floor (or a timeout where it has no texture).
        if (m.status === "track" && this.path > 0.5 && secs > 1.5 && (this.info.floor || secs > 6)) this.settled = true;
      }
      st.quaternion.copy(this.qYaw).multiply(this.qv);
      st.position.copy(this.pv).applyQuaternion(this.qYaw).add(this.offset);
      st.heading = this.headingOf(st.quaternion);
      st.dof = 6;
      st.quality = m.status === "track" ? "good" : "limited";
    } else {
      if (this.wasPosed) {
        this.wasPosed = false;
        this.fallbackYaw = wrap180(st.heading - c.state.heading);
      }
      // Rotation-only from the gyro/compass until tracking is (re)established; position holds.
      this.qYaw.setFromAxisAngle(VioTrackingProvider.UP, -this.fallbackYaw * DEG);
      st.quaternion.copy(this.qYaw).multiply(c.state.quaternion);
      st.heading = wrap360(c.state.heading + this.fallbackYaw);
      st.dof = 3;
      st.quality = c.state.quality === "none" ? "none" : "limited";
      this.qYaw.setFromAxisAngle(VioTrackingProvider.UP, this.yaw);
    }
  }

  // ---- environment ---------------------------------------------------------------------

  private onLandmarks(raw: Float32Array) {
    // Accumulate into the persistent map (tracker world, unscaled, y-up).
    const n = raw.length / 3, VOX = 0.05;
    for (let i = 0; i < n && this.mapCount < VioTrackingProvider.MAP_MAX; i++) {
      const x = raw[3 * i], y = raw[3 * i + 2], z = -raw[3 * i + 1];
      const ix = Math.round(x / VOX) + 512, iy = Math.round(y / VOX) + 512, iz = Math.round(z / VOX) + 512;
      if (ix < 0 || ix > 1023 || iy < 0 || iy > 1023 || iz < 0 || iz > 1023) continue;
      const key = ix * 1048576 + iy * 1024 + iz;
      if (this.mapKeys.has(key)) continue;
      this.mapKeys.add(key);
      this.mapRaw.set([x, y, z], 3 * this.mapCount++);
    }
    this.fitSurfaces();
    this.projectMap();
  }

  /** Map points in the local frame, for rendering and hit tests. */
  private projectMap() {
    const lm = (this.landmarks ??= { positions: new Float32Array(3 * VioTrackingProvider.MAP_MAX), count: 0, version: 0 });
    const out = lm.positions, src = this.mapRaw, s = this.scale, o = this.offset;
    const cs = Math.cos(this.yaw) * s, sn = Math.sin(this.yaw) * s;
    for (let i = 0; i < this.mapCount; i++) {
      const x = src[3 * i], y = src[3 * i + 1], z = src[3 * i + 2];
      out[3 * i] = cs * x + sn * z + o.x;
      out[3 * i + 1] = s * y + o.y;
      out[3 * i + 2] = -sn * x + cs * z + o.z;
    }
    lm.count = this.mapCount;
    lm.version++;
    this.info.mapPoints = this.mapCount;
  }

  /**
   * Finds horizontal surfaces as dense height layers in the map near the player. The lowest
   * strong layer at a plausible depth below the phone is the floor: it is moved to y = 0 and,
   * if the phone's height above it disagrees with the configured one, the world is rescaled.
   */
  private fitSurfaces() {
    const cam = this.state.position, s = this.scale, o = this.offset, src = this.mapRaw;
    const cs = Math.cos(this.yaw) * s, sn = Math.sin(this.yaw) * s;
    const BIN = 0.04, hist = new Map<number, number>();
    for (let i = 0; i < this.mapCount; i++) {
      const x = cs * src[3 * i] + sn * src[3 * i + 2] + o.x, z = -sn * src[3 * i] + cs * src[3 * i + 2] + o.z;
      if (Math.hypot(x - cam.x, z - cam.z) > 6) continue;
      const y = s * src[3 * i + 1] + o.y;
      if (y > cam.y + 0.3 || y < cam.y - 3) continue;
      const k = Math.round(y / BIN);
      hist.set(k, (hist.get(k) ?? 0) + 1);
    }
    // Peaks of a 3-bin window, strongest first, at least 20 cm apart.
    const peaks: { y: number; n: number }[] = [];
    for (const [k, c] of hist) {
      const l = hist.get(k - 1) ?? 0, r = hist.get(k + 1) ?? 0, nSum = c + l + r;
      if (nSum < 18 || c < l || c < r) continue;
      peaks.push({ y: ((k - 1) * l + k * c + (k + 1) * r) / nSum * BIN, n: nSum });
    }
    peaks.sort((a, b) => b.n - a.n);
    const kept: { y: number; n: number }[] = [];
    for (const p of peaks) if (kept.every((q) => Math.abs(q.y - p.y) > 0.2)) kept.push(p);
    // The floor is the lowest surface: plain floors give few points, so a small cluster is enough
    // as long as almost nothing lies below it.
    let floor: { y: number; n: number } | undefined;
    const ks = [...hist.keys()].sort((a, b) => a - b);
    let under = 0;
    for (const k of ks) {
      const c = hist.get(k)!, nSum = c + (hist.get(k + 1) ?? 0) + (hist.get(k + 2) ?? 0);
      const y = (k * c + (k + 1) * (hist.get(k + 1) ?? 0) + (k + 2) * (hist.get(k + 2) ?? 0)) / nSum * BIN;
      if (nSum >= 8 && under <= 0.25 * nSum && cam.y - y > 0.8 && cam.y - y < 2.2) {
        floor = kept.find((p) => Math.abs(p.y - y) < 0.12) ?? { y, n: nSum };
        break;
      }
      under += c;
      if (under > 12) break; // too much below: this view has no clear lowest surface
    }
    if (floor) {
      this.info.floor = true;
      const camHeight = cam.y - floor.y;
      const r = this.cfg.eyeHeight / camHeight;
      if (Math.abs(r - 1) > 0.12 && r > 0.7 && r < 1.4 && this.scaleFixes < 2 && floor.n >= 30) {
        // Rescale the world about the camera so the view does not jump.
        const sNew = this.scale * r;
        this.qYaw.setFromAxisAngle(VioTrackingProvider.UP, this.yaw);
        this.offset.add(this.pvRaw.clone().applyQuaternion(this.qYaw).multiplyScalar(this.scale - sNew));
        this.scale = sNew;
        this.info.scale = sNew;
        this.scaleFixes++;
        return; // layers are re-fitted on the next map update, at the new scale
      }
      if (Math.abs(floor.y) > 0.015) {
        const step = -floor.y * 0.3;
        this.offset.y += step;
        for (const p of kept) p.y += step;
      }
    }
    this.layers = [...(floor ? [floor] : []), ...kept.filter((p) => p !== floor && (!floor || p.y > floor.y + 0.25))].map((p) => p.y);
    this.info.layers = this.layers.map((y) => y.toFixed(2)).join(" / ");
  }

  surfacePoint(origin: Vector3, dir: Vector3) {
    const lm = this.landmarks;
    if (!lm || this.state.dof !== 6) return null;
    const p = lm.positions, depths: number[] = [];
    const tan = Math.tan(3 * DEG);
    for (let i = 0; i < lm.count; i++) {
      const vx = p[3 * i] - origin.x, vy = p[3 * i + 1] - origin.y, vz = p[3 * i + 2] - origin.z;
      const d = vx * dir.x + vy * dir.y + vz * dir.z;
      if (d < 0.3 || d > 15) continue;
      const perp = Math.hypot(vx - d * dir.x, vy - d * dir.y, vz - d * dir.z);
      if (perp < d * tan + 0.03) depths.push(d);
    }
    if (depths.length < 4) return null;
    depths.sort((a, b) => a - b);
    // The nearest tight cluster along the ray is the surface in front; points behind it are ignored.
    let depth = -1;
    for (let i = 0; i + 3 < depths.length; i++) {
      if (depths[i + 3] - depths[i] > 0.25) continue;
      let j = i, sum = 0;
      while (j < depths.length && depths[j] - depths[i] < 0.25) sum += depths[j++];
      depth = sum / (j - i);
      break;
    }
    if (depth < 0) return null;
    const point = origin.clone().addScaledVector(dir, depth);
    // Snap onto a detected horizontal surface when the hit is on one: slide along the ray to its height.
    const layer = this.layers.find((y) => Math.abs(y - point.y) < 0.1);
    if (layer !== undefined && Math.abs(dir.y) > 0.08) {
      depth = (layer - origin.y) / dir.y;
      point.copy(origin).addScaledVector(dir, depth);
    }
    return { point, depth };
  }

  /** Without a detected floor, the floor is wherever the configured phone height puts it. */
  setEyeHeight(prev: number, next: number) {
    if (!this.info.floor && this.aligned) {
      this.offset.y += next - prev;
      this.projectMap();
    }
  }

  recenter() {}
}
