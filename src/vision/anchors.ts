// Visual anchors: remember what the surroundings of an object look like, and find the
// object again from a camera frame. ORB features + brute-force Hamming matching + PnP
// (OpenCV.js, Apache-2.0, self-hosted in external/opencv.js). Everything runs on the phone.
//
// An anchor pack is a set of 3D points with descriptors, expressed in the object's own
// frame (origin at the object, y up, rotated by the object's yaw). Only these numbers are
// stored and shared; camera images never leave the device.
import { Matrix4, Quaternion, Vector3 } from "three";

export interface Frame {
  gray: Uint8Array; w: number; h: number;
  fx: number; fy: number; cx: number; cy: number;
  /** three.js camera pose in the tracker's local frame at the moment of capture. */
  pos: Vector3; quat: Quaternion;
}
export interface Features { n: number; xy: Float32Array; desc: Uint8Array }
export interface Keyframe extends Frame { f: Features }
export interface AnchorPack { n: number; pts: Float32Array; desc: Uint8Array }
export interface Resolved { pos: Vector3; yaw: number; inliers: number; matches: number }

const D = 32; // ORB descriptor bytes
const UP = new Vector3(0, 1, 0);

export class Vision {
  private orb: any;
  private matcher: any;
  private constructor(private cv: any, features: number) {
    this.orb = new cv.ORB(features);
    this.matcher = new cv.BFMatcher(cv.NORM_HAMMING, false);
  }

  static async load(url: string, features = 900): Promise<Vision> {
    const w = globalThis as any;
    if (!w.cv) {
      await new Promise<void>((resolve, reject) => {
        const s = document.createElement("script");
        s.src = url;
        s.async = true;
        s.onload = () => resolve();
        s.onerror = () => reject(new Error("OpenCV failed to load"));
        document.head.appendChild(s);
      });
    }
    let cv = w.cv;
    if (cv instanceof Promise) cv = await cv;
    if (!cv.Mat) await new Promise<void>((r) => (cv.onRuntimeInitialized = () => r()));
    // Older Emscripten modules are "thenable" and resolve to themselves, which makes any
    // await on them spin forever: remove that before the module is passed around.
    if (typeof cv.then === "function") cv.then = undefined;
    w.cv = cv;
    return new Vision(cv, features);
  }

  features(fr: Frame): Features {
    const cv = this.cv;
    const img = new cv.Mat(fr.h, fr.w, cv.CV_8UC1);
    img.data.set(fr.gray);
    const mask = new cv.Mat(), kp = new cv.KeyPointVector(), des = new cv.Mat();
    this.orb.detectAndCompute(img, mask, kp, des);
    const n = Math.min(kp.size(), des.rows);
    const xy = new Float32Array(2 * n);
    for (let i = 0; i < n; i++) {
      const p = kp.get(i).pt;
      xy[2 * i] = p.x;
      xy[2 * i + 1] = p.y;
    }
    const desc = n ? new Uint8Array(des.data.subarray(0, n * D)) : new Uint8Array(0);
    img.delete(); mask.delete(); kp.delete(); des.delete();
    return { n, xy, desc };
  }

  /** Ratio-tested matches from `q` into `t`, as [queryIndex, trainIndex] pairs. */
  match(q: Uint8Array, qn: number, t: Uint8Array, tn: number, ratio = 0.8): [number, number][] {
    if (qn < 2 || tn < 2) return [];
    const cv = this.cv;
    const mq = cv.matFromArray(qn, D, cv.CV_8UC1, q), mt = cv.matFromArray(tn, D, cv.CV_8UC1, t);
    const out = new cv.DMatchVectorVector();
    this.matcher.knnMatch(mq, mt, out, 2);
    const pairs: [number, number][] = [], best = new Map<number, number>();
    for (let i = 0; i < out.size(); i++) {
      const m = out.get(i);
      if (m.size() < 2) continue;
      const a = m.get(0), b = m.get(1);
      if (a.distance > ratio * b.distance || a.distance > 64) continue;
      // keep one query per train point (the closest)
      const prev = best.get(a.trainIdx);
      if (prev !== undefined && prev <= a.distance) continue;
      best.set(a.trainIdx, a.distance);
      pairs.push([a.queryIdx, a.trainIdx]);
    }
    mq.delete(); mt.delete(); out.delete();
    const seen = new Set<number>();
    return pairs.reverse().filter(([, ti]) => !seen.has(ti) && seen.add(ti));
  }

  private ray(fr: Frame, u: number, v: number, out: Vector3) {
    return out.set((u - fr.cx) / fr.fx, -(v - fr.cy) / fr.fy, -1).normalize().applyQuaternion(fr.quat);
  }

  /**
   * Triangulates features matched between keyframes (the tracker's poses give the baseline)
   * and expresses them in the object's frame.
   */
  buildPack(kfs: Keyframe[], objPos: Vector3, objYaw: number, maxPoints = 700): AnchorPack {
    const pts: number[] = [], desc: number[] = [];
    const d1 = new Vector3(), d2 = new Vector3(), w0 = new Vector3(), p = new Vector3(), p2 = new Vector3();
    const inv = new Quaternion().setFromAxisAngle(UP, -objYaw);
    const used = kfs.map(() => new Set<number>());
    for (let i = 0; i < kfs.length; i++) {
      for (let j = i + 1; j < kfs.length; j++) {
        const a = kfs[i], b = kfs[j];
        if (a.pos.distanceTo(b.pos) < 0.06) continue;
        for (const [qi, ti] of this.match(a.f.desc, a.f.n, b.f.desc, b.f.n, 0.75)) {
          if (used[i].has(qi) || used[j].has(ti)) continue;
          this.ray(a, a.f.xy[2 * qi], a.f.xy[2 * qi + 1], d1);
          this.ray(b, b.f.xy[2 * ti], b.f.xy[2 * ti + 1], d2);
          // closest points on the two rays
          w0.copy(a.pos).sub(b.pos);
          const bb = d1.dot(d2), dd = d1.dot(w0), ee = d2.dot(w0), den = 1 - bb * bb;
          if (den < 1.2e-3) continue; // rays under ~2 degrees apart: depth is too uncertain
          const s = (bb * ee - dd) / den, t = (ee - bb * dd) / den;
          if (s < 0.2 || t < 0.2 || s > 15 || t > 15) continue;
          p.copy(a.pos).addScaledVector(d1, s);
          p2.copy(b.pos).addScaledVector(d2, t);
          if (p.distanceTo(p2) > 0.008 + 0.008 * Math.min(s, t)) continue;
          p.add(p2).multiplyScalar(0.5).sub(objPos).applyQuaternion(inv);
          used[i].add(qi); used[j].add(ti);
          pts.push(p.x, p.y, p.z);
          for (let k = 0; k < D; k++) desc.push(a.f.desc[qi * D + k]);
        }
      }
    }
    // Prefer points near the object when there are too many.
    let n = pts.length / 3, order = [...Array(n).keys()];
    if (n > maxPoints) {
      order.sort((x, y) => Math.hypot(pts[3 * x], pts[3 * x + 1], pts[3 * x + 2]) - Math.hypot(pts[3 * y], pts[3 * y + 1], pts[3 * y + 2]));
      order = order.slice(0, maxPoints);
      n = maxPoints;
    }
    const P = new Float32Array(3 * n), Dd = new Uint8Array(D * n);
    order.forEach((src, i) => {
      P.set(pts.slice(3 * src, 3 * src + 3), 3 * i);
      Dd.set(desc.slice(D * src, D * src + D), D * i);
    });
    return { n, pts: P, desc: Dd };
  }

  /** Finds the object's pose in the tracker's local frame from one camera frame, or null. */
  resolve(pack: AnchorPack, fr: Frame, f: Features, minInliers = 14): Resolved | null {
    const pairs = this.match(f.desc, f.n, pack.desc, pack.n, 0.8);
    if (pairs.length < minInliers) return null;
    const cv = this.cv;
    const obj: number[] = [], img: number[] = [];
    for (const [qi, ti] of pairs) {
      obj.push(pack.pts[3 * ti], pack.pts[3 * ti + 1], pack.pts[3 * ti + 2]);
      img.push(f.xy[2 * qi], f.xy[2 * qi + 1]);
    }
    const mo = cv.matFromArray(pairs.length, 1, cv.CV_32FC3, obj), mi = cv.matFromArray(pairs.length, 1, cv.CV_32FC2, img);
    const K = cv.matFromArray(3, 3, cv.CV_64F, [fr.fx, 0, fr.cx, 0, fr.fy, fr.cy, 0, 0, 1]);
    const dist = cv.Mat.zeros(4, 1, cv.CV_64F), rvec = new cv.Mat(), tvec = new cv.Mat(), inl = new cv.Mat(), R = new cv.Mat();
    let res: Resolved | null = null;
    try {
      const ok = cv.solvePnPRansac(mo, mi, K, dist, rvec, tvec, false, 150, 4.0, 0.995, inl, cv.SOLVEPNP_ITERATIVE ?? 0);
      if (ok && inl.rows >= minInliers) {
        cv.Rodrigues(rvec, R);
        const r = R.data64F, t = tvec.data64F;
        // X_cv = R X_anchor + t. Camera centre in the anchor frame: C = -R^T t.
        const C = new Vector3(-(r[0] * t[0] + r[3] * t[1] + r[6] * t[2]), -(r[1] * t[0] + r[4] * t[1] + r[7] * t[2]), -(r[2] * t[0] + r[5] * t[1] + r[8] * t[2]));
        // three.js camera axes in the anchor frame: R^T * diag(1, -1, -1).
        const m = new Matrix4().set(r[0], -r[3], -r[6], 0, r[1], -r[4], -r[7], 0, r[2], -r[5], -r[8], 0, 0, 0, 0, 1);
        const qAnchorCam = new Quaternion().setFromRotationMatrix(m);
        const qT = fr.quat.clone().multiply(qAnchorCam.invert()); // local <- anchor
        const up = UP.clone().applyQuaternion(qT);
        if (up.y > 0.985 && C.length() < 25) { // both frames are gravity-aligned: reject tilted solutions (> ~10 degrees)
          const fwd = new Vector3(1, 0, 0).applyQuaternion(qT);
          const yaw = Math.atan2(-fwd.z, fwd.x);
          const pos = fr.pos.clone().sub(C.applyAxisAngle(UP, yaw));
          res = { pos, yaw, inliers: inl.rows, matches: pairs.length };
        }
      }
    } catch (e) {
      console.warn("[vision] pnp", e);
    }
    for (const x of [mo, mi, K, dist, rvec, tvec, inl, R]) x.delete();
    return res;
  }
}

/** Pinhole intrinsics (pixels, y down) of a `w` x `h` image from a three.js / WebGL projection matrix. */
export function intrinsics(P: ArrayLike<number>, w: number, h: number) {
  return { fx: (P[0] * w) / 2, fy: (P[5] * h) / 2, cx: ((1 - P[8]) * w) / 2, cy: ((1 + P[9]) * h) / 2 };
}

export function packToBase64(p: AnchorPack) {
  const bytes = new Uint8Array(4 + p.pts.byteLength + p.desc.byteLength);
  new DataView(bytes.buffer).setUint32(0, p.n, true);
  bytes.set(new Uint8Array(p.pts.buffer, p.pts.byteOffset, p.pts.byteLength), 4);
  bytes.set(p.desc, 4 + p.pts.byteLength);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function packFromBase64(b64: string): AnchorPack | null {
  try {
    const s = atob(b64), bytes = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
    const n = new DataView(bytes.buffer).getUint32(0, true);
    if (bytes.length !== 4 + n * 12 + n * D) return null;
    return { n, pts: new Float32Array(bytes.slice(4, 4 + n * 12).buffer), desc: bytes.slice(4 + n * 12) };
  } catch {
    return null;
  }
}
