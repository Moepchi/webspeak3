export type SoundEventId =
  | "connect"
  | "disconnect"
  | "clientJoin"
  | "clientLeave"
  | "message"
  | "poke"
  | "mute"
  | "micClickOn"
  | "micClickOff"
  | "whisper";

export const SOUND_EVENTS: SoundEventId[] = [
  "connect",
  "disconnect",
  "clientJoin",
  "clientLeave",
  "message",
  "poke",
  "mute",
  "micClickOn",
  "micClickOff",
  "whisper",
];

/** "ide" swaps the default chimes for synthetic terminal blips (Command Center layout). */
type SoundStyle = "classic" | "ide";
let soundStyle: SoundStyle = "classic";

export function setSoundStyle(style: SoundStyle): void {
  soundStyle = style;
}

const ENABLED_KEY = "webspeak3:sounds-enabled";
const VOLUME_KEY = "webspeak3:sounds-volume";
const EVENT_ENABLED_KEY_PREFIX = "webspeak3:sounds-enabled:";
const DB_NAME = "webspeak3-sounds";
const STORE_NAME = "custom";

interface StoredSound {
  blob: Blob;
  name: string;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveCustomSound(event: SoundEventId, file: File): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put({ blob: file, name: file.name } satisfies StoredSound, event);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function loadCustomSound(event: SoundEventId): Promise<StoredSound | undefined> {
  const db = await openDb();
  const result = await new Promise<StoredSound | undefined>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).get(event);
    req.onsuccess = () => resolve(req.result as StoredSound | undefined);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return result;
}

export async function clearCustomSound(event: SoundEventId): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(event);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export function loadSoundsEnabled(): boolean {
  const raw = localStorage.getItem(ENABLED_KEY);
  return raw === null ? true : raw === "true";
}

export function saveSoundsEnabled(enabled: boolean): void {
  localStorage.setItem(ENABLED_KEY, String(enabled));
}

export function loadEventSoundEnabled(event: SoundEventId): boolean {
  const raw = localStorage.getItem(EVENT_ENABLED_KEY_PREFIX + event);
  return raw === null ? true : raw === "true";
}

export function saveEventSoundEnabled(event: SoundEventId, enabled: boolean): void {
  localStorage.setItem(EVENT_ENABLED_KEY_PREFIX + event, String(enabled));
}

export function loadSoundsVolume(): number {
  const raw = localStorage.getItem(VOLUME_KEY);
  const n = raw ? Number(raw) : 0.5;
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.5;
}

export function saveSoundsVolume(volume: number): void {
  localStorage.setItem(VOLUME_KEY, String(volume));
}

type SinkableElement = HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };

/**
 * Notification sounds get their own AudioContext, independent from the
 * voice AudioContext in voice.ts - that one is created on connect and torn
 * down on disconnect, but sounds must keep working (and be testable from
 * Options) regardless of connection state.
 */
class NotificationSoundPlayer {
  private context: AudioContext | null = null;
  private destination: MediaStreamAudioDestinationNode | null = null;
  private element: SinkableElement | null = null;
  private outputDeviceId = "";

  private ensure(): { context: AudioContext; destination: MediaStreamAudioDestinationNode } {
    if (!this.context) {
      const context = new AudioContext();
      const destination = context.createMediaStreamDestination();
      const element: SinkableElement = new Audio();
      element.srcObject = destination.stream;
      element.autoplay = true;
      this.context = context;
      this.destination = destination;
      this.element = element;
      if (this.outputDeviceId && typeof element.setSinkId === "function") {
        element.setSinkId(this.outputDeviceId).catch(() => {});
      }
    }
    return { context: this.context, destination: this.destination! };
  }

  async setOutputDevice(deviceId: string): Promise<void> {
    this.outputDeviceId = deviceId;
    if (this.element && typeof this.element.setSinkId === "function") {
      await this.element.setSinkId(deviceId).catch(() => {});
    }
  }

  async playBlob(blob: Blob, volume: number): Promise<void> {
    const { context, destination } = this.ensure();
    if (context.state === "suspended") await context.resume().catch(() => {});
    const arrayBuffer = await blob.arrayBuffer();
    const audioBuffer = await context.decodeAudioData(arrayBuffer);
    const source = context.createBufferSource();
    source.buffer = audioBuffer;
    const gain = context.createGain();
    gain.gain.value = volume;
    source.connect(gain).connect(destination);
    source.start();
  }

  playSynth(event: SoundEventId, volume: number): void {
    const { context, destination } = this.ensure();
    if (context.state === "suspended") context.resume().catch(() => {});
    const now = context.currentTime;
    for (const note of soundStyle === "ide" ? ideNotes(event) : synthNotes(event)) {
      this.playNote(context, destination, now + note.delay, volume * note.gain, note);
    }
  }

  private playNote(
    context: AudioContext,
    destination: AudioNode,
    startTime: number,
    peakGain: number,
    { freq, endFreq, duration, type = "sine" }: SynthNote
  ): void {
    const osc = context.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, startTime);
    if (endFreq) osc.frequency.exponentialRampToValueAtTime(endFreq, startTime + duration);
    const gain = context.createGain();
    gain.gain.setValueAtTime(0, startTime);
    gain.gain.linearRampToValueAtTime(peakGain, startTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);
    osc.connect(gain).connect(destination);
    osc.start(startTime);
    osc.stop(startTime + duration + 0.05);
  }
}

/** Soft, modern two/three-note chimes - a sine-wave, quick-attack/exponential-decay
 *  shape reads as gentle rather than the harsh square/saw beeps of classic UI sounds. */
interface SynthNote {
  delay: number;
  freq: number;
  /** Glide to this frequency over the note's duration. */
  endFreq?: number;
  duration: number;
  gain: number;
  type?: OscillatorType;
}

function synthNotes(event: SoundEventId): SynthNote[] {
  switch (event) {
    case "connect":
      return [
        { delay: 0, freq: 523.25, duration: 0.16, gain: 0.5 },
        { delay: 0.09, freq: 783.99, duration: 0.22, gain: 0.5 },
      ];
    case "disconnect":
      return [
        { delay: 0, freq: 659.25, duration: 0.16, gain: 0.45 },
        { delay: 0.09, freq: 440.0, duration: 0.24, gain: 0.45 },
      ];
    case "clientJoin":
      return [{ delay: 0, freq: 880.0, duration: 0.14, gain: 0.4 }];
    case "clientLeave":
      return [{ delay: 0, freq: 587.33, duration: 0.16, gain: 0.4 }];
    case "message":
      return [
        { delay: 0, freq: 987.77, duration: 0.09, gain: 0.35 },
        { delay: 0.06, freq: 1318.51, duration: 0.12, gain: 0.3 },
      ];
    case "poke":
      return [
        { delay: 0, freq: 987.77, duration: 0.1, gain: 0.5 },
        { delay: 0.12, freq: 987.77, duration: 0.1, gain: 0.5 },
      ];
    case "mute":
      return [{ delay: 0, freq: 660, duration: 0.06, gain: 0.3 }];
    case "micClickOn":
      return [{ delay: 0, freq: 1400, duration: 0.03, gain: 0.15 }];
    case "micClickOff":
      return [{ delay: 0, freq: 900, duration: 0.03, gain: 0.15 }];
    case "whisper":
      return [
        { delay: 0, freq: 783.99, duration: 0.12, gain: 0.2 },
        { delay: 0.1, freq: 659.25, duration: 0.16, gain: 0.18 },
      ];
  }
}

/** Command Center: short, dry, synthetic blips - square/triangle clicks and
 *  quick arpeggios instead of soft chimes. Square waves are loud, so lower gains. */
function ideNotes(event: SoundEventId): SynthNote[] {
  switch (event) {
    case "connect":
      return [
        { delay: 0, freq: 440, duration: 0.1, gain: 0.3 },
        { delay: 0.1, freq: 554.37, duration: 0.1, gain: 0.3 },
        { delay: 0.2, freq: 659.25, duration: 0.14, gain: 0.3 },
      ];
    case "disconnect":
      return [{ delay: 0, freq: 200, endFreq: 50, duration: 0.2, gain: 0.45, type: "triangle" }];
    case "clientJoin":
      return [
        { delay: 0, freq: 800, duration: 0.07, gain: 0.18 },
        { delay: 0.1, freq: 800, duration: 0.07, gain: 0.18 },
      ];
    case "clientLeave":
      return [{ delay: 0, freq: 600, endFreq: 400, duration: 0.09, gain: 0.18 }];
    case "message":
      return [{ delay: 0, freq: 1200, duration: 0.04, gain: 0.12, type: "square" }];
    case "poke":
      return [
        { delay: 0, freq: 1000, duration: 0.05, gain: 0.12, type: "square" },
        { delay: 0.08, freq: 1000, duration: 0.05, gain: 0.12, type: "square" },
        { delay: 0.16, freq: 1000, duration: 0.05, gain: 0.12, type: "square" },
      ];
    case "mute":
      return [{ delay: 0, freq: 300, endFreq: 50, duration: 0.04, gain: 0.15, type: "square" }];
    case "micClickOn":
      return [{ delay: 0, freq: 1600, duration: 0.02, gain: 0.08, type: "square" }];
    case "micClickOff":
      return [{ delay: 0, freq: 1000, duration: 0.02, gain: 0.08, type: "square" }];
    case "whisper":
      return [{ delay: 0, freq: 900, endFreq: 700, duration: 0.08, gain: 0.1, type: "triangle" }];
  }
}

const player = new NotificationSoundPlayer();

export function setSoundsOutputDevice(deviceId: string): void {
  void player.setOutputDevice(deviceId);
}

export async function playSound(event: SoundEventId): Promise<void> {
  if (!loadSoundsEnabled()) return;
  if (!loadEventSoundEnabled(event)) return;
  const volume = loadSoundsVolume();
  const custom = await loadCustomSound(event).catch(() => undefined);
  if (custom) {
    try {
      await player.playBlob(custom.blob, volume);
      return;
    } catch {
      // Stored file failed to decode (corrupted/unsupported) - fall back to the default chime.
    }
  }
  player.playSynth(event, volume);
}
