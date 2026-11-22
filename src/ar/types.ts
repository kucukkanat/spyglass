import type { Quaternion, Vector3 } from "three";
import type { LatLon } from "./geo";

export type TrackingQuality = "none" | "limited" | "good";
export type WalkMode = "steps+gps" | "gps" | "locked";

export interface TrackingState {
  /** Camera position in the local frame (x east, y up, z -north), metres. */
  position: Vector3;
  /** Camera orientation in the local frame. */
  quaternion: Quaternion;
  /** True heading of the optical axis, degrees clockwise from north. */
  heading: number;
  headingAccuracy: number | null;
  /** WGS84 coordinate of the local frame origin, once a usable fix arrived. */
  geoOrigin: LatLon | null;
  gpsAccuracy: number | null;
  steps: number;
  quality: TrackingQuality;
  /** 3 = rotation only, 6 = full pose. */
  dof: 3 | 6;
}

/**
 * The pluggable seam. A WebXR provider (Android) and a WASM VIO provider (iOS)
 * implement this same interface later; the engine and game never change.
 */
export interface TrackingProvider {
  readonly name: string;
  readonly state: TrackingState;
  /** Must be called from a user gesture (iOS sensor permissions). */
  start(): Promise<void>;
  stop(): void;
  /** Advance filters; called once per rendered frame. */
  update(dt: number): void;
  /** Sparse map points in the local frame, when the tracker builds one. */
  readonly landmarks?: { positions: Float32Array; count: number; version: number } | null;
  /** Nearest mapped surface along a ray (local frame), or null. */
  surfacePoint?(origin: Vector3, dir: Vector3, sx?: number, sy?: number): { point: Vector3; depth: number } | null;
  /** Short status for the HUD. */
  readonly statusText?: string;
  /** Instruction to show the player while tracking is not established. */
  readonly coach?: string | null;
  recenter?(): void;
  /** Camera projection (column-major 4x4) when the tracker knows the lens; otherwise the engine derives one. */
  readonly projectionMatrix?: ArrayLike<number> | null;
  /** True when the tracker runs the frame loop itself and calls `onRender` each frame. */
  readonly drivesLoop?: boolean;
  onRender?: (() => void) | null;
}

export interface ProviderConfig {
  eyeHeight: number;
  declination: number;
  headingTrim: number;
  stepLength: number;
  walkMode: WalkMode;
}
