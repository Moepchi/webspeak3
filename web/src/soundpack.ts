import { unzipSync } from "fflate";
import type { SoundEventId } from "./sounds";

const AUDIO_EXTENSIONS = [".wav", ".mp3", ".ogg", ".m4a"];

const MIME_BY_EXTENSION: Record<string, string> = {
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
};

/** Real .ts3soundpack files use TeamSpeak's own internal event names, which
 *  vary between client versions and aren't documented anywhere stable - so
 *  this matches by keyword against the filename (soundpacks are zips of
 *  individual audio files, not proprietary-encoded) rather than depending on
 *  an exact manifest format. Falls back to a "not matched" list the caller
 *  can surface, instead of silently dropping unrecognized files. */
const EVENT_KEYWORDS: Record<SoundEventId, string[]> = {
  connect: ["connectionaccepted", "connectionestablished", "youhaveconnected", "connect"],
  disconnect: ["connectionlost", "connectiondisconnected", "youhavebeendisconnected", "disconnect"],
  clientJoin: ["userenteredchannel", "userenteredvisibility", "cliententerview", "userjoined", "enter"],
  clientLeave: ["userleftchannel", "userleftvisibility", "clientleftview", "userleave", "userleft", "leave"],
  message: ["textmessagereceived", "chatmessage", "newmessage", "message"],
  poke: ["gotpoked", "poke"],
  mute: ["micmuted", "microphonemuted", "micactivated", "microphoneactivated"],
  micClickOn: ["micclickon"],
  micClickOff: ["micclickoff"],
  whisper: ["whisperreceived", "whisper"],
};

function normalize(filename: string): string {
  const base = filename.slice(filename.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return (dot === -1 ? base : base.slice(0, dot)).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function extensionOf(filename: string): string | null {
  const lower = filename.toLowerCase();
  return AUDIO_EXTENSIONS.find((ext) => lower.endsWith(ext)) ?? null;
}

export interface SoundpackImportResult {
  matched: Partial<Record<SoundEventId, { name: string; blob: Blob }>>;
  unmatchedFiles: string[];
}

export async function parseSoundpack(file: File): Promise<SoundpackImportResult> {
  const buffer = new Uint8Array(await file.arrayBuffer());
  const entries = unzipSync(buffer, {
    filter: (entry) => extensionOf(entry.name) !== null,
  });

  const matched: SoundpackImportResult["matched"] = {};
  const unmatchedFiles: string[] = [];

  for (const [name, data] of Object.entries(entries)) {
    const ext = extensionOf(name);
    if (!ext) continue;
    const key = normalize(name);
    const eventId = (Object.keys(EVENT_KEYWORDS) as SoundEventId[]).find(
      (id) => !matched[id] && EVENT_KEYWORDS[id].some((keyword) => key.includes(keyword))
    );
    if (eventId) {
      matched[eventId] = {
        name: name.slice(name.lastIndexOf("/") + 1),
        blob: new Blob([data.slice()], { type: MIME_BY_EXTENSION[ext] }),
      };
    } else {
      unmatchedFiles.push(name);
    }
  }

  return { matched, unmatchedFiles };
}
