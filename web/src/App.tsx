import { useEffect, useRef, useState } from "react";
import "./App.css";

/** Only dismiss on a genuine backdrop click, not a text-selection drag that
 *  starts inside the dialog and releases over the backdrop. */
function useBackdropDismiss(onDismiss: () => void) {
  const mouseDownOnBackdrop = useRef(false);
  return {
    onMouseDown: (e: React.MouseEvent<HTMLDivElement>) => {
      mouseDownOnBackdrop.current = e.target === e.currentTarget;
    },
    onClick: (e: React.MouseEvent<HTMLDivElement>) => {
      if (mouseDownOnBackdrop.current && e.target === e.currentTarget) onDismiss();
    },
  };
}
import {
  AudioPlayer,
  MicCapture,
  SAMPLE_RATE,
  encodeWavStereo,
  hasNativeOutputPicker,
  listAudioInputDevices,
  listAudioOutputDevices,
  pickAudioOutputDevice,
} from "./voice";
import { LanguageProvider, useLanguage, useT, type LangPref } from "./i18n";
import { DEMO_HOST, DEMO_MODE, DemoSocket } from "./demoMode";
import {
  SOUND_EVENTS,
  clearCustomSound,
  loadCustomSound,
  loadEventSoundEnabled,
  loadSoundsEnabled,
  loadSoundsVolume,
  playSound,
  saveCustomSound,
  saveEventSoundEnabled,
  saveSoundsEnabled,
  saveSoundsVolume,
  setSoundsOutputDevice,
  type SoundEventId,
} from "./sounds";
import { parseSoundpack } from "./soundpack";

// In dev, the gateway runs standalone on its own port. In production it's
// normally served from the same origin/port as the web app (single
// container behind a reverse proxy), so the WebSocket URL is derived from
// the current location by default. If the static frontend is hosted
// separately from the gateway (e.g. a static host for the landing/app
// bundle, with the gateway staying on your own server), set
// VITE_GATEWAY_URL at build time to the gateway's public wss:// address
// instead - the browser will still block a plain ws:// gateway from an
// https:// page (mixed content), so that address needs real TLS.
// Either way the gateway's WebSocketServer only listens on /ws (see
// gateway/src/index.ts), so that path always gets appended here - a
// VITE_GATEWAY_URL override only needs to name the host, not the path.
const GATEWAY_URL = import.meta.env.DEV
  ? "ws://localhost:8080"
  : import.meta.env.VITE_GATEWAY_URL
    ? `${import.meta.env.VITE_GATEWAY_URL.replace(/\/$/, "")}/ws`
    : `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/ws`;

// One-time migration from the pre-rename "ts-web-client:*" localStorage
// namespace so existing users don't lose their favorites/preferences.
(function migrateLegacyStorageKeys() {
  const oldPrefix = "ts-web-client:";
  const newPrefix = "webspeak3:";
  for (const oldKey of Object.keys(localStorage).filter((k) => k.startsWith(oldPrefix))) {
    const newKey = newPrefix + oldKey.slice(oldPrefix.length);
    if (localStorage.getItem(newKey) === null) {
      localStorage.setItem(newKey, localStorage.getItem(oldKey)!);
    }
    localStorage.removeItem(oldKey);
  }
})();

const LAST_HOST_KEY = "webspeak3:last-host";
const LAST_NICKNAME_KEY = "webspeak3:last-nickname";
/** Identity persisted across sessions so the server sees the same client UID
 *  each time, instead of a fresh one being generated per connection. */
const IDENTITY_KEY = "webspeak3:identity";
const IDENTITIES_KEY = "webspeak3:identities";
const ACTIVE_IDENTITY_KEY = "webspeak3:active-identity";

interface Identity {
  id: string;
  name: string;
  /** Per-identity nickname/phonetic nickname, like the native client - selecting
   *  an identity in the connect dialog fills these in. Empty until first set. */
  nickname: string;
  phoneticName: string;
  /** Opaque tsclientlib identity blob - null until the first successful connect generates one. */
  blob: string | null;
}

// One-time migration from the old single flat identity key to a list of named
// identities (so users can maintain more than one persona), and to seed a
// default entry for users who never had one either. Runs once at module load.
(function ensureIdentitiesSeeded() {
  if (localStorage.getItem(IDENTITIES_KEY) !== null) return;
  const legacyBlob = localStorage.getItem(IDENTITY_KEY);
  const legacyNickname = localStorage.getItem(LAST_NICKNAME_KEY) ?? "";
  const id = crypto.randomUUID();
  const identities: Identity[] = [
    { id, name: "Standard", nickname: legacyNickname, phoneticName: "", blob: legacyBlob },
  ];
  localStorage.setItem(IDENTITIES_KEY, JSON.stringify(identities));
  localStorage.setItem(ACTIVE_IDENTITY_KEY, id);
  localStorage.removeItem(IDENTITY_KEY);
})();

function loadIdentities(): Identity[] {
  try {
    const raw = localStorage.getItem(IDENTITIES_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<Identity>[]) : [];
    if (parsed.length > 0) {
      // Backfill fields older saves (before per-identity nickname/phonetic
      // name existed) don't have.
      return parsed.map((i) => ({
        id: i.id ?? crypto.randomUUID(),
        name: i.name ?? "Standard",
        nickname: i.nickname ?? "",
        phoneticName: i.phoneticName ?? "",
        blob: i.blob ?? null,
      }));
    }
  } catch {
    // fall through
  }
  return [{ id: crypto.randomUUID(), name: "Standard", nickname: "", phoneticName: "", blob: null }];
}

const FAVORITES_KEY = "webspeak3:favorites";
const INPUT_DEVICE_KEY = "webspeak3:input-device";
const PLAYBACK_VOLUME_KEY = "webspeak3:playback-volume";
const NOISE_SUPPRESSION_KEY = "webspeak3:noise-suppression";
const ECHO_CANCELLATION_KEY = "webspeak3:echo-cancellation";
const AUTO_GAIN_CONTROL_KEY = "webspeak3:auto-gain-control";
const VAD_HANGOVER_KEY = "webspeak3:vad-hangover";
const DESIGN_THEME_KEY = "webspeak3:design-theme";
// The user's actual pick - "standard" | "nova" | "custom:<id>". DESIGN_THEME_KEY above
// keeps tracking just the resolved structural base, since a couple of early call sites
// (e.g. the host-field default below) need that cheaply, before customThemes is loaded.
const DESIGN_SELECTION_KEY = "webspeak3:design-selection";
const CUSTOM_THEMES_KEY = "webspeak3:custom-themes";

type DesignTheme = "standard" | "nova";

/** A user-authored theme package: a name, which built-in layout it behaves like
 *  (Standard's plain chrome vs Nova's collapsed menu/splash behavior), and raw CSS
 *  that gets injected while it's active - free-form, so it can restyle or even
 *  reflow the existing markup (e.g. via flex `order`, `display:none`, overlays). */
type CustomTheme = {
  id: string;
  name: string;
  baseTheme: DesignTheme;
  css: string;
};

function loadDesignTheme(): DesignTheme {
  return localStorage.getItem(DESIGN_THEME_KEY) === "nova" ? "nova" : "standard";
}

function loadCustomThemes(): CustomTheme[] {
  try {
    const raw = localStorage.getItem(CUSTOM_THEMES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (v): v is CustomTheme =>
        v &&
        typeof v.id === "string" &&
        typeof v.name === "string" &&
        (v.baseTheme === "standard" || v.baseTheme === "nova") &&
        typeof v.css === "string"
    );
  } catch {
    return [];
  }
}

function saveCustomThemes(list: CustomTheme[]) {
  localStorage.setItem(CUSTOM_THEMES_KEY, JSON.stringify(list));
}

function loadDesignSelection(): string {
  return localStorage.getItem(DESIGN_SELECTION_KEY) ?? loadDesignTheme();
}

function loadBoolPref(key: string, fallback: boolean): boolean {
  const raw = localStorage.getItem(key);
  return raw === null ? fallback : raw === "1";
}

function loadNumberPref(key: string, fallback: number): number {
  const raw = localStorage.getItem(key);
  const parsed = raw === null ? NaN : Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

interface Favorite {
  id: string;
  bookmarkName: string;
  nickname: string;
  host: string;
  serverPassword: string;
  defaultChannel: string;
  defaultChannelPassword: string;
}

function loadFavorites(): Favorite[] {
  try {
    const raw = localStorage.getItem(FAVORITES_KEY);
    return raw ? (JSON.parse(raw) as Favorite[]) : [];
  } catch {
    return [];
  }
}

const AWAY_PRESETS_KEY = "webspeak3:away-presets";
const DISCONNECT_MESSAGE_KEY = "webspeak3:disconnect-message";
const COLLECTED_URLS_KEY = "webspeak3:collected-urls";

interface CollectedUrl {
  url: string;
  count: number;
  lastSeen: number;
  lastSender: string;
}

function loadCollectedUrls(): CollectedUrl[] {
  try {
    const raw = localStorage.getItem(COLLECTED_URLS_KEY);
    return raw ? (JSON.parse(raw) as CollectedUrl[]) : [];
  } catch {
    return [];
  }
}

const URL_REGEX = /https?:\/\/[^\s<>"]+/g;

type LogLevel = "critical" | "error" | "warning" | "info" | "debug";

interface ClientLogEntry {
  id: number;
  timestamp: number;
  category: string;
  level: LogLevel;
  message: string;
}

const LOG_LEVELS: LogLevel[] = ["critical", "error", "warning", "info", "debug"];
const MAX_LOG_ENTRIES = 500;

interface WhisperLogEntry {
  id: number;
  timestamp: number;
  description: string;
}

interface BanListEntry {
  banId: number;
  ip: string;
  name: string;
  uid: string;
  lastNickname: string;
  created: string;
  durationSecs: number;
  invokerName: string;
  reason: string;
  enforcements: number;
}

interface ComplainListEntry {
  targetClientDbId: number;
  targetName: string;
  fromClientDbId: number;
  fromName: string;
  message: string;
  timestamp: string;
}

interface OfflineMessageListEntry {
  messageId: number;
  clientUid: string;
  subject: string;
  timestamp: string;
  isRead: boolean;
}

type ContactCategory = "acquaintance" | "blocked" | "friend";

interface Contact {
  uid: string;
  customName: string;
  category: ContactCategory;
  phoneticName: string;
  ignored: boolean;
}

const CONTACTS_KEY = "webspeak3:contacts";

function loadContacts(): Contact[] {
  try {
    const raw = localStorage.getItem(CONTACTS_KEY);
    return raw ? (JSON.parse(raw) as Contact[]) : [];
  } catch {
    return [];
  }
}

interface MessagePreset {
  name: string;
  message: string;
}

/** A saved whisper target selection. Channels/clients are matched by name when
 *  activated (rather than by id), since ids are only stable for the current
 *  connection - the same names are what a user would recognize across sessions. */
interface WhisperList {
  id: string;
  name: string;
  channelNames: string[];
  clientNames: string[];
}

const WHISPER_LISTS_KEY = "webspeak3:whisper-lists";

function loadWhisperLists(): WhisperList[] {
  try {
    const raw = localStorage.getItem(WHISPER_LISTS_KEY);
    return raw ? (JSON.parse(raw) as WhisperList[]) : [];
  } catch {
    return [];
  }
}

function loadAwayPresets(): MessagePreset[] {
  try {
    const raw = localStorage.getItem(AWAY_PRESETS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    // Older versions stored presets as plain strings (name == message) - migrate on read.
    return parsed.map((p) => (typeof p === "string" ? { name: p, message: p } : (p as MessagePreset)));
  } catch {
    return [];
  }
}

function saveAwayPresets(presets: MessagePreset[]): void {
  localStorage.setItem(AWAY_PRESETS_KEY, JSON.stringify(presets));
}

function loadDisconnectMessage(): string {
  return localStorage.getItem(DISCONNECT_MESSAGE_KEY) ?? "";
}

function saveDisconnectMessage(message: string): void {
  localStorage.setItem(DISCONNECT_MESSAGE_KEY, message);
}

type LogEntry = { text: string; kind: "info" | "error" };

interface ChannelInfo {
  id: number;
  parent: number;
  order: number;
  name: string;
  topic: string;
  codec: string;
  maxClients: number | null;
  hasPassword: boolean;
}

type SelectedItem = { type: "server" } | { type: "channel"; id: number };

interface ClientInfo {
  id: number;
  channel: number;
  name: string;
  inputMuted: boolean;
  outputMuted: boolean;
  inputHardwareEnabled: boolean;
  away: boolean;
  awayMessage: string;
  isChannelCommander: boolean;
  country: string;
  uid: string;
  databaseId: number;
  channelGroup: number;
  serverGroups: number[];
  hasTalkPower: boolean;
}

interface GroupEntry {
  id: number;
  name: string;
  iconId: number;
}

interface PermissionOverviewEntry {
  name: string;
  description: string;
  value: number;
  negated: boolean;
  skip: boolean;
}

interface FileListEntry {
  path: string;
  name: string;
  size: number;
  isFile: boolean;
  timestamp: string;
}

interface PermissionCatalogEntry {
  id: number;
  name: string;
  description: string;
}

type PermScope = "server" | "channelgroup" | "channel" | "client" | "channelclient";

interface ClientConnectionInfoData {
  clientId: number;
  pingMs: number | null;
  connectedSecs: number | null;
  ip: string | null;
  packetsSent: number;
  bytesSent: number;
  packetsReceived: number;
  bytesReceived: number;
  packetLossPercent: number;
}

interface ServerConnectionInfoData {
  pingMs: number;
  connectedSecs: number;
  packetLossPercent: number;
  packetsSentTotal: number;
  bytesSentTotal: number;
  packetsReceivedTotal: number;
  bytesReceivedTotal: number;
  bandwidthSentLastSecond: number;
  bandwidthReceivedLastSecond: number;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

/** Turns a base64-encoded file (as delivered by the "fileDownloadData" event)
 *  into an actual browser download, without ever round-tripping through the
 *  gateway's HTTP surface - it's all-in-memory via a Blob + object URL. */
function triggerBrowserDownload(filename: string, base64Data: string): void {
  const binary = atob(base64Data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const blob = new Blob([bytes]);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function formatDurationSecs(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/** Converts an ISO 3166-1 alpha-2 country code (e.g. "DE") to its flag emoji
 *  via Unicode regional indicator symbols. Returns null for codes the server
 *  doesn't report (empty string - common when geo-IP isn't configured). */
function countryFlag(code: string): string | null {
  if (!/^[A-Za-z]{2}$/.test(code)) return null;
  const codePoints = [...code.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65);
  return String.fromCodePoint(...codePoints);
}

function ChannelIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M1.5 3.5c0-.55.45-1 1-1h3.4l1.2 1.4h6.4c.55 0 1 .45 1 1v7.1c0 .55-.45 1-1 1h-11c-.55 0-1-.45-1-1v-8.5Z"
        fill="#e8c46a"
        stroke="#b8923f"
        strokeWidth="0.6"
      />
    </svg>
  );
}

function ClientIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="5.2" r="3" fill="#6d8fb0" />
      <path d="M2 14c0-3.3 2.7-5.2 6-5.2s6 1.9 6 5.2v.3H2V14Z" fill="#6d8fb0" />
      <circle cx="12.3" cy="12.3" r="2.6" fill="#4caf50" stroke="#fff" strokeWidth="0.8" />
    </svg>
  );
}

function ClientStatusIcons({ client }: { client: ClientInfo }) {
  const t = useT();
  return (
    <span className="ts-status-icons">
      {client.isChannelCommander && <span title={t("tree.channelCommander")}>⭐</span>}
      {client.away && <span title={t("tree.away")}>💤</span>}
      {(client.inputMuted || !client.inputHardwareEnabled) && <span title={t("tree.micMuted")}>🔇</span>}
      {!client.inputMuted && client.inputHardwareEnabled && !client.hasTalkPower && (
        <span title={t("tree.noTalkPower")}>🔒</span>
      )}
      {client.outputMuted && <span title={t("tree.soundMuted")}>🔕</span>}
    </span>
  );
}

function ServerIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="1.5" y="2" width="13" height="4.2" rx="0.6" fill="#7a8a99" stroke="#5c6b78" strokeWidth="0.5" />
      <rect x="1.5" y="7" width="13" height="4.2" rx="0.6" fill="#8a9aab" stroke="#5c6b78" strokeWidth="0.5" />
      <circle cx="3.5" cy="4.1" r="0.6" fill="#4caf50" />
      <circle cx="3.5" cy="9.1" r="0.6" fill="#4caf50" />
    </svg>
  );
}

function ChannelTree({
  channels,
  clients,
  parent,
  ownClientId,
  talkers,
  serverGroups,
  groupIconImages,
  selected,
  onSelectItem,
  onSwitchChannel,
  onOpenPrivateChat,
  onPokeClient,
  onClientContextMenu,
  onChannelContextMenu,
}: {
  channels: ChannelInfo[];
  clients: ClientInfo[];
  parent: number;
  ownClientId: number | null;
  talkers: Set<number>;
  serverGroups: GroupEntry[] | null;
  groupIconImages: Record<string, string>;
  selected: SelectedItem | null;
  onSelectItem: (item: SelectedItem) => void;
  onSwitchChannel: (channelId: number) => void;
  onOpenPrivateChat: (clientId: number, clientName: string) => void;
  onPokeClient: (clientId: number, clientName: string) => void;
  onClientContextMenu: (e: React.MouseEvent, clientId: number, clientName: string, isSelf: boolean) => void;
  onChannelContextMenu: (e: React.MouseEvent, channelId: number, channelName: string) => void;
}) {
  const t = useT();
  const children = channels.filter((c) => c.parent === parent).sort((a, b) => a.order - b.order);
  if (children.length === 0) return null;

  const clientGroupBadges = (client: ClientInfo): GroupEntry[] =>
    serverGroups
      ? client.serverGroups
          .map((gid) => serverGroups.find((g) => g.id === gid))
          .filter((g): g is GroupEntry => !!g && g.iconId !== 0)
      : [];

  return (
    <ul className="ts-tree-list">
      {children.map((channel) => (
        <li key={channel.id}>
          <div
            className={`ts-row ts-channel-row${
              selected?.type === "channel" && selected.id === channel.id ? " ts-row-selected" : ""
            }`}
            onClick={() => onSelectItem({ type: "channel", id: channel.id })}
            onDoubleClick={() => onSwitchChannel(channel.id)}
            onContextMenu={(e) => onChannelContextMenu(e, channel.id, channel.name)}
            title={t("tree.clickToSelect")}
          >
            <ChannelIcon />
            <span>{channel.name}</span>
            {channel.hasPassword && <span title={t("tree.passwordProtected")}>🔒</span>}
          </div>
          <ul className="ts-tree-list">
            {clients
              .filter((c) => c.channel === channel.id)
              .map((c) => (
                <li key={c.id}>
                  <div
                    className={`ts-row ts-client-row${c.id === ownClientId ? " ts-self" : ""}${
                      talkers.has(c.id) && c.hasTalkPower ? " ts-talking" : ""
                    }`}
                    onClick={c.id === ownClientId ? undefined : () => onOpenPrivateChat(c.id, c.name)}
                    onContextMenu={(e) => onClientContextMenu(e, c.id, c.name, c.id === ownClientId)}
                    title={c.id === ownClientId ? undefined : `${t("tree.privateChatWith")} ${c.name}`}
                  >
                    <ClientIcon />
                    <span
                      className="ts-client-avatar"
                      style={{ background: c.id === ownClientId ? "var(--accent)" : clientAvatarColor(c.name) }}
                    >
                      {c.name.trim().charAt(0).toUpperCase() || "?"}
                    </span>
                    {countryFlag(c.country) && <span title={c.country}>{countryFlag(c.country)}</span>}
                    <span>{c.name}</span>
                    {c.away && c.awayMessage && (
                      <span className="ts-client-away-message">({c.awayMessage})</span>
                    )}
                    <span className="ts-client-icons">
                      <ClientStatusIcons client={c} />
                      {clientGroupBadges(c).map((g) => {
                        if (g.iconId >= CUSTOM_ICON_ID_THRESHOLD) {
                          const base64 = groupIconImages[`/icon_${g.iconId}`];
                          if (base64) {
                            return (
                              <img key={g.id} className="ts-group-icon" src={iconDataUrl(base64)} alt="" title={g.name} />
                            );
                          }
                        }
                        return (
                          <span
                            key={g.id}
                            className="ts-group-badge"
                            style={{ background: groupBadgeColor(g.iconId) }}
                            title={g.name}
                          >
                            {g.name.trim().charAt(0).toUpperCase() || "?"}
                          </span>
                        );
                      })}
                    </span>
                  </div>
                </li>
              ))}
          </ul>
          <ChannelTree
            channels={channels}
            clients={clients}
            parent={channel.id}
            ownClientId={ownClientId}
            talkers={talkers}
            serverGroups={serverGroups}
            groupIconImages={groupIconImages}
            selected={selected}
            onSelectItem={onSelectItem}
            onSwitchChannel={onSwitchChannel}
            onOpenPrivateChat={onOpenPrivateChat}
            onPokeClient={onPokeClient}
            onClientContextMenu={onClientContextMenu}
            onChannelContextMenu={onChannelContextMenu}
          />
        </li>
      ))}
    </ul>
  );
}

function InfoPanel({
  selected,
  host,
  serverName,
  serverMaxClients,
  serverVersion,
  serverLicense,
  totalClientCount,
  channels,
  clients,
  onShowServerConnectionInfo,
  onEditServer,
}: {
  selected: SelectedItem | null;
  host: string;
  serverName: string;
  serverMaxClients: number;
  serverVersion: string;
  serverLicense: string;
  totalClientCount: number;
  channels: ChannelInfo[];
  clients: ClientInfo[];
  onShowServerConnectionInfo: () => void;
  onEditServer: () => void;
}) {
  const t = useT();
  if (!selected || selected.type === "server") {
    return (
      <div className="ts-info-panel">
        <div className="ts-info-title">
          <ServerIcon />
          <span>{serverName || host}</span>
        </div>
        <div className="ts-info-row">
          <span>{t("info.address")}</span> <span>{host}</span>
        </div>
        {serverVersion && (
          <div className="ts-info-row">
            <span>{t("info.version")}</span> <span>{serverVersion}</span>
          </div>
        )}
        {serverLicense && (
          <div className="ts-info-row">
            <span>{t("info.license")}</span> <span>{serverLicense}</span>
          </div>
        )}
        <div className="ts-info-row">
          <span>{t("info.currentClients")}</span> <span>{totalClientCount} / {serverMaxClients || "∞"}</span>
        </div>
        <div className="ts-info-row">
          <span>{t("info.currentChannels")}</span> <span>{channels.length}</span>
        </div>
        <button className="ts-info-connection-link" onClick={onShowServerConnectionInfo}>
          🔌 {t("connectionInfo.serverTitle")}
        </button>
        <button className="ts-info-connection-link" onClick={onEditServer}>
          ✏️ {t("serverEdit.title")}
        </button>
      </div>
    );
  }

  const channel = channels.find((c) => c.id === selected.id);
  if (!channel) return <div className="ts-info-panel" />;
  const clientCount = clients.filter((c) => c.channel === channel.id).length;

  return (
    <div className="ts-info-panel">
      <div className="ts-info-title">
        <ChannelIcon />
        <span>{channel.name}</span>
      </div>
      {channel.topic && (
        <div className="ts-info-row">
          <span>{t("info.topic")}</span> <span>{channel.topic}</span>
        </div>
      )}
      <div className="ts-info-row">
        <span>{t("info.audioCodec")}</span> <span>{channel.codec}</span>
      </div>
      <div className="ts-info-row">
        <span>{t("info.passwordProtected")}</span> <span>{channel.hasPassword ? t("info.yes") : t("info.no")}</span>
      </div>
      <div className="ts-info-row">
        <span>{t("info.clients")}</span> <span>{clientCount} / {channel.maxClients ?? "∞"}</span>
      </div>
    </div>
  );
}

interface ChatEntry {
  from: string;
  message: string;
  /** Set for server-log notifications (join/leave/switch/etc.) so they render
   *  without a "from:" prefix, like the native client's server tab. */
  isLog?: boolean;
}

interface PmMessage {
  fromSelf: boolean;
  message: string;
}

interface PmThread {
  partnerId: number;
  partnerName: string;
  messages: PmMessage[];
  unread: boolean;
}

type ActiveTab = "channel" | "server" | number;

interface PokeNotice {
  id: number;
  from: string;
  message: string;
}

function ConnectDialog({
  host,
  nickname,
  serverPassword,
  channelPassword,
  defaultChannel,
  expanded,
  connecting,
  identities,
  activeIdentityId,
  onHostChange,
  onNicknameChange,
  onServerPasswordChange,
  onChannelPasswordChange,
  onDefaultChannelChange,
  onActiveIdentityChange,
  onToggleExpanded,
  onConnect,
  onCancel,
  nova,
  onOpenOptions,
}: {
  host: string;
  nickname: string;
  serverPassword: string;
  channelPassword: string;
  defaultChannel: string;
  expanded: boolean;
  connecting: boolean;
  identities: Identity[];
  activeIdentityId: string | null;
  onHostChange: (v: string) => void;
  onNicknameChange: (v: string) => void;
  onServerPasswordChange: (v: string) => void;
  onChannelPasswordChange: (v: string) => void;
  onDefaultChannelChange: (v: string) => void;
  onActiveIdentityChange: (id: string) => void;
  onToggleExpanded: () => void;
  onConnect: () => void;
  onCancel: () => void;
  /** Nova-theme-only: renders the TS6-redesign "connect hero" (logo, title,
   *  subtitle, settings shortcut) around the same form instead of the
   *  Standard theme's plain titled dialog box. */
  nova: boolean;
  onOpenOptions: () => void;
}) {
  const t = useT();
  const backdrop = useBackdropDismiss(onCancel);

  // Nova-theme-only: the "Erweiterte Optionen" toggle moves from the footer
  // (Standard) to right under the nickname field, with a rotating chevron -
  // matching the TS6 redesign's Connect screen instead of a plain button.
  const expandToggle = nova ? (
    <button className="ts-connect-nova-expand" onClick={onToggleExpanded}>
      <svg
        className={`ts-connect-nova-chevron${expanded ? " ts-connect-nova-chevron-open" : ""}`}
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M9 6l6 6-6 6" />
      </svg>
      {expanded ? t("connect.less") : t("connect.more")}
    </button>
  ) : (
    <button onClick={onToggleExpanded}>{expanded ? t("connect.less") : t("connect.more")}</button>
  );

  const dialogBody = (
    <div className="ts-dialog ts-connect-dialog" onClick={(e) => e.stopPropagation()}>
      {nova ? (
        <button className="ts-connect-nova-settings" onClick={onOpenOptions} title={t("menu.extras.options")}>
          ⚙️
        </button>
      ) : (
        <div className="ts-dialog-titlebar">
          <span>{t("connect.title")}</span>
          <button onClick={onCancel} title={t("dialog.close")}>
            ✕
          </button>
        </div>
      )}
      <div className="ts-dialog-body">
        <div className="ts-dialog-row">
          <label className="ts-dialog-field ts-dialog-field-grow">
            {t("connect.serverAddress")}
            <input autoFocus value={host} onChange={(e) => onHostChange(e.target.value)} />
          </label>
          <label className="ts-dialog-field">
            {t("connect.serverPassword")}
            <input
              type="password"
              value={serverPassword}
              onChange={(e) => onServerPasswordChange(e.target.value)}
            />
          </label>
        </div>
        <label className="ts-dialog-field">
          {t("connect.nickname")}
          <input value={nickname} onChange={(e) => onNicknameChange(e.target.value)} />
        </label>

        {nova && expandToggle}

        {expanded && (
            <div className="ts-dialog-grid">
              <label className="ts-dialog-field">
                {t("connect.phoneticNickname")}
                <input disabled title="Not supported yet" />
              </label>
              <label className="ts-dialog-field">
                {t("connect.identity")}
                <select value={activeIdentityId ?? ""} onChange={(e) => onActiveIdentityChange(e.target.value)}>
                  {identities.map((identity) => (
                    <option key={identity.id} value={identity.id}>
                      {identity.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="ts-dialog-field">
                {t("connect.defaultChannel")}
                <input value={defaultChannel} onChange={(e) => onDefaultChannelChange(e.target.value)} />
              </label>
              <label className="ts-dialog-field">
                {t("connect.recordingProfile")}
                <select disabled defaultValue="Standard">
                  <option>Standard</option>
                </select>
              </label>
              <label className="ts-dialog-field">
                {t("connect.channelPassword")}
                <input
                  type="password"
                  value={channelPassword}
                  onChange={(e) => onChannelPasswordChange(e.target.value)}
                />
              </label>
              <label className="ts-dialog-field">
                {t("connect.playbackProfile")}
                <select disabled defaultValue="Standard">
                  <option>Standard</option>
                </select>
              </label>
              <label className="ts-dialog-field">
                {t("connect.onetimeGrant")}
                <input disabled title="Not supported yet" />
              </label>
              <label className="ts-dialog-field">
                {t("connect.hotkeyProfile")}
                <select disabled defaultValue="Standard">
                  <option>Standard</option>
                </select>
              </label>
              <label className="ts-dialog-field">
                {t("connect.soundPack")}
                <select disabled defaultValue="Standard">
                  <option>Standard</option>
                </select>
              </label>
            </div>
          )}
        </div>
        <div className={nova ? "ts-connect-nova-buttons" : "ts-dialog-buttons"}>
          {!nova && expandToggle}
          <div className={nova ? undefined : "ts-dialog-buttons-right"}>
            {nova && (
              <button className="ts-connect-cancel" onClick={onCancel}>
                {t("connect.cancel")}
              </button>
            )}
            {!nova && (
              <button onClick={onConnect} disabled={connecting || !host || !nickname}>
                {connecting ? t("connect.connecting") : t("connect.connect")}
              </button>
            )}
            <button disabled title="Not supported in the web client">
              {t("connect.newTab")}
            </button>
            {nova ? (
              <button
                className="ts-connect-nova-primary"
                onClick={onConnect}
                disabled={connecting || !host || !nickname}
              >
                {connecting ? t("connect.connecting") : t("connect.connect")}
              </button>
            ) : (
              <button onClick={onCancel}>{t("connect.cancel")}</button>
            )}
          </div>
        </div>
      </div>
  );

  if (!nova)
    return (
      <div className="ts-dialog-backdrop" {...backdrop}>
        {dialogBody}
      </div>
    );

  return (
    <div className="ts-dialog-backdrop" {...backdrop}>
      <div className="ts-connect-nova-wrap">
        <div className="ts-connect-nova-hero">
          <span className="ts-connect-nova-logo">W</span>
          <div className="ts-connect-nova-heading">
            <div className="ts-connect-nova-title">{t("connect.title")}</div>
            <div className="ts-connect-nova-subtitle">{t("connect.novaSubtitle")}</div>
          </div>
        </div>
        {dialogBody}
      </div>
    </div>
  );
}

function FavoritesDialog({
  favorites,
  prefillNew,
  onSave,
  onClose,
}: {
  favorites: Favorite[];
  prefillNew?: Omit<Favorite, "id" | "bookmarkName">;
  onSave: (favorites: Favorite[]) => void;
  onClose: () => void;
}) {
  const t = useT();
  const pendingNewRef = useRef<Favorite | null>(
    prefillNew
      ? {
          id: crypto.randomUUID(),
          bookmarkName: prefillNew.host || t("favorites.newFavoriteName"),
          ...prefillNew,
        }
      : null
  );
  const [draft, setDraft] = useState<Favorite[]>(() =>
    pendingNewRef.current ? [...favorites, pendingNewRef.current] : favorites.map((f) => ({ ...f }))
  );
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    pendingNewRef.current ? pendingNewRef.current.id : (favorites[0]?.id ?? null)
  );

  const selected = draft.find((f) => f.id === selectedId) ?? null;

  const updateSelected = (patch: Partial<Favorite>) => {
    if (!selectedId) return;
    setDraft((prev) => prev.map((f) => (f.id === selectedId ? { ...f, ...patch } : f)));
  };

  const handleNewFavorite = () => {
    const nf: Favorite = {
      id: crypto.randomUUID(),
      bookmarkName: t("favorites.newFavoriteName"),
      nickname: "",
      host: "",
      serverPassword: "",
      defaultChannel: "",
      defaultChannelPassword: "",
    };
    setDraft((prev) => [...prev, nf]);
    setSelectedId(nf.id);
  };

  const handleRemove = () => {
    if (!selectedId) return;
    setDraft((prev) => prev.filter((f) => f.id !== selectedId));
    setSelectedId(null);
  };

  const backdrop = useBackdropDismiss(onClose);
  return (
    <div className="ts-dialog-backdrop" {...backdrop}>
      <div className="ts-dialog ts-favorites-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="ts-dialog-titlebar">
          <span>{t("favorites.title")}</span>
          <button onClick={onClose} title={t("dialog.close")}>
            ✕
          </button>
        </div>
        <div className="ts-favorites-body">
          <div className="ts-favorites-list-col">
            <div className="ts-favorites-list-group-title">{t("favorites.synced")}</div>
            <div className="ts-favorites-list-empty">{t("favorites.notLoggedIn")}</div>
            <div className="ts-favorites-list-group-title">{t("favorites.local")}</div>
            <ul className="ts-favorites-list">
              {draft.map((f) => (
                <li
                  key={f.id}
                  className={`ts-favorites-list-item${f.id === selectedId ? " ts-favorites-list-item-selected" : ""}`}
                  onClick={() => setSelectedId(f.id)}
                >
                  {f.bookmarkName || t("favorites.unnamed")}
                </li>
              ))}
            </ul>
          </div>

          <div className="ts-favorites-fields-col">
            <label className="ts-dialog-field">
              {t("favorites.bookmarkName")}
              <input
                disabled={!selected}
                value={selected?.bookmarkName ?? ""}
                onChange={(e) => updateSelected({ bookmarkName: e.target.value })}
              />
            </label>
            <label className="ts-dialog-field">
              {t("connect.nickname")}
              <input
                disabled={!selected}
                value={selected?.nickname ?? ""}
                onChange={(e) => updateSelected({ nickname: e.target.value })}
              />
            </label>
            <label className="ts-dialog-field">
              {t("connect.phoneticNickname")}
              <input disabled title="Not supported yet" />
            </label>
            <label className="ts-dialog-field">
              {t("connect.serverAddress")}
              <input
                disabled={!selected}
                value={selected?.host ?? ""}
                onChange={(e) => updateSelected({ host: e.target.value })}
              />
            </label>
            <label className="ts-dialog-field">
              {t("connect.serverPassword")}
              <input
                type="password"
                disabled={!selected}
                value={selected?.serverPassword ?? ""}
                onChange={(e) => updateSelected({ serverPassword: e.target.value })}
              />
            </label>
            <label className="ts-dialog-field">
              {t("connect.defaultChannel")}
              <input
                disabled={!selected}
                value={selected?.defaultChannel ?? ""}
                onChange={(e) => updateSelected({ defaultChannel: e.target.value })}
              />
            </label>
            <label className="ts-dialog-field">
              {t("connect.channelPassword")}
              <input
                type="password"
                disabled={!selected}
                value={selected?.defaultChannelPassword ?? ""}
                onChange={(e) => updateSelected({ defaultChannelPassword: e.target.value })}
              />
            </label>
          </div>

          <div className="ts-favorites-profile-col">
            <label className="ts-dialog-field">
              {t("connect.identity")}
              <select disabled defaultValue="Standard">
                <option>Standard</option>
              </select>
            </label>
            <label className="ts-dialog-field">
              {t("connect.recordingProfile")}
              <select disabled defaultValue="Standard">
                <option>Standard</option>
              </select>
            </label>
            <label className="ts-dialog-field">
              {t("connect.playbackProfile")}
              <select disabled defaultValue="Standard">
                <option>Standard</option>
              </select>
            </label>
            <label className="ts-dialog-field">
              {t("connect.hotkeyProfile")}
              <select disabled defaultValue="Standard">
                <option>Standard</option>
              </select>
            </label>
            <label className="ts-dialog-field">
              {t("connect.soundPack")}
              <select disabled defaultValue="Standard">
                <option>Standard</option>
              </select>
            </label>
            <label className="ts-dialog-checkbox">
              <input type="checkbox" disabled defaultChecked title="Not supported yet" />
              {t("favorites.showServerQueryClients")}
            </label>
            <label className="ts-dialog-checkbox">
              <input type="checkbox" disabled title="Not supported yet" />
              {t("favorites.connectOnStartup")}
            </label>
          </div>
        </div>
        <div className="ts-dialog-buttons">
          <div className="ts-dialog-buttons-right">
            <button onClick={handleNewFavorite}>{t("favorites.new")}</button>
            <button disabled title="Not supported in the web client">
              {t("favorites.newFolder")}
            </button>
            <button onClick={handleRemove} disabled={!selected}>
              {t("favorites.remove")}
            </button>
          </div>
          <div className="ts-dialog-buttons-right">
            <button
              onClick={() => {
                onSave(draft);
                onClose();
              }}
            >
              {t("favorites.ok")}
            </button>
            <button onClick={onClose}>{t("favorites.cancel")}</button>
            <button onClick={() => onSave(draft)}>{t("favorites.apply")}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function CollectedUrlsDialog({
  urls,
  onClear,
  onClose,
}: {
  urls: CollectedUrl[];
  onClear: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const [search, setSearch] = useState("");
  const backdrop = useBackdropDismiss(onClose);

  const filtered = urls
    .filter((u) => u.url.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => b.lastSeen - a.lastSeen);

  return (
    <div className="ts-dialog-backdrop" {...backdrop}>
      <div className="ts-dialog ts-collected-urls-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="ts-dialog-titlebar">
          <span>{t("collectedUrls.title")}</span>
          <button onClick={onClose} title={t("dialog.close")}>
            ✕
          </button>
        </div>
        <div className="ts-dialog-body">
          <label className="ts-dialog-field">
            {t("collectedUrls.search")}
            <input value={search} onChange={(e) => setSearch(e.target.value)} />
          </label>
          <table className="ts-collected-urls-table">
            <thead>
              <tr>
                <th>{t("collectedUrls.url")}</th>
                <th>{t("collectedUrls.count")}</th>
                <th>{t("collectedUrls.lastSeen")}</th>
                <th>{t("collectedUrls.mentionedBy")}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((u) => (
                <tr key={u.url}>
                  <td>
                    <a href={u.url} target="_blank" rel="noreferrer noopener">
                      {u.url}
                    </a>
                  </td>
                  <td>{u.count}</td>
                  <td>{new Date(u.lastSeen).toLocaleString()}</td>
                  <td>{u.lastSender}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="ts-dialog-buttons">
          <button onClick={onClear}>{t("collectedUrls.clearList")}</button>
          <div className="ts-dialog-buttons-right">
            <button onClick={onClose}>{t("dialog.close")}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function InviteFriendDialog({
  host,
  channelId,
  onClose,
}: {
  host: string;
  channelId: number | null;
  onClose: () => void;
}) {
  const t = useT();
  const [includeChannel, setIncludeChannel] = useState(false);
  const [copied, setCopied] = useState(false);
  const backdrop = useBackdropDismiss(onClose);

  const link = `ts3server://${host}${includeChannel && channelId !== null ? `?channel=${channelId}` : ""}`;

  return (
    <div className="ts-dialog-backdrop" {...backdrop}>
      <div className="ts-dialog ts-invite-friend-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="ts-dialog-titlebar">
          <span>{t("inviteFriend.title")}</span>
          <button onClick={onClose} title={t("dialog.close")}>
            ✕
          </button>
        </div>
        <div className="ts-dialog-body">
          <div className="ts-dialog-row">
            <label className="ts-dialog-field ts-dialog-field-grow">
              {t("inviteFriend.type")}
              <select disabled value="ts3server">
                <option value="ts3server">ts3server link</option>
              </select>
            </label>
            <label className="ts-dialog-checkbox">
              <input
                type="checkbox"
                checked={includeChannel}
                disabled={channelId === null}
                onChange={(e) => setIncludeChannel(e.target.checked)}
              />
              {t("inviteFriend.includeChannel")}
            </label>
          </div>
          <label className="ts-dialog-field">
            {t("inviteFriend.link")}
            <input readOnly value={link} onFocus={(e) => e.target.select()} />
          </label>
        </div>
        <div className="ts-dialog-buttons">
          <button disabled title={t("clientContext.notSupported")}>
            {t("inviteFriend.addPermissionKey")}
          </button>
          <div className="ts-dialog-buttons-right">
            <button
              onClick={() => {
                void navigator.clipboard.writeText(link);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? t("inviteFriend.copied") : t("inviteFriend.copyToClipboard")}
            </button>
            <button onClick={onClose}>{t("dialog.close")}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ClientLogDialog({ entries, onClose }: { entries: ClientLogEntry[]; onClose: () => void }) {
  const t = useT();
  const [enabledLevels, setEnabledLevels] = useState<Set<LogLevel>>(new Set(LOG_LEVELS));
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const backdrop = useBackdropDismiss(onClose);
  const listRef = useRef<HTMLDivElement | null>(null);

  const toggleLevel = (level: LogLevel) => {
    setEnabledLevels((prev) => {
      const next = new Set(prev);
      if (next.has(level)) next.delete(level);
      else next.add(level);
      return next;
    });
  };

  const matches = (message: string, needle: string) =>
    caseSensitive ? message.includes(needle) : message.toLowerCase().includes(needle.toLowerCase());

  const visible = entries
    .filter((e) => enabledLevels.has(e.level))
    .filter((e) => !filter || matches(e.message, filter));

  const handleMark = () => {
    if (!search) return;
    const idx = visible.findIndex((e) => matches(e.message, search));
    if (idx >= 0) {
      const row = listRef.current?.querySelector(`[data-log-id="${visible[idx].id}"]`);
      row?.scrollIntoView({ block: "center" });
    }
  };

  return (
    <div className="ts-dialog-backdrop" {...backdrop}>
      <div className="ts-dialog ts-client-log-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="ts-dialog-titlebar">
          <span>{t("clientLog.title")}</span>
          <button onClick={onClose} title={t("dialog.close")}>
            ✕
          </button>
        </div>
        <div className="ts-dialog-body">
          <div className="ts-dialog-row ts-log-level-row">
            {LOG_LEVELS.map((level) => (
              <label key={level} className="ts-dialog-checkbox">
                <input
                  type="checkbox"
                  checked={enabledLevels.has(level)}
                  onChange={() => toggleLevel(level)}
                />
                {t(`clientLog.level.${level}`)}
              </label>
            ))}
          </div>
          <div className="ts-log-list" ref={listRef}>
            {visible.map((e) => (
              <div key={e.id} data-log-id={e.id} className={`ts-log-row ts-log-row-${e.level}`}>
                <span className="ts-log-time">{new Date(e.timestamp).toLocaleString()}</span>
                <span className="ts-log-category">{e.category}</span>
                <span className="ts-log-level">{t(`clientLog.level.${e.level}`)}</span>
                <span className="ts-log-message">{e.message}</span>
              </div>
            ))}
          </div>
          <div className="ts-dialog-row">
            <label className="ts-dialog-field ts-dialog-field-grow">
              {t("clientLog.search")}
              <input value={search} onChange={(e) => setSearch(e.target.value)} />
            </label>
            <label className="ts-dialog-checkbox">
              <input
                type="checkbox"
                checked={caseSensitive}
                onChange={(e) => setCaseSensitive(e.target.checked)}
              />
              {t("clientLog.caseSensitive")}
            </label>
          </div>
          <div className="ts-dialog-row">
            <label className="ts-dialog-field ts-dialog-field-grow">
              {t("clientLog.filter")}
              <input value={filter} onChange={(e) => setFilter(e.target.value)} />
            </label>
            <button onClick={handleMark}>{t("clientLog.mark")}</button>
          </div>
        </div>
        <div className="ts-dialog-buttons">
          <div />
          <div className="ts-dialog-buttons-right">
            <button onClick={onClose}>{t("dialog.close")}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function BanListDialog({
  entries,
  onDelete,
  onDeleteAll,
  onClose,
}: {
  entries: BanListEntry[] | null;
  onDelete: (banId: number) => void;
  onDeleteAll: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const backdrop = useBackdropDismiss(onClose);
  // Same silent-decline story as connection-info/server-log: a guest account
  // without b_virtualserver_client_dblist/banlist permission never gets a reply.
  const [timedOut, setTimedOut] = useState(false);
  useEffect(() => {
    setTimedOut(false);
    if (entries) return;
    const id = window.setTimeout(() => setTimedOut(true), 6000);
    return () => window.clearTimeout(id);
  }, [entries]);

  return (
    <div className="ts-dialog-backdrop" {...backdrop}>
      <div className="ts-dialog ts-ban-list-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="ts-dialog-titlebar">
          <span>{t("banList.title")}</span>
          <button onClick={onClose} title={t("dialog.close")}>
            ✕
          </button>
        </div>
        <div className="ts-dialog-body">
          {!entries ? (
            <div className="ts-connection-info-loading">
              {timedOut ? t("connectionInfo.unavailable") : t("connectionInfo.loading")}
            </div>
          ) : entries.length === 0 ? (
            <div className="ts-connection-info-loading">{t("banList.empty")}</div>
          ) : (
            <table className="ts-ban-list-table">
              <thead>
                <tr>
                  <th>{t("banList.name")}</th>
                  <th>{t("banList.ip")}</th>
                  <th>{t("banList.created")}</th>
                  <th>{t("banList.duration")}</th>
                  <th>{t("banList.invoker")}</th>
                  <th>{t("banList.reason")}</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.banId}>
                    <td>{e.name || e.lastNickname || "-"}</td>
                    <td>{e.ip || "-"}</td>
                    <td>{e.created}</td>
                    <td>{e.durationSecs === 0 ? t("banList.permanent") : `${e.durationSecs}s`}</td>
                    <td>{e.invokerName}</td>
                    <td>{e.reason}</td>
                    <td>
                      <button onClick={() => onDelete(e.banId)}>{t("banList.delete")}</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="ts-dialog-buttons">
          <div className="ts-dialog-buttons-left">
            {entries && entries.length > 0 && (
              <button onClick={onDeleteAll}>{t("banList.deleteAll")}</button>
            )}
          </div>
          <div className="ts-dialog-buttons-right">
            <button onClick={onClose}>{t("dialog.close")}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ComplainListDialog({
  entries,
  onDelete,
  onClose,
}: {
  entries: ComplainListEntry[] | null;
  onDelete: (targetClientDbId: number, fromClientDbId: number) => void;
  onClose: () => void;
}) {
  const t = useT();
  const backdrop = useBackdropDismiss(onClose);
  const [timedOut, setTimedOut] = useState(false);
  useEffect(() => {
    setTimedOut(false);
    if (entries) return;
    const id = window.setTimeout(() => setTimedOut(true), 6000);
    return () => window.clearTimeout(id);
  }, [entries]);

  return (
    <div className="ts-dialog-backdrop" {...backdrop}>
      <div className="ts-dialog ts-complain-list-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="ts-dialog-titlebar">
          <span>{t("complainList.title")}</span>
          <button onClick={onClose} title={t("dialog.close")}>
            ✕
          </button>
        </div>
        <div className="ts-dialog-body">
          {!entries ? (
            <div className="ts-connection-info-loading">
              {timedOut ? t("connectionInfo.unavailable") : t("connectionInfo.loading")}
            </div>
          ) : entries.length === 0 ? (
            <div className="ts-connection-info-loading">{t("complainList.empty")}</div>
          ) : (
            <table className="ts-ban-list-table">
              <thead>
                <tr>
                  <th>{t("complainList.target")}</th>
                  <th>{t("complainList.from")}</th>
                  <th>{t("complainList.message")}</th>
                  <th>{t("complainList.timestamp")}</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e, i) => (
                  <tr key={i}>
                    <td>{e.targetName}</td>
                    <td>{e.fromName}</td>
                    <td>{e.message}</td>
                    <td>{e.timestamp}</td>
                    <td>
                      <button onClick={() => onDelete(e.targetClientDbId, e.fromClientDbId)}>
                        {t("banList.delete")}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="ts-dialog-buttons">
          <div className="ts-dialog-buttons-right">
            <button onClick={onClose}>{t("dialog.close")}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function OfflineMessagesDialog({
  entries,
  detail,
  onSelect,
  onDelete,
  onMarkRead,
  onSend,
  onClose,
}: {
  entries: OfflineMessageListEntry[] | null;
  detail: { messageId: number; clientUid: string; subject: string; message: string; timestamp: string } | null;
  onSelect: (messageId: number) => void;
  onDelete: (messageId: number) => void;
  onMarkRead: (messageId: number) => void;
  onSend: (clientUid: string, subject: string, message: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const backdrop = useBackdropDismiss(onClose);
  const [timedOut, setTimedOut] = useState(false);
  const [composing, setComposing] = useState(false);
  const [composeUid, setComposeUid] = useState("");
  const [composeSubject, setComposeSubject] = useState("");
  const [composeMessage, setComposeMessage] = useState("");

  useEffect(() => {
    setTimedOut(false);
    if (entries) return;
    const id = window.setTimeout(() => setTimedOut(true), 6000);
    return () => window.clearTimeout(id);
  }, [entries]);

  const handleSend = () => {
    if (!composeUid.trim() || !composeSubject.trim()) return;
    onSend(composeUid.trim(), composeSubject.trim(), composeMessage.trim());
    setComposing(false);
    setComposeUid("");
    setComposeSubject("");
    setComposeMessage("");
  };

  return (
    <div className="ts-dialog-backdrop" {...backdrop}>
      <div className="ts-dialog ts-offline-messages-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="ts-dialog-titlebar">
          <span>{t("offlineMessages.title")}</span>
          <button onClick={onClose} title={t("dialog.close")}>
            ✕
          </button>
        </div>
        <div className="ts-dialog-body">
          {composing ? (
            <div className="ts-offline-message-compose">
              <label className="ts-dialog-field ts-dialog-field-grow">
                {t("offlineMessages.targetUid")}
                <input value={composeUid} onChange={(e) => setComposeUid(e.target.value)} />
              </label>
              <label className="ts-dialog-field ts-dialog-field-grow">
                {t("offlineMessages.subject")}
                <input value={composeSubject} onChange={(e) => setComposeSubject(e.target.value)} />
              </label>
              <label className="ts-dialog-field ts-dialog-field-grow">
                {t("offlineMessages.message")}
                <textarea value={composeMessage} onChange={(e) => setComposeMessage(e.target.value)} rows={5} />
              </label>
            </div>
          ) : detail ? (
            <div className="ts-offline-message-detail">
              <div className="ts-offline-message-detail-header">
                <strong>{detail.subject}</strong>
                <span>{detail.timestamp}</span>
              </div>
              <div className="ts-offline-message-detail-uid">{detail.clientUid}</div>
              <div className="ts-offline-message-detail-body">{detail.message}</div>
            </div>
          ) : !entries ? (
            <div className="ts-connection-info-loading">
              {timedOut ? t("connectionInfo.unavailable") : t("connectionInfo.loading")}
            </div>
          ) : entries.length === 0 ? (
            <div className="ts-connection-info-loading">{t("offlineMessages.empty")}</div>
          ) : (
            <table className="ts-ban-list-table">
              <thead>
                <tr>
                  <th></th>
                  <th>{t("offlineMessages.subject")}</th>
                  <th>{t("offlineMessages.from")}</th>
                  <th>{t("offlineMessages.timestamp")}</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.messageId}>
                    <td>{e.isRead ? "" : "●"}</td>
                    <td>
                      <a href="#" onClick={(ev) => { ev.preventDefault(); onSelect(e.messageId); }}>
                        {e.subject}
                      </a>
                    </td>
                    <td>{e.clientUid}</td>
                    <td>{e.timestamp}</td>
                    <td>
                      <button onClick={() => onDelete(e.messageId)}>{t("banList.delete")}</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="ts-dialog-buttons">
          <div className="ts-dialog-buttons-left">
            {composing ? (
              <>
                <button onClick={handleSend}>{t("offlineMessages.send")}</button>
                <button onClick={() => setComposing(false)}>{t("dialog.cancel")}</button>
              </>
            ) : detail ? (
              <>
                <button onClick={() => onMarkRead(detail.messageId)}>{t("offlineMessages.markRead")}</button>
                <button onClick={() => onSelect(-1)}>{t("offlineMessages.backToList")}</button>
              </>
            ) : (
              <button onClick={() => setComposing(true)}>{t("offlineMessages.new")}</button>
            )}
          </div>
          <div className="ts-dialog-buttons-right">
            <button onClick={onClose}>{t("dialog.close")}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function GroupAssignDialog({
  kind,
  clientName,
  groups,
  currentGroupIds,
  onSelect,
  onClose,
}: {
  kind: "channel" | "server";
  clientName: string;
  groups: GroupEntry[] | null;
  currentGroupIds: number[];
  onSelect: (groupId: number, alreadyAssigned: boolean) => void;
  onClose: () => void;
}) {
  const t = useT();
  const backdrop = useBackdropDismiss(onClose);
  const [timedOut, setTimedOut] = useState(false);
  useEffect(() => {
    setTimedOut(false);
    if (groups) return;
    const id = window.setTimeout(() => setTimedOut(true), 6000);
    return () => window.clearTimeout(id);
  }, [groups]);

  return (
    <div className="ts-dialog-backdrop" {...backdrop}>
      <div className="ts-dialog ts-group-assign-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="ts-dialog-titlebar">
          <span>
            {kind === "channel" ? t("groupAssign.channelTitle") : t("groupAssign.serverTitle")} - {clientName}
          </span>
          <button onClick={onClose} title={t("dialog.close")}>
            ✕
          </button>
        </div>
        <div className="ts-dialog-body">
          {!groups ? (
            <div className="ts-connection-info-loading">
              {timedOut ? t("connectionInfo.unavailable") : t("connectionInfo.loading")}
            </div>
          ) : groups.length === 0 ? (
            <div className="ts-connection-info-loading">{t("groupAssign.empty")}</div>
          ) : (
            <ul className="ts-group-assign-list">
              {groups.map((g) => {
                const assigned = currentGroupIds.includes(g.id);
                return (
                  <li key={g.id}>
                    <button
                      className={`ts-menu-item${assigned ? " ts-group-assign-current" : ""}`}
                      onClick={() => onSelect(g.id, assigned)}
                    >
                      <span className="ts-menu-item-icon">{assigned ? "✔️" : kind === "channel" ? "🏷️" : "🎖️"}</span>
                      <span className="ts-menu-item-label">{g.name}</span>
                      {kind === "server" && assigned && (
                        <span className="ts-group-assign-hint">{t("groupAssign.clickToRemove")}</span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <div className="ts-dialog-buttons">
          <div />
          <div className="ts-dialog-buttons-right">
            <button onClick={onClose}>{t("dialog.close")}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Builds the full channel-relative path TS3's ft* commands expect (e.g.
 *  "/foo/bar.txt") from a directory and a bare entry name. */
function ftJoinPath(dir: string, name: string): string {
  const base = dir === "/" || dir === "" ? "" : dir.replace(/\/+$/, "");
  return `${base}/${name}`;
}

function ftParentPath(dir: string): string {
  if (dir === "/" || dir === "") return "/";
  const trimmed = dir.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx <= 0 ? "/" : trimmed.slice(0, idx);
}

function FileBrowserDialog({
  channelName,
  path,
  entries,
  onNavigate,
  onCreateDir,
  onDelete,
  onRename,
  onDownload,
  onUpload,
  onRefresh,
  onClose,
}: {
  channelName: string;
  path: string;
  entries: FileListEntry[] | null;
  onNavigate: (path: string) => void;
  onCreateDir: (name: string) => void;
  onDelete: (entry: FileListEntry) => void;
  onRename: (entry: FileListEntry, newName: string) => void;
  onDownload: (entry: FileListEntry) => void;
  onUpload: (file: File) => void;
  onRefresh: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const backdrop = useBackdropDismiss(onClose);
  const [timedOut, setTimedOut] = useState(false);
  const [renaming, setRenaming] = useState<{ entry: FileListEntry; value: string } | null>(null);
  const [creatingDir, setCreatingDir] = useState(false);
  const [newDirName, setNewDirName] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setTimedOut(false);
    if (entries) return;
    const id = window.setTimeout(() => setTimedOut(true), 6000);
    return () => window.clearTimeout(id);
  }, [entries, path]);

  const sorted =
    entries
      ?.slice()
      .sort((a, b) => (a.isFile === b.isFile ? a.name.localeCompare(b.name) : a.isFile ? 1 : -1)) ?? null;

  return (
    <div className="ts-dialog-backdrop" {...backdrop}>
      <div className="ts-dialog ts-file-browser-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="ts-dialog-titlebar">
          <span>
            {t("fileBrowser.title")} - {channelName}
          </span>
          <button onClick={onClose} title={t("dialog.close")}>
            ✕
          </button>
        </div>
        <div className="ts-dialog-body">
          <div className="ts-file-browser-toolbar">
            <button onClick={() => onNavigate(ftParentPath(path))} disabled={path === "/"} title={t("fileBrowser.up")}>
              ⬆ {t("fileBrowser.up")}
            </button>
            <span className="ts-file-browser-path">{path}</span>
            <button onClick={onRefresh} title={t("fileBrowser.refresh")}>
              🔄
            </button>
            <button onClick={() => setCreatingDir(true)} title={t("fileBrowser.newFolder")}>
              🗀 {t("fileBrowser.newFolder")}
            </button>
            <button onClick={() => fileInputRef.current?.click()} title={t("fileBrowser.upload")}>
              ⬆️ {t("fileBrowser.upload")}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              style={{ display: "none" }}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) onUpload(file);
                e.target.value = "";
              }}
            />
          </div>
          {creatingDir && (
            <form
              className="ts-dialog-row"
              onSubmit={(e) => {
                e.preventDefault();
                if (newDirName.trim()) onCreateDir(newDirName.trim());
                setNewDirName("");
                setCreatingDir(false);
              }}
            >
              <input
                autoFocus
                value={newDirName}
                onChange={(e) => setNewDirName(e.target.value)}
                placeholder={t("fileBrowser.folderName")}
              />
              <button type="submit">{t("dialog.ok")}</button>
              <button type="button" onClick={() => setCreatingDir(false)}>
                {t("dialog.cancel")}
              </button>
            </form>
          )}
          {!sorted ? (
            <div className="ts-connection-info-loading">
              {timedOut ? t("connectionInfo.unavailable") : t("connectionInfo.loading")}
            </div>
          ) : sorted.length === 0 ? (
            <div className="ts-connection-info-loading">{t("fileBrowser.empty")}</div>
          ) : (
            <div className="ts-permission-overview-scroll">
              <table className="ts-ban-list-table">
                <thead>
                  <tr>
                    <th>{t("fileBrowser.name")}</th>
                    <th>{t("fileBrowser.size")}</th>
                    <th>{t("fileBrowser.modified")}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((entry) => (
                    <tr key={entry.name}>
                      <td>
                        {renaming?.entry.name === entry.name ? (
                          <form
                            onSubmit={(e) => {
                              e.preventDefault();
                              if (renaming.value.trim()) onRename(entry, renaming.value.trim());
                              setRenaming(null);
                            }}
                          >
                            <input
                              autoFocus
                              value={renaming.value}
                              onChange={(ev) => setRenaming({ entry, value: ev.target.value })}
                              onBlur={() => setRenaming(null)}
                            />
                          </form>
                        ) : entry.isFile ? (
                          <span>📄 {entry.name}</span>
                        ) : (
                          <button
                            className="ts-link-button"
                            onClick={() => onNavigate(ftJoinPath(path, entry.name))}
                          >
                            📁 {entry.name}
                          </button>
                        )}
                      </td>
                      <td>{entry.isFile ? formatBytes(entry.size) : ""}</td>
                      <td>{entry.timestamp}</td>
                      <td className="ts-file-browser-actions">
                        {entry.isFile && (
                          <button onClick={() => onDownload(entry)} title={t("fileBrowser.download")}>
                            ⬇
                          </button>
                        )}
                        <button
                          onClick={() => setRenaming({ entry, value: entry.name })}
                          title={t("fileBrowser.rename")}
                        >
                          ✏
                        </button>
                        <button onClick={() => onDelete(entry)} title={t("fileBrowser.delete")}>
                          🗑
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div className="ts-dialog-buttons">
          <div />
          <div className="ts-dialog-buttons-right">
            <button onClick={onClose}>{t("dialog.close")}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Sniffs an image MIME type from decoded bytes so uploaded icons (which can
 *  be PNG/GIF/JPEG/BMP) render correctly as data URIs regardless of format. */
function sniffImageMime(binary: string): string {
  if (binary.startsWith("\x89PNG")) return "image/png";
  if (binary.startsWith("GIF87a") || binary.startsWith("GIF89a")) return "image/gif";
  if (binary.charCodeAt(0) === 0xff && binary.charCodeAt(1) === 0xd8) return "image/jpeg";
  if (binary.startsWith("BM")) return "image/bmp";
  return "image/png";
}

function iconDataUrl(base64: string): string {
  return `data:${sniffImageMime(atob(base64))};base64,${base64}`;
}

// IDs below this are TeamSpeak's built-in default group icons - they ship
// inside the official client and were never uploaded to the server's icon
// filebase, so downloadFile() for them just hangs forever (nothing to send
// back). We don't have those graphics to embed, so those get a generic
// colored-letter badge instead; only real custom uploads (id >= threshold)
// are fetched as actual images.
const CUSTOM_ICON_ID_THRESHOLD = 1000;

/** Deterministic color for a group's letter badge - same icon id always
 *  produces the same hue, so a group looks consistent across the tree
 *  without needing the real (unavailable) TeamSpeak icon graphics. */
function groupBadgeColor(iconId: number): string {
  const hue = (iconId * 47) % 360;
  return `hsl(${hue}, 55%, 45%)`;
}

/** Nova-theme-only: a stable per-name color for the client avatar chips,
 *  hashed from the name so the same person always gets the same color. */
function clientAvatarColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  const hue = hash % 360;
  return `oklch(0.6 0.13 ${hue})`;
}

/** The icon repository lives under TS3's special "channel 0" - not a real,
 *  selectable channel, just the server-wide filebase icons are stored in.
 *  Icon files are always named "icon_<id>", where <id> is what a server/
 *  channel/group's icon field references. Reuses the same ftlist/download/
 *  upload/delete plumbing as the per-channel file browser. */
function ServerIconsDialog({
  entries,
  images,
  onUpload,
  onDelete,
  onClose,
}: {
  entries: FileListEntry[] | null;
  images: Record<string, string>;
  onUpload: (iconId: number, file: File) => void;
  onDelete: (entry: FileListEntry) => void;
  onClose: () => void;
}) {
  const t = useT();
  const backdrop = useBackdropDismiss(onClose);
  const [timedOut, setTimedOut] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [newIconId, setNewIconId] = useState("");

  useEffect(() => {
    setTimedOut(false);
    if (entries) return;
    const id = window.setTimeout(() => setTimedOut(true), 6000);
    return () => window.clearTimeout(id);
  }, [entries]);

  const nextFreeId = () => {
    const ids = (entries ?? [])
      .map((e) => parseInt(e.name.replace("icon_", ""), 10))
      .filter((n) => !Number.isNaN(n));
    return (ids.length ? Math.max(...ids) : 99) + 1;
  };

  return (
    <div className="ts-dialog-backdrop" {...backdrop}>
      <div className="ts-dialog ts-server-icons-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="ts-dialog-titlebar">
          <span>{t("serverIcons.title")}</span>
          <button onClick={onClose} title={t("dialog.close")}>
            ✕
          </button>
        </div>
        <div className="ts-dialog-body">
          <div className="ts-file-browser-toolbar">
            <button
              onClick={() => {
                setNewIconId(String(nextFreeId()));
                fileInputRef.current?.click();
              }}
              title={t("serverIcons.upload")}
            >
              ⬆️ {t("serverIcons.upload")}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              style={{ display: "none" }}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) setPendingFile(file);
              }}
            />
          </div>
          {pendingFile && (
            <form
              className="ts-dialog-row"
              onSubmit={(e) => {
                e.preventDefault();
                const id = parseInt(newIconId, 10);
                if (!Number.isNaN(id) && pendingFile) onUpload(id, pendingFile);
                setPendingFile(null);
              }}
            >
              <label className="ts-dialog-field">
                {t("serverIcons.iconId")}
                <input
                  type="number"
                  autoFocus
                  value={newIconId}
                  onChange={(e) => setNewIconId(e.target.value)}
                />
              </label>
              <button type="submit">{t("dialog.ok")}</button>
              <button type="button" onClick={() => setPendingFile(null)}>
                {t("dialog.cancel")}
              </button>
            </form>
          )}
          {!entries ? (
            <div className="ts-connection-info-loading">
              {timedOut ? t("connectionInfo.unavailable") : t("connectionInfo.loading")}
            </div>
          ) : entries.length === 0 ? (
            <div className="ts-connection-info-loading">{t("serverIcons.empty")}</div>
          ) : (
            <div className="ts-server-icons-grid">
              {entries.map((entry) => {
                const path = `/${entry.name}`;
                const base64 = images[path];
                return (
                  <div className="ts-server-icons-tile" key={entry.name}>
                    {base64 ? (
                      <img src={iconDataUrl(base64)} alt={entry.name} />
                    ) : (
                      <div className="ts-server-icons-tile-loading" />
                    )}
                    <span>{entry.name.replace("icon_", "#")}</span>
                    <button onClick={() => onDelete(entry)} title={t("fileBrowser.delete")}>
                      🗑
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <div className="ts-dialog-buttons">
          <div />
          <div className="ts-dialog-buttons-right">
            <button onClick={onClose}>{t("dialog.close")}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** The five permission-editor tabs from the real TS3 "Rechte" window - each
 *  is a different scope the ts3 protocol tracks assigned permissions under. */
const PERM_SCOPES: { scope: PermScope; labelKey: string }[] = [
  { scope: "server", labelKey: "permsEditor.tab.server" },
  { scope: "client", labelKey: "permsEditor.tab.client" },
  { scope: "channel", labelKey: "permsEditor.tab.channel" },
  { scope: "channelgroup", labelKey: "permsEditor.tab.channelgroup" },
  { scope: "channelclient", labelKey: "permsEditor.tab.channelclient" },
];

function PermissionsEditorDialog({
  initialScope,
  channelGroups,
  serverGroups,
  channels,
  clients,
  entries,
  catalog,
  onSelectTarget,
  onLoadCatalog,
  onAdd,
  onRemove,
  onClose,
}: {
  initialScope: PermScope;
  channelGroups: GroupEntry[] | null;
  serverGroups: GroupEntry[] | null;
  channels: ChannelInfo[];
  clients: ClientInfo[];
  entries: PermissionOverviewEntry[] | null;
  catalog: PermissionCatalogEntry[] | null;
  onSelectTarget: (scope: PermScope, id1: number, id2?: number) => void;
  onLoadCatalog: () => void;
  onAdd: (scope: PermScope, ids: number[], permId: number, value: number, negated: boolean, skip: boolean) => void;
  onRemove: (scope: PermScope, ids: number[], permId: number) => void;
  onClose: () => void;
}) {
  const t = useT();
  const backdrop = useBackdropDismiss(onClose);
  const [scope, setScope] = useState<PermScope>(initialScope);
  const [groupId, setGroupId] = useState<number | null>(null);
  const [channelId, setChannelId] = useState<number | null>(null);
  const [clientDbIdInput, setClientDbIdInput] = useState("");
  const [filter, setFilter] = useState("");
  const [showAddForm, setShowAddForm] = useState(false);
  const [addPermSearch, setAddPermSearch] = useState("");
  const [addPermId, setAddPermId] = useState<number | null>(null);
  const [addValue, setAddValue] = useState("1");
  const [addNegated, setAddNegated] = useState(false);
  const [addSkip, setAddSkip] = useState(false);

  const isGroupScope = scope === "server" || scope === "channelgroup";
  const groupList = scope === "server" ? serverGroups : scope === "channelgroup" ? channelGroups : null;
  // The channelgrouplist/servergrouplist requests decline silently when the
  // account lacks the permission to see them (no reply at all, same as
  // banlist/complainlist elsewhere) - without this, a permission-limited
  // account just sees a permanently blank panel with no explanation.
  const [groupsTimedOut, setGroupsTimedOut] = useState(false);
  useEffect(() => {
    setGroupsTimedOut(false);
    if (groupList) return;
    const id = window.setTimeout(() => setGroupsTimedOut(true), 6000);
    return () => window.clearTimeout(id);
  }, [groupList]);

  // (ids, ready) for the currently selected target under the active tab -
  // ready is false while a required piece (channel/client) hasn't been picked yet.
  const target: { id1: number; id2?: number } | null = (() => {
    const clientDbId = parseInt(clientDbIdInput, 10);
    switch (scope) {
      case "server":
      case "channelgroup":
        return groupId !== null ? { id1: groupId } : null;
      case "channel":
        return channelId !== null ? { id1: channelId } : null;
      case "client":
        return !Number.isNaN(clientDbId) ? { id1: clientDbId } : null;
      case "channelclient":
        return channelId !== null && !Number.isNaN(clientDbId) ? { id1: channelId, id2: clientDbId } : null;
      default:
        return null;
    }
  })();

  const load = (next: { scope: PermScope; groupId?: number | null; channelId?: number | null; clientDbId?: number }) => {
    // The catalog doubles as the name->id lookup the delete button needs, so
    // fetch it alongside the first load rather than only when "+ Hinzufügen"
    // is opened - onLoadCatalog is idempotent (a no-op once already cached).
    onLoadCatalog();
    const s = next.scope;
    const gid = next.groupId !== undefined ? next.groupId : groupId;
    const cid = next.channelId !== undefined ? next.channelId : channelId;
    const cldbid = next.clientDbId !== undefined ? next.clientDbId : parseInt(clientDbIdInput, 10);
    if ((s === "server" || s === "channelgroup") && gid !== null && gid !== undefined) {
      onSelectTarget(s, gid);
    } else if (s === "channel" && cid !== null && cid !== undefined) {
      onSelectTarget(s, cid);
    } else if (s === "client" && !Number.isNaN(cldbid)) {
      onSelectTarget(s, cldbid);
    } else if (s === "channelclient" && cid !== null && cid !== undefined && !Number.isNaN(cldbid)) {
      onSelectTarget(s, cid, cldbid);
    }
  };

  const filtered = entries?.filter((e) => e.name.toLowerCase().includes(filter.toLowerCase())) ?? null;
  const showNegated = scope === "server";
  const showSkip = scope === "server" || scope === "client";

  const catalogFiltered = (catalog ?? [])
    .filter((p) => p.name.toLowerCase().includes(addPermSearch.toLowerCase()))
    .slice(0, 200); // keep the <select> responsive against the ~500-entry catalog

  return (
    <div className="ts-dialog-backdrop" {...backdrop}>
      <div className="ts-dialog ts-perms-editor-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="ts-dialog-titlebar">
          <span>{t("permsEditor.title")}</span>
          <button onClick={onClose} title={t("dialog.close")}>
            ✕
          </button>
        </div>
        <div className="ts-perms-editor-tabs">
          {PERM_SCOPES.map((tab) => (
            <button
              key={tab.scope}
              className={`ts-perms-editor-tab${scope === tab.scope ? " ts-perms-editor-tab-active" : ""}`}
              onClick={() => {
                setScope(tab.scope);
                setShowAddForm(false);
              }}
            >
              {t(tab.labelKey)}
            </button>
          ))}
        </div>
        <div className="ts-dialog-body ts-perms-editor-body">
          <div className="ts-perms-editor-picker">
            {isGroupScope &&
              (groupList ? (
                <ul className="ts-perms-editor-list">
                  {groupList.length === 0 && (
                    <li className="ts-perms-editor-list-empty">{t("groupAssign.empty")}</li>
                  )}
                  {groupList.map((g) => (
                    <li key={g.id}>
                      <button
                        className={`ts-link-button${groupId === g.id ? " ts-perms-editor-selected" : ""}`}
                        onClick={() => {
                          setGroupId(g.id);
                          load({ scope, groupId: g.id });
                        }}
                      >
                        {g.name}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="ts-connection-info-loading">
                  {groupsTimedOut ? t("connectionInfo.unavailable") : t("connectionInfo.loading")}
                </div>
              ))}
            {(scope === "channel" || scope === "channelclient") && (
              <ul className="ts-perms-editor-list">
                {channels.map((c) => (
                  <li key={c.id}>
                    <button
                      className={`ts-link-button${channelId === c.id ? " ts-perms-editor-selected" : ""}`}
                      onClick={() => {
                        setChannelId(c.id);
                        load({ scope, channelId: c.id });
                      }}
                    >
                      {c.name}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {(scope === "client" || scope === "channelclient") && (
              <div className="ts-perms-editor-client-picker">
                <label className="ts-dialog-field">
                  {t("permsEditor.clientDbId")}
                  <input
                    value={clientDbIdInput}
                    onChange={(e) => setClientDbIdInput(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && load({ scope })}
                    placeholder="1"
                  />
                </label>
                <button onClick={() => load({ scope })}>{t("permsEditor.load")}</button>
                {clients.length > 0 && (
                  <select
                    value=""
                    onChange={(e) => {
                      const id = parseInt(e.target.value, 10);
                      if (!Number.isNaN(id)) {
                        setClientDbIdInput(String(id));
                        load({ scope, clientDbId: id });
                      }
                    }}
                  >
                    <option value="" disabled>
                      {t("permsEditor.pickOnlineClient")}
                    </option>
                    {clients.map((c) => (
                      <option key={c.id} value={c.databaseId}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            )}
          </div>
          <div className="ts-perms-editor-main">
            {!target ? (
              <div className="ts-connection-info-loading">{t("permsEditor.pickTarget")}</div>
            ) : (
              <>
                <div className="ts-dialog-row">
                  <label className="ts-dialog-field ts-dialog-field-grow">
                    {t("clientLog.filter")}
                    <input value={filter} onChange={(e) => setFilter(e.target.value)} />
                  </label>
                  <button
                    onClick={() => {
                      setShowAddForm((v) => !v);
                      if (!catalog) onLoadCatalog();
                    }}
                  >
                    + {t("permsEditor.addPermission")}
                  </button>
                </div>
                {showAddForm && (
                  <form
                    className="ts-perms-editor-add-form"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (addPermId === null || !target) return;
                      const value = parseInt(addValue, 10);
                      if (Number.isNaN(value)) return;
                      const ids = target.id2 !== undefined ? [target.id1, target.id2] : [target.id1];
                      onAdd(scope, ids, addPermId, value, addNegated, addSkip);
                      setShowAddForm(false);
                      setAddPermSearch("");
                      setAddPermId(null);
                    }}
                  >
                    <input
                      placeholder={t("permsEditor.searchPermission")}
                      value={addPermSearch}
                      onChange={(e) => setAddPermSearch(e.target.value)}
                    />
                    <select value={addPermId ?? ""} onChange={(e) => setAddPermId(parseInt(e.target.value, 10))}>
                      <option value="" disabled>
                        {t("permsEditor.searchPermission")}
                      </option>
                      {catalogFiltered.map((p) => (
                        <option key={p.id} value={p.id} title={p.description}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                    <input
                      type="number"
                      value={addValue}
                      onChange={(e) => setAddValue(e.target.value)}
                      style={{ width: "5em" }}
                    />
                    {showNegated && (
                      <label>
                        <input type="checkbox" checked={addNegated} onChange={(e) => setAddNegated(e.target.checked)} />
                        {t("permissionOverview.negated")}
                      </label>
                    )}
                    {showSkip && (
                      <label>
                        <input type="checkbox" checked={addSkip} onChange={(e) => setAddSkip(e.target.checked)} />
                        {t("permissionOverview.skip")}
                      </label>
                    )}
                    <button type="submit" disabled={addPermId === null}>
                      {t("dialog.ok")}
                    </button>
                  </form>
                )}
                {!entries ? (
                  <div className="ts-connection-info-loading">{t("connectionInfo.loading")}</div>
                ) : filtered && filtered.length === 0 ? (
                  <div className="ts-connection-info-loading">{t("permissionOverview.empty")}</div>
                ) : (
                  <div className="ts-permission-overview-scroll">
                    <table className="ts-ban-list-table">
                      <thead>
                        <tr>
                          <th>{t("permissionOverview.name")}</th>
                          <th>{t("permissionOverview.value")}</th>
                          {showNegated && <th>{t("permissionOverview.negated")}</th>}
                          {showSkip && <th>{t("permissionOverview.skip")}</th>}
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {filtered!.map((entry, i) => {
                          const catalogEntry = catalog?.find((p) => p.name === entry.name);
                          return (
                            <tr key={`${entry.name}-${i}`} title={entry.description || undefined}>
                              <td>{entry.name}</td>
                              <td>{entry.value}</td>
                              {showNegated && <td>{entry.negated ? "✔️" : ""}</td>}
                              {showSkip && <td>{entry.skip ? "✔️" : ""}</td>}
                              <td>
                                {catalogEntry && (
                                  <button
                                    onClick={() => {
                                      const ids = target.id2 !== undefined ? [target.id1, target.id2] : [target.id1];
                                      onRemove(scope, ids, catalogEntry.id);
                                    }}
                                    title={t("fileBrowser.delete")}
                                  >
                                    🗑
                                  </button>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
        <div className="ts-dialog-buttons">
          <button onClick={() => target && load({ scope })} disabled={!target}>
            {t("fileBrowser.refresh")}
          </button>
          <div className="ts-dialog-buttons-right">
            <button onClick={onClose}>{t("dialog.close")}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function PermissionOverviewDialog({
  entries,
  onClose,
}: {
  entries: PermissionOverviewEntry[] | null;
  onClose: () => void;
}) {
  const t = useT();
  const backdrop = useBackdropDismiss(onClose);
  const [search, setSearch] = useState("");
  const [timedOut, setTimedOut] = useState(false);
  useEffect(() => {
    setTimedOut(false);
    if (entries) return;
    const id = window.setTimeout(() => setTimedOut(true), 6000);
    return () => window.clearTimeout(id);
  }, [entries]);

  const filtered = entries?.filter((e) => e.name.toLowerCase().includes(search.toLowerCase())) ?? null;

  return (
    <div className="ts-dialog-backdrop" {...backdrop}>
      <div className="ts-dialog ts-permission-overview-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="ts-dialog-titlebar">
          <span>{t("permissionOverview.title")}</span>
          <button onClick={onClose} title={t("dialog.close")}>
            ✕
          </button>
        </div>
        <div className="ts-dialog-body">
          {!entries ? (
            <div className="ts-connection-info-loading">
              {timedOut ? t("connectionInfo.unavailable") : t("connectionInfo.loading")}
            </div>
          ) : entries.length === 0 ? (
            <div className="ts-connection-info-loading">{t("permissionOverview.empty")}</div>
          ) : (
            <>
              <div className="ts-dialog-row">
                <label className="ts-dialog-field ts-dialog-field-grow">
                  {t("clientLog.filter")}
                  <input value={search} onChange={(e) => setSearch(e.target.value)} />
                </label>
              </div>
              <div className="ts-permission-overview-scroll">
                <table className="ts-ban-list-table">
                  <thead>
                    <tr>
                      <th>{t("permissionOverview.name")}</th>
                      <th>{t("permissionOverview.value")}</th>
                      <th>{t("permissionOverview.negated")}</th>
                      <th>{t("permissionOverview.skip")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered!.map((e, i) => (
                      <tr key={`${e.name}-${i}`} title={e.description || undefined}>
                        <td>{e.name}</td>
                        <td>{e.value}</td>
                        <td>{e.negated ? "✔️" : ""}</td>
                        <td>{e.skip ? "✔️" : ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
        <div className="ts-dialog-buttons">
          <div />
          <div className="ts-dialog-buttons-right">
            <button onClick={onClose}>{t("dialog.close")}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ServerProtocolLogDialog({
  lines,
  onClose,
}: {
  lines: string[] | null;
  onClose: () => void;
}) {
  const t = useT();
  const backdrop = useBackdropDismiss(onClose);
  // The server may silently decline (e.g. missing b_virtualserver_log_view
  // permission) without ever replying - fall back to an error instead of
  // spinning forever.
  const [timedOut, setTimedOut] = useState(false);
  useEffect(() => {
    setTimedOut(false);
    if (lines) return;
    const id = window.setTimeout(() => setTimedOut(true), 6000);
    return () => window.clearTimeout(id);
  }, [lines]);

  return (
    <div className="ts-dialog-backdrop" {...backdrop}>
      <div className="ts-dialog ts-server-protocol-log-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="ts-dialog-titlebar">
          <span>{t("serverProtocolLog.title")}</span>
          <button onClick={onClose} title={t("dialog.close")}>
            ✕
          </button>
        </div>
        <div className="ts-dialog-body">
          {!lines ? (
            <div className="ts-connection-info-loading">
              {timedOut ? t("connectionInfo.unavailable") : t("connectionInfo.loading")}
            </div>
          ) : lines.length === 0 ? (
            <div className="ts-connection-info-loading">{t("serverProtocolLog.empty")}</div>
          ) : (
            <div className="ts-log-list">
              {lines.map((line, i) => (
                <div key={i} className="ts-server-protocol-log-line">
                  {line}
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="ts-dialog-buttons">
          <div className="ts-dialog-buttons-right">
            <button onClick={onClose}>{t("dialog.close")}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function WhisperHistoryDialog({
  serverName,
  entries,
  onClear,
  onClose,
}: {
  serverName: string;
  entries: WhisperLogEntry[];
  onClear: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const backdrop = useBackdropDismiss(onClose);

  return (
    <div className="ts-dialog-backdrop" {...backdrop}>
      <div className="ts-dialog ts-whisper-history-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="ts-dialog-titlebar">
          <span>{t("whisperHistory.title", { server: serverName })}</span>
          <button onClick={onClose} title={t("dialog.close")}>
            ✕
          </button>
        </div>
        <div className="ts-dialog-body">
          <div className="ts-whisper-history-list">
            {entries.length === 0 && (
              <div className="ts-whisper-history-empty">{t("whisperHistory.empty")}</div>
            )}
            {entries.map((e) => (
              <div key={e.id} className="ts-whisper-history-row">
                <span className="ts-log-time">{new Date(e.timestamp).toLocaleString()}</span>
                <span>{e.description}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="ts-dialog-buttons">
          <button onClick={onClear}>{t("whisperHistory.clear")}</button>
          <div className="ts-dialog-buttons-right">
            <button disabled title={t("clientContext.notSupported")}>
              {t("whisperHistory.options")}
            </button>
            <button onClick={onClose}>{t("dialog.close")}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function WhisperListsDialog({
  lists,
  hasCurrentSelection,
  onSave,
  onActivate,
  onDelete,
  onClose,
}: {
  lists: WhisperList[];
  hasCurrentSelection: boolean;
  onSave: (name: string) => void;
  onActivate: (list: WhisperList) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const backdrop = useBackdropDismiss(onClose);
  const [nameDraft, setNameDraft] = useState("");

  const handleSave = () => {
    const name = nameDraft.trim();
    if (!name || !hasCurrentSelection) return;
    onSave(name);
    setNameDraft("");
  };

  return (
    <div className="ts-dialog-backdrop" {...backdrop}>
      <div className="ts-dialog ts-whisper-lists-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="ts-dialog-titlebar">
          <span>{t("whisperLists.title")}</span>
          <button onClick={onClose} title={t("dialog.close")}>
            ✕
          </button>
        </div>
        <div className="ts-dialog-body">
          <div className="ts-dialog-row">
            <input
              placeholder={t("whisperLists.namePlaceholder")}
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
            />
            <button disabled={!nameDraft.trim() || !hasCurrentSelection} onClick={handleSave}>
              {t("whisperLists.saveCurrent")}
            </button>
          </div>
          <ul className="ts-whisper-lists-list">
            {lists.map((list) => (
              <li key={list.id} className="ts-whisper-lists-item">
                <div className="ts-whisper-lists-item-info">
                  <span className="ts-whisper-lists-item-name">{list.name}</span>
                  <span className="ts-whisper-lists-item-detail">
                    {t("whisperLists.itemDetail", {
                      channels: String(list.channelNames.length),
                      clients: String(list.clientNames.length),
                    })}
                  </span>
                </div>
                <div className="ts-whisper-lists-item-actions">
                  <button onClick={() => onActivate(list)}>{t("whisperLists.activate")}</button>
                  <button onClick={() => onDelete(list.id)}>{t("whisperLists.delete")}</button>
                </div>
              </li>
            ))}
            {lists.length === 0 && <li className="ts-whisper-lists-empty">{t("whisperLists.empty")}</li>}
          </ul>
        </div>
        <div className="ts-dialog-buttons">
          <div className="ts-dialog-buttons-right">
            <button onClick={onClose}>{t("dialog.close")}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ClientConnectionInfoDialog({
  clientName,
  info,
  onClose,
}: {
  clientName: string;
  info: ClientConnectionInfoData | null;
  onClose: () => void;
}) {
  const t = useT();
  const backdrop = useBackdropDismiss(onClose);
  // The server may silently decline (e.g. missing permission to view another
  // client's connection info) without ever replying - fall back to an error
  // instead of spinning forever.
  const [timedOut, setTimedOut] = useState(false);
  useEffect(() => {
    setTimedOut(false);
    if (info) return;
    const id = window.setTimeout(() => setTimedOut(true), 6000);
    return () => window.clearTimeout(id);
  }, [info, clientName]);

  return (
    <div className="ts-dialog-backdrop" {...backdrop}>
      <div className="ts-dialog ts-connection-info-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="ts-dialog-titlebar">
          <span>{t("connectionInfo.clientTitle", { name: clientName })}</span>
          <button onClick={onClose} title={t("dialog.close")}>
            ✕
          </button>
        </div>
        <div className="ts-dialog-body">
          {!info ? (
            <div className="ts-connection-info-loading">
              {timedOut ? t("connectionInfo.unavailable") : t("connectionInfo.loading")}
            </div>
          ) : (
            <div className="ts-connection-info-grid">
              <span>{t("connectionInfo.ping")}</span>
              <span>{info.pingMs != null ? `${info.pingMs.toFixed(1)} ms` : "-"}</span>
              <span>{t("connectionInfo.connectedSince")}</span>
              <span>{info.connectedSecs != null ? formatDurationSecs(info.connectedSecs) : "-"}</span>
              <span>{t("connectionInfo.ip")}</span>
              <span>{info.ip ?? "-"}</span>
              <span>{t("connectionInfo.packetLoss")}</span>
              <span>{info.packetLossPercent.toFixed(2)}%</span>
              <span>{t("connectionInfo.packetsSent")}</span>
              <span>{info.packetsSent.toLocaleString()}</span>
              <span>{t("connectionInfo.packetsReceived")}</span>
              <span>{info.packetsReceived.toLocaleString()}</span>
              <span>{t("connectionInfo.bytesSent")}</span>
              <span>{formatBytes(info.bytesSent)}</span>
              <span>{t("connectionInfo.bytesReceived")}</span>
              <span>{formatBytes(info.bytesReceived)}</span>
            </div>
          )}
        </div>
        <div className="ts-dialog-buttons">
          <div className="ts-dialog-buttons-right">
            <button onClick={onClose}>{t("dialog.close")}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ServerConnectionInfoDialog({
  info,
  onClose,
}: {
  info: ServerConnectionInfoData | null;
  onClose: () => void;
}) {
  const t = useT();
  const backdrop = useBackdropDismiss(onClose);
  // The server may silently decline (e.g. missing b_virtualserver_connectioninfo_view
  // permission) without ever replying - fall back to an error instead of spinning forever.
  const [timedOut, setTimedOut] = useState(false);
  useEffect(() => {
    setTimedOut(false);
    if (info) return;
    const id = window.setTimeout(() => setTimedOut(true), 6000);
    return () => window.clearTimeout(id);
  }, [info]);

  return (
    <div className="ts-dialog-backdrop" {...backdrop}>
      <div className="ts-dialog ts-connection-info-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="ts-dialog-titlebar">
          <span>{t("connectionInfo.serverTitle")}</span>
          <button onClick={onClose} title={t("dialog.close")}>
            ✕
          </button>
        </div>
        <div className="ts-dialog-body">
          {!info ? (
            <div className="ts-connection-info-loading">
              {timedOut ? t("connectionInfo.unavailable") : t("connectionInfo.loading")}
            </div>
          ) : (
            <div className="ts-connection-info-grid">
              <span>{t("connectionInfo.ping")}</span>
              <span>{info.pingMs.toFixed(1)} ms</span>
              <span>{t("connectionInfo.connectedSince")}</span>
              <span>{formatDurationSecs(info.connectedSecs)}</span>
              <span>{t("connectionInfo.packetLoss")}</span>
              <span>{info.packetLossPercent.toFixed(2)}%</span>
              <span>{t("connectionInfo.packetsSent")}</span>
              <span>{info.packetsSentTotal.toLocaleString()}</span>
              <span>{t("connectionInfo.packetsReceived")}</span>
              <span>{info.packetsReceivedTotal.toLocaleString()}</span>
              <span>{t("connectionInfo.bytesSent")}</span>
              <span>{formatBytes(info.bytesSentTotal)}</span>
              <span>{t("connectionInfo.bytesReceived")}</span>
              <span>{formatBytes(info.bytesReceivedTotal)}</span>
              <span>{t("connectionInfo.bandwidthSent")}</span>
              <span>{formatBytes(info.bandwidthSentLastSecond)}/s</span>
              <span>{t("connectionInfo.bandwidthReceived")}</span>
              <span>{formatBytes(info.bandwidthReceivedLastSecond)}/s</span>
            </div>
          )}
        </div>
        <div className="ts-dialog-buttons">
          <div className="ts-dialog-buttons-right">
            <button onClick={onClose}>{t("dialog.close")}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Mirrors the native client's "Identitäten" window: a list on the left plus
 *  a detail panel on the right (Name/Nickname/Phonetischer Nickname/
 *  Eindeutige ID), rather than the old flat list-with-inline-rename layout.
 *  The native window also has a myTeamSpeak-synced identity list and a
 *  "Sicherheitsstufe erhöhen" button - both deliberately out of scope here:
 *  the former needs a whole separate cloud-account system this self-hosted
 *  client doesn't have, and the latter (tsclientlib's proof-of-work identity
 *  level increase) already runs automatically during connect whenever a
 *  server demands a higher level, so there's nothing a manual button would
 *  add beyond letting you pre-compute it before connecting. */
function IdentitiesDialog({
  identities,
  activeId,
  ownUid,
  onActivate,
  onAdd,
  onRename,
  onNicknameChange,
  onPhoneticChange,
  onDelete,
  onExport,
  onImport,
  onClose,
}: {
  identities: Identity[];
  activeId: string | null;
  /** The connected own client's unique ID, if currently connected with the
   *  active identity - shown as that identity's "Eindeutige ID". */
  ownUid: string | null;
  onActivate: (id: string) => void;
  onAdd: () => void;
  onRename: (id: string, name: string) => void;
  onNicknameChange: (id: string, value: string) => void;
  onPhoneticChange: (id: string, value: string) => void;
  onDelete: (id: string) => void;
  onExport: (id: string) => void;
  onImport: (file: File) => void;
  onClose: () => void;
}) {
  const t = useT();
  const backdrop = useBackdropDismiss(onClose);
  const importInputRef = useRef<HTMLInputElement>(null);
  const [selectedId, setSelectedId] = useState(activeId ?? identities[0]?.id ?? null);
  const selected = identities.find((i) => i.id === selectedId) ?? identities[0] ?? null;

  return (
    <div className="ts-dialog-backdrop" {...backdrop}>
      <div className="ts-dialog ts-identities-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="ts-dialog-titlebar">
          <span>{t("identities.title")}</span>
          <button onClick={onClose} title={t("dialog.close")}>
            ✕
          </button>
        </div>
        <div className="ts-dialog-body ts-identities-body">
          <div>
            <div className="ts-identities-list-label">{t("identities.listLabel")}</div>
            <ul className="ts-identities-list">
              {identities.map((identity) => (
                <li key={identity.id}>
                  <button
                    className={`ts-link-button ts-identities-list-item${
                      identity.id === selectedId ? " ts-perms-editor-selected" : ""
                    }${identity.id === activeId ? " ts-identities-list-item-default" : ""}`}
                    onClick={() => setSelectedId(identity.id)}
                    title={identity.id === activeId ? t("identities.isDefault") : undefined}
                  >
                    {identity.id === activeId ? "★ " : ""}
                    {identity.name}
                  </button>
                </li>
              ))}
            </ul>
          </div>
          <div className="ts-identities-detail">
            {selected && (
              <>
                <label className="ts-dialog-field">
                  {t("identities.name")}
                  <input value={selected.name} onChange={(e) => onRename(selected.id, e.target.value)} />
                </label>
                <label className="ts-dialog-field">
                  {t("connect.nickname")}
                  <input
                    value={selected.nickname}
                    onChange={(e) => onNicknameChange(selected.id, e.target.value)}
                  />
                </label>
                <label className="ts-dialog-field">
                  {t("identities.phoneticNickname")}
                  <input
                    value={selected.phoneticName}
                    onChange={(e) => onPhoneticChange(selected.id, e.target.value)}
                  />
                </label>
                <label className="ts-dialog-field">
                  {t("identities.uniqueId")}
                  <input
                    readOnly
                    value={selected.id === activeId && ownUid ? ownUid : t("identities.unknown")}
                    className="ts-identities-readonly"
                  />
                </label>
                <div className="ts-identities-status">
                  {selected.blob ? t("identities.generated") : t("identities.pending")}
                </div>
              </>
            )}
          </div>
        </div>
        <div className="ts-dialog-buttons">
          <div>
            <button onClick={onAdd}>{t("identities.add")}</button>
            <button onClick={() => importInputRef.current?.click()}>{t("identities.import")}</button>
            <input
              ref={importInputRef}
              type="file"
              accept=".json,.ini,application/json,text/plain"
              style={{ display: "none" }}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) onImport(file);
              }}
            />
            {selected && (
              <>
                <button disabled={!selected.blob} onClick={() => onExport(selected.id)}>
                  {t("identities.export")}
                </button>
                <button onClick={() => onActivate(selected.id)} disabled={selected.id === activeId}>
                  {t("identities.setDefault")}
                </button>
                <button
                  disabled={identities.length <= 1}
                  onClick={() => {
                    const wasActive = selected.id === activeId;
                    const idx = identities.findIndex((i) => i.id === selected.id);
                    onDelete(selected.id);
                    if (selected.id === selectedId) {
                      const remaining = identities.filter((i) => i.id !== selected.id);
                      setSelectedId((wasActive ? remaining[0] : remaining[Math.max(0, idx - 1)])?.id ?? null);
                    }
                  }}
                >
                  {t("identities.delete")}
                </button>
              </>
            )}
          </div>
          <div className="ts-dialog-buttons-right">
            <button onClick={onClose}>{t("dialog.close")}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ContactsDialog({
  contacts,
  onlineClients,
  onSave,
  onWhisper,
  onShow,
  onClose,
}: {
  contacts: Contact[];
  onlineClients: ClientInfo[];
  onSave: (contacts: Contact[]) => void;
  onWhisper: (clientId: number) => void;
  onShow: (clientId: number) => void;
  onClose: () => void;
}) {
  const t = useT();
  const backdrop = useBackdropDismiss(onClose);
  const [draft, setDraft] = useState<Contact[]>(() => contacts.map((c) => ({ ...c })));
  const [selectedUid, setSelectedUid] = useState<string | null>(draft[0]?.uid ?? null);
  const [addClientId, setAddClientId] = useState("");

  const selected = draft.find((c) => c.uid === selectedUid) ?? null;
  const displayName = (c: Contact) => {
    const online = onlineClients.find((cl) => cl.uid === c.uid);
    return c.customName || online?.name || c.uid;
  };

  const updateSelected = (patch: Partial<Contact>) => {
    if (!selectedUid) return;
    setDraft((prev) => prev.map((c) => (c.uid === selectedUid ? { ...c, ...patch } : c)));
  };

  const save = (next: Contact[]) => {
    setDraft(next);
    onSave(next);
  };

  const handleAdd = () => {
    const client = onlineClients.find((c) => String(c.id) === addClientId);
    if (!client || !client.uid || draft.some((c) => c.uid === client.uid)) return;
    const contact: Contact = {
      uid: client.uid,
      customName: client.name,
      category: "acquaintance",
      phoneticName: "",
      ignored: false,
    };
    save([...draft, contact]);
    setSelectedUid(contact.uid);
    setAddClientId("");
  };

  const handleRemove = () => {
    if (!selectedUid) return;
    save(draft.filter((c) => c.uid !== selectedUid));
    setSelectedUid(null);
  };

  const addableClients = onlineClients.filter(
    (c) => c.uid && !draft.some((contact) => contact.uid === c.uid)
  );
  const selectedOnlineClient = selected ? onlineClients.find((c) => c.uid === selected.uid) : undefined;

  return (
    <div className="ts-dialog-backdrop" {...backdrop}>
      <div className="ts-dialog ts-contacts-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="ts-dialog-titlebar">
          <span>{t("contacts.title")}</span>
          <button onClick={onClose} title={t("dialog.close")}>
            ✕
          </button>
        </div>
        <div className="ts-contacts-body">
          <div className="ts-contacts-list-col">
            <div className="ts-dialog-row">
              <select value={addClientId} onChange={(e) => setAddClientId(e.target.value)}>
                <option value="">{t("contacts.addOnlineClient")}</option>
                {addableClients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <button disabled={!addClientId} onClick={handleAdd}>
                {t("contacts.add")}
              </button>
            </div>
            <ul className="ts-contacts-list">
              {draft.map((c) => (
                <li
                  key={c.uid}
                  className={`ts-contacts-list-item ts-contacts-category-${c.category}${c.uid === selectedUid ? " ts-contacts-list-item-selected" : ""}`}
                  onClick={() => setSelectedUid(c.uid)}
                >
                  {onlineClients.some((cl) => cl.uid === c.uid) && <span className="ts-contacts-online-dot" />}
                  {displayName(c)}
                  {c.ignored && " 🚫"}
                </li>
              ))}
              {draft.length === 0 && <li className="ts-contacts-list-empty">{t("contacts.empty")}</li>}
            </ul>
          </div>
          <div className="ts-contacts-fields-col">
            <label className="ts-dialog-field">
              {t("contacts.customName")}
              <input
                disabled={!selected}
                value={selected?.customName ?? ""}
                onChange={(e) => updateSelected({ customName: e.target.value })}
              />
            </label>
            <div className="ts-contacts-category-group">
              {(["acquaintance", "blocked", "friend"] as ContactCategory[]).map((cat) => (
                <label key={cat} className="ts-dialog-checkbox">
                  <input
                    type="radio"
                    name="contact-category"
                    disabled={!selected}
                    checked={selected?.category === cat}
                    onChange={() => updateSelected({ category: cat })}
                  />
                  {t(`contacts.category.${cat}`)}
                </label>
              ))}
            </div>
            <label className="ts-dialog-field">
              {t("contacts.phoneticName")}
              <input
                disabled={!selected}
                value={selected?.phoneticName ?? ""}
                onChange={(e) => updateSelected({ phoneticName: e.target.value })}
              />
            </label>
            <div className="ts-contacts-actions">
              <button
                disabled={!selectedOnlineClient}
                onClick={() => selectedOnlineClient && onShow(selectedOnlineClient.id)}
              >
                {t("contacts.show")}
              </button>
              <button disabled={!selected} onClick={() => updateSelected({ ignored: !selected?.ignored })}>
                {selected?.ignored ? t("contacts.unignore") : t("contacts.ignore")}
              </button>
              <button
                disabled={!selectedOnlineClient}
                onClick={() => selectedOnlineClient && onWhisper(selectedOnlineClient.id)}
              >
                {t("contacts.whisper")}
              </button>
            </div>
          </div>
        </div>
        <div className="ts-dialog-buttons">
          <button onClick={handleRemove} disabled={!selected}>
            {t("contacts.remove")}
          </button>
          <div className="ts-dialog-buttons-right">
            <button disabled title={t("clientContext.notSupported")}>
              {t("contacts.preferences")}
            </button>
            <button
              onClick={() => {
                onSave(draft);
                onClose();
              }}
            >
              {t("dialog.close")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function AwayDialog({
  message,
  presets,
  onMessageChange,
  onOk,
  onSaveTemplate,
  onCancel,
}: {
  message: string;
  presets: MessagePreset[];
  onMessageChange: (v: string) => void;
  onOk: () => void;
  onSaveTemplate: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  const backdrop = useBackdropDismiss(onCancel);
  return (
    <div className="ts-dialog-backdrop" {...backdrop}>
      <div className="ts-dialog ts-away-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="ts-dialog-titlebar">
          <span>{t("away.dialog.title")}</span>
          <button onClick={onCancel} title={t("dialog.close")}>
            ✕
          </button>
        </div>
        <div className="ts-dialog-body">
          <div className="ts-dialog-row">
            <span className="ts-dialog-away-label">{t("away.dialog.message")}</span>
            <label className="ts-dialog-field">
              {t("away.dialog.template")}
              <select
                value=""
                onChange={(e) => {
                  if (e.target.value) onMessageChange(e.target.value);
                }}
              >
                <option value="">{t("away.dialog.none")}</option>
                {presets.map((p) => (
                  <option key={p.name} value={p.message}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <input
            autoFocus
            className="ts-away-message-input"
            value={message}
            onChange={(e) => onMessageChange(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && onOk()}
          />
        </div>
        <div className="ts-dialog-buttons">
          <div className="ts-dialog-buttons-right">
            <button onClick={onOk}>{t("away.dialog.ok")}</button>
            <button onClick={onSaveTemplate} disabled={!message.trim()}>
              {t("away.dialog.save")}
            </button>
            <button onClick={onCancel}>{t("away.dialog.cancel")}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

const OPTIONS_SECTIONS = [
  { id: "anwendung", icon: "🎧" },
  { id: "wiedergabe", icon: "🔊" },
  { id: "aufnahme", icon: "🎙️" },
  { id: "sounds", icon: "🔔" },
  { id: "design", icon: "🖌️" },
  { id: "erweiterungen", icon: "🧩" },
  { id: "hotkeys", icon: "⌨️" },
  { id: "whispern", icon: "🤫" },
  { id: "downloads", icon: "⬇️" },
  { id: "chat", icon: "💬" },
  { id: "sicherheit", icon: "🛡️" },
  { id: "nachrichten", icon: "🔤" },
  { id: "meldungen", icon: "ℹ️" },
] as const;

interface AudioSettings {
  outputDevices: MediaDeviceInfo[];
  outputDeviceId: string;
  onOutputDeviceChange: (id: string, label?: string) => void;
  onRefreshOutputDevices: () => void;
  playbackVolume: number;
  onPlaybackVolumeChange: (v: number) => void;
  onPlayTestTone: () => void;
  inputDevices: MediaDeviceInfo[];
  inputDeviceId: string;
  onInputDeviceChange: (id: string) => void;
  onRefreshInputDevices: () => void;
  micOn: boolean;
  micLevelRef: React.MutableRefObject<number>;
  micTestOn: boolean;
  onToggleMicTest: () => void;
  vadThreshold: number;
  onVadThresholdChange: (v: number) => void;
  vadHangover: number;
  onVadHangoverChange: (v: number) => void;
  noiseSuppressionEnabled: boolean;
  onToggleNoiseSuppression: () => void;
  echoCancellationEnabled: boolean;
  onToggleEchoCancellation: () => void;
  autoGainControlEnabled: boolean;
  onToggleAutoGainControl: () => void;
}

function MicLevelBar({ levelRef, active }: { levelRef: React.MutableRefObject<number>; active: boolean }) {
  const [level, setLevel] = useState(0);
  useEffect(() => {
    if (!active) {
      setLevel(0);
      return;
    }
    let raf = 0;
    const tick = () => {
      setLevel(levelRef.current);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active, levelRef]);
  const pct = Math.min(100, Math.round((level / 0.2) * 100));
  return (
    <div className="ts-options-level-track">
      <div className="ts-options-level-fill" style={{ width: `${pct}%` }} />
    </div>
  );
}

function WiedergabePanel({ audio }: { audio: AudioSettings }) {
  const t = useT();
  const volumeDb = Math.round(20 * Math.log10(audio.playbackVolume || 0.001) * 10) / 10;
  return (
    <>
      <h3>{t("playback.title")}</h3>
      <p className="ts-options-subtitle">{t("playback.subtitle")}</p>
      <div className="ts-options-field-row">
        <label>{t("playback.profile")}</label>
      </div>
      <div className="ts-options-columns">
        <ul className="ts-options-profile-list">
          <li className="ts-options-profile-item-active">{t("playback.default")}</li>
        </ul>
        <div className="ts-options-fields">
          <label className="ts-options-field">
            {t("playback.device")}
            <select
              value={audio.outputDeviceId}
              onFocus={audio.onRefreshOutputDevices}
              onChange={(e) => audio.onOutputDeviceChange(e.target.value)}
            >
              <option value="">{t("playback.systemDefault")}</option>
              {audio.outputDevices.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || `Output ${d.deviceId.slice(0, 6)}`}
                </option>
              ))}
            </select>
          </label>
          <div className="ts-options-slider-row">
            <span>{t("playback.quiet")}</span>
            <span className="ts-options-slider-label">{t("playback.voiceVolume")}</span>
            <span>{t("playback.loud")}</span>
          </div>
          <div className="ts-options-slider-with-value">
            <input
              type="range"
              min={0}
              max={2}
              step={0.02}
              value={audio.playbackVolume}
              onChange={(e) => audio.onPlaybackVolumeChange(Number(e.target.value))}
            />
            <span className="ts-options-db-value">
              {volumeDb > 0 ? "+" : ""}
              {volumeDb} dB
            </span>
          </div>
          <button onClick={audio.onPlayTestTone}>{t("playback.playTestTone")}</button>
          <fieldset className="ts-options-fieldset">
            <legend>{t("playback.options")}</legend>
            <label className="ts-options-checkbox">
              <input type="checkbox" checked disabled readOnly />
              {t("playback.autoVolume")}
            </label>
            <label className="ts-options-checkbox">
              <input type="checkbox" checked disabled readOnly />
              {t("playback.ownMicClicks")}
            </label>
            <label className="ts-options-checkbox">
              <input type="checkbox" disabled readOnly />
              {t("playback.otherMicClicks")}
            </label>
          </fieldset>
        </div>
      </div>
    </>
  );
}

function AufnahmePanel({ audio }: { audio: AudioSettings }) {
  const t = useT();
  return (
    <>
      <h3>{t("recording.title")}</h3>
      <p className="ts-options-subtitle">{t("recording.subtitle")}</p>
      <div className="ts-options-columns">
        <ul className="ts-options-profile-list">
          <li className="ts-options-profile-item-active">{t("playback.default")}</li>
        </ul>
        <div className="ts-options-fields">
          <label className="ts-options-field">
            {t("recording.device")}
            <select
              value={audio.inputDeviceId}
              onFocus={audio.onRefreshInputDevices}
              onChange={(e) => audio.onInputDeviceChange(e.target.value)}
            >
              <option value="">{t("playback.systemDefault")}</option>
              {audio.inputDevices.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || `Input ${d.deviceId.slice(0, 6)}`}
                </option>
              ))}
            </select>
          </label>
          <fieldset className="ts-options-fieldset">
            <legend>{t("recording.activation")}</legend>
            <label className="ts-options-radio">
              <input type="radio" name="activation" disabled readOnly />
              {t("recording.pushToTalk")}
            </label>
            <label className="ts-options-radio">
              <input type="radio" name="activation" disabled readOnly />
              {t("recording.continuous")}
            </label>
            <label className="ts-options-radio">
              <input type="radio" name="activation" checked readOnly />
              {t("recording.voiceActivation")}
            </label>
            <div className="ts-options-level-wrap">
              <MicLevelBar levelRef={audio.micLevelRef} active={audio.micOn} />
              <input
                className="ts-options-level-threshold"
                type="range"
                min={0.002}
                max={0.15}
                step={0.002}
                value={audio.vadThreshold}
                onChange={(e) => audio.onVadThresholdChange(Number(e.target.value))}
              />
            </div>
            <div className="ts-options-field-row">
              <button onClick={audio.onToggleMicTest} disabled={!audio.micOn}>
                {audio.micTestOn ? t("recording.testStop") : t("recording.testStart")}
              </button>
              <span className={`ts-options-test-dot${audio.micTestOn ? " ts-options-test-dot-on" : ""}`} />
              <label className="ts-options-field-inline">
                {t("recording.hangoverDelay")}
                <input
                  type="number"
                  min={0}
                  max={2}
                  step={0.1}
                  value={audio.vadHangover}
                  onChange={(e) => audio.onVadHangoverChange(Number(e.target.value))}
                />
                {t("recording.secondsUnit")}
              </label>
            </div>
          </fieldset>
          <fieldset className="ts-options-fieldset">
            <legend>{t("recording.dsp")}</legend>
            <div className="ts-options-dsp-grid">
              <label className="ts-options-checkbox">
                <input type="checkbox" disabled readOnly />
                {t("recording.typingAttenuation")}
              </label>
              <label className="ts-options-checkbox">
                <input
                  type="checkbox"
                  checked={audio.echoCancellationEnabled}
                  onChange={audio.onToggleEchoCancellation}
                />
                {t("recording.echoCancellation")}
              </label>
              <label className="ts-options-checkbox">
                <input
                  type="checkbox"
                  checked={audio.noiseSuppressionEnabled}
                  onChange={audio.onToggleNoiseSuppression}
                />
                {t("recording.noiseSuppression")}
              </label>
              <label className="ts-options-checkbox">
                <input
                  type="checkbox"
                  checked={audio.autoGainControlEnabled}
                  onChange={audio.onToggleAutoGainControl}
                />
                {t("recording.autoGainControl")}
              </label>
            </div>
          </fieldset>
        </div>
      </div>
    </>
  );
}

function AnwendungPanel() {
  const t = useT();
  const { langPref, setLangPref } = useLanguage();
  return (
    <>
      <h3>{t("app.title")}</h3>
      <p className="ts-options-subtitle">{t("app.subtitle")}</p>
      <label className="ts-options-field">
        {t("app.language")}
        <select value={langPref} onChange={(e) => setLangPref(e.target.value as LangPref)}>
          <option value="auto">{t("app.language.auto")}</option>
          <option value="de">{t("app.language.de")}</option>
          <option value="en">{t("app.language.en")}</option>
        </select>
      </label>
    </>
  );
}

type CustomThemeDraft = { id: string | null; name: string; baseTheme: DesignTheme; css: string };

function DesignPanel({
  designSelection,
  onSelectionChange,
  customThemes,
  onSaveCustomTheme,
  onDeleteCustomTheme,
}: {
  designSelection: string;
  onSelectionChange: (next: string) => void;
  customThemes: CustomTheme[];
  onSaveCustomTheme: (theme: CustomTheme) => void;
  onDeleteCustomTheme: (id: string) => void;
}) {
  const t = useT();
  const [editing, setEditing] = useState<CustomThemeDraft | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);

  const builtins: { id: DesignTheme; name: string; desc: string }[] = [
    { id: "standard", name: t("design.theme.standard"), desc: t("design.theme.standard.desc") },
    { id: "nova", name: t("design.theme.nova"), desc: t("design.theme.nova.desc") },
  ];

  const handleSaveEditing = () => {
    if (!editing || !editing.name.trim()) return;
    const id = editing.id ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    onSaveCustomTheme({ id, name: editing.name.trim(), baseTheme: editing.baseTheme, css: editing.css });
    onSelectionChange(`custom:${id}`);
    setEditing(null);
  };

  const handleExport = (theme: CustomTheme) => {
    const blob = new Blob(
      [JSON.stringify({ name: theme.name, baseTheme: theme.baseTheme, css: theme.css }, null, 2)],
      { type: "application/json" }
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${theme.name.replace(/[^a-z0-9-_]+/gi, "_") || "theme"}.webspeak3theme.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImportSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      if (
        !parsed ||
        typeof parsed.name !== "string" ||
        (parsed.baseTheme !== "standard" && parsed.baseTheme !== "nova") ||
        typeof parsed.css !== "string"
      ) {
        window.alert(t("design.custom.importError"));
        return;
      }
      const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      onSaveCustomTheme({ id, name: parsed.name, baseTheme: parsed.baseTheme, css: parsed.css });
      onSelectionChange(`custom:${id}`);
    } catch {
      window.alert(t("design.custom.importError"));
    }
  };

  if (editing) {
    return (
      <>
        <h3>{editing.id ? t("design.custom.editTitle") : t("design.custom.newTitle")}</h3>
        <label className="ts-options-field">
          {t("design.custom.name")}
          <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} autoFocus />
        </label>
        <label className="ts-options-field">
          {t("design.custom.base")}
          <select
            value={editing.baseTheme}
            onChange={(e) => setEditing({ ...editing, baseTheme: e.target.value as DesignTheme })}
          >
            <option value="standard">{t("design.theme.standard")}</option>
            <option value="nova">{t("design.theme.nova")}</option>
          </select>
        </label>
        <label className="ts-options-field">
          {t("design.custom.css")}
          <textarea
            className="ts-custom-theme-css"
            spellCheck={false}
            value={editing.css}
            onChange={(e) => setEditing({ ...editing, css: e.target.value })}
            placeholder={".ts-app {\n  --accent: #ff6b6b;\n}"}
          />
        </label>
        <p className="ts-options-subtitle">{t("design.custom.hint")}</p>
        <div className="ts-dialog-buttons-right">
          <button onClick={() => setEditing(null)}>{t("connect.cancel")}</button>
          <button onClick={handleSaveEditing} disabled={!editing.name.trim()}>
            {t("design.custom.save")}
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      <h3>{t("options.section.design")}</h3>
      <p className="ts-options-subtitle">{t("design.subtitle")}</p>
      <div className="ts-design-theme-grid">
        {builtins.map((th) => (
          <button
            key={th.id}
            className={`ts-design-theme-card${th.id === designSelection ? " ts-design-theme-card-active" : ""}`}
            onClick={() => onSelectionChange(th.id)}
          >
            <span className={`ts-design-theme-swatch ts-design-theme-swatch-${th.id}`} />
            <span className="ts-design-theme-card-name">{th.name}</span>
            <span className="ts-design-theme-card-desc">{th.desc}</span>
          </button>
        ))}
        {customThemes.map((theme) => (
          <div
            key={theme.id}
            className={`ts-design-theme-card ts-design-theme-card-custom${
              designSelection === `custom:${theme.id}` ? " ts-design-theme-card-active" : ""
            }`}
          >
            <button className="ts-design-theme-card-select" onClick={() => onSelectionChange(`custom:${theme.id}`)}>
              <span className="ts-design-theme-swatch ts-design-theme-swatch-custom" />
              <span className="ts-design-theme-card-name">{theme.name}</span>
              <span className="ts-design-theme-card-desc">
                {theme.baseTheme === "nova" ? t("design.theme.nova") : t("design.theme.standard")}
              </span>
            </button>
            <div className="ts-design-theme-card-actions">
              <button
                onClick={() => setEditing({ id: theme.id, name: theme.name, baseTheme: theme.baseTheme, css: theme.css })}
                title={t("design.custom.edit")}
              >
                ✎
              </button>
              <button
                onClick={() =>
                  setEditing({ id: null, name: t("design.custom.copyOf", { name: theme.name }), baseTheme: theme.baseTheme, css: theme.css })
                }
                title={t("design.custom.duplicate")}
              >
                ⧉
              </button>
              <button onClick={() => handleExport(theme)} title={t("design.custom.export")}>
                ⭳
              </button>
              <button
                onClick={() => {
                  if (window.confirm(t("design.custom.deleteConfirm"))) onDeleteCustomTheme(theme.id);
                }}
                title={t("design.custom.delete")}
              >
                🗑
              </button>
            </div>
          </div>
        ))}
      </div>
      <div className="ts-design-custom-actions">
        <button onClick={() => setEditing({ id: null, name: "", baseTheme: "standard", css: "" })}>
          {t("design.custom.new")}
        </button>
        <button onClick={() => importInputRef.current?.click()}>{t("design.custom.import")}</button>
        <input
          ref={importInputRef}
          type="file"
          accept="application/json,.json"
          style={{ display: "none" }}
          onChange={handleImportSelected}
        />
      </div>
    </>
  );
}

function SoundsPanel() {
  const t = useT();
  const [enabled, setEnabled] = useState(() => loadSoundsEnabled());
  const [volume, setVolume] = useState(() => loadSoundsVolume());
  const [customNames, setCustomNames] = useState<Partial<Record<SoundEventId, string>>>({});
  const [eventEnabled, setEventEnabled] = useState<Record<SoundEventId, boolean>>(() =>
    Object.fromEntries(SOUND_EVENTS.map((id) => [id, loadEventSoundEnabled(id)])) as Record<SoundEventId, boolean>
  );
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const uploadTargetRef = useRef<SoundEventId | null>(null);
  const soundpackInputRef = useRef<HTMLInputElement | null>(null);
  const [soundpackResult, setSoundpackResult] = useState<{
    matchedCount: number;
    unmatchedFiles: string[];
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const entries = await Promise.all(
        SOUND_EVENTS.map(async (id) => [id, (await loadCustomSound(id))?.name] as const)
      );
      if (cancelled) return;
      const next: Partial<Record<SoundEventId, string>> = {};
      for (const [id, name] of entries) if (name) next[id] = name;
      setCustomNames(next);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleToggleEnabled = () => {
    const next = !enabled;
    setEnabled(next);
    saveSoundsEnabled(next);
  };

  const handleVolumeChange = (v: number) => {
    setVolume(v);
    saveSoundsVolume(v);
  };

  const handleToggleEventEnabled = (event: SoundEventId) => {
    const next = !eventEnabled[event];
    setEventEnabled((prev) => ({ ...prev, [event]: next }));
    saveEventSoundEnabled(event, next);
  };

  const handleUploadClick = (event: SoundEventId) => {
    uploadTargetRef.current = event;
    fileInputRef.current?.click();
  };

  const handleFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    const event = uploadTargetRef.current;
    e.target.value = "";
    if (!file || !event) return;
    await saveCustomSound(event, file);
    setCustomNames((prev) => ({ ...prev, [event]: file.name }));
  };

  const handleReset = async (event: SoundEventId) => {
    await clearCustomSound(event);
    setCustomNames((prev) => {
      const next = { ...prev };
      delete next[event];
      return next;
    });
  };

  const handleImportSoundpackClick = () => soundpackInputRef.current?.click();

  const handleSoundpackSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setSoundpackResult(null);
    const { matched, unmatchedFiles } = await parseSoundpack(file);
    for (const [event, sound] of Object.entries(matched) as [SoundEventId, { name: string; blob: Blob }][]) {
      await saveCustomSound(event, new File([sound.blob], sound.name, { type: sound.blob.type }));
    }
    setCustomNames((prev) => {
      const next = { ...prev };
      for (const [event, sound] of Object.entries(matched) as [SoundEventId, { name: string; blob: Blob }][]) {
        next[event] = sound.name;
      }
      return next;
    });
    setSoundpackResult({ matchedCount: Object.keys(matched).length, unmatchedFiles });
  };

  return (
    <>
      <h3>{t("sounds.title")}</h3>
      <p className="ts-options-subtitle">{t("sounds.subtitle")}</p>
      <label className="ts-options-field-row">
        <input type="checkbox" checked={enabled} onChange={handleToggleEnabled} />
        {t("sounds.enable")}
      </label>
      <div className="ts-options-slider-with-value">
        <span className="ts-options-slider-label">{t("sounds.volume")}</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={volume}
          onChange={(e) => handleVolumeChange(Number(e.target.value))}
        />
        <span>{Math.round(volume * 100)}%</span>
      </div>
      <div className="ts-options-field-row">
        <button onClick={handleImportSoundpackClick}>{t("sounds.importSoundpack")}</button>
      </div>
      {soundpackResult && (
        <p className="ts-options-subtitle">
          {t("sounds.importResult", {
            matched: String(soundpackResult.matchedCount),
            unmatched: String(soundpackResult.unmatchedFiles.length),
          })}
        </p>
      )}
      <table className="ts-options-sounds-table">
        <tbody>
          {SOUND_EVENTS.map((eventId) => (
            <tr key={eventId}>
              <td>
                <input
                  type="checkbox"
                  checked={eventEnabled[eventId]}
                  onChange={() => handleToggleEventEnabled(eventId)}
                  title={t("sounds.eventEnable")}
                />
              </td>
              <td>{t(`sounds.event.${eventId}`)}</td>
              <td className="ts-options-sounds-source">
                {customNames[eventId] ? t("sounds.custom", { name: customNames[eventId]! }) : t("sounds.default")}
              </td>
              <td>
                <button onClick={() => void playSound(eventId)}>{t("sounds.test")}</button>
              </td>
              <td>
                <button onClick={() => handleUploadClick(eventId)}>{t("sounds.upload")}</button>
              </td>
              <td>
                {customNames[eventId] && <button onClick={() => void handleReset(eventId)}>{t("sounds.reset")}</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <input
        ref={fileInputRef}
        type="file"
        accept="audio/*"
        style={{ display: "none" }}
        onChange={(e) => void handleFileSelected(e)}
      />
      <input
        ref={soundpackInputRef}
        type="file"
        accept=".ts3soundpack,.zip"
        style={{ display: "none" }}
        onChange={(e) => void handleSoundpackSelected(e)}
      />
    </>
  );
}

function NachrichtenPanel() {
  const t = useT();
  const [presets, setPresets] = useState<MessagePreset[]>(() => loadAwayPresets());
  const [disconnectMessage, setDisconnectMessageState] = useState(() => loadDisconnectMessage());
  const [newName, setNewName] = useState("");
  const [newMessage, setNewMessage] = useState("");

  const handleDisconnectMessageChange = (v: string) => {
    setDisconnectMessageState(v);
    saveDisconnectMessage(v);
  };

  const handleAdd = () => {
    const name = newName.trim();
    const message = newMessage.trim();
    if (!name || !message) return;
    const next = [...presets, { name, message }];
    setPresets(next);
    saveAwayPresets(next);
    setNewName("");
    setNewMessage("");
  };

  const handleDelete = (index: number) => {
    const next = presets.filter((_, i) => i !== index);
    setPresets(next);
    saveAwayPresets(next);
  };

  return (
    <>
      <h3>{t("nachrichten.title")}</h3>
      <p className="ts-options-subtitle">{t("nachrichten.subtitle")}</p>
      <label className="ts-dialog-field">
        {t("nachrichten.disconnectMessage")}
        <input
          value={disconnectMessage}
          onChange={(e) => handleDisconnectMessageChange(e.target.value)}
          placeholder={t("nachrichten.disconnectMessagePlaceholder")}
        />
      </label>
      <h4>{t("nachrichten.presetsTitle")}</h4>
      <table className="ts-options-sounds-table">
        <thead>
          <tr>
            <th>{t("nachrichten.type")}</th>
            <th>{t("nachrichten.templateName")}</th>
            <th>{t("nachrichten.message")}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {presets.map((preset, index) => (
            <tr key={`${preset.name}-${index}`}>
              <td>{t("nachrichten.type.away")}</td>
              <td>{preset.name}</td>
              <td>{preset.message}</td>
              <td>
                <button onClick={() => handleDelete(index)}>{t("nachrichten.delete")}</button>
              </td>
            </tr>
          ))}
          <tr>
            <td>{t("nachrichten.type.away")}</td>
            <td>
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder={t("nachrichten.templateName")}
              />
            </td>
            <td>
              <input
                value={newMessage}
                onChange={(e) => setNewMessage(e.target.value)}
                placeholder={t("nachrichten.message")}
                onKeyDown={(e) => e.key === "Enter" && handleAdd()}
              />
            </td>
            <td>
              <button onClick={handleAdd} disabled={!newName.trim() || !newMessage.trim()}>
                {t("nachrichten.add")}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </>
  );
}

function OptionsDialog({
  section,
  onSectionChange,
  onClose,
  audio,
  designSelection,
  onDesignSelectionChange,
  customThemes,
  onSaveCustomTheme,
  onDeleteCustomTheme,
}: {
  section: string;
  onSectionChange: (id: string) => void;
  onClose: () => void;
  audio: AudioSettings;
  designSelection: string;
  onDesignSelectionChange: (next: string) => void;
  customThemes: CustomTheme[];
  onSaveCustomTheme: (theme: CustomTheme) => void;
  onDeleteCustomTheme: (id: string) => void;
}) {
  const t = useT();
  const active = OPTIONS_SECTIONS.find((s) => s.id === section) ?? OPTIONS_SECTIONS[0];
  const backdrop = useBackdropDismiss(onClose);
  return (
    <div className="ts-dialog-backdrop" {...backdrop}>
      <div className="ts-dialog ts-options-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="ts-dialog-titlebar">
          <span>{t("options.title")}</span>
          <button onClick={onClose} title={t("dialog.close")}>
            ✕
          </button>
        </div>
        <div className="ts-options-body">
          <div className="ts-options-sidebar">
            {OPTIONS_SECTIONS.map((s) => (
              <button
                key={s.id}
                className={`ts-options-sidebar-item${s.id === active.id ? " ts-options-sidebar-item-active" : ""}`}
                onClick={() => onSectionChange(s.id)}
              >
                <span className="ts-options-sidebar-icon">{s.icon}</span>
                <span>{t(`options.section.${s.id}`)}</span>
              </button>
            ))}
          </div>
          <div className="ts-options-content">
            {active.id === "anwendung" ? (
              <AnwendungPanel />
            ) : active.id === "wiedergabe" ? (
              <WiedergabePanel audio={audio} />
            ) : active.id === "aufnahme" ? (
              <AufnahmePanel audio={audio} />
            ) : active.id === "sounds" ? (
              <SoundsPanel />
            ) : active.id === "design" ? (
              <DesignPanel
                designSelection={designSelection}
                onSelectionChange={onDesignSelectionChange}
                customThemes={customThemes}
                onSaveCustomTheme={onSaveCustomTheme}
                onDeleteCustomTheme={onDeleteCustomTheme}
              />
            ) : active.id === "nachrichten" ? (
              <NachrichtenPanel />
            ) : (
              <>
                <h3>{t(`options.section.${active.id}`)}</h3>
                <p className="ts-options-placeholder">{t("options.notImplemented")}</p>
              </>
            )}
          </div>
        </div>
        <div className="ts-dialog-buttons">
          <div className="ts-dialog-buttons-right">
            <button onClick={onClose}>{t("options.ok")}</button>
            <button onClick={onClose}>{t("options.cancel")}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

const SERVER_EDIT_TABS = ["host", "misc", "transmission", "antiflood", "security", "log"] as const;

interface ServerEditPayload {
  name?: string;
  welcomeMessage?: string;
  password?: string;
  maxClients?: number;
  hostmessage?: string;
  hostmessageMode?: string;
  hostbannerUrl?: string;
  hostbannerGfxUrl?: string;
  hostbannerGfxIntervalSecs?: number;
  hostbannerMode?: string;
  hostbuttonTooltip?: string;
  hostbuttonUrl?: string;
  hostbuttonGfxUrl?: string;
  nickname?: string;
  phoneticName?: string;
  codecEncryptionMode?: string;
}

function ServerEditDialog({
  serverName,
  welcomeMessage,
  hostbannerGfxUrl,
  onSave,
  onClose,
}: {
  serverName: string;
  welcomeMessage: string;
  hostbannerGfxUrl: string;
  onSave: (payload: ServerEditPayload) => void;
  onClose: () => void;
}) {
  const t = useT();
  const backdrop = useBackdropDismiss(onClose);
  const [tab, setTab] = useState<(typeof SERVER_EDIT_TABS)[number]>("host");

  const [name, setName] = useState(serverName);
  const [welcome, setWelcome] = useState(welcomeMessage);
  const [clearPassword, setClearPassword] = useState(false);
  const [password, setPassword] = useState("");
  const [hostmessage, setHostmessage] = useState("");
  const [hostmessageMode, setHostmessageMode] = useState("");
  const [hostbannerUrl, setHostbannerUrl] = useState("");
  const [bannerGfxUrl, setBannerGfxUrl] = useState(hostbannerGfxUrl);
  const [hostbannerGfxInterval, setHostbannerGfxInterval] = useState("");
  const [hostbannerMode, setHostbannerMode] = useState("");
  const [hostbuttonTooltip, setHostbuttonTooltip] = useState("");
  const [hostbuttonUrl, setHostbuttonUrl] = useState("");
  const [hostbuttonGfxUrl, setHostbuttonGfxUrl] = useState("");
  const [maxClients, setMaxClients] = useState("");
  const [nickname, setNickname] = useState("");
  const [phoneticName, setPhoneticName] = useState("");
  const [codecEncryptionMode, setCodecEncryptionMode] = useState("");

  const handleSave = () => {
    const payload: ServerEditPayload = {};
    if (name.trim() && name !== serverName) payload.name = name.trim();
    if (welcome !== welcomeMessage) payload.welcomeMessage = welcome;
    if (clearPassword) payload.password = "";
    else if (password) payload.password = password;
    if (hostmessage) payload.hostmessage = hostmessage;
    if (hostmessageMode) payload.hostmessageMode = hostmessageMode;
    if (hostbannerUrl) payload.hostbannerUrl = hostbannerUrl;
    if (bannerGfxUrl !== hostbannerGfxUrl) payload.hostbannerGfxUrl = bannerGfxUrl;
    if (hostbannerGfxInterval) payload.hostbannerGfxIntervalSecs = Number(hostbannerGfxInterval) || 0;
    if (hostbannerMode) payload.hostbannerMode = hostbannerMode;
    if (hostbuttonTooltip) payload.hostbuttonTooltip = hostbuttonTooltip;
    if (hostbuttonUrl) payload.hostbuttonUrl = hostbuttonUrl;
    if (hostbuttonGfxUrl) payload.hostbuttonGfxUrl = hostbuttonGfxUrl;
    if (maxClients) payload.maxClients = Number(maxClients) || 0;
    if (nickname) payload.nickname = nickname;
    if (phoneticName) payload.phoneticName = phoneticName;
    if (codecEncryptionMode) payload.codecEncryptionMode = codecEncryptionMode;
    onSave(payload);
    onClose();
  };

  return (
    <div className="ts-dialog-backdrop" {...backdrop}>
      <div className="ts-dialog ts-options-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="ts-dialog-titlebar">
          <span>{t("serverEdit.title")}</span>
          <button onClick={onClose} title={t("dialog.close")}>
            ✕
          </button>
        </div>
        <div className="ts-options-body">
          <div className="ts-options-sidebar">
            {SERVER_EDIT_TABS.map((id) => (
              <button
                key={id}
                className={`ts-options-sidebar-item${id === tab ? " ts-options-sidebar-item-active" : ""}`}
                onClick={() => setTab(id)}
              >
                <span>{t(`serverEdit.tab.${id}`)}</span>
              </button>
            ))}
          </div>
          <div className="ts-options-content">
            {tab === "host" && (
              <>
                <label className="ts-dialog-field">
                  {t("serverEdit.name")}
                  <input value={name} onChange={(e) => setName(e.target.value)} />
                </label>
                <label className="ts-dialog-field">
                  {t("serverEdit.welcomeMessage")}
                  <textarea rows={3} value={welcome} onChange={(e) => setWelcome(e.target.value)} />
                </label>
                <label className="ts-dialog-field">
                  <span>
                    <input
                      type="checkbox"
                      checked={clearPassword}
                      onChange={(e) => setClearPassword(e.target.checked)}
                    />{" "}
                    {t("serverEdit.clearPassword")}
                  </span>
                </label>
                <label className="ts-dialog-field">
                  {t("serverEdit.newPassword")}
                  <input
                    type="password"
                    disabled={clearPassword}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </label>
                <label className="ts-dialog-field">
                  {t("serverEdit.hostmessage")}
                  <input value={hostmessage} onChange={(e) => setHostmessage(e.target.value)} />
                </label>
                <label className="ts-dialog-field">
                  {t("serverEdit.hostmessageMode")}
                  <select value={hostmessageMode} onChange={(e) => setHostmessageMode(e.target.value)}>
                    <option value="">{t("serverEdit.unchanged")}</option>
                    <option value="none">{t("serverEdit.hostmessageMode.none")}</option>
                    <option value="log">{t("serverEdit.hostmessageMode.log")}</option>
                    <option value="modal">{t("serverEdit.hostmessageMode.modal")}</option>
                    <option value="modalquit">{t("serverEdit.hostmessageMode.modalquit")}</option>
                  </select>
                </label>
                <label className="ts-dialog-field">
                  {t("serverEdit.hostbannerUrl")}
                  <input value={hostbannerUrl} onChange={(e) => setHostbannerUrl(e.target.value)} />
                </label>
                <label className="ts-dialog-field">
                  {t("serverEdit.hostbannerGfxUrl")}
                  <input value={bannerGfxUrl} onChange={(e) => setBannerGfxUrl(e.target.value)} />
                </label>
                <label className="ts-dialog-field">
                  {t("serverEdit.hostbannerGfxInterval")}
                  <input
                    type="number"
                    min={0}
                    value={hostbannerGfxInterval}
                    onChange={(e) => setHostbannerGfxInterval(e.target.value)}
                  />
                </label>
                <label className="ts-dialog-field">
                  {t("serverEdit.hostbannerMode")}
                  <select value={hostbannerMode} onChange={(e) => setHostbannerMode(e.target.value)}>
                    <option value="">{t("serverEdit.unchanged")}</option>
                    <option value="noadjust">{t("serverEdit.hostbannerMode.noadjust")}</option>
                    <option value="adjustignoreaspect">{t("serverEdit.hostbannerMode.adjustignoreaspect")}</option>
                    <option value="adjustkeepaspect">{t("serverEdit.hostbannerMode.adjustkeepaspect")}</option>
                  </select>
                </label>
                <label className="ts-dialog-field">
                  {t("serverEdit.hostbuttonTooltip")}
                  <input value={hostbuttonTooltip} onChange={(e) => setHostbuttonTooltip(e.target.value)} />
                </label>
                <label className="ts-dialog-field">
                  {t("serverEdit.hostbuttonUrl")}
                  <input value={hostbuttonUrl} onChange={(e) => setHostbuttonUrl(e.target.value)} />
                </label>
                <label className="ts-dialog-field">
                  {t("serverEdit.hostbuttonGfxUrl")}
                  <input value={hostbuttonGfxUrl} onChange={(e) => setHostbuttonGfxUrl(e.target.value)} />
                </label>
              </>
            )}
            {tab === "misc" && (
              <>
                <label className="ts-dialog-field">
                  {t("serverEdit.maxClients")}
                  <input
                    type="number"
                    min={0}
                    value={maxClients}
                    onChange={(e) => setMaxClients(e.target.value)}
                  />
                </label>
                <label className="ts-dialog-field">
                  {t("serverEdit.nickname")}
                  <input value={nickname} onChange={(e) => setNickname(e.target.value)} />
                </label>
                <label className="ts-dialog-field">
                  {t("serverEdit.phoneticName")}
                  <input value={phoneticName} onChange={(e) => setPhoneticName(e.target.value)} />
                </label>
                <label className="ts-dialog-field">
                  {t("serverEdit.codecEncryptionMode")}
                  <select
                    value={codecEncryptionMode}
                    onChange={(e) => setCodecEncryptionMode(e.target.value)}
                  >
                    <option value="">{t("serverEdit.unchanged")}</option>
                    <option value="perchannel">{t("serverEdit.codecEncryptionMode.perchannel")}</option>
                    <option value="forcedoff">{t("serverEdit.codecEncryptionMode.forcedoff")}</option>
                    <option value="forcedon">{t("serverEdit.codecEncryptionMode.forcedon")}</option>
                  </select>
                </label>
              </>
            )}
            {(tab === "transmission" || tab === "antiflood" || tab === "security" || tab === "log") && (
              <>
                <h3>{t(`serverEdit.tab.${tab}`)}</h3>
                <p className="ts-options-placeholder">{t("options.notImplemented")}</p>
              </>
            )}
          </div>
        </div>
        <div className="ts-dialog-buttons">
          <div className="ts-dialog-buttons-right">
            <button onClick={handleSave}>{t("serverEdit.save")}</button>
            <button onClick={onClose}>{t("serverEdit.cancel")}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function AppInner() {
  const [host, setHost] = useState(
    () =>
      localStorage.getItem(LAST_HOST_KEY) ??
      (DEMO_MODE ? DEMO_HOST : loadDesignTheme() === "nova" ? "" : "localhost")
  );
  const [nickname, setNickname] = useState(
    () => localStorage.getItem(LAST_NICKNAME_KEY) ?? (DEMO_MODE ? "Guest" : "")
  );
  const [serverPassword, setServerPassword] = useState("");
  const [channelPassword, setChannelPassword] = useState("");
  const [defaultChannel, setDefaultChannel] = useState("");
  const [connectDialogOpen, setConnectDialogOpen] = useState(false);
  const [connectDialogExpanded, setConnectDialogExpanded] = useState(false);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [channels, setChannels] = useState<ChannelInfo[]>([]);
  const [clients, setClients] = useState<ClientInfo[]>([]);
  const [serverName, setServerName] = useState("");
  const [serverMaxClients, setServerMaxClients] = useState(0);
  const [serverVersion, setServerVersion] = useState("");
  const [serverLicense, setServerLicense] = useState("");
  const [serverBannerUrl, setServerBannerUrl] = useState("");
  const [serverWelcomeMessage, setServerWelcomeMessage] = useState("");
  const [serverEditOpen, setServerEditOpen] = useState(false);
  const [serverProtocolLogOpen, setServerProtocolLogOpen] = useState(false);
  const [serverProtocolLog, setServerProtocolLog] = useState<string[] | null>(null);
  const [banListOpen, setBanListOpen] = useState(false);
  const [banList, setBanList] = useState<BanListEntry[] | null>(null);
  const [complainListOpen, setComplainListOpen] = useState(false);
  const [complainList, setComplainList] = useState<ComplainListEntry[] | null>(null);
  const [offlineMessagesOpen, setOfflineMessagesOpen] = useState(false);
  const [offlineMessageList, setOfflineMessageList] = useState<OfflineMessageListEntry[] | null>(null);
  const [offlineMessageDetail, setOfflineMessageDetail] = useState<
    { messageId: number; clientUid: string; subject: string; message: string; timestamp: string } | null
  >(null);
  const [channelGroups, setChannelGroups] = useState<GroupEntry[] | null>(null);
  const [serverGroups, setServerGroups] = useState<GroupEntry[] | null>(null);
  const [groupAssignTarget, setGroupAssignTarget] = useState<{
    kind: "channel" | "server";
    clientId: number;
    clientName: string;
  } | null>(null);
  const [permissionOverviewOpen, setPermissionOverviewOpen] = useState(false);
  const [permissionOverview, setPermissionOverview] = useState<PermissionOverviewEntry[] | null>(null);
  const [permissionsEditorOpen, setPermissionsEditorOpen] = useState(false);
  const [permissionsEditorScope, setPermissionsEditorScope] = useState<PermScope>("server");
  const [permissionsEditorEntries, setPermissionsEditorEntries] = useState<PermissionOverviewEntry[] | null>(null);
  const [permissionsEditorTarget, setPermissionsEditorTarget] = useState<
    { scope: PermScope; id1: number; id2?: number } | null
  >(null);
  const [permissionCatalog, setPermissionCatalog] = useState<PermissionCatalogEntry[] | null>(null);
  const permissionCatalogRequestedRef = useRef(false);
  const [fileBrowserTarget, setFileBrowserTarget] = useState<{ channelId: number; channelName: string } | null>(
    null
  );
  const [fileBrowserPath, setFileBrowserPath] = useState("/");
  const [fileBrowserEntries, setFileBrowserEntries] = useState<FileListEntry[] | null>(null);
  const [serverIconsOpen, setServerIconsOpen] = useState(false);
  const [serverIconEntries, setServerIconEntries] = useState<FileListEntry[] | null>(null);
  const [serverIconImages, setServerIconImages] = useState<Record<string, string>>({});
  const [treeWidth, setTreeWidth] = useState(260);
  const [upperHeight, setUpperHeight] = useState(340);
  const [selected, setSelected] = useState<SelectedItem | null>(null);
  const [chat, setChat] = useState<ChatEntry[]>([]);
  const [serverChat, setServerChat] = useState<ChatEntry[]>([]);
  const [chatInput, setChatInput] = useState("");
  const chatInputRef = useRef<HTMLTextAreaElement>(null);
  const [pmThreads, setPmThreads] = useState<Record<number, PmThread>>({});
  const [pokes, setPokes] = useState<PokeNotice[]>([]);
  const [pokeTarget, setPokeTarget] = useState<{ id: number; name: string } | null>(null);
  const [pokeMessage, setPokeMessage] = useState("");
  const pokeBackdrop = useBackdropDismiss(() => setPokeTarget(null));
  const [kickTarget, setKickTarget] = useState<{ id: number; name: string; scope: "channel" | "server" } | null>(
    null
  );
  const [kickReason, setKickReason] = useState("");
  const kickBackdrop = useBackdropDismiss(() => setKickTarget(null));
  const [banTarget, setBanTarget] = useState<{ id: number; name: string } | null>(null);
  const [banReason, setBanReason] = useState("");
  const [banSeconds, setBanSeconds] = useState("0");
  const banBackdrop = useBackdropDismiss(() => setBanTarget(null));
  const [demoForceMobile, setDemoForceMobile] = useState(false);
  const [clientContextMenu, setClientContextMenu] = useState<{
    x: number;
    y: number;
    clientId: number;
    clientName: string;
    isSelf: boolean;
  } | null>(null);
  const clientContextMenuRef = useRef<HTMLDivElement>(null);
  const [serverContextMenu, setServerContextMenu] = useState<{ x: number; y: number } | null>(null);
  const serverContextMenuRef = useRef<HTMLDivElement>(null);
  const [channelContextMenu, setChannelContextMenu] = useState<{
    x: number;
    y: number;
    channelId: number;
    channelName: string;
  } | null>(null);
  const channelContextMenuRef = useRef<HTMLDivElement>(null);
  const [whisperChannelIds, setWhisperChannelIds] = useState<Set<number>>(new Set());
  const [whisperClientIds, setWhisperClientIds] = useState<Set<number>>(new Set());
  const [whisperMenuOpen, setWhisperMenuOpen] = useState(false);
  const whisperMenuRef = useRef<HTMLDivElement | null>(null);
  const [activeTab, setActiveTab] = useState<ActiveTab>("channel");
  const [theme, setTheme] = useState<"light" | "dark">(() =>
    window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light"
  );
  const [customThemes, setCustomThemes] = useState<CustomTheme[]>(() => loadCustomThemes());
  const [designSelection, setDesignSelection] = useState<string>(() => loadDesignSelection());
  const activeCustomTheme = designSelection.startsWith("custom:")
    ? customThemes.find((th) => `custom:${th.id}` === designSelection) ?? null
    : null;
  // Structural base - everywhere else in the app that branches on "nova" behavior
  // (splash, hamburger menu, ...) keeps working unchanged, whether that behavior
  // came from picking Nova directly or from a custom theme built on top of it.
  const designTheme: DesignTheme = activeCustomTheme ? activeCustomTheme.baseTheme : designSelection === "nova" ? "nova" : "standard";
  const handleDesignSelectionChange = (next: string) => {
    setDesignSelection(next);
    localStorage.setItem(DESIGN_SELECTION_KEY, next);
    const base = next.startsWith("custom:")
      ? customThemes.find((th) => `custom:${th.id}` === next)?.baseTheme ?? "standard"
      : next === "nova"
        ? "nova"
        : "standard";
    localStorage.setItem(DESIGN_THEME_KEY, base);
  };
  const handleSaveCustomTheme = (nextTheme: CustomTheme) => {
    setCustomThemes((prev) => {
      const idx = prev.findIndex((th) => th.id === nextTheme.id);
      const next = idx === -1 ? [...prev, nextTheme] : prev.map((th, i) => (i === idx ? nextTheme : th));
      saveCustomThemes(next);
      return next;
    });
  };
  const handleDeleteCustomTheme = (id: string) => {
    setCustomThemes((prev) => {
      const next = prev.filter((th) => th.id !== id);
      saveCustomThemes(next);
      return next;
    });
    if (designSelection === `custom:${id}`) handleDesignSelectionChange("standard");
  };
  // Custom themes ship as free-form CSS - inject/replace it in a dedicated <style>
  // tag while active, and drop it the moment no custom theme is selected.
  useEffect(() => {
    const css = activeCustomTheme?.css ?? "";
    const existing = document.getElementById("ts-custom-theme-style") as HTMLStyleElement | null;
    if (!css) {
      existing?.remove();
      return;
    }
    const el = existing ?? document.createElement("style");
    el.id = "ts-custom-theme-style";
    el.textContent = css;
    if (!existing) document.head.appendChild(el);
  }, [activeCustomTheme?.id, activeCustomTheme?.css]);
  const [micOn, setMicOn] = useState(false);
  const [talkers, setTalkers] = useState<Set<number>>(new Set());
  const [selfActive, setSelfActive] = useState(false);
  const [vadThreshold, setVadThreshold] = useState(0.02);
  const [vadHangover, setVadHangover] = useState(() => loadNumberPref(VAD_HANGOVER_KEY, 0.3));
  const [outputDevices, setOutputDevices] = useState<MediaDeviceInfo[]>([]);
  const [outputDeviceId, setOutputDeviceId] = useState("");
  const [inputDevices, setInputDevices] = useState<MediaDeviceInfo[]>([]);
  const [inputDeviceId, setInputDeviceId] = useState(() => localStorage.getItem(INPUT_DEVICE_KEY) ?? "");
  const [playbackVolume, setPlaybackVolume] = useState(() => loadNumberPref(PLAYBACK_VOLUME_KEY, 1));
  const [noiseSuppressionEnabled, setNoiseSuppressionEnabled] = useState(() =>
    loadBoolPref(NOISE_SUPPRESSION_KEY, true)
  );
  const [echoCancellationEnabled, setEchoCancellationEnabled] = useState(() =>
    loadBoolPref(ECHO_CANCELLATION_KEY, true)
  );
  const [autoGainControlEnabled, setAutoGainControlEnabled] = useState(() =>
    loadBoolPref(AUTO_GAIN_CONTROL_KEY, true)
  );
  const [micTestOn, setMicTestOn] = useState(false);
  const [connectionsMenuOpen, setConnectionsMenuOpen] = useState(false);
  // Nova-theme-only: collapses the classic menu items behind a hamburger button.
  const [novaMenuOpen, setNovaMenuOpen] = useState(false);
  const novaMenuRef = useRef<HTMLDivElement | null>(null);
  const [favorites, setFavorites] = useState<Favorite[]>(() => loadFavorites());
  const [favoritesMenuOpen, setFavoritesMenuOpen] = useState(false);
  const [favoritesDialogMode, setFavoritesDialogMode] = useState<
    { kind: "add"; prefill: Omit<Favorite, "id" | "bookmarkName"> } | { kind: "manage" } | null
  >(null);
  const [awayMenuOpen, setAwayMenuOpen] = useState(false);
  const [awayDialogOpen, setAwayDialogOpen] = useState(false);
  const [awayDialogMessage, setAwayDialogMessage] = useState("");
  const [awayPresets, setAwayPresets] = useState<MessagePreset[]>(() => loadAwayPresets());
  const [extrasMenuOpen, setExtrasMenuOpen] = useState(false);
  const [collectedUrls, setCollectedUrls] = useState<CollectedUrl[]>(() => loadCollectedUrls());
  const [collectedUrlsOpen, setCollectedUrlsOpen] = useState(false);
  const [inviteFriendOpen, setInviteFriendOpen] = useState(false);
  const [logEntries, setLogEntries] = useState<ClientLogEntry[]>([]);
  const [clientLogOpen, setClientLogOpen] = useState(false);
  const logIdRef = useRef(0);
  const [whisperLog, setWhisperLog] = useState<WhisperLogEntry[]>([]);
  const [whisperHistoryOpen, setWhisperHistoryOpen] = useState(false);
  const [whisperLists, setWhisperLists] = useState<WhisperList[]>(() => loadWhisperLists());
  const [whisperListsOpen, setWhisperListsOpen] = useState(false);
  const [identities, setIdentities] = useState<Identity[]>(() => loadIdentities());
  const [activeIdentityId, setActiveIdentityId] = useState<string | null>(() =>
    localStorage.getItem(ACTIVE_IDENTITY_KEY)
  );
  const [identitiesOpen, setIdentitiesOpen] = useState(false);
  const [clientConnectionInfoTarget, setClientConnectionInfoTarget] = useState<{ id: number; name: string } | null>(
    null
  );
  const [clientConnectionInfo, setClientConnectionInfo] = useState<ClientConnectionInfoData | null>(null);
  const [serverConnectionInfoOpen, setServerConnectionInfoOpen] = useState(false);
  const [serverConnectionInfo, setServerConnectionInfo] = useState<ServerConnectionInfoData | null>(null);
  const [selfMenuOpen, setSelfMenuOpen] = useState(false);
  const selfMenuRef = useRef<HTMLDivElement | null>(null);
  const [rightsMenuOpen, setRightsMenuOpen] = useState(false);
  const rightsMenuRef = useRef<HTMLDivElement | null>(null);
  const [changeNicknameOpen, setChangeNicknameOpen] = useState(false);
  const [nicknameDraft, setNicknameDraft] = useState("");
  const nicknameBackdrop = useBackdropDismiss(() => setChangeNicknameOpen(false));
  const [serverQueryLoginOpen, setServerQueryLoginOpen] = useState(false);
  const [serverQueryUsername, setServerQueryUsername] = useState("");
  const [serverQueryPassword, setServerQueryPassword] = useState("");
  const serverQueryLoginBackdrop = useBackdropDismiss(() => setServerQueryLoginOpen(false));
  const [contacts, setContacts] = useState<Contact[]>(() => loadContacts());
  const [contactsOpen, setContactsOpen] = useState(false);
  const [recording, setRecording] = useState(false);
  const whisperLogIdRef = useRef(0);
  const prevWhisperTargetsRef = useRef<{ channels: Set<number>; clients: Set<number> } | null>(null);

  const logClient = (level: LogLevel, category: string, message: string) => {
    const entry: ClientLogEntry = { id: ++logIdRef.current, timestamp: Date.now(), category, level, message };
    setLogEntries((prev) => [...prev.slice(-(MAX_LOG_ENTRIES - 1)), entry]);
  };
  const [optionsDialogOpen, setOptionsDialogOpen] = useState(false);
  const [optionsSection, setOptionsSection] = useState<string>(OPTIONS_SECTIONS[0].id);
  const socketRef = useRef<WebSocket | DemoSocket | null>(null);
  const connectionsMenuRef = useRef<HTMLDivElement | null>(null);
  const favoritesMenuRef = useRef<HTMLDivElement | null>(null);
  const awayMenuRef = useRef<HTMLDivElement | null>(null);
  const extrasMenuRef = useRef<HTMLDivElement | null>(null);
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioPlayerRef = useRef<AudioPlayer | null>(null);
  const micCaptureRef = useRef<MicCapture | null>(null);
  const recordProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const recordSilenceRef = useRef<GainNode | null>(null);
  const recordChunksRef = useRef<{ left: Float32Array[]; right: Float32Array[] }>({ left: [], right: [] });
  const activeTabRef = useRef<ActiveTab>("channel");
  const hasConnectedRef = useRef(false);
  // Set when a "disconnected" event is received, so the socket's onclose
  // handler (which fires shortly after, on its own close handshake) can tell
  // a clean disconnect apart from the socket dying before ever connecting.
  const cleanDisconnectRef = useRef(false);
  const previousClientsRef = useRef<ClientInfo[] | null>(null);
  const pokeIdRef = useRef(0);
  const inputMutedRef = useRef(false);
  const outputMutedRef = useRef(false);
  const micLevelRef = useRef(0);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ block: "nearest" });
  }, [chat, serverChat, pmThreads, activeTab]);

  useEffect(() => {
    localStorage.setItem(COLLECTED_URLS_KEY, JSON.stringify(collectedUrls));
  }, [collectedUrls]);

  useEffect(() => {
    localStorage.setItem(CONTACTS_KEY, JSON.stringify(contacts));
  }, [contacts]);

  useEffect(() => {
    localStorage.setItem(WHISPER_LISTS_KEY, JSON.stringify(whisperLists));
  }, [whisperLists]);

  useEffect(() => {
    localStorage.setItem(IDENTITIES_KEY, JSON.stringify(identities));
  }, [identities]);

  useEffect(() => {
    if (activeIdentityId) localStorage.setItem(ACTIVE_IDENTITY_KEY, activeIdentityId);
  }, [activeIdentityId]);

  const isSenderIgnored = (senderName: string) => {
    const senderClient = clients.find((c) => c.name === senderName);
    if (!senderClient?.uid) return false;
    return contacts.some((c) => c.uid === senderClient.uid && c.ignored);
  };

  const recordUrlsFromMessage = (message: string, sender: string) => {
    const found = message.match(URL_REGEX);
    if (!found) return;
    const now = Date.now();
    setCollectedUrls((prev) => {
      const next = [...prev];
      for (const url of found) {
        const idx = next.findIndex((u) => u.url === url);
        if (idx >= 0) {
          next[idx] = { ...next[idx], count: next[idx].count + 1, lastSeen: now, lastSender: sender };
        } else {
          next.push({ url, count: 1, lastSeen: now, lastSender: sender });
        }
      }
      return next;
    });
  };

  useEffect(() => {
    const own = clients.find((c) => c.name === nickname) ?? null;
    inputMutedRef.current = own?.inputMuted ?? false;
    outputMutedRef.current = own?.outputMuted ?? false;
  }, [clients, nickname]);

  useEffect(() => {
    if (micCaptureRef.current) micCaptureRef.current.threshold = vadThreshold;
  }, [vadThreshold]);

  useEffect(() => {
    if (micCaptureRef.current) micCaptureRef.current.hangoverSeconds = vadHangover;
    localStorage.setItem(VAD_HANGOVER_KEY, String(vadHangover));
  }, [vadHangover]);

  useEffect(() => {
    audioPlayerRef.current?.setVolume(playbackVolume);
    localStorage.setItem(PLAYBACK_VOLUME_KEY, String(playbackVolume));
  }, [playbackVolume]);

  useEffect(() => {
    localStorage.setItem(NOISE_SUPPRESSION_KEY, noiseSuppressionEnabled ? "1" : "0");
  }, [noiseSuppressionEnabled]);

  useEffect(() => {
    localStorage.setItem(ECHO_CANCELLATION_KEY, echoCancellationEnabled ? "1" : "0");
  }, [echoCancellationEnabled]);

  useEffect(() => {
    localStorage.setItem(AUTO_GAIN_CONTROL_KEY, autoGainControlEnabled ? "1" : "0");
  }, [autoGainControlEnabled]);

  useEffect(() => {
    if (inputDeviceId) localStorage.setItem(INPUT_DEVICE_KEY, inputDeviceId);
  }, [inputDeviceId]);

  useEffect(() => {
    activeTabRef.current = activeTab;
    if (typeof activeTab === "number") {
      setPmThreads((prev) => {
        const thread = prev[activeTab];
        if (!thread || !thread.unread) return prev;
        return { ...prev, [activeTab]: { ...thread, unread: false } };
      });
    }
  }, [activeTab]);

  const refreshOutputDevices = async () => {
    try {
      const devices = await listAudioOutputDevices();
      setOutputDevices(devices);
    } catch {
      // Device labels/enumeration may be unavailable before mic permission is granted.
    }
  };

  const refreshInputDevices = async () => {
    try {
      const devices = await listAudioInputDevices();
      setInputDevices(devices);
    } catch {
      // Device labels/enumeration may be unavailable before mic permission is granted.
    }
  };

  useEffect(() => {
    const refreshBoth = () => {
      void refreshOutputDevices();
      void refreshInputDevices();
    };
    navigator.mediaDevices?.addEventListener?.("devicechange", refreshBoth);
    return () => navigator.mediaDevices?.removeEventListener?.("devicechange", refreshBoth);
  }, []);

  useEffect(() => {
    return () => socketRef.current?.close();
  }, []);

  const appendLog = (entry: LogEntry) => setLog((prev) => [...prev, entry]);

  const startTreeResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = treeWidth;
    const onMove = (ev: MouseEvent) => {
      setTreeWidth(Math.min(500, Math.max(150, startWidth + (ev.clientX - startX))));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const startUpperResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = upperHeight;
    const onMove = (ev: MouseEvent) => {
      setUpperHeight(Math.min(700, Math.max(120, startHeight + (ev.clientY - startY))));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const stopMic = () => {
    micCaptureRef.current?.stop();
    micCaptureRef.current = null;
    setMicOn(false);
    setSelfActive(false);
  };

  // Mic/output-device setup shouldn't require an active server connection (like
  // the real TS3 client, where you can test your devices before connecting) -
  // lazily create the audio context on first use instead of tying it to connect.
  const ensureAudioContext = (): AudioContext => {
    if (!audioContextRef.current) {
      const audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
      audioContextRef.current = audioContext;
      audioPlayerRef.current = new AudioPlayer(audioContext);
    }
    return audioContextRef.current;
  };

  const handleConnect = (overrides?: {
    host?: string;
    nickname?: string;
    serverPassword?: string;
    channelPassword?: string;
    defaultChannel?: string;
  }) => {
    const connectHost = overrides?.host ?? host;
    const connectNickname = overrides?.nickname ?? nickname;
    const connectServerPassword = overrides?.serverPassword ?? serverPassword;
    const connectChannelPassword = overrides?.channelPassword ?? channelPassword;
    const connectDefaultChannel = overrides?.defaultChannel ?? defaultChannel;

    // Switching servers while already connected (or mid-connect): tear down the
    // old socket first and detach its handlers so its async close doesn't later
    // clobber state that belongs to the new connection.
    const previousSocket = socketRef.current;
    if (previousSocket) {
      previousSocket.onopen = null;
      previousSocket.onmessage = null;
      previousSocket.onerror = null;
      previousSocket.onclose = null;
      if (previousSocket.readyState === WebSocket.OPEN || previousSocket.readyState === WebSocket.CONNECTING) {
        previousSocket.close();
      }
      stopMic();
      stopRecording();
      audioPlayerRef.current?.dispose();
      audioPlayerRef.current = null;
      audioContextRef.current?.close();
      audioContextRef.current = null;
      setConnected(false);
      setChannels([]);
      setClients([]);
      setSelected(null);
      setChat([]);
      setServerChat([]);
      setPmThreads({});
      setPokes([]);
      setActiveTab("channel");
      setTalkers(new Set());
    }

    hasConnectedRef.current = false;
    setConnecting(true);
    setConnectError(null);
    setConnectDialogOpen(false);

    ensureAudioContext();

    const connectIdentityId = activeIdentityId;
    const connectIdentityBlob = identities.find((i) => i.id === connectIdentityId)?.blob ?? undefined;

    const socket = DEMO_MODE ? new DemoSocket() : new WebSocket(GATEWAY_URL);
    socketRef.current = socket;

    socket.onopen = () => {
      logClient("info", "Connection", `Connecting to ${connectHost}…`);
      socket.send(
        JSON.stringify({
          type: "connect",
          host: connectHost,
          nickname: connectNickname,
          serverPassword: connectServerPassword || undefined,
          channelPassword: connectChannelPassword || undefined,
          defaultChannel: connectDefaultChannel || undefined,
          identity: connectIdentityBlob || undefined,
        })
      );
    };

    socket.onmessage = (event) => {
      const data = JSON.parse(event.data);
      switch (data.type) {
        case "connected":
          logClient("info", "Connection", `Connected to ${data.serverName}`);
          hasConnectedRef.current = true;
          setConnecting(false);
          setConnectError(null);
          setConnected(true);
          localStorage.setItem(LAST_HOST_KEY, connectHost);
          localStorage.setItem(LAST_NICKNAME_KEY, connectNickname);
          if (connectIdentityId) {
            setIdentities((prev) =>
              prev.map((i) =>
                i.id === connectIdentityId
                  ? { ...i, blob: data.identity || i.blob, nickname: connectNickname }
                  : i
              )
            );
          }
          setServerName(data.serverName);
          setServerMaxClients(data.serverMaxClients);
          setServerVersion(data.serverVersion);
          setServerLicense(data.serverLicense);
          setServerBannerUrl(data.serverBannerUrl);
          setServerWelcomeMessage(data.welcomeMessage);
          setSelected({ type: "server" });
          setServerChat((prev) => [...prev, { from: "Server", message: data.welcomeMessage }]);
          previousClientsRef.current = null;
          void playSound("connect");
          break;
        case "channels": {
          const newClients: ClientInfo[] = data.clients;
          const prevClients = previousClientsRef.current;
          if (prevClients) {
            const prevIds = new Set(prevClients.map((c) => c.id));
            const newIds = new Set(newClients.map((c) => c.id));
            const joined = newClients.some((c) => !prevIds.has(c.id) && c.name !== connectNickname);
            const left = prevClients.some((c) => !newIds.has(c.id) && c.name !== connectNickname);
            if (joined) void playSound("clientJoin");
            if (left) void playSound("clientLeave");
          }
          previousClientsRef.current = newClients;
          setChannels(data.channels);
          setClients(newClients);
          break;
        }
        case "chatMessage":
          if (isSenderIgnored(data.from)) break;
          setChat((prev) => [...prev, { from: data.from, message: data.message }]);
          recordUrlsFromMessage(data.message, data.from);
          if (data.from !== connectNickname) void playSound("message");
          break;
        case "serverMessage":
          if (isSenderIgnored(data.from)) break;
          setServerChat((prev) => [...prev, { from: data.from, message: data.message }]);
          recordUrlsFromMessage(data.message, data.from);
          if (data.from !== connectNickname) void playSound("message");
          break;
        case "privateMessage":
          if (!data.fromSelf && isSenderIgnored(data.partnerName)) break;
          setPmThreads((prev) => {
            const existing = prev[data.partnerId];
            const thread: PmThread = existing ?? {
              partnerId: data.partnerId,
              partnerName: data.partnerName,
              messages: [],
              unread: false,
            };
            return {
              ...prev,
              [data.partnerId]: {
                ...thread,
                partnerName: data.partnerName,
                messages: [...thread.messages, { fromSelf: data.fromSelf, message: data.message }],
                unread: thread.unread || (!data.fromSelf && activeTabRef.current !== data.partnerId),
              },
            };
          });
          recordUrlsFromMessage(data.message, data.fromSelf ? connectNickname : data.partnerName);
          if (!data.fromSelf) void playSound("message");
          break;
        case "audioOut":
          if (!outputMutedRef.current) audioPlayerRef.current?.playFrame(data.pcm);
          break;
        case "talkers":
          setTalkers(new Set<number>(data.clients));
          break;
        case "poke": {
          const id = ++pokeIdRef.current;
          setPokes((prev) => [...prev, { id, from: data.from, message: data.message }]);
          setTimeout(() => setPokes((prev) => prev.filter((p) => p.id !== id)), 10000);
          void playSound("poke");
          break;
        }
        case "serverLog": {
          let message: string;
          switch (data.kind) {
            case "clientJoin":
              message = t("serverLog.clientJoin", { client: data.client, channel: data.channel });
              break;
            case "clientLeave":
              message = t("serverLog.clientLeave", { client: data.client });
              break;
            case "clientChannelSwitch":
              message = t("serverLog.clientChannelSwitch", {
                client: data.client,
                fromChannel: data.fromChannel,
                toChannel: data.toChannel,
              });
              break;
            case "clientChannelGroupAssigned":
              message = t("serverLog.clientChannelGroupAssigned", { client: data.client, group: data.group });
              break;
            case "channelCreated":
              message = t("serverLog.channelCreated", { channel: data.channel });
              break;
            case "channelDeleted":
              message = t("serverLog.channelDeleted", { channel: data.channel });
              break;
            case "channelEdited":
              message = t("serverLog.channelEdited", { channel: data.channel });
              break;
            case "serverEdited":
              message = t("serverLog.serverEdited");
              break;
            case "permissionError":
              message = t("serverLog.permissionError", { action: data.action });
              break;
          }
          setServerChat((prev) => [...prev, { from: "", message, isLog: true }]);
          break;
        }
        case "disconnected": {
          const wasConnected = hasConnectedRef.current;
          hasConnectedRef.current = false;
          cleanDisconnectRef.current = true;
          previousClientsRef.current = null;
          setConnecting(false);
          setConnected(false);
          setChannels([]);
          setClients([]);
          setSelected(null);
          setChat([]);
          setServerChat([]);
          setPmThreads({});
          setPokes([]);
          setActiveTab("channel");
          setTalkers(new Set());
          setWhisperLog([]);
          prevWhisperTargetsRef.current = null;
          stopMic();
          stopRecording();
          appendLog({ text: `Disconnected: ${data.reason}`, kind: "info" });
          logClient("info", "Connection", `Disconnected: ${data.reason}`);
          if (wasConnected) void playSound("disconnect");
          break;
        }
        case "error":
          logClient("error", "Connection", data.message);
          if (hasConnectedRef.current) {
            appendLog({ text: data.message, kind: "error" });
          } else {
            setConnecting(false);
            setConnectError(data.message);
          }
          break;
        case "clientConnectionInfo":
          setClientConnectionInfo({
            clientId: data.clientId,
            pingMs: data.pingMs,
            connectedSecs: data.connectedSecs,
            ip: data.ip,
            packetsSent: data.packetsSent,
            bytesSent: data.bytesSent,
            packetsReceived: data.packetsReceived,
            bytesReceived: data.bytesReceived,
            packetLossPercent: data.packetLossPercent,
          });
          break;
        case "serverConnectionInfo":
          setServerConnectionInfo({
            pingMs: data.pingMs,
            connectedSecs: data.connectedSecs,
            packetLossPercent: data.packetLossPercent,
            packetsSentTotal: data.packetsSentTotal,
            bytesSentTotal: data.bytesSentTotal,
            packetsReceivedTotal: data.packetsReceivedTotal,
            bytesReceivedTotal: data.bytesReceivedTotal,
            bandwidthSentLastSecond: data.bandwidthSentLastSecond,
            bandwidthReceivedLastSecond: data.bandwidthReceivedLastSecond,
          });
          break;
        case "serverProtocolLog":
          setServerProtocolLog(data.lines);
          break;
        case "banList":
          setBanList(data.entries);
          break;
        case "complainList":
          setComplainList(data.entries);
          break;
        case "offlineMessageList":
          setOfflineMessageList(data.entries);
          break;
        case "offlineMessage":
          setOfflineMessageDetail({
            messageId: data.messageId,
            clientUid: data.clientUid,
            subject: data.subject,
            message: data.message,
            timestamp: data.timestamp,
          });
          break;
        case "channelGroupList":
          setChannelGroups(data.entries);
          break;
        case "serverGroupList":
          setServerGroups(data.entries);
          break;
        case "permissionOverview":
          setPermissionOverview(data.entries);
          break;
        case "fileList":
          // Channel 0 isn't a real, selectable channel - it's TS3's special
          // server-wide icon repository, so a listing for it always means the
          // server icons window, never the per-channel file browser.
          if (data.cid === 0) {
            setServerIconEntries(
              data.entries.filter((e: FileListEntry) => e.isFile && /^icon_\d+$/.test(e.name))
            );
          } else {
            setFileBrowserEntries(data.entries);
          }
          break;
        case "fileDownloadData": {
          if (data.cid === 0) {
            // Icon preview fetch, not a user-initiated download - stash the
            // bytes for the server icons grid instead of saving a file.
            setServerIconImages((prev) => ({ ...prev, [data.path]: data.data }));
          } else {
            const filename = data.path.split("/").filter(Boolean).pop() ?? "download";
            triggerBrowserDownload(filename, data.data);
          }
          break;
        }
        case "fileUploadDone":
          if (data.cid === 0) handleServerIconsRefresh();
          else handleFileBrowserRefresh();
          break;
        case "permList":
          setPermissionsEditorEntries(data.entries);
          break;
        case "permissionCatalog":
          setPermissionCatalog(data.entries);
          break;
      }
    };

    socket.onerror = () => {
      logClient("error", "WebSocket", "WebSocket error (is the gateway running?)");
      if (!hasConnectedRef.current) {
        setConnecting(false);
        setConnectError("Could not reach the gateway - is it running?");
      } else {
        appendLog({ text: "WebSocket error (is the gateway running?)", kind: "error" });
      }
    };
    socket.onclose = () => {
      if (!hasConnectedRef.current && !cleanDisconnectRef.current) {
        setConnecting(false);
        setConnectError((prev) => prev ?? "Connection closed before the server responded");
      }
      cleanDisconnectRef.current = false;
      setConnected(false);
      stopMic();
      stopRecording();
      audioPlayerRef.current?.dispose();
      audioPlayerRef.current = null;
      audioContextRef.current?.close();
      audioContextRef.current = null;
    };
  };

  const handleDisconnect = () => {
    const socket = socketRef.current;
    if (!socket) return;
    const message = loadDisconnectMessage();
    if (message && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "disconnect", message }));
    }
    socket.close();
  };

  const connectToFavorite = (f: Favorite) => {
    setHost(f.host);
    setNickname(f.nickname);
    setServerPassword(f.serverPassword);
    setChannelPassword(f.defaultChannelPassword);
    setDefaultChannel(f.defaultChannel);
    handleConnect({
      host: f.host,
      nickname: f.nickname,
      serverPassword: f.serverPassword,
      channelPassword: f.defaultChannelPassword,
      defaultChannel: f.defaultChannel,
    });
  };

  const saveFavorites = (next: Favorite[]) => {
    setFavorites(next);
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(next));
  };

  const openAddFavorite = () => {
    setFavoritesDialogMode({
      kind: "add",
      prefill: {
        host,
        nickname,
        serverPassword,
        defaultChannel,
        defaultChannelPassword: channelPassword,
      },
    });
    setFavoritesMenuOpen(false);
  };

  const openManageFavorites = () => {
    setFavoritesDialogMode({ kind: "manage" });
    setFavoritesMenuOpen(false);
  };

  const sendAway = (away: boolean, message: string) => {
    socketRef.current?.send(JSON.stringify({ type: "setAway", away, message }));
  };

  const handleSaveAwayTemplate = () => {
    const trimmed = awayDialogMessage.trim();
    if (!trimmed) return;
    setAwayPresets((prev) => {
      if (prev.some((p) => p.message === trimmed)) return prev;
      const next = [...prev, { name: trimmed, message: trimmed }];
      saveAwayPresets(next);
      return next;
    });
    setAwayDialogOpen(false);
  };

  const handleConfirmAway = () => {
    sendAway(true, awayDialogMessage);
    setAwayDialogOpen(false);
  };

  useEffect(() => {
    if (!novaMenuOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!novaMenuRef.current?.contains(e.target as Node)) setNovaMenuOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setNovaMenuOpen(false);
    };
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [novaMenuOpen]);

  useEffect(() => {
    if (!connectionsMenuOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!connectionsMenuRef.current?.contains(e.target as Node)) setConnectionsMenuOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setConnectionsMenuOpen(false);
    };
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [connectionsMenuOpen]);

  useEffect(() => {
    if (!favoritesMenuOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!favoritesMenuRef.current?.contains(e.target as Node)) setFavoritesMenuOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFavoritesMenuOpen(false);
    };
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [favoritesMenuOpen]);

  useEffect(() => {
    if (!awayMenuOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!awayMenuRef.current?.contains(e.target as Node)) setAwayMenuOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAwayMenuOpen(false);
    };
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [awayMenuOpen]);

  useEffect(() => {
    if (!clientContextMenu) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!clientContextMenuRef.current?.contains(e.target as Node)) setClientContextMenu(null);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setClientContextMenu(null);
    };
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [clientContextMenu]);

  useEffect(() => {
    if (!serverContextMenu) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!serverContextMenuRef.current?.contains(e.target as Node)) setServerContextMenu(null);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setServerContextMenu(null);
    };
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [serverContextMenu]);

  useEffect(() => {
    if (!channelContextMenu) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!channelContextMenuRef.current?.contains(e.target as Node)) setChannelContextMenu(null);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setChannelContextMenu(null);
    };
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [channelContextMenu]);

  // Icon files aren't previewable from the listing alone - fetch each one's
  // bytes individually once, then cache them in serverIconImages so re-runs
  // (triggered by that same state update) become no-ops for already-fetched icons.
  useEffect(() => {
    if (!serverIconsOpen || !serverIconEntries) return;
    for (const entry of serverIconEntries) {
      const path = `/${entry.name}`;
      if (!(path in serverIconImages)) {
        socketRef.current?.send(JSON.stringify({ type: "downloadFile", channelId: 0, path }));
      }
    }
  }, [serverIconsOpen, serverIconEntries, serverIconImages]);

  // Server group badges next to client names need the group list (for the
  // id->icon lookup) even if the user never opens a group-related dialog -
  // fetch it once per connection instead of only on demand.
  useEffect(() => {
    if (!connected || serverGroups) return;
    socketRef.current?.send(JSON.stringify({ type: "getServerGroupList" }));
  }, [connected, serverGroups]);

  // Same icon-file cache as the server icons dialog (fileDownloadData for
  // cid 0 always lands in serverIconImages, regardless of who asked) - fetch
  // any group icon referenced by a currently visible client that isn't
  // cached yet.
  useEffect(() => {
    if (!serverGroups) return;
    const iconById = new Map(serverGroups.map((g) => [g.id, g.iconId]));
    const wantedIconIds = new Set(
      clients
        .flatMap((c) => c.serverGroups.map((gid) => iconById.get(gid) ?? 0))
        .filter((id) => id >= CUSTOM_ICON_ID_THRESHOLD)
    );
    for (const iconId of wantedIconIds) {
      const path = `/icon_${iconId}`;
      if (!(path in serverIconImages)) {
        socketRef.current?.send(JSON.stringify({ type: "downloadFile", channelId: 0, path }));
      }
    }
  }, [clients, serverGroups, serverIconImages]);

  useEffect(() => {
    if (!connected) {
      setWhisperChannelIds(new Set());
      setWhisperClientIds(new Set());
    }
  }, [connected]);

  useEffect(() => {
    if (!connected) return;
    socketRef.current?.send(
      JSON.stringify({
        type: "setWhisperTargets",
        channelIds: [...whisperChannelIds],
        clientIds: [...whisperClientIds],
      })
    );

    const prev = prevWhisperTargetsRef.current;
    prevWhisperTargetsRef.current = { channels: new Set(whisperChannelIds), clients: new Set(whisperClientIds) };
    const wasEmpty = !prev || (prev.channels.size === 0 && prev.clients.size === 0);
    const isEmpty = whisperChannelIds.size === 0 && whisperClientIds.size === 0;
    if (wasEmpty && isEmpty) return;

    const describe = () => {
      const channelNames = [...whisperChannelIds]
        .map((id) => channels.find((c) => c.id === id)?.name)
        .filter((n): n is string => Boolean(n));
      const clientNames = [...whisperClientIds]
        .map((id) => clients.find((c) => c.id === id)?.name)
        .filter((n): n is string => Boolean(n));
      return [...channelNames, ...clientNames].join(", ");
    };

    const description = isEmpty
      ? t("whisperHistory.stopped")
      : t("whisperHistory.started", { targets: describe() });
    setWhisperLog((prevLog) => [
      ...prevLog,
      { id: ++whisperLogIdRef.current, timestamp: Date.now(), description },
    ]);
  }, [whisperChannelIds, whisperClientIds, connected]);

  useEffect(() => {
    if (!whisperMenuOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!whisperMenuRef.current?.contains(e.target as Node)) setWhisperMenuOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setWhisperMenuOpen(false);
    };
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [whisperMenuOpen]);

  useEffect(() => {
    if (!extrasMenuOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!extrasMenuRef.current?.contains(e.target as Node)) setExtrasMenuOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExtrasMenuOpen(false);
    };
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [extrasMenuOpen]);

  useEffect(() => {
    if (!selfMenuOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!selfMenuRef.current?.contains(e.target as Node)) setSelfMenuOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelfMenuOpen(false);
    };
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [selfMenuOpen]);

  useEffect(() => {
    if (!rightsMenuOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!rightsMenuRef.current?.contains(e.target as Node)) setRightsMenuOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setRightsMenuOpen(false);
    };
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [rightsMenuOpen]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.ctrlKey) return;
      if (e.key.toLowerCase() === "s" && !connected && !connecting) {
        e.preventDefault();
        setConnectDialogOpen(true);
      } else if (e.key.toLowerCase() === "d" && connected) {
        e.preventDefault();
        handleDisconnect();
      } else if (e.key.toLowerCase() === "b") {
        e.preventDefault();
        openAddFavorite();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [connected, connecting, host, nickname, serverPassword, defaultChannel, channelPassword]);

  // Nova-theme-only: the connect dialog IS the app until a connection exists -
  // it's forced open on load and after every disconnect, and closes itself the
  // moment a connection succeeds.
  useEffect(() => {
    if (designTheme === "nova" && !connected) setConnectDialogOpen(true);
  }, [designTheme, connected]);

  // Overrides let a device/DSP-setting change take effect immediately, without
  // waiting for the next render's (possibly still-stale) state closure.
  const startMic = async (overrides?: {
    deviceId?: string;
    echoCancellation?: boolean;
    noiseSuppression?: boolean;
    autoGainControl?: boolean;
  }) => {
    const audioContext = ensureAudioContext();
    try {
      const mic = new MicCapture(audioContext, {
        onFrame: (pcm) => {
          if (!inputMutedRef.current) socketRef.current?.send(JSON.stringify({ type: "sendAudio", pcm }));
        },
        onActivity: (active) => setSelfActive(active),
        onLevel: (rms) => {
          micLevelRef.current = rms;
        },
        threshold: vadThreshold,
        hangoverSeconds: vadHangover,
        deviceId: overrides?.deviceId ?? (inputDeviceId || undefined),
        echoCancellation: overrides?.echoCancellation ?? echoCancellationEnabled,
        noiseSuppression: overrides?.noiseSuppression ?? noiseSuppressionEnabled,
        autoGainControl: overrides?.autoGainControl ?? autoGainControlEnabled,
      });
      await mic.start();
      micCaptureRef.current = mic;
      setMicOn(true);
      refreshOutputDevices();
      refreshInputDevices();
      connectMicToRecorder();
    } catch (error) {
      appendLog({ text: `Microphone error: ${(error as Error).message}`, kind: "error" });
    }
  };

  const restartMic = async (overrides?: {
    deviceId?: string;
    echoCancellation?: boolean;
    noiseSuppression?: boolean;
    autoGainControl?: boolean;
  }) => {
    micCaptureRef.current?.stop();
    micCaptureRef.current = null;
    await startMic(overrides);
  };

  const handleToggleMic = async () => {
    if (!micOn) {
      await startMic();
      return;
    }
    socketRef.current?.send(JSON.stringify({ type: "setInputMuted", muted: !inputMutedRef.current }));
  };

  // Enable the mic automatically on page load (voice activation still gates
  // what's actually sent) instead of requiring an explicit click every time.
  const autoMicAttemptedRef = useRef(false);
  useEffect(() => {
    if (autoMicAttemptedRef.current) return;
    autoMicAttemptedRef.current = true;
    void handleToggleMic();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleInputDeviceChange = (deviceId: string) => {
    setInputDeviceId(deviceId);
    if (micCaptureRef.current) void restartMic({ deviceId });
  };

  const handleToggleNoiseSuppression = () => {
    const next = !noiseSuppressionEnabled;
    setNoiseSuppressionEnabled(next);
    if (micCaptureRef.current) void restartMic({ noiseSuppression: next });
  };

  const handleToggleEchoCancellation = () => {
    const next = !echoCancellationEnabled;
    setEchoCancellationEnabled(next);
    if (micCaptureRef.current) void restartMic({ echoCancellation: next });
  };

  const handleToggleAutoGainControl = () => {
    const next = !autoGainControlEnabled;
    setAutoGainControlEnabled(next);
    if (micCaptureRef.current) void restartMic({ autoGainControl: next });
  };

  const handleToggleMicTest = () => {
    const next = !micTestOn;
    setMicTestOn(next);
    const inputNode = audioPlayerRef.current?.getInputNode();
    if (inputNode) micCaptureRef.current?.setMonitoring(next, inputNode);
  };

  const handleToggleOutputMuted = () => {
    socketRef.current?.send(JSON.stringify({ type: "setOutputMuted", muted: !outputMutedRef.current }));
  };

  // Connects the current mic (if any) into the active recording, so a device
  // switch or a mic (re)start mid-recording doesn't silently drop it from the mix.
  const connectMicToRecorder = () => {
    const processor = recordProcessorRef.current;
    const source = micCaptureRef.current?.getSourceNode();
    if (processor && source) source.connect(processor);
  };

  const startRecording = () => {
    if (recordProcessorRef.current) return;
    const audioContext = ensureAudioContext();
    // Captures raw PCM via a ScriptProcessorNode (rather than MediaRecorder) so the
    // download can be an uncompressed WAV instead of a browser-codec-dependent webm/ogg.
    const processor = audioContext.createScriptProcessor(4096, 2, 2);
    const silence = audioContext.createGain();
    silence.gain.value = 0;
    recordChunksRef.current = { left: [], right: [] };
    processor.onaudioprocess = (event) => {
      const left = event.inputBuffer.getChannelData(0);
      const right = event.inputBuffer.numberOfChannels > 1 ? event.inputBuffer.getChannelData(1) : left;
      recordChunksRef.current.left.push(left.slice());
      recordChunksRef.current.right.push(right.slice());
    };
    // A ScriptProcessorNode only fires while connected to a destination; route
    // through a muted gain node so the recording tap isn't also heard.
    processor.connect(silence);
    silence.connect(audioContext.destination);
    recordProcessorRef.current = processor;
    recordSilenceRef.current = silence;
    audioPlayerRef.current?.getInputNode().connect(processor);
    connectMicToRecorder();

    setRecording(true);
    logClient("info", "Recording", "Started local recording");
  };

  const stopRecording = () => {
    const processor = recordProcessorRef.current;
    if (!processor) return;
    processor.onaudioprocess = null;
    processor.disconnect();
    recordSilenceRef.current?.disconnect();
    recordProcessorRef.current = null;
    recordSilenceRef.current = null;
    setRecording(false);

    const { left, right } = recordChunksRef.current;
    recordChunksRef.current = { left: [], right: [] };
    const totalFrames = left.reduce((sum, chunk) => sum + chunk.length, 0);
    if (totalFrames === 0) return;

    const mergedLeft = new Float32Array(totalFrames);
    const mergedRight = new Float32Array(totalFrames);
    let offset = 0;
    for (let i = 0; i < left.length; i++) {
      mergedLeft.set(left[i], offset);
      mergedRight.set(right[i], offset);
      offset += left[i].length;
    }

    const blob = encodeWavStereo(mergedLeft, mergedRight, audioContextRef.current?.sampleRate ?? SAMPLE_RATE);
    const safeServerName = (serverName || "session").replace(/[\\/:*?"<>|]+/g, "_").trim() || "session";
    const filename = `webspeak3-${safeServerName}-${new Date().toISOString().replace(/[:.]/g, "-")}.wav`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    logClient("info", "Recording", `Saved recording as ${filename}`);
  };

  const handleSetNickname = (newNickname: string) => {
    socketRef.current?.send(JSON.stringify({ type: "setNickname", nickname: newNickname }));
  };

  const handleServerQueryLogin = () => {
    if (!serverQueryUsername.trim() || !serverQueryPassword) return;
    socketRef.current?.send(
      JSON.stringify({
        type: "serverQueryLogin",
        username: serverQueryUsername.trim(),
        password: serverQueryPassword,
      })
    );
    setServerQueryLoginOpen(false);
  };

  const handleOutputDeviceChange = async (deviceId: string) => {
    setOutputDeviceId(deviceId);
    await audioPlayerRef.current?.setOutputDevice(deviceId);
    setSoundsOutputDevice(deviceId);
  };

  const handlePickOutputDevice = async () => {
    try {
      const device = await pickAudioOutputDevice();
      if (device) await handleOutputDeviceChange(device.deviceId);
    } catch (error) {
      appendLog({ text: `Output device error: ${(error as Error).message}`, kind: "error" });
    }
  };

  const handlePlayTestTone = () => {
    ensureAudioContext();
    audioPlayerRef.current?.playTestTone();
  };

  const handleSwitchChannel = (channelId: number) => {
    socketRef.current?.send(JSON.stringify({ type: "switchChannel", channelId }));
  };

  const handleSelectItem = (item: SelectedItem) => setSelected(item);

  useEffect(() => {
    const el = chatInputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [chatInput]);

  const handleSendChat = () => {
    const message = chatInput.trim();
    if (!message) return;
    if (activeTab === "channel") {
      socketRef.current?.send(JSON.stringify({ type: "sendChatMessage", message }));
    } else if (activeTab === "server") {
      socketRef.current?.send(JSON.stringify({ type: "sendServerMessage", message }));
    } else {
      socketRef.current?.send(JSON.stringify({ type: "sendPrivateMessage", clientId: activeTab, message }));
    }
    setChatInput("");
  };

  const handleOpenPrivateChat = (clientId: number, clientName: string) => {
    setPmThreads((prev) => ({
      ...prev,
      [clientId]: prev[clientId] ?? { partnerId: clientId, partnerName: clientName, messages: [], unread: false },
    }));
    setActiveTab(clientId);
  };

  const handlePokeClient = (clientId: number, clientName: string) => {
    setPokeTarget({ id: clientId, name: clientName });
    setPokeMessage("");
  };

  const toggleWhisperChannel = (channelId: number) => {
    setWhisperChannelIds((prev) => {
      const next = new Set(prev);
      if (next.has(channelId)) next.delete(channelId);
      else next.add(channelId);
      return next;
    });
  };

  const toggleWhisperClient = (clientId: number) => {
    setWhisperClientIds((prev) => {
      const next = new Set(prev);
      if (next.has(clientId)) next.delete(clientId);
      else next.add(clientId);
      return next;
    });
  };

  const clearWhisperTargets = () => {
    setWhisperChannelIds(new Set());
    setWhisperClientIds(new Set());
  };

  const handleSaveWhisperList = (name: string) => {
    const channelNames = channels.filter((c) => whisperChannelIds.has(c.id)).map((c) => c.name);
    const clientNames = clients.filter((c) => whisperClientIds.has(c.id)).map((c) => c.name);
    if (channelNames.length === 0 && clientNames.length === 0) return;
    setWhisperLists((prev) => [...prev, { id: crypto.randomUUID(), name, channelNames, clientNames }]);
  };

  const handleActivateWhisperList = (list: WhisperList) => {
    const nextChannelIds = new Set(
      channels.filter((c) => list.channelNames.includes(c.name)).map((c) => c.id)
    );
    const nextClientIds = new Set(clients.filter((c) => list.clientNames.includes(c.name)).map((c) => c.id));
    setWhisperChannelIds(nextChannelIds);
    setWhisperClientIds(nextClientIds);
  };

  const handleDeleteWhisperList = (id: string) => {
    setWhisperLists((prev) => prev.filter((list) => list.id !== id));
  };

  /** Switching identities (in the connect dialog's picker) also switches the
   *  nickname field to that identity's own remembered nickname, like the
   *  native client - only when it actually has one saved, so a fresh
   *  identity doesn't blank out what the user already typed. */
  const handleActiveIdentityChange = (id: string) => {
    setActiveIdentityId(id);
    const identity = identities.find((i) => i.id === id);
    if (identity?.nickname) setNickname(identity.nickname);
  };

  const handleAddIdentity = () => {
    const identity: Identity = {
      id: crypto.randomUUID(),
      name: t("identities.newName"),
      nickname: "",
      phoneticName: "",
      blob: null,
    };
    setIdentities((prev) => [...prev, identity]);
  };

  const handleRenameIdentity = (id: string, name: string) => {
    setIdentities((prev) => prev.map((i) => (i.id === id ? { ...i, name } : i)));
  };

  const handleIdentityNicknameChange = (id: string, value: string) => {
    setIdentities((prev) => prev.map((i) => (i.id === id ? { ...i, nickname: value } : i)));
    if (id === activeIdentityId) setNickname(value);
  };

  const handleIdentityPhoneticChange = (id: string, value: string) => {
    setIdentities((prev) => prev.map((i) => (i.id === id ? { ...i, phoneticName: value } : i)));
  };

  const handleDeleteIdentity = (id: string) => {
    setIdentities((prev) => {
      if (prev.length <= 1) return prev;
      const next = prev.filter((i) => i.id !== id);
      if (activeIdentityId === id) setActiveIdentityId(next[0]?.id ?? null);
      return next;
    });
  };

  /** Downloads one identity's opaque tsclientlib blob as a JSON file - the
   *  same file this dialog's "Importieren" button reads back in, so it
   *  doubles as a backup/transfer mechanism between browsers or devices. */
  const handleExportIdentity = (id: string) => {
    const identity = identities.find((i) => i.id === id);
    if (!identity?.blob) return;
    const blob = new Blob([identity.blob], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${identity.name.replace(/[^a-z0-9_-]+/gi, "_") || "identity"}.ts3identity.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  /** Parses the native client's identity .ini format:
   *  [Identity]
   *  id=<name, with \xHH-escaped non-ASCII chars>
   *  identity="<counter>V<base64 key>"
   *  nickname=<...>
   *  phonetic_nickname=<...>
   *  Returns null if it doesn't look like one. */
  /** Undoes Qt's QSettings .ini string escaping: `\xH..HHHH` (1-4 hex
   *  digits) is one UTF-16 *code unit*, not one byte - astral characters
   *  (emoji etc.) come out as two consecutive escapes forming a surrogate
   *  pair, e.g. "\xd83d\xde43" for 🙃. Treating each \xHH as a standalone
   *  Latin-1 byte (the previous approach) mangles anything outside the
   *  Latin-1 range into mojibake, which is exactly what showed up in the
   *  nickname field for names with Greek/Turkish letters or emoji. */
  const unescapeQtIni = (value: string): string => {
    let result = "";
    for (let i = 0; i < value.length; i++) {
      if (value[i] === "\\") {
        const next = value[i + 1];
        if (next === "x") {
          let hex = "";
          let j = i + 2;
          while (j < value.length && hex.length < 4 && /[0-9a-fA-F]/.test(value[j])) {
            hex += value[j];
            j++;
          }
          if (hex.length > 0) {
            result += String.fromCharCode(parseInt(hex, 16));
            i = j - 1;
            continue;
          }
        } else if (next === "n") {
          result += "\n";
          i++;
          continue;
        } else if (next === "t") {
          result += "\t";
          i++;
          continue;
        } else if (next === "r") {
          result += "\r";
          i++;
          continue;
        } else if (next === "\\" || next === '"') {
          result += next;
          i++;
          continue;
        }
      }
      result += value[i];
    }
    return result;
  };

  const parseIniIdentity = (text: string): { name: string; nickname: string; phonetic: string; blob: string } | null => {
    if (!/^\s*\[Identity\]/im.test(text)) return null;
    const fields: Record<string, string> = {};
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^(\w+)\s*=\s*(.*)$/);
      if (!m) continue;
      let value = m[2].trim();
      if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
      fields[m[1]] = unescapeQtIni(value);
    }
    if (!fields.identity) return null;
    return { name: fields.id ?? "", nickname: fields.nickname ?? "", phonetic: fields.phonetic_nickname ?? "", blob: fields.identity };
  };

  const handleImportIdentity = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const text = (reader.result as string).trim();
      const ini = parseIniIdentity(text);
      if (ini) {
        const identity: Identity = {
          id: crypto.randomUUID(),
          name: ini.name || file.name.replace(/\.ini$/i, "") || t("identities.newName"),
          nickname: ini.nickname,
          phoneticName: ini.phonetic,
          blob: ini.blob,
        };
        setIdentities((prev) => [...prev, identity]);
        return;
      }
      try {
        JSON.parse(text);
      } catch {
        logClient("error", "Identitäten", `"${file.name}" ist keine gültige Identitätsdatei.`);
        return;
      }
      const name = file.name.replace(/\.(ts3identity\.)?json$/i, "") || t("identities.newName");
      const identity: Identity = { id: crypto.randomUUID(), name, nickname: "", phoneticName: "", blob: text };
      setIdentities((prev) => [...prev, identity]);
    };
    reader.readAsText(file);
  };

  const handleShowClientConnectionInfo = (clientId: number, clientName: string) => {
    setClientConnectionInfoTarget({ id: clientId, name: clientName });
    setClientConnectionInfo(null);
    socketRef.current?.send(JSON.stringify({ type: "getClientConnectionInfo", clientId }));
  };

  const handleShowServerConnectionInfo = () => {
    setServerConnectionInfoOpen(true);
    setServerConnectionInfo(null);
    socketRef.current?.send(JSON.stringify({ type: "getServerConnectionInfo" }));
  };

  const handleShowServerProtocolLog = () => {
    setServerProtocolLogOpen(true);
    setServerProtocolLog(null);
    socketRef.current?.send(JSON.stringify({ type: "getServerLog" }));
  };

  const handleShowBanList = () => {
    setBanListOpen(true);
    setBanList(null);
    socketRef.current?.send(JSON.stringify({ type: "getBanList" }));
  };

  const handleDeleteBan = (banId: number) => {
    socketRef.current?.send(JSON.stringify({ type: "deleteBan", banId }));
    setBanList((prev) => (prev ? prev.filter((e) => e.banId !== banId) : prev));
  };

  const handleDeleteAllBans = () => {
    socketRef.current?.send(JSON.stringify({ type: "deleteAllBans" }));
    setBanList([]);
  };

  const handleShowComplainList = () => {
    setComplainListOpen(true);
    setComplainList(null);
    socketRef.current?.send(JSON.stringify({ type: "getComplainList" }));
  };

  const handleDeleteComplaint = (targetClientDbId: number, fromClientDbId: number) => {
    socketRef.current?.send(
      JSON.stringify({ type: "deleteComplaint", targetClientDbId, fromClientDbId })
    );
    setComplainList((prev) =>
      prev
        ? prev.filter(
            (e) => !(e.targetClientDbId === targetClientDbId && e.fromClientDbId === fromClientDbId)
          )
        : prev
    );
  };

  const handleShowOfflineMessages = () => {
    setOfflineMessagesOpen(true);
    setOfflineMessageList(null);
    setOfflineMessageDetail(null);
    socketRef.current?.send(JSON.stringify({ type: "getOfflineMessageList" }));
  };

  const handleSelectOfflineMessage = (messageId: number) => {
    if (messageId === -1) {
      setOfflineMessageDetail(null);
      return;
    }
    socketRef.current?.send(JSON.stringify({ type: "getOfflineMessage", messageId }));
  };

  const handleDeleteOfflineMessage = (messageId: number) => {
    socketRef.current?.send(JSON.stringify({ type: "deleteOfflineMessage", messageId }));
    setOfflineMessageList((prev) => (prev ? prev.filter((e) => e.messageId !== messageId) : prev));
    setOfflineMessageDetail((prev) => (prev?.messageId === messageId ? null : prev));
  };

  const handleMarkOfflineMessageRead = (messageId: number) => {
    socketRef.current?.send(JSON.stringify({ type: "markOfflineMessageRead", messageId }));
    setOfflineMessageList((prev) =>
      prev ? prev.map((e) => (e.messageId === messageId ? { ...e, isRead: true } : e)) : prev
    );
  };

  const handleSendOfflineMessage = (clientUid: string, subject: string, message: string) => {
    socketRef.current?.send(JSON.stringify({ type: "sendOfflineMessage", clientUid, subject, message }));
  };

  const handleClientContextMenu = (
    e: React.MouseEvent,
    clientId: number,
    clientName: string,
    isSelf: boolean
  ) => {
    e.preventDefault();
    const x = Math.min(e.clientX, window.innerWidth - 220);
    const y = Math.min(e.clientY, window.innerHeight - 300);
    setClientContextMenu({ x, y, clientId, clientName, isSelf });
  };

  const handleServerContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const x = Math.min(e.clientX, window.innerWidth - 220);
    const y = Math.min(e.clientY, window.innerHeight - 300);
    setServerContextMenu({ x, y });
  };

  const handleShowChannelGroupAssign = (clientId: number, clientName: string) => {
    setGroupAssignTarget({ kind: "channel", clientId, clientName });
    setChannelGroups(null);
    socketRef.current?.send(JSON.stringify({ type: "getChannelGroupList" }));
  };

  const handleShowServerGroupAssign = (clientId: number, clientName: string) => {
    setGroupAssignTarget({ kind: "server", clientId, clientName });
    setServerGroups(null);
    socketRef.current?.send(JSON.stringify({ type: "getServerGroupList" }));
  };

  const handleSelectGroup = (groupId: number, alreadyAssigned: boolean) => {
    if (!groupAssignTarget) return;
    const target = clients.find((c) => c.id === groupAssignTarget.clientId);
    if (!target) {
      setGroupAssignTarget(null);
      return;
    }
    if (groupAssignTarget.kind === "channel") {
      socketRef.current?.send(
        JSON.stringify({
          type: "setChannelGroup",
          channelGroupId: groupId,
          channelId: target.channel,
          clientDbId: target.databaseId,
        })
      );
      setGroupAssignTarget(null);
    } else {
      socketRef.current?.send(
        JSON.stringify({
          type: alreadyAssigned ? "removeServerGroup" : "addServerGroup",
          serverGroupId: groupId,
          clientDbId: target.databaseId,
        })
      );
      // Server group membership is multi-select, so keep the dialog open for
      // further toggling instead of closing after a single action.
    }
  };

  const handleShowPermissionOverview = () => {
    setPermissionOverviewOpen(true);
    setPermissionOverview(null);
    socketRef.current?.send(JSON.stringify({ type: "getPermissionOverview" }));
  };

  const handleOpenPermissionsEditor = (scope: PermScope) => {
    setPermissionsEditorScope(scope);
    setPermissionsEditorEntries(null);
    setPermissionsEditorTarget(null);
    setPermissionsEditorOpen(true);
    // Fetch both lists regardless of the initial tab - the dialog lets the
    // user switch to any of the 5 tabs, including the group ones, later.
    if (!serverGroups) socketRef.current?.send(JSON.stringify({ type: "getServerGroupList" }));
    if (!channelGroups) socketRef.current?.send(JSON.stringify({ type: "getChannelGroupList" }));
  };

  const handlePermsLoadCatalog = () => {
    if (permissionCatalogRequestedRef.current) return;
    permissionCatalogRequestedRef.current = true;
    socketRef.current?.send(JSON.stringify({ type: "getPermissionCatalog" }));
  };

  const handlePermsSelectTarget = (scope: PermScope, id1: number, id2?: number) => {
    setPermissionsEditorEntries(null);
    setPermissionsEditorTarget({ scope, id1, id2 });
    socketRef.current?.send(JSON.stringify({ type: "getPermList", scope, id1, id2 }));
  };

  const handlePermsRefresh = () => {
    if (!permissionsEditorTarget) return;
    const { scope, id1, id2 } = permissionsEditorTarget;
    setPermissionsEditorEntries(null);
    socketRef.current?.send(JSON.stringify({ type: "getPermList", scope, id1, id2 }));
  };

  const handlePermsAdd = (
    scope: PermScope,
    ids: number[],
    permId: number,
    value: number,
    negated: boolean,
    skip: boolean
  ) => {
    socketRef.current?.send(JSON.stringify({ type: "addPermission", scope, ids, permId, value, negated, skip }));
    window.setTimeout(handlePermsRefresh, 300);
  };

  const handlePermsRemove = (scope: PermScope, ids: number[], permId: number) => {
    socketRef.current?.send(JSON.stringify({ type: "removePermission", scope, ids, permId }));
    window.setTimeout(handlePermsRefresh, 300);
  };

  const handleChannelContextMenu = (e: React.MouseEvent, channelId: number, channelName: string) => {
    e.preventDefault();
    const x = Math.min(e.clientX, window.innerWidth - 220);
    const y = Math.min(e.clientY, window.innerHeight - 200);
    setChannelContextMenu({ x, y, channelId, channelName });
  };

  const handleShowFileBrowser = (channelId: number, channelName: string) => {
    setFileBrowserTarget({ channelId, channelName });
    setFileBrowserPath("/");
    setFileBrowserEntries(null);
    socketRef.current?.send(JSON.stringify({ type: "getFileList", channelId, path: "/" }));
  };

  const handleFileBrowserNavigate = (path: string) => {
    if (!fileBrowserTarget) return;
    setFileBrowserPath(path);
    setFileBrowserEntries(null);
    socketRef.current?.send(JSON.stringify({ type: "getFileList", channelId: fileBrowserTarget.channelId, path }));
  };

  const handleFileBrowserRefresh = () => {
    if (!fileBrowserTarget) return;
    setFileBrowserEntries(null);
    socketRef.current?.send(
      JSON.stringify({ type: "getFileList", channelId: fileBrowserTarget.channelId, path: fileBrowserPath })
    );
  };

  const handleFileBrowserCreateDir = (name: string) => {
    if (!fileBrowserTarget) return;
    socketRef.current?.send(
      JSON.stringify({
        type: "createDirectory",
        channelId: fileBrowserTarget.channelId,
        dirname: ftJoinPath(fileBrowserPath, name),
      })
    );
    // ftcreatedir gets no dedicated reply - the server processes commands from
    // one connection in order, so a refresh sent right after is guaranteed to
    // see the new directory.
    window.setTimeout(handleFileBrowserRefresh, 300);
  };

  const handleFileBrowserDelete = (entry: FileListEntry) => {
    if (!fileBrowserTarget) return;
    if (!window.confirm(t("fileBrowser.deleteConfirm"))) return;
    socketRef.current?.send(
      JSON.stringify({
        type: "deleteFile",
        channelId: fileBrowserTarget.channelId,
        name: ftJoinPath(fileBrowserPath, entry.name),
      })
    );
    window.setTimeout(handleFileBrowserRefresh, 300);
  };

  const handleFileBrowserRename = (entry: FileListEntry, newName: string) => {
    if (!fileBrowserTarget) return;
    socketRef.current?.send(
      JSON.stringify({
        type: "renameFile",
        channelId: fileBrowserTarget.channelId,
        oldName: ftJoinPath(fileBrowserPath, entry.name),
        newName: ftJoinPath(fileBrowserPath, newName),
      })
    );
    window.setTimeout(handleFileBrowserRefresh, 300);
  };

  const handleFileBrowserDownload = (entry: FileListEntry) => {
    if (!fileBrowserTarget) return;
    socketRef.current?.send(
      JSON.stringify({
        type: "downloadFile",
        channelId: fileBrowserTarget.channelId,
        path: ftJoinPath(fileBrowserPath, entry.name),
      })
    );
  };

  const handleFileBrowserUpload = (file: File) => {
    if (!fileBrowserTarget) return;
    const channelId = fileBrowserTarget.channelId;
    const targetPath = ftJoinPath(fileBrowserPath, file.name);
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string; // data:*/*;base64,AAAA...
      const base64 = result.slice(result.indexOf(",") + 1);
      socketRef.current?.send(
        JSON.stringify({ type: "uploadFile", channelId, path: targetPath, dataBase64: base64 })
      );
    };
    reader.readAsDataURL(file);
  };

  const handleShowServerIcons = () => {
    setServerIconsOpen(true);
    setServerIconEntries(null);
    setServerIconImages({});
    socketRef.current?.send(JSON.stringify({ type: "getFileList", channelId: 0, path: "/" }));
  };

  const handleServerIconsRefresh = () => {
    setServerIconImages({});
    socketRef.current?.send(JSON.stringify({ type: "getFileList", channelId: 0, path: "/" }));
  };

  const handleServerIconUpload = (iconId: number, file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const base64 = result.slice(result.indexOf(",") + 1);
      socketRef.current?.send(
        JSON.stringify({ type: "uploadFile", channelId: 0, path: `/icon_${iconId}`, dataBase64: base64 })
      );
    };
    reader.readAsDataURL(file);
  };

  const handleServerIconDelete = (entry: FileListEntry) => {
    if (!window.confirm(t("fileBrowser.deleteConfirm"))) return;
    socketRef.current?.send(JSON.stringify({ type: "deleteFile", channelId: 0, name: `/${entry.name}` }));
    window.setTimeout(handleServerIconsRefresh, 300);
  };

  const handleSendPoke = () => {
    if (!pokeTarget) return;
    socketRef.current?.send(
      JSON.stringify({ type: "sendPoke", clientId: pokeTarget.id, message: pokeMessage })
    );
    setPokeTarget(null);
    setPokeMessage("");
  };

  const handleConfirmKick = () => {
    if (!kickTarget) return;
    socketRef.current?.send(
      JSON.stringify({
        type: kickTarget.scope === "channel" ? "kickFromChannel" : "kickFromServer",
        clientId: kickTarget.id,
        reason: kickReason,
      })
    );
    logClient("info", "Moderation", `Kicked ${kickTarget.name} from ${kickTarget.scope}`);
    setKickTarget(null);
    setKickReason("");
  };

  const handleConfirmBan = () => {
    if (!banTarget) return;
    socketRef.current?.send(
      JSON.stringify({
        type: "banClient",
        clientId: banTarget.id,
        seconds: Number(banSeconds) || 0,
        reason: banReason,
      })
    );
    logClient("info", "Moderation", `Banned ${banTarget.name}`);
    setBanTarget(null);
    setBanReason("");
    setBanSeconds("0");
  };

  const handleClosePrivateChat = (clientId: number) => {
    setPmThreads((prev) => {
      const next = { ...prev };
      delete next[clientId];
      return next;
    });
    setActiveTab((current) => (current === clientId ? "channel" : current));
  };

  const ownClient = clients.find((c) => c.name === nickname) ?? null;
  const isAway = ownClient?.away ?? false;
  const inputMuted = ownClient?.inputMuted ?? false;
  const outputMuted = ownClient?.outputMuted ?? false;
  const displayTalkers =
    selfActive && !inputMuted && ownClient?.hasTalkPower
      ? new Set(talkers).add(ownClient.id)
      : talkers;
  const t = useT();
  const novaSplash = designTheme === "nova" && !connected;

  return (
    <div
      className={`ts-app ts-theme-${theme}${designTheme === "nova" ? " ts-design-nova" : ""}${
        activeCustomTheme ? " ts-design-custom" : ""
      }${demoForceMobile ? " ts-force-mobile" : ""}${novaSplash ? " ts-nova-splash" : ""}`}
      data-custom-theme={activeCustomTheme?.id}
    >
      {DEMO_MODE && (
        <div className="ts-demo-banner">
          Demo mode — simulated data only, no real TeamSpeak server involved.{" "}
          <a href="https://github.com/Moepchi/webspeak3" target="_blank" rel="noreferrer">
            Get WebSpeak3
          </a>
          <button className="ts-demo-mobile-toggle" onClick={() => setDemoForceMobile((v) => !v)}>
            {demoForceMobile ? "🖥 Desktop view" : "📱 Mobile view"}
          </button>
        </div>
      )}
      <div className="ts-menubar">
        <div className={designTheme === "nova" ? "ts-nova-menu-dropdown" : undefined} ref={novaMenuRef}>
        {designTheme === "nova" && (
          <button
            className="ts-icon-button ts-nova-menu-toggle"
            onClick={() => setNovaMenuOpen((v) => !v)}
            aria-label={t("menu.connections")}
          >
            ☰
          </button>
        )}
        <div
          className={`ts-menubar-items${designTheme === "nova" ? " ts-nova-menu-panel" : ""}${
            novaMenuOpen ? " ts-nova-menu-panel-open" : ""
          }`}
        >
        <div className="ts-menubar-dropdown" ref={connectionsMenuRef}>
          <span
            className="ts-menubar-item ts-menubar-item-active"
            onClick={() => setConnectionsMenuOpen((v) => !v)}
          >
            {t("menu.connections")}
          </span>
          {connectionsMenuOpen && (
            <div className="ts-menu">
              <button
                className="ts-menu-item"
                disabled={connected || connecting}
                onClick={() => {
                  setConnectDialogOpen(true);
                  setConnectionsMenuOpen(false);
                }}
              >
                <span className="ts-menu-item-icon">🟢</span>
                <span className="ts-menu-item-label">{t("menu.connections.connect")}</span>
                <span className="ts-menu-item-shortcut">Strg+S</span>
              </button>
              <button
                className="ts-menu-item"
                disabled={!connected}
                onClick={() => {
                  handleDisconnect();
                  setConnectionsMenuOpen(false);
                }}
              >
                <span className="ts-menu-item-icon">🔴</span>
                <span className="ts-menu-item-label">{t("menu.connections.disconnectCurrent")}</span>
                <span className="ts-menu-item-shortcut">Strg+D</span>
              </button>
              <button
                className="ts-menu-item"
                disabled={!connected}
                onClick={() => {
                  handleDisconnect();
                  setConnectionsMenuOpen(false);
                }}
              >
                <span className="ts-menu-item-icon">❌</span>
                <span className="ts-menu-item-label">{t("menu.connections.disconnectAll")}</span>
              </button>
            </div>
          )}
        </div>
        <div className="ts-menubar-dropdown" ref={favoritesMenuRef}>
          <span
            className="ts-menubar-item ts-menubar-item-active"
            onClick={() => setFavoritesMenuOpen((v) => !v)}
          >
            {t("menu.favorites")}
          </span>
          {favoritesMenuOpen && (
            <div className="ts-menu">
              <button className="ts-menu-item" onClick={openAddFavorite}>
                <span className="ts-menu-item-icon">⭐</span>
                <span className="ts-menu-item-label">{t("menu.favorites.add")}</span>
                <span className="ts-menu-item-shortcut">Strg+B</span>
              </button>
              <button className="ts-menu-item" onClick={openManageFavorites}>
                <span className="ts-menu-item-icon">🗂️</span>
                <span className="ts-menu-item-label">{t("menu.favorites.manage")}</span>
              </button>
              {favorites.length > 0 && <div className="ts-menu-separator" />}
              {favorites.map((f) => (
                <button
                  key={f.id}
                  className="ts-menu-item"
                  disabled={connecting}
                  onClick={() => {
                    connectToFavorite(f);
                    setFavoritesMenuOpen(false);
                  }}
                >
                  <span className="ts-menu-item-icon">🔖</span>
                  <span className="ts-menu-item-label">{f.bookmarkName}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="ts-menubar-dropdown" ref={selfMenuRef}>
          <span
            className="ts-menubar-item ts-menubar-item-active"
            onClick={() => setSelfMenuOpen((v) => !v)}
          >
            {t("menu.self")}
          </span>
          {selfMenuOpen && (
            <div className="ts-menu">
              <button className="ts-menu-item" disabled title={t("clientContext.notSupported")}>
                <span className="ts-menu-item-icon">🎙️</span>
                <span className="ts-menu-item-label">{t("menu.self.recordingProfile")}</span>
              </button>
              <button className="ts-menu-item" disabled title={t("clientContext.notSupported")}>
                <span className="ts-menu-item-icon">🔊</span>
                <span className="ts-menu-item-label">{t("menu.self.playbackProfile")}</span>
              </button>
              <button className="ts-menu-item" disabled title={t("clientContext.notSupported")}>
                <span className="ts-menu-item-icon">⌨️</span>
                <span className="ts-menu-item-label">{t("menu.self.hotkeyProfile")}</span>
              </button>
              <button className="ts-menu-item" disabled title={t("clientContext.notSupported")}>
                <span className="ts-menu-item-icon">🔔</span>
                <span className="ts-menu-item-label">{t("menu.self.soundPack")}</span>
              </button>
              <div className="ts-menu-separator" />
              <button
                className="ts-menu-item"
                disabled={!connected}
                onClick={() => {
                  setAwayDialogMessage("");
                  setAwayDialogOpen(true);
                  setSelfMenuOpen(false);
                }}
              >
                <span className="ts-menu-item-icon">💤</span>
                <span className="ts-menu-item-label">{t("menu.self.setAway")}</span>
              </button>
              <button
                className="ts-menu-item"
                disabled={!connected}
                onClick={() => {
                  void handleToggleMic();
                  setSelfMenuOpen(false);
                }}
              >
                <span className="ts-menu-item-icon">{micOn ? "🔇" : "🎤"}</span>
                <span className="ts-menu-item-label">
                  {micOn ? t("menu.self.disableMic") : t("menu.self.enableMic")}
                </span>
              </button>
              <button
                className="ts-menu-item"
                disabled={!connected}
                onClick={() => {
                  handleToggleOutputMuted();
                  setSelfMenuOpen(false);
                }}
              >
                <span className="ts-menu-item-icon">{outputMuted ? "🔊" : "🔇"}</span>
                <span className="ts-menu-item-label">
                  {outputMuted ? t("menu.self.unmuteOutput") : t("menu.self.muteOutput")}
                </span>
              </button>
              <div className="ts-menu-separator" />
              <button
                className="ts-menu-item"
                disabled={!connected}
                onClick={() => {
                  setNicknameDraft(nickname);
                  setChangeNicknameOpen(true);
                  setSelfMenuOpen(false);
                }}
              >
                <span className="ts-menu-item-icon">✎</span>
                <span className="ts-menu-item-label">{t("menu.self.changeNickname")}</span>
              </button>
              <button className="ts-menu-item" disabled title={t("clientContext.notSupported")}>
                <span className="ts-menu-item-icon">🗣️</span>
                <span className="ts-menu-item-label">{t("menu.self.requestTalkPower")}</span>
              </button>
              <button className="ts-menu-item" disabled title={t("clientContext.notSupported")}>
                <span className="ts-menu-item-icon">🖼️</span>
                <span className="ts-menu-item-label">{t("menu.self.setAvatar")}</span>
              </button>
              <button className="ts-menu-item" disabled title={t("clientContext.notSupported")}>
                <span className="ts-menu-item-icon">🔤</span>
                <span className="ts-menu-item-label">{t("menu.self.setPhoneticNickname")}</span>
              </button>
              <div className="ts-menu-separator" />
              <button
                className="ts-menu-item"
                disabled={!ownClient}
                onClick={() => {
                  if (ownClient) handleShowClientConnectionInfo(ownClient.id, ownClient.name);
                  setSelfMenuOpen(false);
                }}
              >
                <span className="ts-menu-item-icon">ℹ️</span>
                <span className="ts-menu-item-label">{t("menu.self.connectionInfo")}</span>
              </button>
            </div>
          )}
        </div>
        <div className="ts-menubar-dropdown" ref={rightsMenuRef}>
          <span
            className="ts-menubar-item ts-menubar-item-active"
            onClick={() => setRightsMenuOpen((v) => !v)}
          >
            {t("menu.rights")}
          </span>
          {rightsMenuOpen && (
            <div className="ts-menu">
              <button
                className="ts-menu-item"
                onClick={() => {
                  handleOpenPermissionsEditor("server");
                  setRightsMenuOpen(false);
                }}
              >
                <span className="ts-menu-item-icon">🏷️</span>
                <span className="ts-menu-item-label">{t("menu.rights.serverGroups")}</span>
              </button>
              <button
                className="ts-menu-item"
                onClick={() => {
                  handleOpenPermissionsEditor("channelgroup");
                  setRightsMenuOpen(false);
                }}
              >
                <span className="ts-menu-item-icon">🎖️</span>
                <span className="ts-menu-item-label">{t("menu.rights.channelGroups")}</span>
              </button>
              <div className="ts-menu-separator" />
              <button
                className="ts-menu-item"
                onClick={() => {
                  handleOpenPermissionsEditor("client");
                  setRightsMenuOpen(false);
                }}
              >
                <span className="ts-menu-item-icon">🔐</span>
                <span className="ts-menu-item-label">{t("menu.rights.serverPermissions")}</span>
              </button>
              <button
                className="ts-menu-item"
                onClick={() => {
                  handleOpenPermissionsEditor("channel");
                  setRightsMenuOpen(false);
                }}
              >
                <span className="ts-menu-item-icon">🔑</span>
                <span className="ts-menu-item-label">{t("menu.rights.channelPermissions")}</span>
              </button>
              <button className="ts-menu-item" disabled title={t("clientContext.notSupported")}>
                <span className="ts-menu-item-icon">📖</span>
                <span className="ts-menu-item-label">{t("menu.rights.overview")}</span>
              </button>
              <div className="ts-menu-separator" />
              <button
                className="ts-menu-item"
                onClick={() => {
                  handleShowPermissionOverview();
                  setRightsMenuOpen(false);
                }}
              >
                <span className="ts-menu-item-icon">🙋</span>
                <span className="ts-menu-item-label">{t("menu.rights.myRights")}</span>
              </button>
            </div>
          )}
        </div>
        <div className="ts-menubar-dropdown" ref={extrasMenuRef}>
          <span
            className="ts-menubar-item ts-menubar-item-active"
            onClick={() => setExtrasMenuOpen((v) => !v)}
          >
            {t("menu.extras")}
          </span>
          {extrasMenuOpen && (
            <div className="ts-menu">
              <button
                className="ts-menu-item"
                onClick={() => {
                  setIdentitiesOpen(true);
                  setExtrasMenuOpen(false);
                }}
              >
                <span className="ts-menu-item-icon">🪪</span>
                <span className="ts-menu-item-label">{t("menu.extras.identities")}</span>
                <span className="ts-menu-item-shortcut">Strg+I</span>
              </button>
              <button
                className="ts-menu-item"
                onClick={() => {
                  setContactsOpen(true);
                  setExtrasMenuOpen(false);
                }}
              >
                <span className="ts-menu-item-icon">📇</span>
                <span className="ts-menu-item-label">{t("menu.extras.contacts")}</span>
                <span className="ts-menu-item-shortcut">Strg+Umschalt+O</span>
              </button>
              <button
                className="ts-menu-item"
                onClick={() => {
                  setCollectedUrlsOpen(true);
                  setExtrasMenuOpen(false);
                }}
              >
                <span className="ts-menu-item-icon">🔗</span>
                <span className="ts-menu-item-label">{t("menu.extras.collectedUrls")}</span>
                <span className="ts-menu-item-shortcut">Strg+U</span>
              </button>
              <button
                className="ts-menu-item"
                disabled={!connected}
                onClick={() => {
                  setInviteFriendOpen(true);
                  setExtrasMenuOpen(false);
                }}
              >
                <span className="ts-menu-item-icon">🧑‍🤝‍🧑</span>
                <span className="ts-menu-item-label">{t("menu.extras.inviteFriend")}</span>
              </button>
              <div className="ts-menu-separator" />
              <button
                className="ts-menu-item"
                onClick={() => {
                  setWhisperListsOpen(true);
                  setExtrasMenuOpen(false);
                }}
              >
                <span className="ts-menu-item-icon">🗒️</span>
                <span className="ts-menu-item-label">{t("menu.extras.whisperLists")}</span>
                <span className="ts-menu-item-shortcut">Strg+Umschalt+W</span>
              </button>
              <button
                className="ts-menu-item"
                onClick={() => {
                  setWhisperHistoryOpen(true);
                  setExtrasMenuOpen(false);
                }}
              >
                <span className="ts-menu-item-icon">🕓</span>
                <span className="ts-menu-item-label">{t("menu.extras.whisperHistory")}</span>
                <span className="ts-menu-item-shortcut">Strg+Umschalt+H</span>
              </button>
              <button
                className="ts-menu-item"
                onClick={() => {
                  setClientLogOpen(true);
                  setExtrasMenuOpen(false);
                }}
              >
                <span className="ts-menu-item-icon">📜</span>
                <span className="ts-menu-item-label">{t("menu.extras.clientLog")}</span>
                <span className="ts-menu-item-shortcut">Strg+L</span>
              </button>
              <div className="ts-menu-separator" />
              <button
                className="ts-menu-item"
                onClick={() => {
                  handleShowBanList();
                  setExtrasMenuOpen(false);
                }}
              >
                <span className="ts-menu-item-icon">🚫</span>
                <span className="ts-menu-item-label">{t("menu.extras.banList")}</span>
                <span className="ts-menu-item-shortcut">Strg+Umschalt+B</span>
              </button>
              <button
                className="ts-menu-item"
                onClick={() => {
                  handleShowComplainList();
                  setExtrasMenuOpen(false);
                }}
              >
                <span className="ts-menu-item-icon">⚠️</span>
                <span className="ts-menu-item-label">{t("menu.extras.complaintList")}</span>
                <span className="ts-menu-item-shortcut">Strg+Umschalt+C</span>
              </button>
              <button
                className="ts-menu-item"
                onClick={() => {
                  handleShowOfflineMessages();
                  setExtrasMenuOpen(false);
                }}
              >
                <span className="ts-menu-item-icon">📧</span>
                <span className="ts-menu-item-label">{t("menu.extras.offlineMessages")}</span>
              </button>
              <button
                className="ts-menu-item"
                onClick={() => {
                  setServerQueryUsername("");
                  setServerQueryPassword("");
                  setServerQueryLoginOpen(true);
                  setExtrasMenuOpen(false);
                }}
              >
                <span className="ts-menu-item-icon">🔑</span>
                <span className="ts-menu-item-label">{t("menu.extras.serverQueryLogin")}</span>
              </button>
              <button
                className="ts-menu-item"
                onClick={() => {
                  handleShowServerProtocolLog();
                  setExtrasMenuOpen(false);
                }}
              >
                <span className="ts-menu-item-icon">📄</span>
                <span className="ts-menu-item-label">{t("menu.extras.serverLog")}</span>
                <span className="ts-menu-item-shortcut">Strg+Umschalt+L</span>
              </button>
              <div className="ts-menu-separator" />
              <button
                className="ts-menu-item"
                disabled={recording}
                onClick={() => {
                  startRecording();
                  setExtrasMenuOpen(false);
                }}
              >
                <span className="ts-menu-item-icon">🔴</span>
                <span className="ts-menu-item-label">{t("menu.extras.startRecording")}</span>
                <span className="ts-menu-item-shortcut">Strg+Umschalt+R</span>
              </button>
              <button className="ts-menu-item" disabled>
                <span className="ts-menu-item-icon">🔴</span>
                <span className="ts-menu-item-label">{t("menu.extras.startMultitrackRecording")}</span>
              </button>
              <button
                className="ts-menu-item"
                disabled={!recording}
                onClick={() => {
                  stopRecording();
                  setExtrasMenuOpen(false);
                }}
              >
                <span className="ts-menu-item-icon">⏹️</span>
                <span className="ts-menu-item-label">{t("menu.extras.stopRecording")}</span>
                <span className="ts-menu-item-shortcut">Strg+Umschalt+T</span>
              </button>
              <div className="ts-menu-separator" />
              <button
                className="ts-menu-item"
                onClick={() => {
                  setOptionsDialogOpen(true);
                  setExtrasMenuOpen(false);
                }}
              >
                <span className="ts-menu-item-icon">⚙️</span>
                <span className="ts-menu-item-label">{t("menu.extras.options")}</span>
                <span className="ts-menu-item-shortcut">Alt+P</span>
              </button>
            </div>
          )}
        </div>
        <span className="ts-menubar-item">{t("menu.help")}</span>
        </div>
        </div>
        {designTheme === "nova" && (
          <div className="ts-nova-topbar-server">
            <span className="ts-nova-topbar-logo">W</span>
            <span className="ts-nova-topbar-name">{connected ? serverName || host : "WebSpeak3"}</span>
            <span className={`ts-nova-topbar-status${connected ? " ts-nova-topbar-status-on" : ""}`}>
              <span className="ts-nova-topbar-dot" />
              {connected ? t("design.status.connected") : t("tree.notConnected")}
            </span>
          </div>
        )}
      </div>

      <div className="ts-toolbar">
        {designTheme === "nova" && connected && ownClient && (
          <div className="ts-nova-toolbar-self">
            <span className="ts-nova-toolbar-avatar">
              {ownClient.name.trim().charAt(0).toUpperCase() || "?"}
            </span>
            <span className="ts-nova-toolbar-self-info">
              <span className="ts-nova-toolbar-self-name">{ownClient.name}</span>
              <span className="ts-nova-toolbar-self-status">
                {isAway ? t("tree.away") : t("design.status.connected")}
              </span>
            </span>
          </div>
        )}
        <div className="ts-toolbar-icons">
          <div className="ts-toolbar-away" ref={awayMenuRef}>
            <button
              className={`ts-icon-button${isAway ? " ts-away-on" : ""}`}
              onClick={() => sendAway(!isAway, "")}
              disabled={!connected}
              title={isAway ? t("toolbar.backOnline") : t("toolbar.setAway")}
            >
              💤
            </button>
            <button
              className="ts-icon-caret"
              onClick={() => {
                setAwayPresets(loadAwayPresets());
                setAwayMenuOpen((v) => !v);
              }}
              disabled={!connected}
              title={t("toolbar.awayOptions")}
            >
              ▾
            </button>
            {awayMenuOpen && (
              <div className="ts-menu ts-menu-away">
                <button
                  className="ts-menu-item"
                  onClick={() => {
                    sendAway(true, "");
                    setAwayMenuOpen(false);
                  }}
                >
                  <span className="ts-menu-item-icon">💤</span>
                  <span className="ts-menu-item-label">{t("away.setGlobal")}</span>
                </button>
                <button
                  className="ts-menu-item"
                  onClick={() => {
                    setAwayDialogMessage("");
                    setAwayDialogOpen(true);
                    setAwayMenuOpen(false);
                  }}
                >
                  <span className="ts-menu-item-icon">✎</span>
                  <span className="ts-menu-item-label">{t("away.setGlobalStatus")}</span>
                </button>
                {awayPresets.length > 0 && <div className="ts-menu-separator" />}
                {awayPresets.map((preset) => (
                  <button
                    key={preset.name}
                    className="ts-menu-item"
                    onClick={() => {
                      sendAway(true, preset.message);
                      setAwayMenuOpen(false);
                    }}
                  >
                    <span className="ts-menu-item-label">{preset.name}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <span className="ts-toolbar-sep" />
          <div className="ts-toolbar-away" ref={whisperMenuRef}>
            <button
              className={`ts-icon-button${whisperChannelIds.size > 0 || whisperClientIds.size > 0 ? " ts-away-on" : ""}`}
              onClick={() => setWhisperMenuOpen((v) => !v)}
              disabled={!connected}
              title={t("toolbar.whisper")}
            >
              🤫
            </button>
            {whisperMenuOpen && (
              <div className="ts-menu ts-menu-away">
                <div className="ts-context-menu-title">{t("whisper.channels")}</div>
                {channels.map((ch) => (
                  <label key={ch.id} className="ts-menu-item">
                    <input
                      type="checkbox"
                      checked={whisperChannelIds.has(ch.id)}
                      onChange={() => toggleWhisperChannel(ch.id)}
                    />
                    <span className="ts-menu-item-label">{ch.name}</span>
                  </label>
                ))}
                {whisperClientIds.size > 0 && (
                  <>
                    <div className="ts-menu-separator" />
                    <div className="ts-context-menu-title">{t("whisper.clients")}</div>
                    {[...whisperClientIds].map((id) => (
                      <button key={id} className="ts-menu-item" onClick={() => toggleWhisperClient(id)}>
                        <span className="ts-menu-item-icon">✕</span>
                        <span className="ts-menu-item-label">
                          {clients.find((c) => c.id === id)?.name ?? id}
                        </span>
                      </button>
                    ))}
                  </>
                )}
                {(whisperChannelIds.size > 0 || whisperClientIds.size > 0) && (
                  <>
                    <div className="ts-menu-separator" />
                    <button className="ts-menu-item" onClick={clearWhisperTargets}>
                      <span className="ts-menu-item-label">{t("whisper.clearAll")}</span>
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
          <span className="ts-toolbar-sep" />
          <button
            className={`ts-icon-button${micOn && !inputMuted ? " ts-mic-on" : ""}${micOn && inputMuted ? " ts-muted-on" : ""}`}
            onClick={handleToggleMic}
            title={
              !micOn
                ? t("toolbar.micEnable")
                : inputMuted
                  ? t("toolbar.micUnmute")
                  : t("toolbar.micMute")
            }
          >
            {micOn && !inputMuted ? "🎤" : "🔇"}
          </button>
          <label className="ts-icon-slider" title={t("toolbar.vadSensitivity")}>
            🎚️
            <input
              type="range"
              min={0.002}
              max={0.15}
              step={0.002}
              value={vadThreshold}
              onChange={(e) => setVadThreshold(Number(e.target.value))}
            />
          </label>
          <span className="ts-toolbar-sep" />
          <button
            className={`ts-icon-button${outputMuted ? " ts-muted-on" : ""}`}
            onClick={handleToggleOutputMuted}
            disabled={!connected}
            title={outputMuted ? t("toolbar.unmuteSound") : t("toolbar.muteSound")}
          >
            {outputMuted ? "🔇" : "🔊"}
          </button>
          {hasNativeOutputPicker() ? (
            <button className="ts-icon-button" onClick={handlePickOutputDevice} title={t("toolbar.chooseOutputDevice")}>
              🎧
            </button>
          ) : (
            <label className="ts-icon-select">
              🎧
              <select
                value={outputDeviceId}
                onChange={(e) => handleOutputDeviceChange(e.target.value)}
                onFocus={refreshOutputDevices}
              >
                <option value="">{t("playback.systemDefault")}</option>
                {outputDevices.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || `Output ${d.deviceId.slice(0, 6)}`}
                  </option>
                ))}
              </select>
            </label>
          )}
          {recording && (
            <button className="ts-icon-button ts-recording-on" onClick={stopRecording} title={t("menu.extras.stopRecording")}>
              🔴
            </button>
          )}
          <span className="ts-toolbar-sep" />
          <button
            className="ts-icon-button"
            onClick={() => setTheme((mode) => (mode === "dark" ? "light" : "dark"))}
            title={t("toolbar.toggleTheme")}
          >
            {theme === "dark" ? "☀️" : "🌙"}
          </button>
          <img src={`${import.meta.env.BASE_URL}logo.png`} alt="" className="ts-app-logo" />
          <span className="ts-app-title">WebSpeak3</span>
        </div>

      </div>

      {connectDialogOpen && (
        <ConnectDialog
          host={host}
          nickname={nickname}
          serverPassword={serverPassword}
          channelPassword={channelPassword}
          defaultChannel={defaultChannel}
          expanded={connectDialogExpanded}
          connecting={connecting}
          identities={identities}
          activeIdentityId={activeIdentityId}
          onHostChange={setHost}
          onNicknameChange={setNickname}
          onServerPasswordChange={setServerPassword}
          onChannelPasswordChange={setChannelPassword}
          onDefaultChannelChange={setDefaultChannel}
          onActiveIdentityChange={handleActiveIdentityChange}
          onToggleExpanded={() => setConnectDialogExpanded((v) => !v)}
          onConnect={handleConnect}
          onCancel={novaSplash ? () => {} : () => setConnectDialogOpen(false)}
          nova={designTheme === "nova"}
          onOpenOptions={() => setOptionsDialogOpen(true)}
        />
      )}

      {favoritesDialogMode && (
        <FavoritesDialog
          favorites={favorites}
          prefillNew={favoritesDialogMode.kind === "add" ? favoritesDialogMode.prefill : undefined}
          onSave={saveFavorites}
          onClose={() => setFavoritesDialogMode(null)}
        />
      )}

      {collectedUrlsOpen && (
        <CollectedUrlsDialog
          urls={collectedUrls}
          onClear={() => setCollectedUrls([])}
          onClose={() => setCollectedUrlsOpen(false)}
        />
      )}

      {inviteFriendOpen && (
        <InviteFriendDialog
          host={host}
          channelId={selected?.type === "channel" ? selected.id : null}
          onClose={() => setInviteFriendOpen(false)}
        />
      )}

      {clientLogOpen && (
        <ClientLogDialog entries={logEntries} onClose={() => setClientLogOpen(false)} />
      )}

      {whisperHistoryOpen && (
        <WhisperHistoryDialog
          serverName={serverName}
          entries={whisperLog}
          onClear={() => setWhisperLog([])}
          onClose={() => setWhisperHistoryOpen(false)}
        />
      )}

      {whisperListsOpen && (
        <WhisperListsDialog
          lists={whisperLists}
          hasCurrentSelection={whisperChannelIds.size > 0 || whisperClientIds.size > 0}
          onSave={handleSaveWhisperList}
          onActivate={handleActivateWhisperList}
          onDelete={handleDeleteWhisperList}
          onClose={() => setWhisperListsOpen(false)}
        />
      )}

      {identitiesOpen && (
        <IdentitiesDialog
          identities={identities}
          activeId={activeIdentityId}
          ownUid={connected ? ownClient?.uid ?? null : null}
          onActivate={setActiveIdentityId}
          onAdd={handleAddIdentity}
          onRename={handleRenameIdentity}
          onNicknameChange={handleIdentityNicknameChange}
          onPhoneticChange={handleIdentityPhoneticChange}
          onDelete={handleDeleteIdentity}
          onExport={handleExportIdentity}
          onImport={handleImportIdentity}
          onClose={() => setIdentitiesOpen(false)}
        />
      )}

      {clientConnectionInfoTarget && (
        <ClientConnectionInfoDialog
          clientName={clientConnectionInfoTarget.name}
          info={clientConnectionInfo?.clientId === clientConnectionInfoTarget.id ? clientConnectionInfo : null}
          onClose={() => setClientConnectionInfoTarget(null)}
        />
      )}

      {serverConnectionInfoOpen && (
        <ServerConnectionInfoDialog
          info={serverConnectionInfo}
          onClose={() => setServerConnectionInfoOpen(false)}
        />
      )}

      {serverEditOpen && (
        <ServerEditDialog
          serverName={serverName}
          welcomeMessage={serverWelcomeMessage}
          hostbannerGfxUrl={serverBannerUrl}
          onSave={(payload) => {
            socketRef.current?.send(JSON.stringify({ type: "editServer", payload }));
            logClient("info", "Moderation", "Edited server settings");
          }}
          onClose={() => setServerEditOpen(false)}
        />
      )}

      {serverProtocolLogOpen && (
        <ServerProtocolLogDialog
          lines={serverProtocolLog}
          onClose={() => setServerProtocolLogOpen(false)}
        />
      )}

      {banListOpen && (
        <BanListDialog
          entries={banList}
          onDelete={handleDeleteBan}
          onDeleteAll={handleDeleteAllBans}
          onClose={() => setBanListOpen(false)}
        />
      )}

      {complainListOpen && (
        <ComplainListDialog
          entries={complainList}
          onDelete={handleDeleteComplaint}
          onClose={() => setComplainListOpen(false)}
        />
      )}

      {offlineMessagesOpen && (
        <OfflineMessagesDialog
          entries={offlineMessageList}
          detail={offlineMessageDetail}
          onSelect={handleSelectOfflineMessage}
          onDelete={handleDeleteOfflineMessage}
          onMarkRead={handleMarkOfflineMessageRead}
          onSend={handleSendOfflineMessage}
          onClose={() => setOfflineMessagesOpen(false)}
        />
      )}

      {groupAssignTarget && (
        <GroupAssignDialog
          kind={groupAssignTarget.kind}
          clientName={groupAssignTarget.clientName}
          groups={groupAssignTarget.kind === "channel" ? channelGroups : serverGroups}
          currentGroupIds={(() => {
            const target = clients.find((c) => c.id === groupAssignTarget.clientId);
            if (!target) return [];
            return groupAssignTarget.kind === "channel" ? [target.channelGroup] : target.serverGroups;
          })()}
          onSelect={handleSelectGroup}
          onClose={() => setGroupAssignTarget(null)}
        />
      )}

      {permissionOverviewOpen && (
        <PermissionOverviewDialog
          entries={permissionOverview}
          onClose={() => setPermissionOverviewOpen(false)}
        />
      )}

      {permissionsEditorOpen && (
        <PermissionsEditorDialog
          initialScope={permissionsEditorScope}
          channelGroups={channelGroups}
          serverGroups={serverGroups}
          channels={channels}
          clients={clients}
          entries={permissionsEditorEntries}
          catalog={permissionCatalog}
          onSelectTarget={handlePermsSelectTarget}
          onLoadCatalog={handlePermsLoadCatalog}
          onAdd={handlePermsAdd}
          onRemove={handlePermsRemove}
          onClose={() => setPermissionsEditorOpen(false)}
        />
      )}

      {fileBrowserTarget && (
        <FileBrowserDialog
          channelName={fileBrowserTarget.channelName}
          path={fileBrowserPath}
          entries={fileBrowserEntries}
          onNavigate={handleFileBrowserNavigate}
          onCreateDir={handleFileBrowserCreateDir}
          onDelete={handleFileBrowserDelete}
          onRename={handleFileBrowserRename}
          onDownload={handleFileBrowserDownload}
          onUpload={handleFileBrowserUpload}
          onRefresh={handleFileBrowserRefresh}
          onClose={() => setFileBrowserTarget(null)}
        />
      )}

      {serverIconsOpen && (
        <ServerIconsDialog
          entries={serverIconEntries}
          images={serverIconImages}
          onUpload={handleServerIconUpload}
          onDelete={handleServerIconDelete}
          onClose={() => setServerIconsOpen(false)}
        />
      )}

      {contactsOpen && (
        <ContactsDialog
          contacts={contacts}
          onlineClients={clients}
          onSave={setContacts}
          onWhisper={toggleWhisperClient}
          onShow={(clientId) => {
            const client = clients.find((c) => c.id === clientId);
            if (client) setSelected({ type: "channel", id: client.channel });
          }}
          onClose={() => setContactsOpen(false)}
        />
      )}

      {awayDialogOpen && (
        <AwayDialog
          message={awayDialogMessage}
          presets={awayPresets}
          onMessageChange={setAwayDialogMessage}
          onOk={handleConfirmAway}
          onSaveTemplate={handleSaveAwayTemplate}
          onCancel={() => setAwayDialogOpen(false)}
        />
      )}

      {optionsDialogOpen && (
        <OptionsDialog
          section={optionsSection}
          onSectionChange={setOptionsSection}
          onClose={() => setOptionsDialogOpen(false)}
          designSelection={designSelection}
          onDesignSelectionChange={handleDesignSelectionChange}
          customThemes={customThemes}
          onSaveCustomTheme={handleSaveCustomTheme}
          onDeleteCustomTheme={handleDeleteCustomTheme}
          audio={{
            outputDevices,
            outputDeviceId,
            onOutputDeviceChange: handleOutputDeviceChange,
            onRefreshOutputDevices: refreshOutputDevices,
            playbackVolume,
            onPlaybackVolumeChange: setPlaybackVolume,
            onPlayTestTone: handlePlayTestTone,
            inputDevices,
            inputDeviceId,
            onInputDeviceChange: handleInputDeviceChange,
            onRefreshInputDevices: refreshInputDevices,
            micOn,
            micLevelRef,
            micTestOn,
            onToggleMicTest: handleToggleMicTest,
            vadThreshold,
            onVadThresholdChange: setVadThreshold,
            vadHangover,
            onVadHangoverChange: setVadHangover,
            noiseSuppressionEnabled,
            onToggleNoiseSuppression: handleToggleNoiseSuppression,
            echoCancellationEnabled,
            onToggleEchoCancellation: handleToggleEchoCancellation,
            autoGainControlEnabled,
            onToggleAutoGainControl: handleToggleAutoGainControl,
          }}
        />
      )}

      {connectError && (
        <div className="ts-connect-error">
          <span>⚠️ {connectError}</span>
          <button onClick={() => setConnectError(null)} title={t("connectError.dismiss")}>
            ✕
          </button>
        </div>
      )}

      {changeNicknameOpen && (
        <div className="ts-poke-compose-backdrop" {...nicknameBackdrop}>
          <div className="ts-poke-compose" onClick={(e) => e.stopPropagation()}>
            <span>✎ {t("menu.self.changeNickname")}</span>
            <input
              autoFocus
              value={nicknameDraft}
              onChange={(e) => setNicknameDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && nicknameDraft.trim()) {
                  handleSetNickname(nicknameDraft.trim());
                  setChangeNicknameOpen(false);
                }
                if (e.key === "Escape") setChangeNicknameOpen(false);
              }}
            />
            <button
              disabled={!nicknameDraft.trim()}
              onClick={() => {
                handleSetNickname(nicknameDraft.trim());
                setChangeNicknameOpen(false);
              }}
            >
              {t("favorites.ok")}
            </button>
            <button onClick={() => setChangeNicknameOpen(false)}>{t("favorites.cancel")}</button>
          </div>
        </div>
      )}

      {serverQueryLoginOpen && (
        <div className="ts-poke-compose-backdrop" {...serverQueryLoginBackdrop}>
          <div className="ts-poke-compose ts-serverquery-login-compose" onClick={(e) => e.stopPropagation()}>
            <span>🔑 {t("menu.extras.serverQueryLogin")}</span>
            <input
              autoFocus
              placeholder={t("serverQueryLogin.username")}
              value={serverQueryUsername}
              onChange={(e) => setServerQueryUsername(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setServerQueryLoginOpen(false);
              }}
            />
            <input
              type="password"
              placeholder={t("serverQueryLogin.password")}
              value={serverQueryPassword}
              onChange={(e) => setServerQueryPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleServerQueryLogin();
                if (e.key === "Escape") setServerQueryLoginOpen(false);
              }}
            />
            <button
              disabled={!serverQueryUsername.trim() || !serverQueryPassword}
              onClick={handleServerQueryLogin}
            >
              {t("serverQueryLogin.login")}
            </button>
            <button onClick={() => setServerQueryLoginOpen(false)}>{t("favorites.cancel")}</button>
          </div>
        </div>
      )}

      {pokeTarget && (
        <div className="ts-poke-compose-backdrop" {...pokeBackdrop}>
          <div className="ts-poke-compose" onClick={(e) => e.stopPropagation()}>
            <span>
              👉 {t("poke.title")} <strong>{pokeTarget.name}</strong>
            </span>
            <input
              autoFocus
              value={pokeMessage}
              onChange={(e) => setPokeMessage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSendPoke();
                if (e.key === "Escape") setPokeTarget(null);
              }}
              placeholder={t("poke.optionalMessage")}
            />
            <button onClick={handleSendPoke}>{t("poke.send")}</button>
            <button onClick={() => setPokeTarget(null)}>{t("poke.cancel")}</button>
          </div>
        </div>
      )}

      {kickTarget && (
        <div className="ts-poke-compose-backdrop" {...kickBackdrop}>
          <div className="ts-poke-compose" onClick={(e) => e.stopPropagation()}>
            <span>
              👢 {t("kick.title")} <strong>{kickTarget.name}</strong>
            </span>
            <input
              autoFocus
              value={kickReason}
              onChange={(e) => setKickReason(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleConfirmKick();
                if (e.key === "Escape") setKickTarget(null);
              }}
              placeholder={t("kick.reasonPlaceholder")}
            />
            <button onClick={handleConfirmKick}>{t("kick.confirm")}</button>
            <button onClick={() => setKickTarget(null)}>{t("kick.cancel")}</button>
          </div>
        </div>
      )}

      {banTarget && (
        <div className="ts-poke-compose-backdrop" {...banBackdrop}>
          <div className="ts-poke-compose ts-ban-compose" onClick={(e) => e.stopPropagation()}>
            <span>
              🚫 {t("ban.title")} <strong>{banTarget.name}</strong>
            </span>
            <label className="ts-ban-duration-field">
              {t("ban.duration")}
              <select value={banSeconds} onChange={(e) => setBanSeconds(e.target.value)}>
                <option value="0">{t("ban.durationPermanent")}</option>
                <option value="3600">{t("ban.duration1h")}</option>
                <option value="86400">{t("ban.duration1d")}</option>
                <option value="604800">{t("ban.duration1w")}</option>
              </select>
            </label>
            <input
              value={banReason}
              onChange={(e) => setBanReason(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleConfirmBan();
                if (e.key === "Escape") setBanTarget(null);
              }}
              placeholder={t("ban.reasonPlaceholder")}
            />
            <button onClick={handleConfirmBan}>{t("ban.confirm")}</button>
            <button onClick={() => setBanTarget(null)}>{t("ban.cancel")}</button>
          </div>
        </div>
      )}

      {pokes.map((poke) => (
        <div key={poke.id} className="ts-poke-notice">
          <span>
            👉 <strong>{poke.from}</strong> {t("poke.pokedYou")}{poke.message ? `: ${poke.message}` : ""}
          </span>
          <button onClick={() => setPokes((prev) => prev.filter((p) => p.id !== poke.id))} title={t("poke.dismiss")}>
            ✕
          </button>
        </div>
      ))}

      {clientContextMenu && (
        <div
          ref={clientContextMenuRef}
          className="ts-context-menu"
          style={{ top: clientContextMenu.y, left: clientContextMenu.x }}
        >
          <div className="ts-context-menu-title">{clientContextMenu.clientName}</div>
          <button
            className="ts-menu-item"
            disabled={clientContextMenu.isSelf}
            onClick={() => {
              handleOpenPrivateChat(clientContextMenu.clientId, clientContextMenu.clientName);
              setClientContextMenu(null);
            }}
          >
            <span className="ts-menu-item-icon">💬</span>
            <span className="ts-menu-item-label">{t("clientContext.privateChat")}</span>
          </button>
          <button
            className="ts-menu-item"
            disabled={clientContextMenu.isSelf}
            onClick={() => {
              handlePokeClient(clientContextMenu.clientId, clientContextMenu.clientName);
              setClientContextMenu(null);
            }}
          >
            <span className="ts-menu-item-icon">👉</span>
            <span className="ts-menu-item-label">{t("clientContext.poke")}</span>
          </button>
          <button
            className="ts-menu-item"
            onClick={() => {
              void navigator.clipboard?.writeText(clientContextMenu.clientName);
              setClientContextMenu(null);
            }}
          >
            <span className="ts-menu-item-icon">📋</span>
            <span className="ts-menu-item-label">{t("clientContext.copyName")}</span>
          </button>
          <button
            className="ts-menu-item"
            onClick={() => {
              handleShowClientConnectionInfo(clientContextMenu.clientId, clientContextMenu.clientName);
              setClientContextMenu(null);
            }}
          >
            <span className="ts-menu-item-icon">🔌</span>
            <span className="ts-menu-item-label">{t("clientContext.connectionInfo")}</span>
          </button>
          {!clientContextMenu.isSelf && (
            <button
              className="ts-menu-item"
              onClick={() => {
                toggleWhisperClient(clientContextMenu.clientId);
                setClientContextMenu(null);
              }}
            >
              <span className="ts-menu-item-icon">🤫</span>
              <span className="ts-menu-item-label">
                {whisperClientIds.has(clientContextMenu.clientId)
                  ? t("clientContext.removeWhisperTarget")
                  : t("clientContext.addWhisperTarget")}
              </span>
            </button>
          )}
          <div className="ts-menu-separator" />
          <button
            className="ts-menu-item"
            onClick={() => {
              handleShowChannelGroupAssign(clientContextMenu.clientId, clientContextMenu.clientName);
              setClientContextMenu(null);
            }}
          >
            <span className="ts-menu-item-icon">🏷️</span>
            <span className="ts-menu-item-label">{t("clientContext.assignChannelGroup")}</span>
          </button>
          <button
            className="ts-menu-item"
            onClick={() => {
              handleShowServerGroupAssign(clientContextMenu.clientId, clientContextMenu.clientName);
              setClientContextMenu(null);
            }}
          >
            <span className="ts-menu-item-icon">🎖️</span>
            <span className="ts-menu-item-label">{t("clientContext.assignServerGroup")}</span>
          </button>
          {!clientContextMenu.isSelf && (
            <>
              <div className="ts-menu-separator" />
              <button
                className="ts-menu-item"
                onClick={() => {
                  setKickTarget({
                    id: clientContextMenu.clientId,
                    name: clientContextMenu.clientName,
                    scope: "channel",
                  });
                  setKickReason("");
                  setClientContextMenu(null);
                }}
              >
                <span className="ts-menu-item-icon">🚪</span>
                <span className="ts-menu-item-label">{t("clientContext.kickChannel")}</span>
              </button>
              <button
                className="ts-menu-item"
                onClick={() => {
                  setKickTarget({
                    id: clientContextMenu.clientId,
                    name: clientContextMenu.clientName,
                    scope: "server",
                  });
                  setKickReason("");
                  setClientContextMenu(null);
                }}
              >
                <span className="ts-menu-item-icon">👢</span>
                <span className="ts-menu-item-label">{t("clientContext.kick")}</span>
              </button>
              <button
                className="ts-menu-item"
                onClick={() => {
                  setBanTarget({ id: clientContextMenu.clientId, name: clientContextMenu.clientName });
                  setBanReason("");
                  setBanSeconds("0");
                  setClientContextMenu(null);
                }}
              >
                <span className="ts-menu-item-icon">🚫</span>
                <span className="ts-menu-item-label">{t("clientContext.ban")}</span>
              </button>
            </>
          )}
        </div>
      )}

      {serverContextMenu && (
        <div
          ref={serverContextMenuRef}
          className="ts-context-menu"
          style={{ top: serverContextMenu.y, left: serverContextMenu.x }}
        >
          <div className="ts-context-menu-title">{serverName || host}</div>
          <button
            className="ts-menu-item"
            onClick={() => {
              handleShowServerConnectionInfo();
              setServerContextMenu(null);
            }}
          >
            <span className="ts-menu-item-icon">🔌</span>
            <span className="ts-menu-item-label">{t("serverContext.connectionInfo")}</span>
          </button>
          <button
            className="ts-menu-item"
            onClick={() => {
              setServerEditOpen(true);
              setServerContextMenu(null);
            }}
          >
            <span className="ts-menu-item-icon">✏️</span>
            <span className="ts-menu-item-label">{t("serverEdit.title")}</span>
          </button>
          <button
            className="ts-menu-item"
            onClick={() => {
              void navigator.clipboard?.writeText(host);
              setServerContextMenu(null);
            }}
          >
            <span className="ts-menu-item-icon">📋</span>
            <span className="ts-menu-item-label">{t("serverContext.copyAddress")}</span>
          </button>
          <button
            className="ts-menu-item"
            onClick={() => {
              openAddFavorite();
              setServerContextMenu(null);
            }}
          >
            <span className="ts-menu-item-icon">⭐</span>
            <span className="ts-menu-item-label">{t("serverContext.addFavorite")}</span>
          </button>
          <div className="ts-menu-separator" />
          <button
            className="ts-menu-item"
            onClick={() => {
              handleShowServerIcons();
              setServerContextMenu(null);
            }}
          >
            <span className="ts-menu-item-icon">🖼️</span>
            <span className="ts-menu-item-label">{t("serverContext.icons")}</span>
          </button>
          <button
            className="ts-menu-item"
            onClick={() => {
              handleShowServerProtocolLog();
              setServerContextMenu(null);
            }}
          >
            <span className="ts-menu-item-icon">📜</span>
            <span className="ts-menu-item-label">{t("menu.extras.serverLog")}</span>
          </button>
          <button
            className="ts-menu-item"
            onClick={() => {
              handleShowBanList();
              setServerContextMenu(null);
            }}
          >
            <span className="ts-menu-item-icon">🚫</span>
            <span className="ts-menu-item-label">{t("menu.extras.banList")}</span>
          </button>
          <button
            className="ts-menu-item"
            onClick={() => {
              handleShowComplainList();
              setServerContextMenu(null);
            }}
          >
            <span className="ts-menu-item-icon">⚠️</span>
            <span className="ts-menu-item-label">{t("menu.extras.complaintList")}</span>
          </button>
          <div className="ts-menu-separator" />
          <button
            className="ts-menu-item"
            onClick={() => {
              handleDisconnect();
              setServerContextMenu(null);
            }}
          >
            <span className="ts-menu-item-icon">❌</span>
            <span className="ts-menu-item-label">{t("serverContext.disconnect")}</span>
          </button>
        </div>
      )}

      {channelContextMenu && (
        <div
          ref={channelContextMenuRef}
          className="ts-context-menu"
          style={{ top: channelContextMenu.y, left: channelContextMenu.x }}
        >
          <div className="ts-context-menu-title">{channelContextMenu.channelName}</div>
          <button
            className="ts-menu-item"
            onClick={() => {
              handleShowFileBrowser(channelContextMenu.channelId, channelContextMenu.channelName);
              setChannelContextMenu(null);
            }}
          >
            <span className="ts-menu-item-icon">📁</span>
            <span className="ts-menu-item-label">{t("channelContext.files")}</span>
          </button>
        </div>
      )}

      <div className="ts-body">
        <div className="ts-upper" style={{ height: upperHeight }}>
          <div className="ts-tree-panel" style={{ width: treeWidth }}>
            {connected ? (
              <>
                <div
                  className={`ts-row ts-server-row${selected?.type === "server" ? " ts-row-selected" : ""}`}
                  onClick={() => handleSelectItem({ type: "server" })}
                  onContextMenu={handleServerContextMenu}
                >
                  <ServerIcon />
                  <span>{serverName || host}</span>
                </div>
                <ChannelTree
                  channels={channels}
                  clients={clients}
                  parent={0}
                  ownClientId={ownClient?.id ?? null}
                  talkers={displayTalkers}
                  serverGroups={serverGroups}
                  groupIconImages={serverIconImages}
                  selected={selected}
                  onSelectItem={handleSelectItem}
                  onSwitchChannel={handleSwitchChannel}
                  onOpenPrivateChat={handleOpenPrivateChat}
                  onPokeClient={handlePokeClient}
                  onClientContextMenu={handleClientContextMenu}
                  onChannelContextMenu={handleChannelContextMenu}
                />
              </>
            ) : (
              <div className="ts-tree-empty">{t("tree.notConnected")}</div>
            )}
          </div>

          <div className="ts-resize-handle-vertical" onMouseDown={startTreeResize} />

          <div className="ts-side-panel">
            {connected && serverBannerUrl && (
              <div className="ts-banner-panel">
                <img className="ts-server-banner" src={serverBannerUrl} alt="" />
              </div>
            )}
            {connected && (
              <InfoPanel
                selected={selected}
                host={host}
                serverName={serverName}
                serverMaxClients={serverMaxClients}
                serverVersion={serverVersion}
                serverLicense={serverLicense}
                totalClientCount={clients.length}
                channels={channels}
                clients={clients}
                onShowServerConnectionInfo={handleShowServerConnectionInfo}
                onEditServer={() => setServerEditOpen(true)}
              />
            )}
          </div>
        </div>

        <div className="ts-resize-handle-horizontal" onMouseDown={startUpperResize} />

        <div className="ts-chat-panel">
          <div className="ts-chat-messages">
            {activeTab === "channel"
              ? chat.map((entry, i) => (
                  <div
                    key={i}
                    className={`ts-chat-line${entry.from === ownClient?.name ? " ts-chat-line-self" : ""}`}
                  >
                    <span className="ts-chat-from">{entry.from}:</span>{" "}
                    <span className="ts-chat-bubble">{entry.message}</span>
                  </div>
                ))
              : activeTab === "server"
                ? serverChat.map((entry, i) =>
                    entry.isLog ? (
                      <div key={i} className="ts-chat-line ts-chat-line-log">
                        <span>{entry.message}</span>
                      </div>
                    ) : (
                      <div
                        key={i}
                        className={`ts-chat-line${entry.from === ownClient?.name ? " ts-chat-line-self" : ""}`}
                      >
                        <span className="ts-chat-from">{entry.from}:</span>{" "}
                        <span className="ts-chat-bubble">{entry.message}</span>
                      </div>
                    )
                  )
                : pmThreads[activeTab]?.messages.map((entry, i) => (
                    <div key={i} className={`ts-chat-line${entry.fromSelf ? " ts-chat-line-self" : ""}`}>
                      <span className="ts-chat-from">
                        {entry.fromSelf ? t("chat.you") : pmThreads[activeTab].partnerName}:
                      </span>{" "}
                      <span className="ts-chat-bubble">{entry.message}</span>
                    </div>
                  ))}
            <div ref={chatEndRef} />
          </div>
          <div className="ts-chat-tabs">
            <button
              className={`ts-chat-tab${activeTab === "server" ? " ts-chat-tab-active" : ""}`}
              onClick={() => setActiveTab("server")}
            >
              {t("chat.server")}
            </button>
            <button
              className={`ts-chat-tab${activeTab === "channel" ? " ts-chat-tab-active" : ""}`}
              onClick={() => setActiveTab("channel")}
            >
              {t("chat.channel")}
            </button>
            {Object.values(pmThreads).map((thread) => (
              <button
                key={thread.partnerId}
                className={`ts-chat-tab${activeTab === thread.partnerId ? " ts-chat-tab-active" : ""}${
                  thread.unread ? " ts-chat-tab-unread" : ""
                }`}
                onClick={() => setActiveTab(thread.partnerId)}
              >
                {thread.partnerName}
                <span
                  className="ts-chat-tab-close"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleClosePrivateChat(thread.partnerId);
                  }}
                >
                  ×
                </span>
              </button>
            ))}
          </div>
          <div className="ts-chat-input-row">
            <textarea
              ref={chatInputRef}
              rows={1}
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSendChat();
                }
              }}
              disabled={!connected}
              placeholder={
                !connected
                  ? t("chat.notConnected")
                  : activeTab === "channel"
                    ? t("chat.messageChannel")
                    : activeTab === "server"
                      ? t("chat.messageServer")
                      : t("chat.messagePartner", { name: pmThreads[activeTab]?.partnerName ?? "" })
              }
            />
            <button onClick={handleSendChat} disabled={!connected}>
              {t("chat.send")}
            </button>
          </div>
        </div>
      </div>

      <div className="ts-log">
        {log.map((entry, i) => (
          <div key={i} className={entry.kind === "error" ? "ts-log-error" : "ts-log-info"}>
            {entry.text}
          </div>
        ))}
      </div>
    </div>
  );
}

function App() {
  return (
    <LanguageProvider>
      <AppInner />
    </LanguageProvider>
  );
}

export default App;
