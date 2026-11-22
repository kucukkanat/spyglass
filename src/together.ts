// "Play together": shared places over Nostr, two-point alignment, optional peer-to-peer.
import { MathUtils } from "three";
import type { AREngine, Anchor } from "./ar/engine";
import { toEN, toLatLon } from "./ar/geo";
import { SharedFrame, type SharedPose } from "./ar/shared-frame";
import { Identity, RelayPool } from "./net/nostr";
import { PeerMesh } from "./net/p2p";
import { newCode, PlaceSession, publishPlace, watchNearby, watchPlace, type ObjectState, type Place } from "./net/places";

export const DEFAULT_RELAYS = "wss://relay.damus.io, wss://nos.lol, wss://relay.primal.net";

interface Ctx {
  engine: () => AREngine;
  prefs: { relays: string; p2p: boolean };
  savePrefs: () => void;
  toast: (msg: string, ms?: number) => void;
  onRemoteChange: () => void;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export function initTogether(ctx: Ctx) {
  let id: Identity | null = null;
  let pool: RelayPool | null = null;
  let session: PlaceSession | null = null;
  let mesh: PeerMesh | null = null;
  let place: Place | null = null;
  let frame: SharedFrame | null = null;
  let marking: { step: "A" | "B"; a?: import("three").Vector3 } | null = null;
  let stopNearby: (() => void) | null = null;
  const nearby = new Map<string, Place>();

  const here = () => {
    const st = ctx.engine().provider.state;
    return st.geoOrigin ? toLatLon(st.geoOrigin, { e: st.position.x, n: -st.position.z }) : null;
  };

  function connect() {
    id ??= Identity.load();
    if (pool) return;
    const urls = ctx.prefs.relays.split(",").map((s) => s.trim()).filter((s) => /^wss?:\/\//.test(s));
    pool = new RelayPool(urls);
    pool.onStatus = render;
  }

  // ---- alignment ---------------------------------------------------------------------
  function startMarking() {
    marking = { step: "A" };
    ctx.engine().reticle.visible = true;
    $("mark").hidden = false;
    renderMark();
  }
  function renderMark() {
    if (!marking || !place) return;
    const hint = marking.step === "A" ? place.hintA : place.hintB;
    $("mark-text").innerHTML = `<b>Reference point ${marking.step}</b>${hint ? `: ${esc(hint)}` : ""}<br><span>Aim the ring exactly at it, then mark. Everyone must mark the same two spots.</span>`;
    $("mark-go").textContent = `Mark point ${marking.step}`;
  }
  function mark() {
    if (!marking) return;
    const p = ctx.engine().groundPoint().clone();
    if (marking.step === "A") {
      marking = { step: "B", a: p };
      return renderMark();
    }
    if (!SharedFrame.valid(marking.a!, p)) return ctx.toast("Point B is too close to point A. Pick a spot at least 30 cm away.");
    frame = new SharedFrame(marking.a!, p);
    stopMarking();
    ctx.toast(`Aligned to "${place!.name}". Objects are now shared.`, 4000);
    // Adopt whatever the place already holds; after a moment, contribute what it lacks.
    for (const s of session!.objects.values()) applyRemote(s);
    const s0 = session;
    setTimeout(() => {
      if (session === s0 && frame) for (const a of ctx.engine().anchors) if (a.group.visible && !session!.objects.has(a.id)) share(a);
    }, 1800);
    render();
  }
  function stopMarking() {
    marking = null;
    ctx.engine().reticle.visible = false;
    $("mark").hidden = true;
  }

  // ---- object sync -------------------------------------------------------------------
  function applyRemote(s: ObjectState) {
    if (!frame) return;
    const a = ctx.engine().anchors.find((x) => x.id === s.obj);
    if (!a) return;
    const l = frame.toLocal(s);
    a.set(l.pos, l.yaw, l.scale);
    ctx.onRemoteChange();
  }
  const same = (a: SharedPose, b: SharedPose) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.z - b.z) < 1e-3 && Math.abs(a.yaw - b.yaw) < 1e-3 && Math.abs(a.scale - b.scale) < 1e-3;
  /** Call after any local change to an object; a no-op outside an aligned place. */
  function share(a: Anchor) {
    if (!frame || !session || !a.group.visible) return;
    const pose = frame.toShared(a.group.position, a.group.rotation.y, a.userScale);
    const cur = session.objects.get(a.id);
    if (cur && same(cur, pose)) return;
    session.setObject(a.id, pose);
  }

  // ---- places ------------------------------------------------------------------------
  function enter(p: Place) {
    leave(false);
    connect();
    place = p;
    session = new PlaceSession(pool!, id!, p.code);
    session.onObject = applyRemote;
    session.onLive = (from, live) => {
      if (live?.type === "sig") void mesh?.signal(from, live.data);
    };
    setP2P(ctx.prefs.p2p);
    $("mp").hidden = true;
    startMarking();
    render();
  }
  function leave(note = true) {
    if (!session) return;
    stopMarking();
    mesh?.close();
    session.close();
    mesh = null; session = null; place = null; frame = null;
    if (note) ctx.toast("Left the place. Your objects are local again.");
    render();
  }
  function setP2P(on: boolean) {
    ctx.prefs.p2p = on;
    ctx.savePrefs();
    mesh?.close();
    mesh = null;
    if (session) {
      if (on && typeof RTCPeerConnection !== "undefined") {
        mesh = new PeerMesh(session, id!.pk);
        mesh.onChange = render;
      }
      session.p2p = mesh;
    }
    render();
  }
  function create() {
    const name = $<HTMLInputElement>("mp-name").value.trim();
    if (!name) return ctx.toast("Give the place a name.");
    connect();
    const pos = here();
    const p = { code: newCode(), name, hintA: $<HTMLInputElement>("mp-a").value.trim(), hintB: $<HTMLInputElement>("mp-b").value.trim(), lat: pos?.lat, lon: pos?.lon };
    publishPlace(pool!, id!, p);
    enter({ ...p, owner: id!.pk, at: Date.now() / 1000 });
  }
  function join(code: string) {
    code = code.trim().toLowerCase();
    if (!/^[a-z0-9]{4,8}$/.test(code)) return ctx.toast("That code doesn't look right.");
    const known = nearby.get(code);
    if (known) return enter(known);
    connect();
    let done = false;
    const stop = watchPlace(pool!, code, (p) => {
      if (done) return;
      done = true;
      stop();
      enter(p);
    });
    ctx.toast("Looking for that place…", 6000);
    setTimeout(() => {
      if (!done) (stop(), (done = true), ctx.toast("No place with that code on these relays."));
    }, 6000);
  }
  function refreshNearby() {
    const pos = here();
    if (!pool || !pos || stopNearby) return;
    stopNearby = watchNearby(pool, pos.lat, pos.lon, (p) => {
      const cur = nearby.get(p.code);
      if (!cur || cur.at < p.at) (nearby.set(p.code, p), render());
    });
  }

  // ---- UI ----------------------------------------------------------------------------
  function render() {
    const chip = $("mp-chip");
    chip.hidden = !place;
    if (place && session) chip.textContent = `${place.name} · ${frame ? `${session.activePeers.length + 1} here` : "not aligned"}`;
    if ($("mp").hidden) return;
    const n = pool ? `${pool.connected}/${pool.urls.length} relays` : "not connected";
    $("mp-status").textContent = `${n}${id ? ` · you ${id.pk.slice(0, 8)}…` : ""}${mesh ? ` · ${mesh.open} direct link${mesh.open === 1 ? "" : "s"}` : ""}`;
    $("mp-in").hidden = !place;
    $("mp-lobby").hidden = !!place;
    if (place && session) {
      $("mp-place").innerHTML = `<b>${esc(place.name)}</b><span>Code <code>${place.code}</code></span><span>${session.activePeers.length} other player${session.activePeers.length === 1 ? "" : "s"} · ${frame ? "aligned" : "not aligned yet"}</span>`;
    } else {
      const pos = here();
      const rows = [...nearby.values()].map((p) => {
        const d = pos && typeof p.lat === "number" && typeof p.lon === "number" ? toEN(pos, { lat: p.lat, lon: p.lon }) : null;
        return { p, dist: d ? Math.hypot(d.e, d.n) : Infinity };
      }).sort((a, b) => a.dist - b.dist).slice(0, 8);
      $("mp-near").innerHTML = rows.length
        ? rows.map(({ p, dist }) => `<button data-code="${p.code}"><b>${esc(p.name)}</b><span>${isFinite(dist) ? `${dist < 1000 ? Math.round(dist) + " m" : (dist / 1000).toFixed(1) + " km"} · ` : ""}${p.code}</span></button>`).join("")
        : `<p class="hint">${pos ? "No places found nearby yet." : "Waiting for a GPS fix to look for places nearby. Joining by code works without it."}</p>`;
    }
    document.querySelectorAll<HTMLElement>("#mp-transport button").forEach((b) => b.classList.toggle("sel", (b.dataset.v === "p2p") === ctx.prefs.p2p));
  }

  $("together").addEventListener("click", () => {
    $("mp").hidden = false;
    $<HTMLInputElement>("mp-relays").value = ctx.prefs.relays;
    connect();
    refreshNearby();
    render();
  });
  $("mp-close").addEventListener("click", () => ($("mp").hidden = true));
  $("mp-create").addEventListener("click", create);
  $("mp-join").addEventListener("click", () => join($<HTMLInputElement>("mp-code").value));
  $("mp-near").addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("button[data-code]");
    if (b) join(b.dataset.code!);
  });
  $("mp-leave").addEventListener("click", () => leave());
  $("mp-remark").addEventListener("click", () => (($("mp").hidden = true), startMarking()));
  $("mark-go").addEventListener("click", mark);
  $("mark-cancel").addEventListener("click", () => (stopMarking(), !frame && ctx.toast("Not aligned yet. Open Play together to mark the points.")));
  document.querySelectorAll<HTMLElement>("#mp-transport button").forEach((b) => b.addEventListener("click", () => setP2P(b.dataset.v === "p2p")));
  $("mp-relays").addEventListener("change", () => {
    ctx.prefs.relays = $<HTMLInputElement>("mp-relays").value;
    ctx.savePrefs();
    if (session) return ctx.toast("Relays change after you leave this place.");
    pool?.close();
    pool = null;
    stopNearby = null;
    nearby.clear();
    connect();
    refreshNearby();
    render();
  });
  setInterval(() => (refreshNearby(), render()), 1500);

  return { share, get aligned() { return !!frame; }, yawDeg: (rad: number) => MathUtils.radToDeg(rad) };
}
