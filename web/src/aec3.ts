// Lazy loader for Google WebRTC's AEC3 (compiled to WASM via
// @ennuicastr/webrtcaec3.js), an opt-in, stronger alternative to the browser's
// native echo cancellation for speaker+mic (no headset) setups where native
// AEC often isn't enough (github.com/Moepchi/webspeak3 issue #2). Loaded as a
// plain <script> tag rather than bundled: the module's own glue code resolves
// its .wasm file next to its own <script src>, by a name it decides itself -
// see scripts/sync-aec3-assets.mjs for how that file gets there.

export interface Aec3Instance {
  free(): void;
  analyze(data: Float32Array[]): void;
  processSize(data: Float32Array[]): number;
  process(out: Float32Array[], data: Float32Array[]): void;
}

interface Aec3Module {
  AEC3: new (sampleRate: number, renderChannels: number, captureChannels: number) => Aec3Instance;
}

declare global {
  interface Window {
    WebRtcAec3?: () => Promise<Aec3Module>;
  }
}

let modulePromise: Promise<Aec3Module> | null = null;

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.src = src;
    el.onload = () => resolve();
    el.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(el);
  });
}

function loadModule(): Promise<Aec3Module> {
  if (!modulePromise) {
    modulePromise = loadScript("/vendor/webrtcaec3.js").then(() => {
      if (!window.WebRtcAec3) throw new Error("AEC3 script loaded but did not register window.WebRtcAec3");
      return window.WebRtcAec3();
    });
  }
  return modulePromise;
}

/** Creates a fresh AEC3 instance. `renderChannels` must match the channel
 *  count passed to `analyze()`, `captureChannels` the count passed to
 *  `process()`. */
export async function createAec3(
  sampleRate: number,
  renderChannels: number,
  captureChannels: number,
): Promise<Aec3Instance> {
  const mod = await loadModule();
  return new mod.AEC3(sampleRate, renderChannels, captureChannels);
}
