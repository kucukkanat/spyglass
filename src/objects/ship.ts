import * as THREE from "three";
import type { ARObject } from "../ar/engine";
import { glowSprite, gold, shadowed, woodTexture } from "./shared";

function hullGeometry(L: number, B: number, Dp: number) {
  const NS = 28, NC = 14;
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  const beam = (t: number) => (t < 0.35 ? B * (0.62 + 0.38 * THREE.MathUtils.smoothstep(t, 0, 0.35)) : B * Math.pow(Math.cos(((t - 0.35) / 0.65) * Math.PI * 0.5), 0.75));
  const sheer = (t: number) => 0.55 * L * 0.16 * Math.pow(2 * t - 1, 2) + (t < 0.25 ? (0.25 - t) * 0.5 : 0);
  for (let i = 0; i <= NS; i++) {
    const t = i / NS, x = (t - 0.5) * L, b = Math.max(beam(t), 0.004), top = sheer(t), d = Dp * (0.7 + 0.3 * Math.sin(Math.PI * Math.min(1, t * 1.15)));
    for (let j = 0; j <= NC; j++) {
      const phi = (j / NC - 0.5) * Math.PI;
      const sn = Math.sin(phi);
      pos.push(x, top - d * Math.pow(Math.cos(phi), 0.85), b * Math.sign(sn) * Math.pow(Math.abs(sn), 0.72));
      uv.push(t * 3, j / NC);
    }
  }
  const row = NC + 1;
  for (let i = 0; i < NS; i++)
    for (let j = 0; j < NC; j++) {
      const a = i * row + j, b = a + 1, c = a + row, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  // transom cap + deck
  const base = pos.length / 3;
  for (let i = 0; i <= NS; i++) {
    const t = i / NS, x = (t - 0.5) * L, b = Math.max(beam(t), 0.004) * 0.97, y = sheer(t) - 0.035;
    pos.push(x, y, -b, x, y, b);
    uv.push(t * 3, 0, t * 3, 1);
    if (i < NS) {
      const a = base + i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  for (let j = 1; j < NC; j++) idx.push(0, j, j + 1);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return { geo: g, sheer };
}

function sail(w: number, h: number, bulge: number, mat: THREE.Material) {
  const g = new THREE.PlaneGeometry(w, h, 10, 10);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const u = p.getX(i) / w + 0.5, v = p.getY(i) / h + 0.5;
    p.setZ(i, Math.sin(Math.PI * u) * Math.sin(Math.PI * (0.15 + 0.85 * v)) * bulge);
    p.setX(i, p.getX(i) * (0.82 + 0.18 * (1 - v))); // slightly narrower at the top
  }
  g.computeVertexNormals();
  g.rotateY(Math.PI / 2); // face along the hull (+x = bow)
  return new THREE.Mesh(g, mat);
}

/** Ghost galleon, ~2.6 m long, hovering and bobbing above the ground. */
export function createShip(): ARObject {
  const root = new THREE.Group();
  const ship = new THREE.Group();
  const L = 2.6, B = 0.42, Dp = 0.5;
  const wood = new THREE.MeshStandardMaterial({ map: woodTexture("#5b3a20", "#2a180c", 7), roughness: 0.7, metalness: 0.05, side: THREE.DoubleSide });
  const dark = new THREE.MeshStandardMaterial({ color: 0x2c1b10, roughness: 0.8 });
  const goldM = gold();
  const sailM = new THREE.MeshStandardMaterial({ color: 0xf1e6cf, roughness: 0.9, side: THREE.DoubleSide, emissive: 0x3d5f66, emissiveIntensity: 0.35 });

  const { geo, sheer } = hullGeometry(L, B, Dp);
  ship.add(new THREE.Mesh(geo, wood));
  // gunwale trim
  const trimPts: THREE.Vector3[] = [];
  for (let i = 0; i <= 28; i++) {
    const t = i / 28;
    const b = t < 0.35 ? B * (0.62 + 0.38 * THREE.MathUtils.smoothstep(t, 0, 0.35)) : B * Math.pow(Math.cos(((t - 0.35) / 0.65) * Math.PI * 0.5), 0.75);
    trimPts.push(new THREE.Vector3((t - 0.5) * L, sheer(t), b));
  }
  for (const sz of [1, -1]) {
    const tube = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(trimPts.map((p) => new THREE.Vector3(p.x, p.y, p.z * sz))), 40, 0.022, 6), goldM);
    ship.add(tube);
  }
  // stern cabin + lanterns
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.26, 0.5), wood);
  cabin.position.set(-L / 2 + 0.33, sheer(0.1) + 0.08, 0);
  ship.add(cabin);
  const lanterns: THREE.Sprite[] = [];
  for (const sz of [-1, 1]) {
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.045, 12, 8), new THREE.MeshStandardMaterial({ color: 0x9ffff0, emissive: 0x58ffe0, emissiveIntensity: 3 }));
    lamp.position.set(-L / 2 + 0.06, sheer(0) + 0.28, sz * 0.2);
    const g = glowSprite(0x58ffe0, 0.5, 0.8);
    g.position.copy(lamp.position);
    lanterns.push(g);
    ship.add(lamp, g);
  }
  // masts, yards, sails
  const masts: [number, number][] = [[-0.25, 1.75], [0.55, 1.45]];
  for (const [x, h] of masts) {
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.034, h, 10), dark);
    mast.position.set(x, h / 2 - 0.1, 0);
    ship.add(mast);
    const specs: [number, number, number][] = [[0.42 * h, 1.0, 0.5 * h], [0.84 * h, 0.72, 0.3 * h]];
    for (const [y, w, sh] of specs) {
      const yard = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, w * 1.08, 8), dark);
      yard.rotation.x = Math.PI / 2;
      yard.position.set(x + 0.03, y + sh / 2 - 0.1, 0);
      const s = sail(w, sh, 0.16, sailM);
      s.position.set(x + 0.03, y - 0.1, 0);
      ship.add(yard, s);
    }
    const flag = new THREE.Mesh(new THREE.PlaneGeometry(0.26, 0.14, 6, 1), new THREE.MeshStandardMaterial({ color: 0x15171c, side: THREE.DoubleSide, roughness: 0.9 }));
    flag.position.set(x - 0.14, h - 0.12, 0);
    flag.userData.flag = true;
    ship.add(flag);
  }
  const bowsprit = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.022, 0.75, 8), dark);
  bowsprit.rotation.z = -Math.PI / 2 + 0.28;
  bowsprit.position.set(L / 2 + 0.2, sheer(1) + 0.08, 0);
  ship.add(bowsprit);
  const jibGeo = new THREE.BufferGeometry();
  jibGeo.setAttribute("position", new THREE.Float32BufferAttribute([L / 2 + 0.52, sheer(1) + 0.18, 0, 0.6, 1.2, 0, 0.66, sheer(0.75) + 0.12, 0], 3));
  jibGeo.computeVertexNormals();
  ship.add(new THREE.Mesh(jibGeo, sailM));

  shadowed(ship);
  ship.position.y = 1.15;
  root.add(ship);

  // spectral wake under the hull
  const wake = glowSprite(0x4fffe0, 3.2, 0.3);
  wake.position.y = 0.55;
  wake.scale.set(3.4, 0.9, 1);
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.95, 1.0, 64),
    new THREE.MeshBasicMaterial({ color: 0x58ffe0, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.02;
  root.add(wake, ring);

  const flags = ship.children.filter((c) => c.userData.flag) as THREE.Mesh[];
  return {
    root,
    footprint: 1.25,
    update(t) {
      ship.position.y = 1.15 + Math.sin(t * 0.9) * 0.07;
      ship.rotation.z = Math.sin(t * 0.7) * 0.05;
      ship.rotation.x = Math.sin(t * 0.55 + 1) * 0.035;
      const k = (t * 0.35) % 1;
      ring.scale.setScalar(0.6 + k * 0.9);
      (ring.material as THREE.MeshBasicMaterial).opacity = 0.55 * (1 - k);
      wake.material.opacity = 0.26 + Math.sin(t * 1.7) * 0.06;
      for (const l of lanterns) l.material.opacity = 0.7 + Math.sin(t * 5 + l.position.z * 9) * 0.15;
      for (const f of flags) {
        const p = f.geometry.attributes.position;
        for (let i = 0; i < p.count; i++) p.setZ(i, Math.sin(p.getX(i) * 22 + t * 7) * 0.02 * (0.5 - p.getX(i) / 0.26));
        p.needsUpdate = true;
      }
    },
  };
}
