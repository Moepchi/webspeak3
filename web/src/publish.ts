// Publishing a stream that TeamSpeak 6 clients can watch.
//
// The mirror image of stream.ts. Where a viewer answers an offer, a publisher
// makes one - TS6 puts the first SDP in `respondjoinstreamrequest`, so the
// side that owns the stream is the side that offers.
//
// The exchange, from our side:
//
//   1. setupStream    -> notifystreamstarted naming our own clid + the id
//   2. wait           <- notifyjoinstreamrequest, one per viewer
//   3. offer          respondJoinStream(accept, <our SDP>)
//   4. answer         <- {cmd:"answer", args:{answer:"<sdp>"}}
//   5. trickle ICE    both directions via {cmd:"iceCandidate"}
//
// TS6's P2P mode is a mesh: there is no SFU in the path, so every viewer gets
// its own peer connection and its own copy of the encoded media.

import type { StreamEvent } from "./stream";

/** Source kind in `setupstream`. A real TS6 screen share sends 3. */
export const STREAM_TYPE_SCREEN = 3;

/** `mode` in `setupstream`. 1 is what a real TS6 client sends for P2P. */
export const STREAM_MODE_P2P = 1;

/**
 * `accessibility` in `setupstream` - TS6's Privacy setting. 1 is what the
 * observed client sent; the three UI choices are public / contacts / private,
 * and which number maps to which is still unverified.
 */
export const STREAM_ACCESS_DEFAULT = 1;

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:turn.teamspeak.com:3478" },
  { urls: "stun:turn2.teamspeak.com:3478" },
  { urls: "stun:stun.l.google.com:19302" },
];

export interface StreamPublishOptions {
  name: string;
  bitrate: number;
  /** Send the capture's audio track too, when the source has one. */
  audio: boolean;
  /** 0 means unlimited. */
  viewerLimit?: number;
}

export interface StreamPublisherOptions {
  send: (message: Record<string, unknown>) => void;
  /** Needed to recognise our own `notifystreamstarted` among everyone's. */
  ownClientId: number;
  onStateChange?: (state: PublishState) => void;
  onViewersChange?: (viewers: number[]) => void;
  onError?: (error: string) => void;
  iceServers?: RTCIceServer[];
}

export type PublishState = "idle" | "starting" | "live" | "stopped";

interface Viewer {
  pc: RTCPeerConnection;
  /** Candidates that arrived before the answer; replayed after. */
  pending: RTCIceCandidateInit[];
  answered: boolean;
}

export class StreamPublisher {
  private readonly opts: StreamPublisherOptions;
  private readonly viewers = new Map<number, Viewer>();
  private media: MediaStream | null = null;
  private state: PublishState = "idle";

  /** Assigned by the server, not by us; null until notifystreamstarted. */
  streamId: string | null = null;

  /** The local capture, for showing the user what they are sending. */
  get previewStream(): MediaStream | null {
    return this.media;
  }

  constructor(opts: StreamPublisherOptions) {
    this.opts = opts;
  }

  /**
   * Captures a screen and announces the stream.
   *
   * `getDisplayMedia` is secure-context-only, so this throws on a plain-http
   * origin - the same limitation the microphone already has.
   */
  async start(options: StreamPublishOptions): Promise<void> {
    if (this.state === "live" || this.state === "starting") return;
    if (!navigator.mediaDevices?.getDisplayMedia) {
      this.fail("Screen sharing requires HTTPS (or localhost) - the site is not a secure context.");
      return;
    }

    this.setState("starting");
    try {
      this.media = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: options.audio,
      });
    } catch (err) {
      this.setState("idle");
      this.fail(`Could not capture the screen: ${describe(err)}`);
      return;
    }

    // The browser's own "stop sharing" bar bypasses our UI entirely, so the
    // track ending is the authoritative signal that the stream is over.
    for (const track of this.media.getTracks()) {
      track.onended = () => this.stop();
    }

    this.opts.send({
      type: "setupStream",
      name: options.name,
      streamType: STREAM_TYPE_SCREEN,
      bitrate: options.bitrate,
      accessibility: STREAM_ACCESS_DEFAULT,
      mode: STREAM_MODE_P2P,
      viewerLimit: options.viewerLimit ?? 0,
      audio: options.audio && this.media.getAudioTracks().length > 0,
    });
  }

  /** Feeds one `streamEvent` in; events for other streams are ignored. */
  handleEvent(event: StreamEvent): void {
    switch (event.name) {
      case "notifystreamstarted":
        // Everyone in the channel sees this, so the clid decides whether it
        // is the answer to our own setupstream.
        if (Number(event.args.clid) === this.opts.ownClientId && event.args.id) {
          this.streamId = event.args.id;
          this.setState("live");
        }
        break;
      case "notifyjoinstreamrequest":
        if (event.args.id === this.streamId) void this.admit(event.args);
        break;
      case "notifystreamsignaling":
        if (event.args.id === this.streamId) void this.handleSignaling(event.args);
        break;
      case "notifystreamclientleft":
        if (event.args.id === this.streamId) this.dropViewer(Number(event.args.clid));
        break;
      case "notifystreamstopped":
        if (event.args.id === this.streamId) this.teardown("stopped");
        break;
    }
  }

  /** Accepts a viewer and sends it our offer. */
  private async admit(args: Record<string, string>): Promise<void> {
    const clid = Number(args.clid);
    if (!Number.isFinite(clid) || !this.media || !this.streamId) return;

    // is_remove=1 is how TS6 says "stop watching"; the same notify carries it.
    if (args.is_remove === "1") {
      this.dropViewer(clid);
      return;
    }
    if (this.viewers.has(clid)) return;

    const pc = new RTCPeerConnection({ iceServers: this.opts.iceServers ?? DEFAULT_ICE_SERVERS });
    const viewer: Viewer = { pc, pending: [], answered: false };
    this.viewers.set(clid, viewer);

    for (const track of this.media.getTracks()) pc.addTrack(track, this.media);

    pc.onicecandidate = (ev) => {
      if (!ev.candidate) return;
      this.signal(clid, "iceCandidate", {
        sdp: ev.candidate.candidate,
        mid: ev.candidate.sdpMid ?? "0",
        mLine: ev.candidate.sdpMLineIndex ?? 0,
      });
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed") this.dropViewer(clid);
    };

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.opts.send({
        type: "respondJoinStream",
        streamId: this.streamId,
        clientId: clid,
        accept: true,
        offer: offer.sdp ?? "",
      });
      this.notifyViewers();
    } catch (err) {
      this.dropViewer(clid);
      this.fail(`Could not offer the stream to client ${clid}: ${describe(err)}`);
    }
  }

  private async handleSignaling(args: Record<string, string>): Promise<void> {
    const clid = Number(args.clid);
    const viewer = this.viewers.get(clid);
    if (!viewer) return;

    let msg: { cmd: string; args: unknown };
    try {
      msg = JSON.parse(args.json ?? "");
    } catch {
      return;
    }

    const payload = msg.args as Record<string, unknown> | string | null;
    switch (msg.cmd) {
      case "answer": {
        // Same key rule as the sending side: the key is named after the cmd.
        const sdp =
          typeof payload === "string"
            ? payload
            : typeof payload?.answer === "string"
              ? payload.answer
              : typeof payload?.sdp === "string"
                ? payload.sdp
                : null;
        if (!sdp) return;
        try {
          await viewer.pc.setRemoteDescription({ type: "answer", sdp });
          viewer.answered = true;
          const pending = viewer.pending;
          viewer.pending = [];
          for (const c of pending) {
            try {
              await viewer.pc.addIceCandidate(c);
            } catch (err) {
              console.warn("[publish] ignoring buffered ICE candidate:", describe(err));
            }
          }
        } catch (err) {
          this.fail(`Could not accept the viewer's answer: ${describe(err)}`);
        }
        break;
      }
      case "iceCandidate": {
        if (typeof payload !== "object" || payload === null) return;
        const candidate = payload.sdp;
        if (typeof candidate !== "string" || !candidate) return;
        const init: RTCIceCandidateInit = {
          candidate,
          sdpMid: typeof payload.mid === "string" ? payload.mid : undefined,
          sdpMLineIndex: typeof payload.mLine === "number" ? payload.mLine : undefined,
        };
        // TS6 trickles from the moment it gets the offer, so these routinely
        // beat its own answer. Holding them is not an edge case.
        if (!viewer.answered) {
          viewer.pending.push(init);
          return;
        }
        try {
          await viewer.pc.addIceCandidate(init);
        } catch (err) {
          console.warn("[publish] ignoring ICE candidate:", describe(err));
        }
        break;
      }
    }
  }

  private dropViewer(clid: number): void {
    const viewer = this.viewers.get(clid);
    if (!viewer) return;
    this.viewers.delete(clid);
    viewer.pc.close();
    this.notifyViewers();
  }

  /** Stops the capture and takes the stream down. Safe to call twice. */
  stop(): void {
    if (this.state === "idle" || this.state === "stopped") return;
    if (this.streamId) this.opts.send({ type: "stopStream", streamId: this.streamId });
    this.teardown("stopped");
  }

  private teardown(state: PublishState): void {
    for (const [, viewer] of this.viewers) viewer.pc.close();
    this.viewers.clear();
    for (const track of this.media?.getTracks() ?? []) track.stop();
    this.media = null;
    this.streamId = null;
    this.notifyViewers();
    this.setState(state);
  }

  private signal(clid: number, cmd: string, args: unknown): void {
    this.opts.send({
      type: "streamSignal",
      streamId: this.streamId,
      clientId: clid,
      payload: { cmd, args },
    });
  }

  private setState(state: PublishState): void {
    this.state = state;
    this.opts.onStateChange?.(state);
  }

  private notifyViewers(): void {
    this.opts.onViewersChange?.([...this.viewers.keys()]);
  }

  private fail(message: string): void {
    this.opts.onError?.(message);
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
