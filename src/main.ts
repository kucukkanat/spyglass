import { AREngine, type Anchor } from "./ar/engine";
import { DemoTrackingProvider } from "./ar/demo-provider";
import { SensorTrackingProvider } from "./ar/sensor-provider";
import { VioTrackingProvider, openVioCamera } from "./ar/vio-provider";
import type { ProviderConfig, TrackingProvider, WalkMode } from "./ar/types";
import { createBeacon } from "./objects/beacon";
import { createChest } from "./objects/chest";
import { createShip } from "./objects/ship";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const STORE = "spyglass.anchors.v1";
const PREFS = "spyglass.prefs.v1";

const prefs = { fov: 63, trim: 0, eye: 1.5, walk: "steps+gps" as WalkMode, vio: true, sharp: false, points: true, ...load(PREFS) };
const cfg: ProviderConfig = { eyeHeight: prefs.eye, declination: 2.5, headingTrim: prefs.trim, stepLength: 0.7, walkMode: prefs.walk };

function load(key: string): any {
  try { return JSON.parse(localStorage.getItem(key) || "null") || {}; } catch { return {}; }
}
function save(key: string, v: unknown) {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch {}
}

let engine: AREngine;
let provider: SensorTrackingProvider | DemoTrackingProvider | VioTrackingProvider;
let selected = 0;
let placing = false;
let placedOnce = false;

const LAYOUT = [
  { id: "chest", name: "Captain's Hoard", icon: "chest", dist: 3.5, bearing: 0, make: createChest },
  { id: "ship", name: "The Pale Wanderer", icon: "ship", dist: 9, bearing: 42, turn: -38, make: createShip },
  { id: "beacon", name: "Wayfinder Stone", icon: "beacon", dist: 6, bearing: -48, make: createBeacon },
];

const ICONS: Record<string, string> = {
  chest: '<path d="M4 11h16v8H4zM4 11a8 5 0 0 1 16 0M12 11v3"/><circle cx="12" cy="15" r="1.2"/>',
  ship: '<path d="M3 16h18l-3 4H6zM12 3v13M12 4l6 9h-6M12 6l-5 7h5"/>',
  beacon: '<path d="M12 2l4 7-4 7-4-7zM6 21h12M9 21l1-3h4l1 3"/>',
};

function toast(msg: string, ms = 3200) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("on");
  clearTimeout((toast as any).h);
  (toast as any).h = setTimeout(() => t.classList.remove("on"), ms);
}

async function startCamera(video: HTMLVideoElement) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 60 } },
  });
  video.srcObject = stream;
  await video.play();
}

async function begin(forceDemo: boolean) {
  const video = $<HTMLVideoElement>("video");
  let demo = forceDemo;
  let granted = false;
  if (!demo) {
    // Sensor permission must be requested first, inside the tap.
    granted = await SensorTrackingProvider.requestPermissions();
    try {
      if (prefs.vio) await openVioCamera(video, prefs.sharp);
      else await startCamera(video);
    } catch {
      demo = true;
      toast("Camera unavailable: showing the preview scene instead.", 5000);
    }
  }
  if (!demo && granted) {
    const sp = new SensorTrackingProvider(cfg);
    await sp.start();
    // Desktop browsers expose the API but never fire events.
    await new Promise((r) => setTimeout(r, 900));
    if (!sp.live) sp.stop();
    else if (prefs.vio) {
      // The compass tracker keeps running underneath: it seeds the heading and covers gaps.
      sp.cfg = Object.assign(Object.create(cfg), { walkMode: "locked" });
      const vio = new VioTrackingProvider(cfg, video, sp);
      provider = vio;
      vio.start().catch((err) => {
        vio.stop();
        sp.cfg = cfg;
        engine.provider = provider = sp;
        toast(`Visual tracking unavailable (${err?.message ?? err}). Using compass tracking.`, 7000);
      });
    } else provider = sp;
  }
  if (!provider) {
    provider = new DemoTrackingProvider(cfg, $("gl"));
    await provider.start();
    if (!demo) toast("No motion sensors: drag to look around.", 5000);
  }
  document.body.classList.toggle("demo", demo);

  const fov = provider instanceof VioTrackingProvider ? provider.cameraFov : prefs.fov;
  engine = new AREngine({ canvas: $<HTMLCanvasElement>("gl"), video: demo ? null : video, provider, cameraFov: fov });
  engine.showLandmarks = prefs.points;
  if (provider instanceof VioTrackingProvider) {
    $<HTMLInputElement>("fov").value = String(Math.round(fov * 2) / 2);
    $("fov-v").textContent = `${fov.toFixed(1)}° (calibrated)`;
  }
  video.addEventListener("resize", () => engine.resize());
  for (const o of LAYOUT) engine.addAnchor(o.id, o.name, o.make());
  buildCards();
  engine.onFrame = hud;
  engine.start();
  $("start").classList.add("gone");
  $("hud").classList.add("on");

  if (provider instanceof DemoTrackingProvider) placeAround();
  else {
    if (!(provider instanceof VioTrackingProvider)) toast("Hold the phone upright and look around slowly while the compass settles…", 4000);
    const wait = setInterval(() => {
      const ready = provider instanceof VioTrackingProvider ? provider.settled && provider.state.dof === 6 : provider.state.quality !== "none";
      if (ready && !placedOnce) {
        clearInterval(wait);
        setTimeout(() => {
          placeAround();
          toast("Three anchors dropped. Walk around them.");
        }, provider instanceof VioTrackingProvider ? 600 : 1800);
      }
    }, 200);
  }
}

function placeAround() {
  const st = provider.state;
  provider.recenter();
  // Visual tracking is usually tried at room scale first, so keep the objects close.
  const k = provider instanceof VioTrackingProvider ? 0.5 : 1;
  for (const [i, o] of LAYOUT.entries()) {
    const b = ((st.heading + o.bearing) * Math.PI) / 180;
    engine.anchors[i].place(st.position.x + Math.sin(b) * o.dist * k, -st.position.z + Math.cos(b) * o.dist * k, st.heading + o.bearing + ((o as any).turn ?? 0));
  }
  placedOnce = true;
  persist();
}

function persist() {
  const out = engine.anchors.map((a) => ({ id: a.id, yaw: a.yaw, y: a.group.position.y, scale: a.userScale, ...(engine.geoOf(a) ?? {}) }));
  if (out.every((o: any) => typeof o.lat === "number")) save(STORE, out);
}

function restore() {
  const saved = load(STORE);
  if (!Array.isArray(saved)) return toast("No saved anchors on this device yet.");
  if (!provider.state.geoOrigin) return toast("Waiting for a GPS fix first…");
  for (const s of saved) {
    const a = engine.anchors.find((x) => x.id === s.id);
    if (a) engine.placeGeo(a, s, s.yaw, s.y ?? 0), a.setScale(s.scale ?? 1);
  }
  placedOnce = true;
  toast("Anchors restored from saved coordinates (GPS-accurate, not centimetre-accurate).", 4500);
}

function buildCards() {
  $("cards").innerHTML = LAYOUT.map(
    (o, i) => `<button class="card" data-i="${i}">
      <svg viewBox="0 0 24 24" class="ico">${ICONS[o.icon]}</svg>
      <span class="nm">${o.name}</span>
      <span class="meta"><svg viewBox="0 0 24 24" class="arrow"><path d="M12 3l6 16-6-4-6 4z"/></svg><b>–</b></span>
    </button>`,
  ).join("");
  document.querySelectorAll<HTMLElement>(".card").forEach((c) =>
    c.addEventListener("click", () => {
      selected = +c.dataset.i!;
      syncCards();
    }),
  );
  syncCards();
}
function syncAdjust() {
  const a = engine?.anchors[selected];
  if (a) $("size-v").textContent = `${Math.round(a.userScale * 100)}%`;
}
function syncCards() {
  syncAdjust();
  document.querySelectorAll(".card").forEach((c, i) => c.classList.toggle("sel", i === selected));
  $("move").textContent = placing ? "Drop it here" : `Move ${LAYOUT[selected].name}`;
  $("cancel").hidden = !placing;
}

let lastText = 0;
function hud(t: number) {
  const st = provider.state;
  drawCompass(st.heading, engine.anchors);
  const cards = document.querySelectorAll<HTMLElement>(".card");
  engine.anchors.forEach((a: Anchor, i) => {
    const el = cards[i];
    if (!el || !a.group.visible) return;
    (el.querySelector(".arrow") as HTMLElement).style.transform = `rotate(${a.bearing.toFixed(0)}deg)`;
  });
  if (t - lastText < 0.25) return;
  lastText = t;
  engine.anchors.forEach((a, i) => {
    const b = cards[i]?.querySelector("b");
    if (b) b.textContent = a.group.visible ? `${a.distance < 10 ? a.distance.toFixed(1) : a.distance.toFixed(0)} m` : "–";
  });
  const q = $("q");
  q.dataset.q = st.quality;
  q.textContent = (provider as TrackingProvider).statusText ?? (provider instanceof DemoTrackingProvider ? "Preview mode" : st.quality === "good" ? "Compass locked" : st.quality === "limited" ? "Compass settling" : "No sensors");
  const coach = (provider as TrackingProvider).coach ?? null;
  $("coach").textContent = coach ?? "";
  $("coach").classList.toggle("on", !!coach);
  $("gps").textContent = st.gpsAccuracy === null ? "GPS –" : `GPS ±${st.gpsAccuracy.toFixed(0)} m`;
  $("gps").dataset.q = st.gpsAccuracy === null ? "none" : st.gpsAccuracy <= 8 ? "good" : "limited";
  if (!$("sheet").hidden) {
    const sel = engine.anchors[selected];
    const g = engine.geoOf(sel);
    $("debug").textContent = [
      `tracker   ${provider.name}`,
      ...(provider instanceof VioTrackingProvider
        ? [
            `vio       ${provider.status} · ${provider.info.fps.toFixed(0)} Hz · ${provider.info.ms.toFixed(0)} ms · ${provider.info.points} pts · ${provider.info.resets} resets`,
            `          ${provider.info.frame} · ${provider.info.threads} thread(s) · ${provider.info.gpu ? "GPU points" : "CPU points"} · sync ${provider.info.timeOffsetMs} ms`,
            `          ${st.dof}DoF · floor ${provider.info.floor ? "found" : "assumed from phone height"} · scale x${provider.info.scale.toFixed(2)}`,
            `map       ${provider.info.mapPoints} points · surfaces at ${provider.info.layers || "none yet"} m`,
          ]
        : []),
      `render    ${engine.fps.toFixed(0)} fps · fov ${engine.camera.fov.toFixed(1)}° vertical`,
      `heading   ${st.heading.toFixed(1)}°  ±${st.headingAccuracy?.toFixed(0) ?? "?"}°`,
      `position  E ${st.position.x.toFixed(2)}  N ${(-st.position.z).toFixed(2)}  up ${st.position.y.toFixed(2)} m`,
      `sun       az ${engine.sun.azimuth.toFixed(0)}° alt ${engine.sun.altitude.toFixed(0)}°${engine.sun.real ? "" : " (default, sun is down)"}`,
      `anchor    ${g ? `${g.lat.toFixed(7)}, ${g.lon.toFixed(7)}` : "no GPS fix yet"}`,
    ].join("\n");
  }
}

const cv = $<HTMLCanvasElement>("compass");
const cx = cv.getContext("2d")!;
function drawCompass(heading: number, anchors: Anchor[]) {
  const dpr = Math.min(devicePixelRatio, 2);
  const w = cv.clientWidth, h = cv.clientHeight;
  if (cv.width !== w * dpr) { cv.width = w * dpr; cv.height = h * dpr; }
  cx.setTransform(dpr, 0, 0, dpr, 0, 0);
  cx.clearRect(0, 0, w, h);
  const span = 110, ppd = w / span;
  cx.textAlign = "center";
  const first = Math.ceil((heading - span / 2) / 5) * 5;
  for (let d = first; d <= heading + span / 2; d += 5) {
    const x = w / 2 + (d - heading) * ppd;
    const n = ((d % 360) + 360) % 360;
    const edge = Math.min(1, (1 - Math.abs(x - w / 2) / (w / 2)) * 3);
    const major = n % 45 === 0;
    cx.globalAlpha = edge * (major ? 1 : n % 15 === 0 ? 0.7 : 0.35);
    cx.fillStyle = n === 0 ? "#ff6b57" : "#f4e7c5";
    cx.fillRect(x - 0.75, h - (major ? 16 : n % 15 === 0 ? 11 : 6), 1.5, major ? 16 : n % 15 === 0 ? 11 : 6);
    if (major) {
      cx.font = `600 ${n % 90 === 0 ? 15 : 11}px ui-serif, Georgia, serif`;
      cx.fillText(["N", "NE", "E", "SE", "S", "SW", "W", "NW"][n / 45], x, 15);
    }
  }
  anchors.forEach((a, i) => {
    if (!a.group.visible) return;
    const x = w / 2 + Math.max(-span / 2 + 3, Math.min(span / 2 - 3, a.bearing)) * ppd;
    cx.globalAlpha = 1;
    cx.fillStyle = i === selected ? "#ffd36b" : "#7fe9ff";
    cx.beginPath();
    cx.moveTo(x, h - 20); cx.lineTo(x + 5, h - 27); cx.lineTo(x, h - 34); cx.lineTo(x - 5, h - 27);
    cx.fill();
  });
  cx.globalAlpha = 1;
  cx.fillStyle = "#ffd36b";
  cx.beginPath();
  cx.moveTo(w / 2, h); cx.lineTo(w / 2 - 6, h + 0.5 - 8 + 8); cx.lineTo(w / 2, h - 9); cx.lineTo(w / 2 + 6, h);
  cx.fill();
  $("hdg").textContent = `${Math.round(heading) % 360}°`;
}

// ---- wiring ----
$("go").addEventListener("click", () => begin(false));
$("preview").addEventListener("click", () => begin(true));
$("move").addEventListener("click", () => {
  if (!placing) {
    placing = true;
    engine.reticle.visible = true;
    toast("Aim the ring at the ground, then drop.");
  } else {
    const p = engine.groundPoint();
    const st = provider.state;
    const a = engine.anchors[selected];
    const yaw = (Math.atan2(p.x - st.position.x, -(p.z - st.position.z)) * 180) / Math.PI;
    a.place(p.x, -p.z, yaw, p.y);
    placing = false;
    engine.reticle.visible = false;
    persist();
  }
  syncCards();
});
// Size and height of the selected object: buttons, or pinch with two fingers.
const adjust = (fn: (a: Anchor) => void) => () => {
  const a = engine.anchors[selected];
  if (!a.group.visible) return;
  fn(a);
  syncAdjust();
  persist();
};
$("size-dn").addEventListener("click", adjust((a) => a.setScale(a.userScale / 1.15)));
$("size-up").addEventListener("click", adjust((a) => a.setScale(a.userScale * 1.15)));
$("lower").addEventListener("click", adjust((a) => a.lift(-0.05)));
$("raise").addEventListener("click", adjust((a) => a.lift(0.05)));
let pinch: { d: number; s: number } | null = null;
const spread = (e: TouchEvent) => Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
$("gl").addEventListener("touchstart", (e) => {
  if (e.touches.length === 2 && engine) pinch = { d: spread(e), s: engine.anchors[selected].userScale };
}, { passive: true });
$("gl").addEventListener("touchmove", (e) => {
  if (pinch && e.touches.length === 2) (engine.anchors[selected].setScale((pinch.s * spread(e)) / pinch.d), syncAdjust());
}, { passive: true });
$("gl").addEventListener("touchend", () => {
  if (pinch) (pinch = null), persist();
});

$("cancel").addEventListener("click", () => {
  placing = false;
  engine.reticle.visible = false;
  syncCards();
});
$("gear").addEventListener("click", () => ($("sheet").hidden = false));
$("close").addEventListener("click", () => ($("sheet").hidden = true));
$("around").addEventListener("click", () => {
  placeAround();
  $("sheet").hidden = true;
  toast("Anchors re-dropped around you.");
});
$("restore").addEventListener("click", () => {
  restore();
  $("sheet").hidden = true;
});

function slider(id: string, key: "fov" | "trim" | "eye", unit: string, apply: (v: number) => void) {
  const el = $<HTMLInputElement>(id), out = $(id + "-v");
  el.value = String(prefs[key]);
  const on = () => {
    const v = +el.value;
    prefs[key] = v;
    out.textContent = `${v}${unit}`;
    save(PREFS, prefs);
    if (engine) apply(v);
  };
  el.addEventListener("input", on);
  out.textContent = `${prefs[key]}${unit}`;
}
let fovTimer = 0;
slider("fov", "fov", "°", (v) => {
  engine.cameraFov = v;
  engine.resize();
  if (provider instanceof VioTrackingProvider) {
    // The tracker needs the same lens model: restart it once the slider rests.
    clearTimeout(fovTimer);
    const vio = provider;
    fovTimer = setTimeout(() => vio.setFov(v), 700) as unknown as number;
  }
});
slider("trim", "trim", "°", (v) => (cfg.headingTrim = v));
slider("eye", "eye", " m", (v) => {
  if (provider instanceof VioTrackingProvider) provider.setEyeHeight(cfg.eyeHeight, v);
  cfg.eyeHeight = v;
});
document.querySelectorAll<HTMLElement>("#walk button").forEach((b) => {
  b.classList.toggle("sel", b.dataset.v === prefs.walk);
  b.addEventListener("click", () => {
    prefs.walk = cfg.walkMode = b.dataset.v as WalkMode;
    save(PREFS, prefs);
    document.querySelectorAll("#walk button").forEach((x) => x.classList.toggle("sel", x === b));
  });
});

for (const key of ["vio", "sharp", "points"] as const) {
  const b = $(`t-${key}`);
  b.classList.toggle("sel", prefs[key]);
  b.addEventListener("click", () => {
    prefs[key] = !prefs[key];
    save(PREFS, prefs);
    b.classList.toggle("sel", prefs[key]);
    if (key === "points") engine && (engine.showLandmarks = prefs.points);
    else location.reload();
  });
}

if (!window.isSecureContext) $("warn").hidden = false;
if (location.hash.startsWith("#preview")) begin(true);
