// Encoding/decoding and Web Audio plumbing for the voice feature.
//
// The connector always speaks 48kHz PCM in 20ms frames: mono for the
// microphone -> server direction (which it Opus-encodes), stereo mixed
// for the server -> speakers direction (already decoded/mixed for us).

export const SAMPLE_RATE = 48000;
export const FRAME_SAMPLES = 960; // 20ms @ 48kHz

function int16ToBase64(samples: Int16Array): string {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToInt16(b64: string): Int16Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Int16Array(bytes.buffer);
}

export interface MicCaptureOptions {
  onFrame: (base64Pcm: string) => void;
  onActivity?: (active: boolean) => void;
  /** Reports the raw input RMS (roughly 0-1) on every processing tick, for live level meters. */
  onLevel?: (rms: number) => void;
  threshold?: number;
  /** How long transmission continues after the level drops back below the threshold, so words aren't clipped. */
  hangoverSeconds?: number;
  /** `MediaDeviceInfo.deviceId` of the input device to use - omit for the system default. */
  deviceId?: string;
  echoCancellation?: boolean;
  noiseSuppression?: boolean;
  /** Automatic gain control. Exposed as its own toggle (rather than folded into
   *  echoCancellation) because AGC re-amplifying the mic signal after the
   *  browser's own AEC runs can bring back audible echo residue in speaker+mic
   *  (no headset) setups - some users get a cleaner result with it off. */
  autoGainControl?: boolean;
}

/**
 * Captures the microphone and emits base64-encoded mono 16-bit PCM frames.
 *
 * Uses voice activation (like TeamSpeak's own "Sprachaktivierung"): frames are
 * only sent while the input level is above `threshold`, plus a short hangover
 * so the tail of a word isn't cut off. `onActivity` reports transitions so the
 * UI can show a local "currently transmitting" indicator.
 */
export class MicCapture {
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private silence: GainNode | null = null;
  private monitorTarget: AudioNode | null = null;
  private pending: number[] = [];
  private active = false;
  private activeUntil = 0;
  private onFrame: (base64Pcm: string) => void;
  private onActivity?: (active: boolean) => void;
  private onLevel?: (rms: number) => void;
  private deviceId?: string;
  private echoCancellation: boolean;
  private noiseSuppression: boolean;
  private autoGainControl: boolean;
  private context: AudioContext;
  threshold: number;
  hangoverSeconds: number;

  constructor(context: AudioContext, options: MicCaptureOptions) {
    this.context = context;
    this.onFrame = options.onFrame;
    this.onActivity = options.onActivity;
    this.onLevel = options.onLevel;
    this.threshold = options.threshold ?? 0.02;
    this.hangoverSeconds = options.hangoverSeconds ?? 0.3;
    this.deviceId = options.deviceId;
    this.echoCancellation = options.echoCancellation ?? true;
    this.noiseSuppression = options.noiseSuppression ?? true;
    this.autoGainControl = options.autoGainControl ?? true;
  }

  async start(): Promise<void> {
    if (!navigator.mediaDevices) {
      throw new Error("Microphone access requires HTTPS (or localhost) - the site is not a secure context.");
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        // Requesting the pipeline's own rate (rather than leaving it to the
        // device/OS default) avoids an extra internal resampling step ahead
        // of the browser's own echo canceller - standard constraint, honored
        // by both Chromium and Firefox, "ideal" so it's not fatal if a device
        // genuinely can't provide it.
        sampleRate: { ideal: SAMPLE_RATE },
        echoCancellation: this.echoCancellation,
        noiseSuppression: this.noiseSuppression,
        autoGainControl: this.autoGainControl,
        ...(this.deviceId ? { deviceId: { exact: this.deviceId } } : {}),
      },
    });
    // Granting the permission prompt counts as a user gesture, so this can
    // succeed even when start() was triggered automatically on page load,
    // before the AudioContext would otherwise be allowed to leave "suspended".
    if (this.context.state === "suspended") await this.context.resume();
    this.source = this.context.createMediaStreamSource(this.stream);
    this.processor = this.context.createScriptProcessor(2048, 1, 1);
    this.processor.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);

      let sumSquares = 0;
      for (let i = 0; i < input.length; i++) sumSquares += input[i] * input[i];
      const rms = Math.sqrt(sumSquares / input.length);
      this.onLevel?.(rms);

      const now = this.context.currentTime;
      if (rms >= this.threshold) this.activeUntil = now + this.hangoverSeconds;
      const shouldBeActive = now < this.activeUntil;
      if (shouldBeActive !== this.active) {
        this.active = shouldBeActive;
        this.onActivity?.(this.active);
        if (!this.active) this.pending = [];
      }

      if (!this.active) return;

      for (let i = 0; i < input.length; i++) this.pending.push(input[i]);
      while (this.pending.length >= FRAME_SAMPLES) {
        const frame = this.pending.splice(0, FRAME_SAMPLES);
        const int16 = new Int16Array(FRAME_SAMPLES);
        for (let i = 0; i < FRAME_SAMPLES; i++) {
          const clamped = Math.max(-1, Math.min(1, frame[i]));
          int16[i] = clamped < 0 ? clamped * 32768 : clamped * 32767;
        }
        this.onFrame(int16ToBase64(int16));
      }
    };
    // A ScriptProcessorNode only fires while connected to a destination; route
    // it through a muted gain node so we don't hear our own mic echoed back.
    this.silence = this.context.createGain();
    this.silence.gain.value = 0;
    this.source.connect(this.processor);
    this.processor.connect(this.silence);
    this.silence.connect(this.context.destination);
  }

  /** The raw mic input node, e.g. to additionally route it into a recorder. */
  getSourceNode(): AudioNode | null {
    return this.source;
  }

  /** Routes the raw mic signal to `destination` too, so you can hear yourself (a mic test), until disabled again. */
  setMonitoring(enabled: boolean, destination: AudioNode): void {
    if (!this.source) return;
    if (enabled && this.monitorTarget !== destination) {
      if (this.monitorTarget) this.source.disconnect(this.monitorTarget);
      this.source.connect(destination);
      this.monitorTarget = destination;
    } else if (!enabled && this.monitorTarget) {
      this.source.disconnect(this.monitorTarget);
      this.monitorTarget = null;
    }
  }

  stop(): void {
    if (this.source && this.monitorTarget) this.source.disconnect(this.monitorTarget);
    this.monitorTarget = null;
    this.processor?.disconnect();
    this.silence?.disconnect();
    this.source?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.processor = null;
    this.silence = null;
    this.source = null;
    this.stream = null;
    this.pending = [];
    if (this.active) {
      this.active = false;
      this.onActivity?.(false);
    }
  }
}

function writeAsciiString(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

/** Encodes raw stereo float samples (range -1..1) as an uncompressed 16-bit PCM WAV file. */
export function encodeWavStereo(left: Float32Array, right: Float32Array, sampleRate: number): Blob {
  const numChannels = 2;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = left.length * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeAsciiString(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAsciiString(view, 8, "WAVE");
  writeAsciiString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeAsciiString(view, 36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < left.length; i++) {
    const l = Math.max(-1, Math.min(1, left[i]));
    const r = Math.max(-1, Math.min(1, right[i]));
    view.setInt16(offset, l < 0 ? l * 0x8000 : l * 0x7fff, true);
    view.setInt16(offset + 2, r < 0 ? r * 0x8000 : r * 0x7fff, true);
    offset += blockAlign;
  }

  return new Blob([buffer], { type: "audio/wav" });
}

/** Output ("audiooutput") devices available for playback, e.g. for a device picker. */
export async function listAudioOutputDevices(): Promise<MediaDeviceInfo[]> {
  if (!navigator.mediaDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === "audiooutput");
}

/** Input ("audioinput") devices available for the mic, e.g. for a device picker. */
export async function listAudioInputDevices(): Promise<MediaDeviceInfo[]> {
  if (!navigator.mediaDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === "audioinput");
}

type MediaDevicesWithPicker = MediaDevices & { selectAudioOutput?: () => Promise<MediaDeviceInfo> };

/** Whether the browser supports the native OS output-device picker (Chrome/Edge 105+). */
export function hasNativeOutputPicker(): boolean {
  if (!navigator.mediaDevices) return false;
  return typeof (navigator.mediaDevices as MediaDevicesWithPicker).selectAudioOutput === "function";
}

/**
 * Opens the browser's native OS device chooser for audio output. Unlike
 * `enumerateDevices()`, this lists every device the OS knows about (including
 * ones like a USB headset that plain enumeration can otherwise omit) and asks
 * the user to pick one, each call - no persistent listing to keep in sync.
 */
export async function pickAudioOutputDevice(): Promise<MediaDeviceInfo | null> {
  if (!navigator.mediaDevices) return null;
  const md = navigator.mediaDevices as MediaDevicesWithPicker;
  if (typeof md.selectAudioOutput !== "function") return null;
  return md.selectAudioOutput();
}

type SinkableElement = HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
type SinkableContext = AudioContext & { setSinkId?: (id: string) => Promise<void> };

/**
 * Schedules incoming base64-encoded stereo 16-bit PCM frames for gap-free
 * playback, and supports switching output device across browsers.
 *
 * Playback is routed through a `MediaStreamAudioDestinationNode` into a
 * hidden `<audio>` element rather than straight to `context.destination`,
 * because device switching support is split across browsers:
 * `AudioContext.setSinkId` (Chrome 110+) only retargets the context itself,
 * while `HTMLMediaElement.setSinkId` (Chrome, and Firefox 130+) only works on
 * a media element. Routing through the element lets `setOutputDevice` use
 * whichever one the browser actually supports.
 */
export class AudioPlayer {
  private nextTime = 0;
  private destination: MediaStreamAudioDestinationNode;
  private element: SinkableElement;
  private gain: GainNode;
  private context: AudioContext;

  constructor(context: AudioContext) {
    this.context = context;
    this.destination = context.createMediaStreamDestination();
    this.gain = context.createGain();
    this.gain.connect(this.destination);
    this.element = document.createElement("audio") as SinkableElement;
    this.element.autoplay = true;
    this.element.srcObject = this.destination.stream;
    this.element.style.display = "none";
    document.body.appendChild(this.element);
  }

  playFrame(base64Pcm: string): void {
    const int16 = base64ToInt16(base64Pcm);
    const frames = int16.length / 2;
    if (frames <= 0) return;

    const buffer = this.context.createBuffer(2, frames, SAMPLE_RATE);
    const left = buffer.getChannelData(0);
    const right = buffer.getChannelData(1);
    for (let i = 0; i < frames; i++) {
      left[i] = int16[i * 2] / 32768;
      right[i] = int16[i * 2 + 1] / 32768;
    }

    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gain);

    const now = this.context.currentTime;
    if (this.nextTime < now + 0.02) {
      // First frame, or we fell behind - restart just ahead of now instead of
      // letting a backlog build up.
      this.nextTime = now + 0.02;
    }
    source.start(this.nextTime);
    this.nextTime += frames / SAMPLE_RATE;
  }

  reset(): void {
    this.nextTime = 0;
  }

  /** Playback volume as linear gain (1 = unity/0dB). */
  setVolume(gain: number): void {
    this.gain.gain.value = gain;
  }

  /** The node all voice/test audio ultimately reaches - use as a mic-monitoring target so it also respects volume/output device. */
  getInputNode(): AudioNode {
    return this.gain;
  }

  /** Plays a short sine-wave test tone through the same volume/output-device routing as voice playback. */
  playTestTone(): void {
    const osc = this.context.createOscillator();
    osc.type = "sine";
    osc.frequency.value = 440;
    const toneGain = this.context.createGain();
    toneGain.gain.value = 0.3;
    osc.connect(toneGain);
    toneGain.connect(this.gain);
    const now = this.context.currentTime;
    osc.start(now);
    osc.stop(now + 0.6);
    osc.onended = () => {
      osc.disconnect();
      toneGain.disconnect();
    };
  }

  /** Routes playback to a specific device (empty string = system default). */
  async setOutputDevice(deviceId: string): Promise<void> {
    if (typeof this.element.setSinkId === "function") {
      await this.element.setSinkId(deviceId);
      return;
    }
    const ctx = this.context as SinkableContext;
    if (typeof ctx.setSinkId === "function") {
      await ctx.setSinkId(deviceId);
    }
    // Neither API is available - stays on the system default output.
  }

  dispose(): void {
    this.element.pause();
    this.element.srcObject = null;
    this.element.remove();
    this.destination.stream.getTracks().forEach((t) => t.stop());
  }
}
