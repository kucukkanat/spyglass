import * as THREE from "three";
import { radialTexture } from "../ar/engine";

export function shadowed<T extends THREE.Object3D>(o: T, receive = true): T {
  o.traverse((m) => {
    if ((m as THREE.Mesh).isMesh) {
      m.castShadow = true;
      m.receiveShadow = receive;
    }
  });
  return o;
}

let seed = 7;
export const rnd = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;

export function woodTexture(base = "#6a4526", dark = "#3a2413", planks = 5) {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d")!;
  g.fillStyle = base;
  g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 900; i++) {
    g.strokeStyle = `rgba(${rnd() > 0.5 ? "255,220,170" : "30,15,5"},${0.04 + rnd() * 0.08})`;
    g.lineWidth = 0.5 + rnd() * 1.5;
    const y = rnd() * 256, x = rnd() * 256;
    g.beginPath();
    g.moveTo(x, y);
    g.bezierCurveTo(x + 30, y + rnd() * 4 - 2, x + 60, y + rnd() * 4 - 2, x + 90 + rnd() * 60, y + rnd() * 3);
    g.stroke();
  }
  g.fillStyle = dark;
  for (let i = 0; i <= planks; i++) g.fillRect(0, (i * 256) / planks - 2, 256, 4);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

export const gold = () =>
  new THREE.MeshStandardMaterial({ color: 0xffc64a, metalness: 1, roughness: 0.24, emissive: 0x5a3200, emissiveIntensity: 0.35 });

export const iron = () => new THREE.MeshStandardMaterial({ color: 0x4a4038, metalness: 0.9, roughness: 0.45 });

let glowTex: THREE.Texture | null = null;
export function glowSprite(color: number, size: number, opacity = 1) {
  glowTex ??= radialTexture([
    [0, "rgba(255,255,255,1)"],
    [0.25, "rgba(255,255,255,0.45)"],
    [1, "rgba(255,255,255,0)"],
  ]);
  const s = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: glowTex, color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  s.scale.setScalar(size);
  return s;
}

/** Additive point cloud that drifts upward inside a cylinder and loops. */
export function sparkles(count: number, radius: number, height: number, color: number, size: number) {
  const pos = new Float32Array(count * 3);
  const speed = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const a = rnd() * Math.PI * 2, r = Math.sqrt(rnd()) * radius;
    pos.set([Math.cos(a) * r, rnd() * height, Math.sin(a) * r], i * 3);
    speed[i] = 0.15 + rnd() * 0.45;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  glowTex ??= glowSprite(0xffffff, 1).material.map!;
  const pts = new THREE.Points(
    geo,
    new THREE.PointsMaterial({ map: glowTex, color, size, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true }),
  );
  pts.frustumCulled = false;
  return {
    points: pts,
    update(dt: number) {
      for (let i = 0; i < count; i++) {
        pos[i * 3 + 1] += speed[i] * dt;
        if (pos[i * 3 + 1] > height) pos[i * 3 + 1] = 0;
      }
      geo.attributes.position.needsUpdate = true;
    },
  };
}
