import { Vector3 } from "three";

export interface SharedPose { x: number; y: number; z: number; yaw: number; scale: number }

/**
 * A coordinate frame every player can reconstruct from the same two physical points.
 * Origin at A, x towards B (horizontally), y up, and ONE UNIT = the distance from A to B.
 * Because the unit is the real A-B distance, phones whose trackers disagree about scale
 * still agree about where things are and how big they look.
 */
export class SharedFrame {
  readonly k: number; // local units per shared unit
  private ex = new Vector3();
  private ez = new Vector3();
  private theta: number;
  constructor(readonly a: Vector3, readonly b: Vector3) {
    const d = b.clone().sub(a);
    this.k = d.length();
    this.ex.set(d.x, 0, d.z).normalize();
    this.ez.crossVectors(this.ex, new Vector3(0, 1, 0));
    this.theta = Math.atan2(-this.ex.z, this.ex.x);
  }
  static valid(a: Vector3, b: Vector3) {
    return Math.hypot(b.x - a.x, b.z - a.z) >= 0.3;
  }
  toShared(pos: Vector3, yawRad: number, scale: number): SharedPose {
    const d = pos.clone().sub(this.a).divideScalar(this.k);
    return { x: d.dot(this.ex), y: d.y, z: d.dot(this.ez), yaw: yawRad - this.theta, scale: scale / this.k };
  }
  toLocal(p: SharedPose) {
    const pos = this.a.clone().addScaledVector(this.ex, p.x * this.k).addScaledVector(this.ez, p.z * this.k);
    pos.y += p.y * this.k;
    return { pos, yaw: p.yaw + this.theta, scale: p.scale * this.k };
  }
}
