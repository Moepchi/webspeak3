/** Options -> Chat ("Chat Fenster", "Automatisch protokollieren", ...). */
export interface ChatSettings {
  /** Lines kept per chat tab. */
  maxLines: number;
  /** "" = the design's font. */
  fontFamily: string;
  /** px, 0 = the design's size. */
  fontSize: number;
  logChannel: boolean;
  logPrivate: boolean;
  logServer: boolean;
  /** Prefill a new channel chat / private chat with this many logged lines (0 = off). */
  restoreChannelLines: number;
  restorePrivateLines: number;
  notifyServer: boolean;
  notifyChannel: boolean;
  notifyPrivate: boolean;
}

export const DEFAULT_CHAT_SETTINGS: ChatSettings = {
  maxLines: 500,
  fontFamily: "",
  fontSize: 0,
  logChannel: true,
  logPrivate: true,
  logServer: true,
  restoreChannelLines: 100,
  restorePrivateLines: 100,
  notifyServer: false,
  notifyChannel: true,
  notifyPrivate: true,
};

const SETTINGS_KEY = "webspeak3:chat-settings";

export function loadChatSettings(): ChatSettings {
  try {
    return { ...DEFAULT_CHAT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") };
  } catch {
    return DEFAULT_CHAT_SETTINGS;
  }
}

export function saveChatSettings(settings: ChatSettings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

export interface LoggedLine {
  from: string;
  message: string;
  self?: boolean;
  at: number;
}

// ponytail: localStorage, 1000 lines per chat. Move to IndexedDB if logs outgrow the ~5 MB quota.
const MAX_LOGGED = 1000;

/** kind: "channel" | "server" | "pm:<uid>" */
const logKey = (server: string, kind: string) => `webspeak3:chatlog:${server.trim().toLowerCase()}:${kind}`;

export function readChatLog(server: string, kind: string, lines: number): LoggedLine[] {
  if (!lines) return [];
  try {
    const all: LoggedLine[] = JSON.parse(localStorage.getItem(logKey(server, kind)) ?? "[]");
    return all.slice(-lines);
  } catch {
    return [];
  }
}

export function appendChatLog(server: string, kind: string, line: Omit<LoggedLine, "at">): void {
  try {
    const all = readChatLog(server, kind, MAX_LOGGED);
    all.push({ ...line, at: Date.now() });
    localStorage.setItem(logKey(server, kind), JSON.stringify(all.slice(-MAX_LOGGED)));
  } catch {
    // Quota full: logging is best effort.
  }
}

/** Keeps the newest `max` entries. */
export function capLines<T>(lines: T[], max: number): T[] {
  return lines.length > max ? lines.slice(-max) : lines;
}
