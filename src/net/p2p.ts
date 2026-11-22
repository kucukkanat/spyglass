// Optional peer-to-peer channel for live updates: WebRTC data channels between the players
// in a place, with offers, answers and ICE candidates exchanged as Nostr ephemeral events.
// Relays stay the source of truth for durable state; this only shortens the live path.
import type { Live, PeerLink, PlaceSession } from "./places";

const ICE = [{ urls: "stun:stun.l.google.com:19302" }];

export class PeerMesh implements PeerLink {
  private pcs = new Map<string, RTCPeerConnection>();
  private chans = new Map<string, RTCDataChannel>();
  private timer: ReturnType<typeof setInterval>;
  onChange: (() => void) | null = null;

  constructor(private session: PlaceSession, private me: string) {
    this.timer = setInterval(() => this.dial(), 2000);
  }
  get open() {
    return [...this.chans.values()].filter((c) => c.readyState === "open").length;
  }

  private dial() {
    // The lower public key calls, so two peers never call each other at once.
    for (const peer of this.session.activePeers) if (!this.pcs.has(peer) && this.me < peer) void this.call(peer);
  }

  private make(peer: string) {
    const pc = new RTCPeerConnection({ iceServers: ICE });
    this.pcs.set(peer, pc);
    pc.onicecandidate = (e) => e.candidate && this.session.sendLive({ type: "sig", data: { ice: e.candidate.toJSON() } }, peer, true);
    pc.onconnectionstatechange = () => {
      if (["failed", "closed", "disconnected"].includes(pc.connectionState)) {
        this.pcs.delete(peer);
        this.chans.delete(peer);
        pc.close();
        this.onChange?.();
      }
    };
    pc.ondatachannel = (e) => this.adopt(peer, e.channel);
    return pc;
  }
  private adopt(peer: string, ch: RTCDataChannel) {
    this.chans.set(peer, ch);
    ch.onopen = ch.onclose = () => this.onChange?.();
    ch.onmessage = (m) => {
      try { this.session.receiveLive(peer, JSON.parse(String(m.data)) as Live); } catch {}
    };
  }
  private async call(peer: string) {
    const pc = this.make(peer);
    this.adopt(peer, pc.createDataChannel("spyglass", { ordered: false, maxRetransmits: 0 }));
    await pc.setLocalDescription(await pc.createOffer());
    this.session.sendLive({ type: "sig", data: { sdp: pc.localDescription } }, peer, true);
  }

  /** Feed signalling messages addressed to us (from PlaceSession.onLive). */
  async signal(from: string, data: any) {
    try {
      let pc = this.pcs.get(from);
      if (data?.sdp?.type === "offer") {
        pc?.close();
        pc = this.make(from);
        await pc.setRemoteDescription(data.sdp);
        await pc.setLocalDescription(await pc.createAnswer());
        this.session.sendLive({ type: "sig", data: { sdp: pc.localDescription } }, from, true);
      } else if (data?.sdp?.type === "answer") await pc?.setRemoteDescription(data.sdp);
      else if (data?.ice) await pc?.addIceCandidate(data.ice);
    } catch (err) {
      console.warn("[p2p]", err);
    }
  }

  send(to: string | null, live: Live) {
    const msg = JSON.stringify(live);
    let sent = 0;
    for (const [peer, ch] of this.chans) if ((!to || to === peer) && ch.readyState === "open") (ch.send(msg), sent++);
    // Only claim delivery when every active peer has a channel; otherwise the relay carries it too.
    return sent > 0 && sent >= (to ? 1 : this.session.activePeers.length);
  }

  close() {
    clearInterval(this.timer);
    for (const pc of this.pcs.values()) pc.close();
    this.pcs.clear();
    this.chans.clear();
  }
}
