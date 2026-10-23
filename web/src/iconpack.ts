import { unzipSync } from "fflate";

/** Icons an icon pack can replace. Each element that shows one carries
 *  data-pack-icon="<id>"; iconPackCss() swaps its default for the pack's image. */
export type PackIconId =
  | "talkIdle"
  | "talking"
  | "micMuted"
  | "hardwareMicMuted"
  | "soundMuted"
  | "away"
  | "commanderIdle"
  | "commanderTalking"
  | "channel"
  | "server";

/** TS3 icon pack file names (gfx/<pack>/16x16_<name>.png or <name>.svg). */
const TS3_NAMES: Record<PackIconId, string> = {
  talkIdle: "player_off",
  talking: "player_on",
  micMuted: "input_muted",
  hardwareMicMuted: "hardware_input_muted",
  soundMuted: "output_muted",
  away: "away",
  commanderIdle: "player_commander_off",
  commanderTalking: "player_commander_on",
  channel: "channel_green",
  server: "server_green",
};

const MIME_BY_EXTENSION: Record<string, string> = {
  svg: "image/svg+xml",
  png: "image/png",
  gif: "image/gif",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

export interface IconPack {
  id: string;
  name: string;
  /** data: URLs */
  icons: Partial<Record<PackIconId, string>>;
}

const PACKS_KEY = "webspeak3:icon-packs";
const SELECTED_KEY = "webspeak3:icon-pack";

export function loadIconPacks(): IconPack[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(PACKS_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Throws when localStorage is full (a pack with huge images). */
export function saveIconPacks(packs: IconPack[]): void {
  localStorage.setItem(PACKS_KEY, JSON.stringify(packs));
}

export function loadSelectedIconPack(): string {
  return localStorage.getItem(SELECTED_KEY) ?? "";
}

export function saveSelectedIconPack(id: string): void {
  localStorage.setItem(SELECTED_KEY, id);
}

function toDataUrl(data: Uint8Array, mime: string): string {
  let binary = "";
  for (let i = 0; i < data.length; i += 0x8000) binary += String.fromCharCode(...data.subarray(i, i + 0x8000));
  return `data:${mime};base64,${btoa(binary)}`;
}

/** Reads a .ts3_iconpack (a zip) or any zip of images named like TS3's icons.
 *  Returns null when nothing in it matches a known icon. */
export async function parseIconPack(file: File): Promise<IconPack | null> {
  const entries = unzipSync(new Uint8Array(await file.arrayBuffer()), {
    filter: (entry) => (entry.name.split(".").pop()?.toLowerCase() ?? "") in MIME_BY_EXTENSION,
  });
  const byStem = new Map<string, { data: Uint8Array; ext: string }>();
  for (const [path, data] of Object.entries(entries)) {
    const base = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
    const ext = base.slice(base.lastIndexOf(".") + 1);
    const stem = base.slice(0, base.lastIndexOf(".")).replace(/^\d+x\d+_/, "");
    // Several sizes of the same icon: an SVG beats any PNG, else the largest file.
    const prev = byStem.get(stem);
    if (!prev || (ext === "svg" && prev.ext !== "svg") || (prev.ext !== "svg" && data.length > prev.data.length))
      byStem.set(stem, { data, ext });
  }
  const icons: IconPack["icons"] = {};
  for (const [id, name] of Object.entries(TS3_NAMES) as [PackIconId, string][]) {
    const hit = byStem.get(name);
    if (hit) icons[id] = toDataUrl(hit.data, MIME_BY_EXTENSION[hit.ext]);
  }
  if (Object.keys(icons).length === 0) return null;
  return {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name: file.name.replace(/\.(ts3_iconpack|zip)$/i, ""),
    icons,
  };
}

export function iconPackCss(pack: IconPack | undefined): string {
  if (!pack) return "";
  return Object.entries(pack.icons)
    .map(
      ([id, url]) => `.ts-app [data-pack-icon="${id}"] {
  background: url("${url}") center / contain no-repeat !important;
  border: 0 !important;
  border-radius: 0 !important;
  box-shadow: none !important;
  color: transparent !important;
  display: inline-block !important;
  width: 16px !important;
  height: 16px !important;
  overflow: hidden;
  vertical-align: middle;
}
.ts-app [data-pack-icon="${id}"] > *, .ts-app [data-pack-icon="${id}"]::after { visibility: hidden !important; }`
    )
    .join("\n");
}
