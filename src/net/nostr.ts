// Minimal Nostr client: identity, NIP-01 events, and a reconnecting relay pool.
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, randomBytes } from "@noble/hashes/utils.js";

export interface NEvent { id: string; pubkey: string; created_at: number; kind: number; tags: string[][]; content: string; sig: string }
export type Filter = Record<string, unknown>;

const KEY = "spyglass.nostr.sk";

export class Identity {
  readonly pk: string;
  private constructor(private sk: Uint8Array) {
    this.pk = bytesToHex(schnorr.getPublicKey(sk));
  }
  /** One key per browser, generated on first use and kept in localStorage. */
  static load(): Identity {
    let hex: string | null = null;
    try { hex = localStorage.getItem(KEY); } catch {}
    if (!hex || !/^[0-9a-f]{64}$/.test(hex)) {
      hex = bytesToHex(randomBytes(32));
      try { localStorage.setItem(KEY, hex); } catch {}
    }
    return new Identity(hexToBytes(hex));
  }
  sign(kind: number, tags: string[][], content: string): NEvent {
    const created_at = Math.floor(Date.now() / 1000);
    const id = bytesToHex(sha256(new TextEncoder().encode(JSON.stringify([0, this.pk, created_at, kind, tags, content]))));
    return { id, pubkey: this.pk, created_at, kind, tags, content, sig: bytesToHex(schnorr.sign(hexToBytes(id), this.sk)) };
  }
}

export function verify(e: NEvent): boolean {
  try {
    const id = bytesToHex(sha256(new TextEncoder().encode(JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content]))));
    return id === e.id && schnorr.verify(hexToBytes(e.sig), hexToBytes(e.id), hexToBytes(e.pubkey));
  } catch {
    return false;
  }
}

interface Sub { filters: Filter[]; cb: (e: NEvent) => void; seen: Set<string> }

export class RelayPool {
  private sockets = new Map<string, WebSocket>();
  private subs = new Map<string, Sub>();
  private pending: NEvent[] = [];
  private closed = false;
  private n = 0;
  onStatus: (() => void) | null = null;

  constructor(readonly urls: string[]) {
    urls.forEach((u) => this.connect(u));
  }
  get connected() {
    return [...this.sockets.values()].filter((w) => w.readyState === WebSocket.OPEN).length;
  }
  private connect(url: string) {
    if (this.closed) return;
    let ws: WebSocket;
    try { ws = new WebSocket(url); } catch { return; }
    this.sockets.set(url, ws);
    ws.onopen = () => {
      for (const [id, s] of this.subs) ws.send(JSON.stringify(["REQ", id, ...s.filters]));
      for (const e of this.pending.splice(0)) ws.send(JSON.stringify(["EVENT", e]));
      this.onStatus?.();
    };
    ws.onmessage = (m) => {
      let msg: any;
      try { msg = JSON.parse(String(m.data)); } catch { return; }
      if (msg?.[0] !== "EVENT") return;
      const s = this.subs.get(msg[1]), e = msg[2] as NEvent;
      if (!s || !e?.id || s.seen.has(e.id)) return;
      s.seen.add(e.id);
      if (verify(e)) s.cb(e);
    };
    ws.onclose = () => {
      this.onStatus?.();
      if (!this.closed) setTimeout(() => this.connect(url), 3000);
    };
    ws.onerror = () => {};
  }
  publish(e: NEvent) {
    let sent = false;
    for (const ws of this.sockets.values()) if (ws.readyState === WebSocket.OPEN) (ws.send(JSON.stringify(["EVENT", e])), (sent = true));
    if (!sent && this.pending.length < 50) this.pending.push(e);
  }
  subscribe(filters: Filter[], cb: (e: NEvent) => void) {
    const id = `s${++this.n}`;
    this.subs.set(id, { filters, cb, seen: new Set() });
    for (const ws of this.sockets.values()) if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(["REQ", id, ...filters]));
    return () => {
      this.subs.delete(id);
      for (const ws of this.sockets.values()) if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(["CLOSE", id]));
    };
  }
  close() {
    this.closed = true;
    for (const ws of this.sockets.values()) ws.close();
  }
}

const B32 = "0123456789bcdefghjkmnpqrstuvwxyz";
export function geohash(lat: number, lon: number, precision = 6) {
  let la = [-90, 90], lo = [-180, 180], out = "", bit = 0, ch = 0, even = true;
  while (out.length < precision) {
    const r = even ? lo : la, v = even ? lon : lat, mid = (r[0] + r[1]) / 2;
    if (v >= mid) (ch = (ch << 1) | 1), (r[0] = mid);
    else (ch <<= 1), (r[1] = mid);
    even = !even;
    if (++bit === 5) (out += B32[ch]), (bit = 0), (ch = 0);
  }
  return out;
}
/** The cell containing the point plus its eight neighbours. */
export function geohashNeighbourhood(lat: number, lon: number, precision = 6) {
  const bits = precision * 5, lonBits = Math.ceil(bits / 2), latBits = Math.floor(bits / 2);
  const dLon = 360 / 2 ** lonBits, dLat = 180 / 2 ** latBits;
  const set = new Set<string>();
  for (const i of [-1, 0, 1]) for (const j of [-1, 0, 1]) set.add(geohash(Math.max(-89.99, Math.min(89.99, lat + i * dLat)), lon + j * dLon, precision));
  return [...set];
}
