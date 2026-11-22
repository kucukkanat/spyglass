import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import type { ARObject } from "../ar/engine";
import { glowSprite, gold, iron, rnd, shadowed, sparkles, woodTexture } from "./shared";

/** Open treasure chest, ~0.95 m wide, brimming with coins. */
export function createChest(): ARObject {
  const root = new THREE.Group();
  const W = 0.95, D = 0.58, H = 0.42, R = D / 2;
  const wood = new THREE.MeshStandardMaterial({ map: woodTexture(), roughness: 0.78, metalness: 0.05 });
  const goldM = gold(), ironM = iron();
  const solid = new THREE.Group();

  const body = new THREE.Mesh(new RoundedBoxGeometry(W, H, D, 3, 0.025), wood);
  body.position.y = H / 2;
  solid.add(body);
  const inside = new THREE.Mesh(new THREE.BoxGeometry(W - 0.08, 0.02, D - 0.08), new THREE.MeshStandardMaterial({ color: 0x1a0f08, roughness: 1 }));
  inside.position.y = H - 0.05;
  solid.add(inside);

  // Lid: half cylinder hinged on the back edge.
  const lid = new THREE.Group();
  lid.position.set(0, H, -R);
  const lidGeo = new THREE.CylinderGeometry(R, R, W, 28, 1, false, 0, Math.PI);
  lidGeo.rotateZ(Math.PI / 2); // axis along x
  lidGeo.rotateX(-Math.PI / 2); // dome up
  const lidWood = wood.clone();
  lidWood.side = THREE.DoubleSide;
  const dome = new THREE.Mesh(lidGeo, lidWood);
  dome.position.z = R;
  lid.add(dome);
  for (const x of [-W / 2 + 0.07, 0, W / 2 - 0.07]) {
    const band = new THREE.Mesh(new RoundedBoxGeometry(0.07, H + 0.012, D + 0.02, 2, 0.008), goldM);
    band.position.set(x, H / 2, 0);
    solid.add(band);
    const arcGeo = new THREE.CylinderGeometry(R + 0.012, R + 0.012, 0.07, 28, 1, true, 0, Math.PI);
    arcGeo.rotateZ(Math.PI / 2);
    arcGeo.rotateX(-Math.PI / 2);
    const gm = goldM.clone();
    gm.side = THREE.DoubleSide;
    const arc = new THREE.Mesh(arcGeo, gm);
    arc.position.set(x, 0, R);
    lid.add(arc);
  }
  lid.rotation.x = -1.05;
  solid.add(lid);

  const rim = new THREE.Mesh(new RoundedBoxGeometry(W + 0.02, 0.05, D + 0.02, 2, 0.01), ironM);
  rim.position.y = H - 0.025;
  solid.add(rim);
  const lock = new THREE.Mesh(new RoundedBoxGeometry(0.13, 0.16, 0.04, 2, 0.012), goldM);
  lock.position.set(0, H - 0.1, D / 2 + 0.02);
  solid.add(lock);
  for (const sx of [-1, 1]) {
    const handle = new THREE.Mesh(new THREE.TorusGeometry(0.07, 0.014, 8, 20, Math.PI), ironM);
    handle.position.set(sx * (W / 2 + 0.012), H * 0.55, 0);
    handle.rotation.set(Math.PI, Math.PI / 2, 0);
    solid.add(handle);
  }

  // Coin mound.
  const mound = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), goldM);
  mound.scale.set(W / 2 - 0.07, 0.13, D / 2 - 0.07);
  mound.position.y = H - 0.05;
  solid.add(mound);
  const N = 150;
  const coins = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.032, 0.032, 0.007, 14), goldM, N);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), p = new THREE.Vector3(), s = new THREE.Vector3(1, 1, 1);
  for (let i = 0; i < N; i++) {
    const spill = i > N - 16;
    const a = rnd() * Math.PI * 2, r = Math.sqrt(rnd());
    if (spill) p.set((rnd() - 0.5) * 1.5, 0.006, D / 2 + 0.08 + rnd() * 0.4);
    else {
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      p.set(x * (W / 2 - 0.09), H - 0.05 + 0.135 * Math.sqrt(Math.max(0, 1 - r * r)) + rnd() * 0.012, z * (D / 2 - 0.09));
    }
    e.set(spill ? 0 : (rnd() - 0.5) * 1.1, rnd() * 6, spill ? 0 : (rnd() - 0.5) * 1.1);
    m.compose(p, q.setFromEuler(e), s);
    coins.setMatrixAt(i, m);
  }
  solid.add(coins);
  // A few gems.
  for (const [x, z, col] of [[-0.2, 0.05, 0xff3355], [0.18, -0.06, 0x33d6ff], [0.02, 0.12, 0x5dff8a]] as const) {
    const gem = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.045),
      new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 0.6, metalness: 0.3, roughness: 0.08, flatShading: true }),
    );
    gem.position.set(x, H + 0.07, z);
    gem.rotation.set(rnd(), rnd(), rnd());
    solid.add(gem);
  }
  root.add(shadowed(solid));

  const glow = glowSprite(0xffb640, 1.5, 0.55);
  glow.position.set(0, H + 0.2, 0);
  const light = new THREE.PointLight(0xffb040, 2.2, 3.5, 2);
  light.position.set(0, H + 0.25, 0);
  const sp = sparkles(36, 0.4, 1.3, 0xffe29a, 0.07);
  sp.points.position.y = H;
  root.add(glow, light, sp.points);

  return {
    root,
    footprint: 0.62,
    update(t, dt) {
      sp.update(dt);
      lid.rotation.x = -1.05 + Math.sin(t * 1.3) * 0.04;
      glow.material.opacity = 0.5 + Math.sin(t * 2.4) * 0.12;
      light.intensity = 2.2 + Math.sin(t * 2.4) * 0.5;
    },
  };
}
