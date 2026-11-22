import { Euler, MathUtils, Quaternion, Vector3 } from "three";
import { toEN, toLatLon, wrap180, wrap360, type LatLon } from "./geo";
import type { ProviderConfig, TrackingProvider, TrackingState } from "./types";

const Q_CAM = new Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5)); // look out the back of the phone
const Z = new Vector3(0, 0, 1);
const Y = new Vector3(0, 1, 0);

/**
 * Sensor-fusion tracker for browsers without WebXR (iOS Safari).
 *  - Rotation: gyro-fused device attitude (smooth), yaw-aligned to the compass by a
 *    slowly adapting offset, so compass noise never reaches the rendered objects.
 *  - Translation: pedestrian dead reckoning (step detection x heading). GPS only
 *    nudges the estimate while the player is walking; standing still freezes it,
 *    which is what keeps anchors solid.
 */
export class SensorTrackingProvider implements TrackingProvider {
  readonly name = "sensor-fusion (gyro + compass + steps + GPS)";
  readonly state: TrackingState = {
    position: new Vector3(0, 1.5, 0),
    quaternion: new Quaternion(),
    heading: 0,
    headingAccuracy: null,
    geoOrigin: null,
    gpsAccuracy: null,
    steps: 0,
    quality: "none",
    dof: 3,
  };

  private rawQ = new Quaternion();
  private hasOrientation = false;
  private absolute = false;
  private yawOffset = 0; // degrees added to raw heading to get true heading
  private offsetSamples = 0;
  private target = new Vector3(0, 0, 0); // east, 0, -north
  private gEst = 9.81;
  private hp = 0;
  private armed = true;
  private lastStep = 0;
  private watchId: number | null = null;
  private euler = new Euler();
  private fwd = new Vector3();
  private tmpQ = new Quaternion();
  private startedAt = 0;

  constructor(public cfg: ProviderConfig) {}

  static async requestPermissions(): Promise<boolean> {
    const req: Promise<string>[] = [];
    const DO = (window as any).DeviceOrientationEvent;
    const DM = (window as any).DeviceMotionEvent;
    if (DO?.requestPermission) req.push(DO.requestPermission());
    if (DM?.requestPermission) req.push(DM.requestPermission());
    if (!DO) return false;
    try {
      const res = await Promise.all(req);
      return res.every((r) => r === "granted");
    } catch {
      return false;
    }
  }

  async start() {
    this.startedAt = performance.now();
    if ("ondeviceorientationabsolute" in (window as any)) {
      (window as any).addEventListener("deviceorientationabsolute", this.onOrientation as any);
      this.absolute = true;
    } else {
      window.addEventListener("deviceorientation", this.onOrientation as any);
    }
    window.addEventListener("devicemotion", this.onMotion);
    if (navigator.geolocation) {
      this.watchId = navigator.geolocation.watchPosition(this.onGps, () => {}, {
        enableHighAccuracy: true,
        maximumAge: 0,
        timeout: 20000,
      });
    }
  }

  stop() {
    window.removeEventListener("deviceorientationabsolute", this.onOrientation as any);
    window.removeEventListener("deviceorientation", this.onOrientation as any);
    window.removeEventListener("devicemotion", this.onMotion);
    if (this.watchId !== null) navigator.geolocation.clearWatch(this.watchId);
  }

  /** True once at least one orientation event arrived. */
  get live() {
    return this.hasOrientation;
  }

  private headingOf(q: Quaternion) {
    this.fwd.set(0, 0, -1).applyQuaternion(q);
    return { heading: wrap360(Math.atan2(this.fwd.x, -this.fwd.z) * MathUtils.RAD2DEG), up: this.fwd.y };
  }

  private onOrientation = (e: DeviceOrientationEvent & { webkitCompassHeading?: number; webkitCompassAccuracy?: number }) => {
    if (e.alpha === null || e.beta === null || e.gamma === null) return;
    const orient = MathUtils.degToRad((screen.orientation?.angle ?? (window as any).orientation ?? 0) as number);
    this.euler.set(MathUtils.degToRad(e.beta), MathUtils.degToRad(e.alpha), -MathUtils.degToRad(e.gamma), "YXZ");
    this.rawQ.setFromEuler(this.euler).multiply(Q_CAM).multiply(this.tmpQ.setFromAxisAngle(Z, -orient));
    this.hasOrientation = true;

    if (typeof e.webkitCompassHeading === "number" && e.webkitCompassHeading >= 0) {
      // iOS: alpha is relative to an arbitrary start, compass heading is magnetic.
      const acc = e.webkitCompassAccuracy ?? -1;
      this.state.headingAccuracy = acc >= 0 ? acc : null;
      const { heading, up } = this.headingOf(this.rawQ);
      // Only calibrate while the phone is held up like a viewfinder and the compass is sane.
      if (Math.abs(up) < 0.75 && acc >= 0 && acc <= 30) {
        const diff = wrap180(e.webkitCompassHeading + this.cfg.declination - heading);
        if (this.offsetSamples === 0) this.yawOffset = diff;
        else {
          // Fast convergence for the first ~2 s, then a very slow drift correction.
          const k = this.offsetSamples < 120 ? 0.06 : 0.0025;
          this.yawOffset = wrap180(this.yawOffset + k * wrap180(diff - this.yawOffset));
        }
        this.offsetSamples++;
      }
    } else if (this.absolute || (e as any).absolute) {
      this.yawOffset = 0;
      this.offsetSamples = 999;
    }
  };

  private onMotion = (e: DeviceMotionEvent) => {
    const a = e.accelerationIncludingGravity;
    if (!a || a.x === null || a.y === null || a.z === null) return;
    const mag = Math.hypot(a.x, a.y, a.z);
    this.gEst += 0.02 * (mag - this.gEst);
    this.hp += 0.35 * (mag - this.gEst - this.hp);
    const now = performance.now();
    if (this.armed && this.hp > 1.1 && now - this.lastStep > 300) {
      this.armed = false;
      this.lastStep = now;
      this.state.steps++;
      if (this.cfg.walkMode === "steps+gps") {
        const h = this.state.heading * MathUtils.DEG2RAD;
        this.target.x += Math.sin(h) * this.cfg.stepLength;
        this.target.z -= Math.cos(h) * this.cfg.stepLength;
      }
    } else if (this.hp < 0.2) this.armed = true;
  };

  private get walking() {
    return performance.now() - this.lastStep < 1800;
  }

  private onGps = (p: GeolocationPosition) => {
    const acc = p.coords.accuracy;
    this.state.gpsAccuracy = acc;
    const fix: LatLon = { lat: p.coords.latitude, lon: p.coords.longitude };
    const st = this.state;
    if (!st.geoOrigin) {
      // Bind the local frame to the globe on the first usable fix.
      const settled = performance.now() - this.startedAt > 6000;
      if (acc <= 20 || (settled && acc <= 80)) {
        st.geoOrigin = toLatLon(fix, { e: -this.target.x, n: this.target.z });
      }
      return;
    }
    if (acc > 30 || this.cfg.walkMode === "locked") return;
    const en = toEN(st.geoOrigin, fix);
    const dx = en.e - this.target.x, dz = -en.n - this.target.z;
    if (this.cfg.walkMode === "gps") {
      const k = MathUtils.clamp(4 / acc, 0.05, 0.5);
      this.target.x += k * dx;
      this.target.z += k * dz;
    } else if (this.walking) {
      // Dead reckoning carries the motion; GPS only bounds its drift.
      const k = MathUtils.clamp(1.2 / acc, 0.02, 0.25);
      this.target.x += k * dx;
      this.target.z += k * dz;
    }
  };

  /** Re-zero the local frame on the player (objects are re-placed by the caller). */
  recenter() {
    const st = this.state;
    if (st.geoOrigin) st.geoOrigin = toLatLon(st.geoOrigin, { e: this.target.x, n: -this.target.z });
    this.target.set(0, 0, 0);
    st.position.set(0, this.cfg.eyeHeight, 0);
  }

  update(dt: number) {
    const st = this.state;
    if (this.hasOrientation) {
      const yaw = -(this.yawOffset + this.cfg.headingTrim) * MathUtils.DEG2RAD;
      this.tmpQ.setFromAxisAngle(Y, yaw).multiply(this.rawQ);
      st.quaternion.slerp(this.tmpQ, 1 - Math.exp(-dt * 28));
      st.heading = this.headingOf(st.quaternion).heading;
    }
    const k = 1 - Math.exp(-dt * 3.2);
    st.position.x += (this.target.x - st.position.x) * k;
    st.position.z += (this.target.z - st.position.z) * k;
    st.position.y = this.cfg.eyeHeight;
    const accOk = st.headingAccuracy === null || st.headingAccuracy <= 15;
    st.quality = !this.hasOrientation ? "none" : this.offsetSamples > 60 && accOk ? "good" : "limited";
  }
}
