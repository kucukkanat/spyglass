import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { sunPosition, toEN, toLatLon, wrap180, type LatLon } from "./geo";
import type { TrackingProvider } from "./types";

export interface ARObject {
  root: THREE.Object3D;
  /** Radius of the soft contact shadow, metres. */
  footprint: number;
  update(t: number, dt: number): void;
}

export class Anchor {
  readonly group = new THREE.Group();
  private born = -1;
  distance = 0;
  bearing = 0; // relative to camera heading, degrees (+ = right)
  constructor(public id: string, public name: string, public object: ARObject, blob: THREE.Texture) {
    const shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(object.footprint * 2.6, object.footprint * 2.6),
      new THREE.MeshBasicMaterial({ map: blob, transparent: true, depthWrite: false, opacity: 0.55 }),
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.006;
    shadow.renderOrder = -1;
    this.group.add(shadow, object.root);
    this.group.visible = false;
  }
  place(e: number, n: number, yawDeg: number) {
    this.group.position.set(e, 0, -n);
    this.group.rotation.y = -THREE.MathUtils.degToRad(yawDeg);
    this.group.visible = true;
    this.born = -1;
  }
  get en() {
    return { e: this.group.position.x, n: -this.group.position.z };
  }
  get yaw() {
    return -THREE.MathUtils.radToDeg(this.group.rotation.y);
  }
  tick(t: number, dt: number) {
    if (!this.group.visible) return;
    if (this.born < 0) this.born = t;
    const a = Math.min(1, (t - this.born) / 0.9);
    // back-out ease for a little "pop" on spawn
    const s = a < 1 ? 1 + 2.7 * Math.pow(a - 1, 3) + 1.7 * Math.pow(a - 1, 2) : 1;
    this.object.root.scale.setScalar(Math.max(0.001, s));
    this.object.update(t, dt);
  }
}

export interface EngineOptions {
  canvas: HTMLCanvasElement;
  video: HTMLVideoElement | null;
  provider: TrackingProvider;
  /** FOV of the camera stream along its long side, degrees. */
  cameraFov: number;
}

export class AREngine {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(60, 1, 0.05, 400);
  readonly renderer: THREE.WebGLRenderer;
  readonly anchors: Anchor[] = [];
  readonly reticle: THREE.Mesh;
  provider: TrackingProvider;
  cameraFov: number;
  sun = { azimuth: 200, altitude: 35, real: false };
  fps = 0;
  onFrame: ((t: number) => void) | null = null;

  private video: HTMLVideoElement | null;
  private sunLight = new THREE.DirectionalLight(0xfff1dc, 2.4);
  private hemi = new THREE.HemisphereLight(0xcfe4ff, 0x6b5a45, 0.9);
  private shadowMat = new THREE.ShadowMaterial({ opacity: 0.38 });
  private blob: THREE.Texture;
  private clock = new THREE.Clock();
  private probe = document.createElement("canvas");
  private probeCtx: CanvasRenderingContext2D | null;
  private lastProbe = 0;
  private lastSun = -1e9;
  private ray = new THREE.Ray();
  private centroid = new THREE.Vector3();

  constructor(opts: EngineOptions) {
    this.provider = opts.provider;
    this.video = opts.video;
    this.cameraFov = opts.cameraFov;
    const r = (this.renderer = new THREE.WebGLRenderer({ canvas: opts.canvas, alpha: true, antialias: true, powerPreference: "high-performance" }));
    r.setClearColor(0x000000, 0);
    r.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.0;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;

    const pmrem = new THREE.PMREMGenerator(r);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.55;

    const s = this.sunLight;
    s.castShadow = true;
    s.shadow.mapSize.set(2048, 2048);
    s.shadow.bias = -0.0004;
    s.shadow.normalBias = 0.02;
    s.shadow.radius = 5;
    const c = s.shadow.camera;
    c.left = c.bottom = -14;
    c.right = c.top = 14;
    c.near = 1;
    c.far = 90;
    this.scene.add(s, s.target, this.hemi);

    const ground = new THREE.Mesh(new THREE.PlaneGeometry(240, 240), this.shadowMat);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);

    this.blob = radialTexture([
      [0, "rgba(0,0,0,0.75)"],
      [0.45, "rgba(0,0,0,0.35)"],
      [1, "rgba(0,0,0,0)"],
    ]);

    this.reticle = new THREE.Mesh(
      new THREE.RingGeometry(0.32, 0.4, 48),
      new THREE.MeshBasicMaterial({ color: 0xffd36b, transparent: true, opacity: 0.95, depthTest: false }),
    );
    this.reticle.rotation.x = -Math.PI / 2;
    this.reticle.visible = false;
    this.reticle.renderOrder = 10;
    this.scene.add(this.reticle);

    this.probe.width = this.probe.height = 16;
    this.probeCtx = this.probe.getContext("2d", { willReadFrequently: true });

    window.addEventListener("resize", () => this.resize());
    this.resize();
  }

  addAnchor(id: string, name: string, object: ARObject) {
    const a = new Anchor(id, name, object, this.blob);
    this.anchors.push(a);
    this.scene.add(a.group);
    return a;
  }

  /** Point on the ground under the screen centre, or a fallback ahead of the player. */
  groundPoint(fallbackDist = 6) {
    const cam = this.camera;
    this.ray.origin.copy(cam.position);
    this.ray.direction.set(0, 0, -1).applyQuaternion(cam.quaternion);
    const d = this.ray.direction;
    let t = d.y < -0.05 ? -cam.position.y / d.y : Infinity;
    if (!isFinite(t) || t > 40) {
      const h = Math.hypot(d.x, d.z) || 1;
      return new THREE.Vector3(cam.position.x + (d.x / h) * fallbackDist, 0, cam.position.z + (d.z / h) * fallbackDist);
    }
    return new THREE.Vector3(cam.position.x + d.x * t, 0, cam.position.z + d.z * t);
  }

  geoOf(a: Anchor): LatLon | null {
    const o = this.provider.state.geoOrigin;
    return o ? toLatLon(o, a.en) : null;
  }
  placeGeo(a: Anchor, p: LatLon, yaw: number) {
    const o = this.provider.state.geoOrigin;
    if (!o) return false;
    const en = toEN(o, p);
    a.place(en.e, en.n, yaw);
    return true;
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // Match the virtual camera to the cropped (object-fit: cover) camera stream.
    const v = this.video;
    const vw = v?.videoWidth || (w > h ? 1920 : 1080);
    const vh = v?.videoHeight || (w > h ? 1080 : 1920);
    const scale = Math.max(w / vw, h / vh);
    const f = (Math.max(vw, vh) / 2 / Math.tan(THREE.MathUtils.degToRad(this.cameraFov) / 2)) * scale;
    this.camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(h / 2 / f));
    this.camera.updateProjectionMatrix();
  }

  private updateLighting(now: number) {
    const st = this.provider.state;
    if (now - this.lastSun > 30000) {
      this.lastSun = now;
      const o = st.geoOrigin;
      if (o) {
        const sp = sunPosition(new Date(), o.lat, o.lon);
        this.sun = sp.altitude > 3 ? { ...sp, real: true } : { azimuth: st.heading + 140, altitude: 50, real: false };
      } else this.lastSun = now - 28000; // retry soon until we have a fix
      const alt = THREE.MathUtils.degToRad(Math.max(this.sun.altitude, 16)); // cap shadow length
      const az = THREE.MathUtils.degToRad(this.sun.azimuth);
      this.sunLight.userData.dir = new THREE.Vector3(Math.sin(az) * Math.cos(alt), Math.sin(alt), -Math.cos(az) * Math.cos(alt));
      const low = 1 - THREE.MathUtils.smoothstep(this.sun.altitude, 5, 30);
      this.sunLight.color.setRGB(1, 0.95 - 0.2 * low, 0.86 - 0.42 * low);
    }
    const dir = this.sunLight.userData.dir as THREE.Vector3 | undefined;
    if (dir) {
      this.centroid.set(0, 0, 0);
      let n = 0;
      for (const a of this.anchors) if (a.group.visible) (this.centroid.add(a.group.position), n++);
      if (n) this.centroid.multiplyScalar(1 / n);
      this.sunLight.target.position.copy(this.centroid);
      this.sunLight.position.copy(this.centroid).addScaledVector(dir, 40);
    }
    // Match ambient colour/brightness and shadow contrast to the live camera image.
    const v = this.video;
    if (v && v.readyState >= 2 && this.probeCtx && now - this.lastProbe > 450) {
      this.lastProbe = now;
      try {
        this.probeCtx.drawImage(v, 0, 0, 16, 16);
        const d = this.probeCtx.getImageData(0, 0, 16, 16).data;
        let r = 0, g = 0, b = 0, l2 = 0;
        for (let i = 0; i < d.length; i += 4) {
          const R = Math.pow(d[i] / 255, 2.2), G = Math.pow(d[i + 1] / 255, 2.2), B = Math.pow(d[i + 2] / 255, 2.2);
          r += R; g += G; b += B;
          const L = 0.2126 * R + 0.7152 * G + 0.0722 * B;
          l2 += L * L;
        }
        const n = d.length / 4;
        r /= n; g /= n; b /= n;
        const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        const contrast = Math.sqrt(Math.max(0, l2 / n - L * L)) / (L + 0.02);
        const m = Math.max(r, g, b, 0.02);
        const k = 0.08;
        this.hemi.color.lerp(new THREE.Color(0.55 + (0.45 * r) / m, 0.55 + (0.45 * g) / m, 0.55 + (0.45 * b) / m), k);
        const exposure = THREE.MathUtils.clamp(0.55 + L * 1.6, 0.55, 1.25);
        this.renderer.toneMappingExposure += (exposure - this.renderer.toneMappingExposure) * k * 2;
        const sunny = THREE.MathUtils.clamp((contrast - 0.45) / 0.6, 0, 1); // overcast -> soft, faint shadows
        this.shadowMat.opacity += (0.22 + 0.3 * sunny - this.shadowMat.opacity) * k * 2;
        this.sunLight.intensity += (1.5 + 1.6 * sunny - this.sunLight.intensity) * k * 2;
        this.hemi.intensity += (1.15 - 0.4 * sunny - this.hemi.intensity) * k * 2;
      } catch {}
    }
  }

  start() {
    let frames = 0, acc = 0;
    this.renderer.setAnimationLoop(() => {
      const dt = Math.min(this.clock.getDelta(), 0.1);
      const t = this.clock.elapsedTime;
      this.provider.update(dt);
      const st = this.provider.state;
      this.camera.position.copy(st.position);
      this.camera.quaternion.copy(st.quaternion);
      this.updateLighting(performance.now());
      for (const a of this.anchors) {
        a.tick(t, dt);
        const dx = a.group.position.x - st.position.x, dz = a.group.position.z - st.position.z;
        a.distance = Math.hypot(dx, dz);
        a.bearing = wrap180(THREE.MathUtils.radToDeg(Math.atan2(dx, -dz)) - st.heading);
      }
      if (this.reticle.visible) {
        this.reticle.position.copy(this.groundPoint()).setY(0.02);
        this.reticle.scale.setScalar(1 + 0.08 * Math.sin(t * 5));
      }
      this.onFrame?.(t);
      this.renderer.render(this.scene, this.camera);
      frames++; acc += dt;
      if (acc >= 0.5) { this.fps = frames / acc; frames = 0; acc = 0; }
    });
  }
}

export function radialTexture(stops: [number, string][], size = 128) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [o, col] of stops) grad.addColorStop(o, col);
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
