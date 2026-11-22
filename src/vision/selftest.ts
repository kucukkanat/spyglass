// Synthetic end-to-end check of the visual-anchor maths: render a textured room from known
// camera poses, build an anchor, then find the object again from a new viewpoint in a
// "different session" (the tracker frame is rotated, shifted). Not shipped in the app.
import * as THREE from "three";
import { intrinsics, packFromBase64, packToBase64, Vision, type Frame, type Keyframe } from "./anchors";

const W = 384, H = 640;
const log = (s: string) => ((document.getElementById("o")!.textContent += s + "\n"), console.log(s));

function texture(seed: number) {
  const c = document.createElement("canvas");
  c.width = c.height = 512;
  const g = c.getContext("2d")!;
  let r = seed;
  const rnd = () => ((r = (r * 16807) % 2147483647) - 1) / 2147483646;
  g.fillStyle = `hsl(${rnd() * 360},25%,55%)`;
  g.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 260; i++) {
    g.fillStyle = `hsl(${rnd() * 360},${30 + rnd() * 50}%,${15 + rnd() * 70}%)`;
    const x = rnd() * 512, y = rnd() * 512, s = 6 + rnd() * 34;
    if (rnd() > 0.5) g.fillRect(x, y, s, s * (0.4 + rnd()));
    else (g.beginPath(), g.moveTo(x, y), g.lineTo(x + s, y + s * rnd()), g.lineTo(x + s * rnd(), y + s), g.fill());
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

async function main() {
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(W, H, false);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x8899aa);
  const mat = (i: number) => new THREE.MeshBasicMaterial({ map: texture(i) });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(8, 8), mat(11));
  floor.rotation.x = -Math.PI / 2;
  const wall = new THREE.Mesh(new THREE.PlaneGeometry(8, 3), mat(23));
  wall.position.set(0, 1.5, -4);
  const box = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.7, 0.6), mat(37));
  box.position.set(0.9, 0.35, -2.6);
  const box2 = new THREE.Mesh(new THREE.BoxGeometry(0.5, 1.1, 0.5), mat(51));
  box2.position.set(-1.1, 0.55, -3.1);
  scene.add(floor, wall, box, box2);
  const cam = new THREE.PerspectiveCamera(60, W / H, 0.05, 50);
  cam.updateProjectionMatrix();
  const K = intrinsics(cam.projectionMatrix.elements, W, H);

  // The object sits on the floor in front of the wall.
  const objPos = new THREE.Vector3(0.1, 0, -2.4), objYaw = 0.5;

  // "Session" = how the tracker's local frame relates to the true world.
  const session = (yaw: number, t: THREE.Vector3) => {
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    return { q, t, yaw, toLocal: (p: THREE.Vector3) => p.clone().applyQuaternion(q).add(t) };
  };
  const gl = renderer.getContext();
  const shoot = (eye: THREE.Vector3, target: THREE.Vector3, s: ReturnType<typeof session>): Frame => {
    cam.position.copy(eye);
    cam.lookAt(target);
    cam.updateMatrixWorld();
    renderer.render(scene, cam);
    const px = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const gray = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const j = ((H - 1 - y) * W + x) * 4;
      gray[y * W + x] = (77 * px[j] + 150 * px[j + 1] + 29 * px[j + 2]) >> 8;
    }
    return { gray, w: W, h: H, ...K, pos: s.toLocal(eye), quat: s.q.clone().multiply(cam.quaternion) };
  };

  const t0 = performance.now();
  const vision = await Vision.load("../external/opencv.js");
  log(`opencv loaded in ${(performance.now() - t0).toFixed(0)} ms`);

  // Placing session: a few frames as the player naturally moves while aiming.
  const s1 = session(0.7, new THREE.Vector3(3, 0, -1));
  const look = new THREE.Vector3(0.1, 0.5, -2.8);
  const eyes = [[0, 1.45, 0.4], [0.18, 1.47, 0.36], [0.35, 1.5, 0.3], [-0.2, 1.42, 0.45], [0.1, 1.3, 0.15]].map((e) => new THREE.Vector3(...(e as [number, number, number])));
  const kfs: Keyframe[] = eyes.map((e) => {
    const f = shoot(e, look, s1);
    return { ...f, f: vision.features(f) };
  });
  const t1 = performance.now();
  const built = vision.buildPack(kfs, s1.toLocal(objPos), objYaw + s1.yaw);
  const b64 = packToBase64(built);
  const pack = packFromBase64(b64)!;
  log(`features/frame ${kfs.map((k) => k.f.n).join(",")} | pack ${pack.n} points, ${(b64.length / 1024).toFixed(0)} KB base64, built in ${(performance.now() - t1).toFixed(0)} ms`);

  // Check the triangulated points against the true geometry: every point should lie on a surface.
  let onSurface = 0;
  const inv = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), objYaw);
  const ray = new THREE.Raycaster();
  for (let i = 0; i < pack.n; i++) {
    const world = new THREE.Vector3(pack.pts[3 * i], pack.pts[3 * i + 1], pack.pts[3 * i + 2]).applyQuaternion(inv).add(objPos);
    const dir = world.clone().sub(eyes[0]).normalize();
    ray.set(eyes[0], dir);
    const hit = ray.intersectObjects(scene.children)[0];
    if (hit && Math.abs(hit.distance - world.distanceTo(eyes[0])) < 0.06) onSurface++;
  }
  log(`points within 6 cm of the true surface: ${onSurface}/${pack.n}`);

  // Finding sessions: different tracker frames and viewpoints.
  const cases: [string, THREE.Vector3, number, THREE.Vector3][] = [
    ["same spot, new session", new THREE.Vector3(0.1, 1.45, 0.35), -2.1, new THREE.Vector3(-7, 0, 4)],
    ["1 m to the right", new THREE.Vector3(1.1, 1.5, 0.2), 1.3, new THREE.Vector3(2, 0, 9)],
    ["1.2 m left, closer", new THREE.Vector3(-1.1, 1.4, -0.5), 0.2, new THREE.Vector3(0, 0, 0)],
    ["further back, lower", new THREE.Vector3(0.3, 1.1, 1.4), 2.9, new THREE.Vector3(5, 0, 5)],
    ["facing away (should fail)", new THREE.Vector3(0, 1.45, 0.4), 0.4, new THREE.Vector3(1, 0, 1)],
  ];
  for (const [name, eye, yaw, t] of cases) {
    const s = session(yaw, t);
    const target = name.startsWith("facing away") ? new THREE.Vector3(0, 1.2, 5) : look;
    const fr = shoot(eye, target, s);
    const tt = performance.now();
    const f = vision.features(fr);
    const r = vision.resolve(pack, fr, f);
    const ms = (performance.now() - tt).toFixed(0);
    if (!r) { log(`${name}: not found (${f.n} features, ${ms} ms)`); continue; }
    const want = s.toLocal(objPos);
    const dyaw = Math.atan2(Math.sin(r.yaw - (objYaw + s.yaw)), Math.cos(r.yaw - (objYaw + s.yaw)));
    log(`${name}: position error ${(r.pos.distanceTo(want) * 100).toFixed(1)} cm, yaw error ${((dyaw * 180) / Math.PI).toFixed(2)} deg, ${r.inliers}/${r.matches} inliers, ${ms} ms`);
  }
  log("done");
}
main().catch((e) => log("ERROR " + (e?.stack ?? e)));
