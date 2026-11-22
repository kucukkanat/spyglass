// Shared places over Nostr. A place is a named spot with two reference points that every
// player marks; objects are stored relative to those points (see SharedFrame).
//   37517  addressable  place definition      d = <code>,         t = spyglass-place, g = geohashes
//   37518  addressable  object state          d = <code>:<object>, t = spyglass:<code>
//   25517  ephemeral    live updates, presence and WebRTC signalling, t = spyglass:<code>
import type { SharedPose } from "../ar/shared-frame";
import { geohash, geohashNeighbourhood, type Identity, type NEvent, type RelayPool } from "./nostr";

export const KIND_PLACE = 37517, KIND_OBJECT = 37518, KIND_LIVE = 25517;

export interface Place { code: string; name: string; hintA: string; hintB: string; lat?: number; lon?: number; owner: string; at: number }
export interface ObjectState extends SharedPose { obj: string; ts: number; by: string }
export type Live = { type: "obj"; state: ObjectState } | { type: "hello" } | { type: "sig"; data: unknown };

const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
export const newCode = () => Array.from(crypto.getRandomValues(new Uint8Array(5)), (b) => ALPHABET[b % ALPHABET.length]).join("");

function parsePlace(e: NEvent): Place | null {
  try {
    const code = e.tags.find((t) => t[0] === "d")?.[1];
    const c = JSON.parse(e.content);
    if (!code || typeof c.name !== "string") return null;
    return { code, name: c.name.slice(0, 60), hintA: String(c.hintA ?? "").slice(0, 80), hintB: String(c.hintB ?? "").slice(0, 80), lat: c.lat, lon: c.lon, owner: e.pubkey, at: e.created_at };
  } catch {
    return null;
  }
}

export function publishPlace(pool: RelayPool, id: Identity, p: Omit<Place, "owner" | "at">) {
  const tags = [["d", p.code], ["t", "spyglass-place"]];
  if (typeof p.lat === "number" && typeof p.lon === "number") for (const n of [5, 6, 7]) tags.push(["g", geohash(p.lat, p.lon, n)]);
  pool.publish(id.sign(KIND_PLACE, tags, JSON.stringify({ name: p.name, hintA: p.hintA, hintB: p.hintB, lat: p.lat, lon: p.lon })));
}

/** Places whose geohash cell (about 1.2 x 0.6 km) is the player's or a neighbour. */
export function watchNearby(pool: RelayPool, lat: number, lon: number, cb: (p: Place) => void) {
  return pool.subscribe([{ kinds: [KIND_PLACE], "#g": geohashNeighbourhood(lat, lon, 6) }], (e) => {
    const p = parsePlace(e);
    if (p) cb(p);
  });
}
export function watchPlace(pool: RelayPool, code: string, cb: (p: Place) => void) {
  return pool.subscribe([{ kinds: [KIND_PLACE], "#d": [code] }], (e) => {
    const p = parsePlace(e);
    if (p) cb(p);
  });
}

export interface PeerLink { send(to: string | null, live: Live): boolean; readonly open: number }

/** Object state and presence for one place. Newest write per object wins, whoever made it. */
export class PlaceSession {
  readonly objects = new Map<string, ObjectState>();
  readonly peers = new Map<string, number>(); // pubkey -> last seen (ms)
  onObject: ((s: ObjectState) => void) | null = null;
  onLive: ((from: string, live: Live, e: NEvent) => void) | null = null;
  /** When set and connected, live updates go peer-to-peer; relays still get the settled state. */
  p2p: PeerLink | null = null;
  private unsub: () => void;
  private hello: ReturnType<typeof setInterval>;
  private settle = new Map<string, ReturnType<typeof setTimeout>>();
  private lastLive = new Map<string, number>();
  private tag: string;

  constructor(private pool: RelayPool, private id: Identity, readonly code: string) {
    this.tag = `spyglass:${code}`;
    const since = Math.floor(Date.now() / 1000) - 5;
    this.unsub = pool.subscribe([{ kinds: [KIND_OBJECT], "#t": [this.tag] }, { kinds: [KIND_LIVE], "#t": [this.tag], since }], (e) => this.onEvent(e));
    this.hello = setInterval(() => this.sendLive({ type: "hello" }, null, true), 4000);
    this.sendLive({ type: "hello" }, null, true);
  }

  private onEvent(e: NEvent) {
    if (e.pubkey === this.id.pk) return;
    let c: any;
    try { c = JSON.parse(e.content); } catch { return; }
    if (e.kind === KIND_OBJECT) return this.accept({ ...c, by: e.pubkey });
    const to = e.tags.find((t) => t[0] === "p")?.[1];
    if (to && to !== this.id.pk) return;
    this.receiveLive(e.pubkey, c as Live, e);
  }

  /** Entry point for live messages from relays and from peer channels alike. */
  receiveLive(from: string, live: Live, e?: NEvent) {
    this.peers.set(from, Date.now());
    if (live?.type === "obj") this.accept({ ...live.state, by: from });
    this.onLive?.(from, live, e as NEvent);
  }

  private accept(s: ObjectState) {
    if (typeof s?.obj !== "string" || ![s.x, s.y, s.z, s.yaw, s.scale, s.ts].every(Number.isFinite)) return;
    const cur = this.objects.get(s.obj);
    if (cur && cur.ts >= s.ts) return;
    this.objects.set(s.obj, s);
    this.onObject?.(s);
  }

  sendLive(live: Live, to: string | null, relayOnly = false) {
    if (!relayOnly && this.p2p?.send(to, live)) return;
    const tags = [["t", this.tag]];
    if (to) tags.push(["p", to]);
    this.pool.publish(this.id.sign(KIND_LIVE, tags, JSON.stringify(live)));
  }

  /** Publishes a local change: live at up to 10 Hz, then once as durable state when it settles. */
  setObject(obj: string, pose: SharedPose) {
    const state: ObjectState = { ...pose, obj, ts: Date.now(), by: this.id.pk };
    this.objects.set(obj, state);
    const now = Date.now();
    if (now - (this.lastLive.get(obj) ?? 0) > 100) {
      this.lastLive.set(obj, now);
      this.sendLive({ type: "obj", state }, null);
    }
    clearTimeout(this.settle.get(obj));
    this.settle.set(obj, setTimeout(() => {
      const latest = this.objects.get(obj);
      if (!latest || latest.by !== this.id.pk) return;
      const { by, ...body } = latest;
      this.pool.publish(this.id.sign(KIND_OBJECT, [["d", `${this.code}:${obj}`], ["t", this.tag]], JSON.stringify(body)));
      this.sendLive({ type: "obj", state: latest }, null);
    }, 400));
  }

  get activePeers() {
    const cut = Date.now() - 12000;
    return [...this.peers].filter(([, t]) => t > cut).map(([k]) => k);
  }

  close() {
    this.unsub();
    clearInterval(this.hello);
    for (const t of this.settle.values()) clearTimeout(t);
  }
}
