// Viewing a TeamSpeak 6 Stream/Call broadcast in the browser.
//
// TS6's stream signaling rides the ordinary TS3 command channel, so everything
// here travels the same WebSocket as the rest of the session: the connector
// unescapes the TS wire format and hands us the JSON payload untouched (see
// ts6-re/findings/ts6-stream-protocol-static-analysis.md).
//
// The exchange, from our side:
//
//   1. discover      client_is_streaming=1 on a client in view
//   2. joinStream    -> notifyrespondjoinstreamrequest (decision=1 + SDP offer)
//   3. answer        <- streamSignal {cmd:"answer"}
//   4. trickle ICE   both directions via {cmd:"iceCandidate"}
//
// TS6 publishes sendonly, so this is a receive-only peer connection.

/** A `streamEvent` as the connector emits it. */
export interface StreamEvent {
  type: "streamEvent";
  name: string;
  args: Record<string, string>;
}

/**
 * The payload shape inside `notifystreamsignaling`'s `json` argument.
 *
 * Each `cmd` names its own key inside `args`, and the key is *not* `sdp`
 * except for `iceCandidate`: an answer is `{answer: "<sdp>"}`, an offer
 * `{offer: "<sdp>"}`, a candidate `{sdp, mid, mLine}`. Live-verified against
 * TS6 6.0.0-beta12.1 - `{sdp: "<sdp>"}` and a bare string are both accepted
 * by the server and then silently dropped by the client.
 */
interface SignalingMessage {
  cmd: string;
  args: unknown;
}

export interface StreamInfo {
  id: string;
  clientId: number;
  name: string;
  /** Current viewer count as of the last notifystreaminfo. */
  viewers: number;
  hasAudio: boolean;
  bitrate: number;
}

export interface StreamViewerOptions {
  /** Sends one message up the session WebSocket. */
  send: (message: Record<string, unknown>) => void;
  /** The remote media, once the first track arrives. */
  onTrack: (stream: MediaStream) => void;
  onStateChange?: (state: RTCPeerConnectionState) => void;
  onError?: (error: string) => void;
  /** The viewer shut down — by us, or because the publisher stopped. */
  onClosed?: () => void;
  /**
   * ICE servers to use. TS6 itself only ever configures `stun:` URLs and so
   * never gathers a relay candidate, but it will happily *connect* to one we
   * offer - which is how webspeak3 can work on networks where TS6 cannot.
   */
  iceServers?: RTCIceServer[];
}

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:turn.teamspeak.com:3478" },
  { urls: "stun:turn2.teamspeak.com:3478" },
  { urls: "stun:stun.l.google.com:19302" },
];

/**
 * Reads a stream's properties out of a `notifystreaminfo` / `notifystreamstarted`.
 *
 * The two notifies disagree on one name: `notifystreaminfo` says
 * `accessibility`, `notifystreamstarted` shortens it to `access`. Only
 * `notifystreaminfo` carries `viewer`.
 */
export function parseStreamInfo(args: Record<string, string>): StreamInfo | null {
  const id = args.id;
  const clientId = Number(args.clid);
  if (!id || !Number.isFinite(clientId)) return null;
  return {
    id,
    clientId,
    name: args.name ?? "",
    viewers: Number(args.viewer ?? 0) || 0,
    hasAudio: args.audio === "1",
    bitrate: Number(args.bitrate ?? 0) || 0,
  };
}

export class StreamViewer {
  private pc: RTCPeerConnection | null = null;
  private readonly opts: StreamViewerOptions;
  private readonly remote = new MediaStream();

  /** Candidates that arrived before setRemoteDescription; replayed after. */
  private pendingRemoteCandidates: RTCIceCandidateInit[] = [];
  private remoteDescriptionSet = false;
  private closed = false;

  readonly streamId: string;
  readonly peerClientId: number;

  constructor(streamId: string, peerClientId: number, opts: StreamViewerOptions) {
    this.streamId = streamId;
    this.peerClientId = peerClientId;
    this.opts = opts;
  }

  /** Asks the publishing client to let us watch. The offer arrives asynchronously. */
  join(message = ""): void {
    this.opts.send({
      type: "joinStream",
      streamId: this.streamId,
      clientId: this.peerClientId,
      message,
    });
  }

  /**
   * Feeds one `streamEvent` in. Events for other streams are ignored, so the
   * caller can pass everything it receives without filtering.
   */
  handleEvent(event: StreamEvent): void {
    if (this.closed) return;
    if (event.args.id && event.args.id !== this.streamId) return;

    switch (event.name) {
      case "notifyrespondjoinstreamrequest":
        void this.handleJoinResponse(event.args);
        break;
      case "notifystreamsignaling":
        void this.handleSignaling(event.args);
        break;
      case "notifystreamstopped":
      case "notifystreamclientleft":
        this.close();
        break;
    }
  }

  private async handleJoinResponse(args: Record<string, string>): Promise<void> {
    if (args.decision !== "1") {
      this.fail(args.msg ? `Stream join refused: ${args.msg}` : "Stream join refused");
      return;
    }
    if (!args.offer) {
      this.fail("Stream join accepted but no SDP offer was sent");
      return;
    }
    await this.acceptOffer(args.offer);
  }

  private async acceptOffer(sdp: string): Promise<void> {
    const pc = this.ensurePeerConnection();
    try {
      await pc.setRemoteDescription({ type: "offer", sdp });
      this.remoteDescriptionSet = true;
      await this.flushRemoteCandidates();

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.signal("answer", { answer: answer.sdp ?? "" });
    } catch (err) {
      this.fail(`Could not answer the stream offer: ${describe(err)}`);
    }
  }

  private async handleSignaling(args: Record<string, string>): Promise<void> {
    let msg: SignalingMessage;
    try {
      msg = JSON.parse(args.json ?? "");
    } catch {
      this.fail("Received malformed stream signaling payload");
      return;
    }

    switch (msg.cmd) {
      case "iceCandidate": {
        const candidate =
          typeof msg.args === "object" && msg.args !== null
            ? candidateFromArgs(msg.args as Record<string, unknown>)
            : null;
        if (!candidate) return;
        if (!this.remoteDescriptionSet) {
          // TS6 starts trickling immediately, so these routinely beat the
          // offer's setRemoteDescription. Holding them is not an edge case.
          this.pendingRemoteCandidates.push(candidate);
          return;
        }
        try {
          await this.ensurePeerConnection().addIceCandidate(candidate);
        } catch (err) {
          // A single unusable candidate must not tear the session down; ICE
          // only needs one working pair.
          console.warn("[stream] ignoring ICE candidate:", describe(err));
        }
        break;
      }
      case "offer":
      case "reconnectOffer": {
        // Renegotiation from the publisher, e.g. after it switches source.
        // `offer` mirrors the `answer` key we send; the other two are cheap
        // to tolerate and cost nothing if they never arrive.
        const a = msg.args as Record<string, unknown> | string | null;
        const sdp =
          typeof a === "string"
            ? a
            : typeof a?.offer === "string"
              ? a.offer
              : typeof a?.sdp === "string"
                ? a.sdp
                : null;
        if (sdp) await this.acceptOffer(sdp);
        break;
      }
      default:
        break;
    }
  }

  private async flushRemoteCandidates(): Promise<void> {
    const pending = this.pendingRemoteCandidates;
    this.pendingRemoteCandidates = [];
    const pc = this.ensurePeerConnection();
    for (const candidate of pending) {
      try {
        await pc.addIceCandidate(candidate);
      } catch (err) {
        console.warn("[stream] ignoring buffered ICE candidate:", describe(err));
      }
    }
  }

  private ensurePeerConnection(): RTCPeerConnection {
    if (this.pc) return this.pc;

    const pc = new RTCPeerConnection({
      iceServers: this.opts.iceServers ?? DEFAULT_ICE_SERVERS,
    });

    pc.ontrack = (ev) => {
      this.remote.addTrack(ev.track);
      this.opts.onTrack(this.remote);
    };

    pc.onicecandidate = (ev) => {
      if (!ev.candidate) return; // end-of-candidates; TS6 sends no such marker
      this.signal("iceCandidate", {
        sdp: ev.candidate.candidate,
        mid: ev.candidate.sdpMid ?? "0",
        mLine: ev.candidate.sdpMLineIndex ?? 0,
      });
    };

    pc.onconnectionstatechange = () => {
      this.opts.onStateChange?.(pc.connectionState);
      if (pc.connectionState === "failed") this.fail("The stream connection failed");
    };

    this.pc = pc;
    return pc;
  }

  private signal(cmd: string, args: unknown): void {
    this.opts.send({
      type: "streamSignal",
      streamId: this.streamId,
      clientId: this.peerClientId,
      payload: { cmd, args },
    });
  }

  private fail(message: string): void {
    this.opts.onError?.(message);
  }

  /** Leaves the stream and releases the peer connection. Safe to call twice. */
  close(): void {
    if (this.closed) return;
    this.closed = true;

    this.opts.send({
      type: "leaveStream",
      streamId: this.streamId,
      clientId: this.peerClientId,
    });

    for (const track of this.remote.getTracks()) track.stop();
    this.pc?.close();
    this.pc = null;
    this.opts.onClosed?.();
  }
}

/**
 * Builds an `RTCIceCandidateInit` from TS6's `iceCandidate` args.
 *
 * TS6 names them `sdp`, `mid` and `mLine`, which map to `candidate`, `sdpMid`
 * and `sdpMLineIndex`.
 */
function candidateFromArgs(args: Record<string, unknown>): RTCIceCandidateInit | null {
  const candidate = args.sdp;
  if (typeof candidate !== "string" || !candidate) return null;
  return {
    candidate,
    sdpMid: typeof args.mid === "string" ? args.mid : undefined,
    sdpMLineIndex: typeof args.mLine === "number" ? args.mLine : undefined,
  };
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
