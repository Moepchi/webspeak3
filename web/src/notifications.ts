import { unzipSync } from "fflate";
import { SOUND_EVENTS, playSound, playSoundBlob, type SoundEventId } from "./sounds";

/** Options -> Meldungen: TS3's notification tree. Keys are TeamSpeak's own
 *  sound pack keys, so a real .ts3_soundpack's settings.ini maps 1:1. */
export interface NotificationNode {
  /** Locale key under "notify.". */
  label: string;
  key?: string;
  children?: NotificationNode[];
}

const leaf = (label: string, key: string): NotificationNode => ({ label, key });
const group = (label: string, children: NotificationNode[]): NotificationNode => ({ label, children });
const byWho = (p: string) => [leaf("byYou", `${p}_BY_YOU`), leaf("byOther", `${p}_BY_OTHER`)];
const where = (p: string) => [leaf("server", `${p}_SERVER`), leaf("currentChannel", `${p}_CURRENT_CHANNEL`)];
const byServerUser = (p: string) => [leaf("byServer", `${p}_BY_SERVER`), leaf("byUser", `${p}_BY_USER`)];
const moves = (p: string) => [
  group("toCurrent", [leaf("appears", `${p}_TO_CURRENT_CHANNEL_APPEARS`), leaf("stays", `${p}_TO_CURRENT_CHANNEL_STAYS`)]),
  group("fromCurrent", [
    leaf("disappears", `${p}_FROM_CURRENT_CHANNEL_DISAPPEARS`),
    leaf("stays", `${p}_FROM_CURRENT_CHANNEL_STAYS`),
  ]),
  group("toOther", [
    leaf("appears", `${p}_TO_OTHER_CHANNEL_APPEARS`),
    leaf("disappears", `${p}_TO_OTHER_CHANNEL_DISAPPEARS`),
    leaf("stays", `${p}_TO_OTHER_CHANNEL_STAYS`),
  ]),
];

export const NOTIFICATION_TREE: NotificationNode[] = [
  group("connection", [
    leaf("connected", "CONNECTION_CONNECTED"),
    leaf("disconnected", "CONNECTION_DISCONNECTED"),
    leaf("lostConnection", "CONNECTION_LOST_CONNECTION"),
  ]),
  group("channel", [
    group("created", byWho("CHANNEL_CREATED")),
    group("deleted", byWho("CHANNEL_DELETED")),
    group("edited", [
      group("currentChannel", byWho("CHANNEL_EDITED_CURRENT")),
      group("otherChannel", byWho("CHANNEL_EDITED_OTHER")),
    ]),
    group("moved", byWho("CHANNEL_MOVED")),
  ]),
  group("server", [
    group("edited", byWho("SERVER_EDITED")),
    leaf("insufficientPermissions", "SERVER_INSUFFICIENT_PERMISSIONS"),
    leaf("error", "SERVER_ERROR"),
  ]),
  group("client", [
    group("connection", [
      group("connected", where("CLIENT_CONNECTION_CONNECTED")),
      group("disconnected", where("CLIENT_CONNECTION_DISCONNECTED")),
      group("lostConnection", where("CLIENT_CONNECTION_LOST_CONNECTION")),
    ]),
    group("switched", moves("CLIENT_SWITCHED")),
    group("movedClient", moves("CLIENT_MOVED")),
    group("kickedChannel", moves("CLIENT_WAS_KICKED_FROM_CHANNEL")),
    group("kickedServer", where("CLIENT_WAS_KICKED_FROM_SERVER")),
    group("banned", where("CLIENT_WAS_BANNED")),
    group("serverGroup", [
      group("added", byServerUser("CLIENT_SERVERGROUP_ADDED")),
      group("removed", byServerUser("CLIENT_SERVERGROUP_REMOVED")),
    ]),
    group("channelGroup", byServerUser("CLIENT_CHANNELGROUP_CHANGED")),
    group("recording", [
      leaf("recordingStart", "CLIENT_RECORDING_START"),
      leaf("recordingStop", "CLIENT_RECORDING_STOP"),
      leaf("recordingInChannel", "CLIENT_RECORDING_IN_CHANNEL"),
    ]),
    leaf("talkPowerRequested", "CLIENT_REQUESTED_TALK_POWER"),
  ]),
  group("self", [
    leaf("youSwitched", "YOU_SWITCHED_CHANNEL"),
    leaf("youMoved", "YOU_WERE_MOVED_TO_DIFFERENT_CHANNEL"),
    leaf("youKickedServer", "YOU_WERE_KICKED_FROM_SERVER"),
    leaf("youKickedChannel", "YOU_WERE_KICKED_FROM_CHANNEL"),
    leaf("youBanned", "YOU_WERE_BANNED"),
    leaf("talkPowerGranted", "YOU_WERE_GRANTED_TALK_POWER"),
    leaf("talkPowerRevoked", "YOU_WERE_REVOKED_TALK_POWER"),
    group("serverGroup", [
      group("added", byServerUser("YOU_SERVERGROUP_ADDED")),
      group("removed", byServerUser("YOU_SERVERGROUP_REMOVED")),
    ]),
    group("channelGroup", byServerUser("YOU_CHANNELGROUP_CHANGED")),
  ]),
  group("chat", [leaf("messageSent", "CHAT_SENT_MESSAGE"), leaf("messageReceived", "CHAT_RECEIVED_MESSAGE")]),
  group("capture", [leaf("muted", "SOUND_CAPTURE_MUTED"), leaf("unmuted", "SOUND_CAPTURE_UNMUTED")]),
  group("playback", [leaf("muted", "SOUND_PLAYBACK_MUTED"), leaf("unmuted", "SOUND_PLAYBACK_UNMUTED")]),
  group("status", [leaf("away", "STATUS_SET_AWAY"), leaf("present", "STATUS_SET_PRESENT")]),
  group("other", [
    leaf("poked", "OTHER_RECEIVED_POKE"),
    leaf("transferComplete", "OTHER_FILETRANSFER_COMPLETE"),
    leaf("transferFailed", "OTHER_FILETRANSFER_FAILED"),
    leaf("whisperListEmpty", "OTHER_WHISPERLIST_EMPTY"),
    leaf("whisperTargetNotFound", "OTHER_WHISPERTARGET_NOT_FOUND"),
    leaf("whisperTooMany", "OTHER_WHISPERTARGET_TOO_MANY"),
  ]),
  // Like native: no checkboxes here, these are switched on/off on their own options pages.
  group("special", [
    leaf("micClickOtherOn", "SPECIAL_MIC_CLICK_OTHER_ON"),
    leaf("micClickOtherOff", "SPECIAL_MIC_CLICK_OTHER_OFF"),
    leaf("micClickSelfOn", "SPECIAL_MIC_CLICK_SELF_ON"),
    leaf("micClickSelfOff", "SPECIAL_MIC_CLICK_SELF_OFF"),
    leaf("whisperNotify", "SPECIAL_WHISPER_NOTIFY"),
    leaf("soundTest", "SPECIAL_SOUND_TEST"),
    leaf("test3d", "SPECIAL_3D_TEST"),
    leaf("talkingWhileMuted", "SPECIAL_TALKING_WHILE_MUTED"),
  ]),
];

export const isSpecialKey = (key: string) => key.startsWith("SPECIAL_");

/** WebSpeak3's own pack: plays the chimes from Options -> Sounds (or the file you put there). */
const BUILTIN_SCRIPTS: Record<string, SoundEventId> = {
  CONNECTION_CONNECTED: "connect",
  CONNECTION_DISCONNECTED: "disconnect",
  CONNECTION_LOST_CONNECTION: "disconnect",
  CLIENT_CONNECTION_CONNECTED_SERVER: "clientJoin",
  CLIENT_CONNECTION_CONNECTED_CURRENT_CHANNEL: "clientJoin",
  CLIENT_CONNECTION_DISCONNECTED_SERVER: "clientLeave",
  CLIENT_CONNECTION_DISCONNECTED_CURRENT_CHANNEL: "clientLeave",
  CLIENT_CONNECTION_LOST_CONNECTION_SERVER: "clientLeave",
  CLIENT_CONNECTION_LOST_CONNECTION_CURRENT_CHANNEL: "clientLeave",
  CLIENT_SWITCHED_TO_CURRENT_CHANNEL_APPEARS: "clientJoin",
  CLIENT_SWITCHED_TO_CURRENT_CHANNEL_STAYS: "clientJoin",
  CLIENT_SWITCHED_FROM_CURRENT_CHANNEL_DISAPPEARS: "clientLeave",
  CLIENT_SWITCHED_FROM_CURRENT_CHANNEL_STAYS: "clientLeave",
  CHAT_RECEIVED_MESSAGE: "message",
  OTHER_RECEIVED_POKE: "poke",
  SOUND_CAPTURE_MUTED: "mute",
  SOUND_CAPTURE_UNMUTED: "mute",
  SOUND_PLAYBACK_MUTED: "mute",
  SOUND_PLAYBACK_UNMUTED: "mute",
  SPECIAL_MIC_CLICK_OTHER_ON: "micClickOn",
  SPECIAL_MIC_CLICK_OTHER_OFF: "micClickOff",
  SPECIAL_MIC_CLICK_SELF_ON: "micClickOn",
  SPECIAL_MIC_CLICK_SELF_OFF: "micClickOff",
  SPECIAL_WHISPER_NOTIFY: "whisper",
};

export const BUILTIN_PACK = "builtin";
export const NO_SOUNDS_PACK = "none";

export interface SoundPack {
  id: string;
  name: string;
  scripts: Record<string, string>;
  /** Lowercased path relative to settings.ini -> audio. */
  files: Record<string, Blob>;
}

export type TextPosition = "none" | "server" | "channel";

export interface NotificationOverride {
  off?: boolean;
  script?: string;
  text?: TextPosition;
}

export interface NotificationSettings {
  pack: string;
  whenMuted: "all" | "none";
  overrides: Record<string, NotificationOverride>;
}

const SETTINGS_KEY = "webspeak3:notification-settings";
const DEFAULT_SETTINGS: NotificationSettings = { pack: BUILTIN_PACK, whenMuted: "all", overrides: {} };

let settings: NotificationSettings = (() => {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") };
  } catch {
    return DEFAULT_SETTINGS;
  }
})();

export const getNotificationSettings = () => settings;

export function saveNotificationSettings(next: NotificationSettings): void {
  settings = next;
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
}

/** Set by the app: output muted state, and the active favorite's pack override. */
let playbackMuted = false;
let sessionPack: string | undefined;
export const setNotificationPlaybackMuted = (muted: boolean) => void (playbackMuted = muted);
export const setSessionSoundPack = (pack: string | undefined) => void (sessionPack = pack || undefined);

// --- imported packs (IndexedDB, blobs don't fit localStorage) ---

function withPacks<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("webspeak3-soundpacks", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("packs", { keyPath: "id" });
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const req = run(open.result.transaction("packs", mode).objectStore("packs"));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    };
  });
}

let packsCache: Promise<SoundPack[]> | null = null;

export function loadSoundPacks(): Promise<SoundPack[]> {
  packsCache ??= withPacks<SoundPack[]>("readonly", (s) => s.getAll()).catch(() => []);
  return packsCache;
}

export async function deleteSoundPack(id: string): Promise<void> {
  await withPacks("readwrite", (s) => s.delete(id)).catch(() => {});
  packsCache = null;
}

const AUDIO = /\.(wav|mp3|ogg|m4a)$/i;

/** Parses a TS3 sound pack (.ts3_soundpack / .zip with a settings.ini). */
export function parseSoundPackZip(data: Uint8Array, fallbackName: string): SoundPack {
  const entries = unzipSync(data);
  const iniPath = Object.keys(entries)
    .filter((p) => p.toLowerCase().endsWith("settings.ini"))
    .sort((a, b) => a.length - b.length)[0];
  if (!iniPath) throw new Error("settings.ini missing");
  const base = iniPath.slice(0, iniPath.length - "settings.ini".length).toLowerCase();
  const ini = new TextDecoder().decode(entries[iniPath]);
  let section = "";
  let name = fallbackName;
  const scripts: Record<string, string> = {};
  for (const raw of ini.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const head = /^\[(.+)\]$/.exec(line);
    if (head) {
      section = head[1].toLowerCase();
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    const v = line.slice(eq + 1).trim();
    if (section === "info" && k === "name" && v) name = v;
    else if (section === "soundfiles") scripts[k] = v;
  }
  const files: Record<string, Blob> = {};
  for (const [path, bytes] of Object.entries(entries)) {
    const lower = path.toLowerCase();
    if (lower.startsWith(base) && AUDIO.test(lower)) files[lower.slice(base.length)] = new Blob([bytes.slice()]);
  }
  return { id: `pack:${Date.now()}`, name, scripts, files };
}

export async function importSoundPack(file: File): Promise<SoundPack> {
  const pack = parseSoundPackZip(new Uint8Array(await file.arrayBuffer()), file.name.replace(/\.[^.]+$/, ""));
  await withPacks("readwrite", (s) => s.put(pack));
  packsCache = null;
  return pack;
}

// --- resolving + playing ---

/** The pack's own script for a key ("" = silent). */
export function packScript(pack: SoundPack | undefined, packId: string, key: string): string {
  if (packId === NO_SOUNDS_PACK) return "";
  if (packId === BUILTIN_PACK) return BUILTIN_SCRIPTS[key] ? `play("${BUILTIN_SCRIPTS[key]}")` : "";
  return pack?.scripts[key] ?? "";
}

export const isNotificationEnabled = (key: string) => isSpecialKey(key) || !settings.overrides[key]?.off;

/** Where the event's text goes; "none" also when the row is unticked. */
export function notificationTextPosition(key: string): TextPosition {
  if (!isNotificationEnabled(key)) return "none";
  return settings.overrides[key]?.text ?? "server";
}

export type NotificationVars = Record<string, string>;

export async function runSoundScript(script: string, packId: string, vars: NotificationVars = {}): Promise<void> {
  const pack = packId.startsWith("pack:") ? (await loadSoundPacks()).find((p) => p.id === packId) : undefined;
  const fill = (s: string) => s.replace(/\$\{(\w+)\}/g, (_, v: string) => vars[v] ?? (v === "clientType" ? "neutral" : ""));
  for (const [, fn, arg] of script.matchAll(/(play|say)\(\s*"([^"]*)"\s*\)/g)) {
    const value = fill(arg);
    if (fn === "say") {
      if ("speechSynthesis" in window) speechSynthesis.speak(new SpeechSynthesisUtterance(value));
    } else if (packId === BUILTIN_PACK || !pack) {
      if ((SOUND_EVENTS as string[]).includes(value)) await playSound(value as SoundEventId);
    } else {
      const blob = pack.files[value.toLowerCase().replace(/\\/g, "/")];
      if (blob) await playSoundBlob(blob);
    }
  }
}

/** Plays the sound for a TS3 notification key, honouring the Meldungen settings. */
export async function notify(key: string, vars?: NotificationVars): Promise<void> {
  if (!isNotificationEnabled(key)) return;
  if (playbackMuted && settings.whenMuted === "none") return;
  const packId = sessionPack ?? settings.pack;
  const override = settings.overrides[key]?.script;
  const pack = packId.startsWith("pack:") ? (await loadSoundPacks()).find((p) => p.id === packId) : undefined;
  await runSoundScript(override ?? packScript(pack, packId, key), packId, vars);
}
