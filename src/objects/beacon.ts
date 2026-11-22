import * as THREE from "three";
import type { ARObject } from "../ar/engine";
import { glowSprite, gold, rnd, shadowed, sparkles } from "./shared";

/** Wayfinder: a floating crystal over a stone plinth with orbiting astrolabe rings. */
export function createBeacon(): ARObject {
  const root = new THREE.Group();
  const stone = new THREE.MeshStandardMaterial({ color: 0x77736c, roughness: 0.95, metalness: 0, flatShading: true });
  const solid = new THREE.Group();
  const tiers: [number, number, number][] = [[0.46, 0.14, 0.07], [0.36, 0.16, 0.22], [0.25, 0.42, 0.51]];
  for (const [r, h, y] of tiers) {
    const g = new THREE.CylinderGeometry(r * 0.9, r, h, 8, 2);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) p.setXYZ(i, p.getX(i) + (rnd() - 0.5) * 0.02, p.getY(i), p.getZ(i) + (rnd() - 0.5) * 0.02);
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, stone);
    m.position.y = y;
    m.rotation.y = rnd() * 3;
    solid.add(m);
  }
  const bowl = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.035, 10, 32), gold());
  bowl.rotation.x = Math.PI / 2;
  bowl.position.y = 0.74;
  solid.add(bowl);
  root.add(shadowed(solid));

  const float = new THREE.Group();
  float.position.y = 1.35;
  const crystalM = new THREE.MeshPhysicalMaterial({
    color: 0x7af0ff, emissive: 0x16b5e0, emissiveIntensity: 1.1, metalness: 0.15, roughness: 0.04,
    clearcoat: 1, transparent: true, opacity: 0.93, flatShading: true,
  });
  const crystal = new THREE.Mesh(new THREE.OctahedronGeometry(0.24), crystalM);
  crystal.scale.y = 1.75;
  crystal.castShadow = true;
  const core = glowSprite(0x9ff6ff, 1.5, 0.75);
  const shards: THREE.Mesh[] = [];
  for (let i = 0; i < 5; i++) {
    const s = new THREE.Mesh(new THREE.OctahedronGeometry(0.05), crystalM);
    s.scale.y = 1.8;
    s.castShadow = true;
    shards.push(s);
    float.add(s);
  }
  const rings: THREE.Mesh[] = [];
  for (const [r, tube] of [[0.52, 0.014], [0.62, 0.012], [0.72, 0.01]] as const) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(r, tube, 8, 72), gold());
    ring.castShadow = true;
    for (let i = 0; i < 4; i++) {
      const stud = new THREE.Mesh(new THREE.SphereGeometry(tube * 2.4, 8, 6), ring.material);
      stud.position.set(Math.cos((i * Math.PI) / 2) * r, Math.sin((i * Math.PI) / 2) * r, 0);
      ring.add(stud);
    }
    rings.push(ring);
    float.add(ring);
  }
  float.add(crystal, core);
  root.add(float);

  // light pillar
  const c = document.createElement("canvas");
  c.width = 4; c.height = 128;
  const g = c.getContext("2d")!;
  const grad = g.createLinearGradient(0, 128, 0, 0);
  grad.addColorStop(0, "rgba(255,255,255,0.85)");
  grad.addColorStop(0.35, "rgba(255,255,255,0.3)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 4, 128);
  const beamTex = new THREE.CanvasTexture(c);
  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(0.1, 0.16, 9, 20, 1, true),
    new THREE.MeshBasicMaterial({ map: beamTex, color: 0x66e8ff, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
  );
  beam.position.y = 1.35 + 4.5;
  const sp = sparkles(50, 0.55, 2.6, 0x9ff6ff, 0.06);
  sp.points.position.y = 0.6;
  root.add(beam, sp.points);

  return {
    root,
    footprint: 0.6,
    update(t, dt) {
      sp.update(dt);
      float.position.y = 1.35 + Math.sin(t * 1.1) * 0.06;
      crystal.rotation.y = t * 0.6;
      rings[0].rotation.set(t * 0.7, t * 0.4, 0);
      rings[1].rotation.set(Math.PI / 2 + t * 0.3, t * -0.6, 0.4);
      rings[2].rotation.set(0.6, t * 0.25, t * -0.5);
      shards.forEach((s, i) => {
        const a = t * 0.8 + (i * Math.PI * 2) / 5;
        s.position.set(Math.cos(a) * 0.4, Math.sin(t * 1.3 + i) * 0.16, Math.sin(a) * 0.4);
        s.rotation.y = a * 2;
      });
      const pulse = 0.5 + 0.5 * Math.sin(t * 2.1);
      crystalM.emissiveIntensity = 0.9 + pulse * 0.6;
      core.material.opacity = 0.55 + pulse * 0.3;
      (beam.material as THREE.MeshBasicMaterial).opacity = 0.35 + pulse * 0.2;
    },
  };
}
