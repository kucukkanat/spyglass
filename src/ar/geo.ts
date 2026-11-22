// Geodesy + sun helpers. Scene frame: x = east, y = up, z = -north (metres).
const A = 6378137.0;
const E2 = 6.69437999014e-3;
const RAD = Math.PI / 180;

export interface LatLon { lat: number; lon: number }
export interface EN { e: number; n: number }

function ecef(lat: number, lon: number, h = 0): [number, number, number] {
  const p = lat * RAD, l = lon * RAD;
  const s = Math.sin(p), c = Math.cos(p);
  const N = A / Math.sqrt(1 - E2 * s * s);
  return [(N + h) * c * Math.cos(l), (N + h) * c * Math.sin(l), (N * (1 - E2) + h) * s];
}

/** Exact WGS84 -> local East/North relative to origin (tangent plane). */
export function toEN(origin: LatLon, p: LatLon): EN {
  const [ox, oy, oz] = ecef(origin.lat, origin.lon);
  const [x, y, z] = ecef(p.lat, p.lon);
  const dx = x - ox, dy = y - oy, dz = z - oz;
  const sp = Math.sin(origin.lat * RAD), cp = Math.cos(origin.lat * RAD);
  const sl = Math.sin(origin.lon * RAD), cl = Math.cos(origin.lon * RAD);
  return {
    e: -sl * dx + cl * dy,
    n: -sp * cl * dx - sp * sl * dy + cp * dz,
  };
}

/** Local East/North -> WGS84 (accurate to mm within a few km of origin). */
export function toLatLon(origin: LatLon, en: EN): LatLon {
  const s = Math.sin(origin.lat * RAD);
  const w = Math.sqrt(1 - E2 * s * s);
  const M = (A * (1 - E2)) / (w * w * w); // meridional radius
  const N = A / w; // prime vertical radius
  return {
    lat: origin.lat + en.n / M / RAD,
    lon: origin.lon + en.e / (N * Math.cos(origin.lat * RAD)) / RAD,
  };
}

export const wrap180 = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;
export const wrap360 = (d: number) => ((d % 360) + 360) % 360;

/** Sun azimuth (deg clockwise from true north) and altitude (deg). */
export function sunPosition(date: Date, lat: number, lon: number) {
  const d = date.getTime() / 86400000 - 0.5 + 2440588 - 2451545;
  const M = RAD * (357.5291 + 0.98560028 * d);
  const C = RAD * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
  const L = M + C + RAD * 102.9372 + Math.PI;
  const e = RAD * 23.4397;
  const dec = Math.asin(Math.sin(L) * Math.sin(e));
  const ra = Math.atan2(Math.sin(L) * Math.cos(e), Math.cos(L));
  const phi = lat * RAD;
  const H = RAD * (280.16 + 360.9856235 * d) + lon * RAD - ra;
  const az = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi));
  const alt = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));
  return { azimuth: wrap360(az / RAD + 180), altitude: alt / RAD };
}
