/**
 * Multi-join session bookkeeping. The active tab keeps its UI in React state
 * (App.tsx); inactive tabs park a snapshot here and keep their WebSocket alive.
 * Audio is intentionally active-tab-only (see README / known limits).
 */

export type ConnectionSessionId = string;

export type SelectedItem =
  | { type: "server" }
  | { type: "channel"; id: number }
  | { type: "client"; id: number };

export type ChatEntry = { from: string; message: string; isLog?: boolean };
export type PmMessage = { fromSelf: boolean; message: string };
export type PmThread = {
  partnerId: number;
  partnerName: string;
  messages: PmMessage[];
  unread: boolean;
};
export type ActiveChatTab = "channel" | "server" | number;
export type PokeNotice = { id: number; from: string; message: string };
export type LogEntry = { text: string; kind: "info" | "error" };

export type ChannelInfo = {
  id: number;
  parent: number;
  order: number;
  name: string;
  topic: string;
  codec: string;
  maxClients: number | null;
  hasPassword: boolean;
};

export type ClientInfo = {
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
};

export type WhisperLogEntry = {
  id: number;
  timestamp: number;
  description: string;
};

/** Snapshot of per-connection UI state for a parked (inactive) tab. */
export type ParkedSessionState = {
  host: string;
  nickname: string;
  connected: boolean;
  connecting: boolean;
  connectError: string | null;
  channels: ChannelInfo[];
  clients: ClientInfo[];
  ownClientId: number | null;
  serverName: string;
  serverMaxClients: number;
  serverClientsOnline: number;
  serverChannelsOnline: number;
  serverVersion: string;
  serverLicense: string;
  serverLicenseId: number;
  serverBannerUrl: string;
  serverWelcomeMessage: string;
  selected: SelectedItem | null;
  chat: ChatEntry[];
  serverChat: ChatEntry[];
  pmThreads: Record<number, PmThread>;
  pokes: PokeNotice[];
  chatTab: ActiveChatTab;
  talkers: number[];
  whisperChannelIds: number[];
  whisperClientIds: number[];
  whisperLog: WhisperLogEntry[];
  log: LogEntry[];
  hasConnected: boolean;
  previousClients: ClientInfo[] | null;
};

export type SessionTabInfo = {
  id: ConnectionSessionId;
  label: string;
  connected: boolean;
  connecting: boolean;
};

export type SessionSocket = WebSocket | { close: () => void; readyState: number; send: (data: string) => void };

export type SessionRecord = {
  id: ConnectionSessionId;
  socket: SessionSocket | null;
  /** null while this session is the active React UI. */
  parked: ParkedSessionState | null;
};

export function emptyParkedState(partial?: Partial<ParkedSessionState>): ParkedSessionState {
  return {
    host: "",
    nickname: "",
    connected: false,
    connecting: false,
    connectError: null,
    channels: [],
    clients: [],
    ownClientId: null,
    serverName: "",
    serverMaxClients: 0,
    serverClientsOnline: 0,
    serverChannelsOnline: 0,
    serverVersion: "",
    serverLicense: "",
    serverLicenseId: 0,
    serverBannerUrl: "",
    serverWelcomeMessage: "",
    selected: null,
    chat: [],
    serverChat: [],
    pmThreads: {},
    pokes: [],
    chatTab: "channel",
    talkers: [],
    whisperChannelIds: [],
    whisperClientIds: [],
    whisperLog: [],
    log: [],
    hasConnected: false,
    previousClients: null,
    ...partial,
  };
}

export function sessionLabel(state: Pick<ParkedSessionState, "serverName" | "host">): string {
  const name = state.serverName.trim() || state.host.trim();
  return name || "…";
}

/** Apply a gateway event to a parked session. Returns whether the tab label may have changed. */
export function applyParkedGatewayEvent(
  state: ParkedSessionState,
  data: { type: string; [key: string]: unknown },
  opts: { connectNickname: string; chatTab: ActiveChatTab }
): { state: ParkedSessionState; labelChanged: boolean } {
  let labelChanged = false;
  switch (data.type) {
    case "connected": {
      const serverName = String(data.serverName ?? "");
      labelChanged = serverName !== state.serverName;
      return {
        labelChanged,
        state: {
          ...state,
          connecting: false,
          connectError: null,
          connected: true,
          hasConnected: true,
          serverName,
          serverMaxClients: Number(data.serverMaxClients) || 0,
          serverClientsOnline: 0,
          serverChannelsOnline: 0,
          serverVersion: String(data.serverVersion ?? ""),
          serverLicense: String(data.serverLicense ?? ""),
          serverLicenseId: typeof data.serverLicenseId === "number" ? data.serverLicenseId : 0,
          serverBannerUrl: String(data.serverBannerUrl ?? ""),
          serverWelcomeMessage: String(data.welcomeMessage ?? ""),
          selected: { type: "server" },
          serverChat: [
            ...state.serverChat,
            { from: "Server", message: String(data.welcomeMessage ?? "") },
          ],
          previousClients: null,
        },
      };
    }
    case "channels": {
      const newClients = (data.clients as ClientInfo[]) ?? [];
      const ownClientId =
        typeof data.ownClientId === "number" && data.ownClientId > 0
          ? data.ownClientId
          : state.ownClientId;
      return {
        labelChanged: false,
        state: {
          ...state,
          channels: (data.channels as ChannelInfo[]) ?? state.channels,
          clients: newClients,
          ownClientId,
          serverMaxClients:
            typeof data.serverMaxClients === "number" && data.serverMaxClients > 0
              ? data.serverMaxClients
              : state.serverMaxClients,
          serverClientsOnline:
            typeof data.serverClientsOnline === "number" && data.serverClientsOnline >= 0
              ? data.serverClientsOnline
              : state.serverClientsOnline,
          serverChannelsOnline:
            typeof data.serverChannelsOnline === "number" && data.serverChannelsOnline >= 0
              ? data.serverChannelsOnline
              : state.serverChannelsOnline,
          previousClients: newClients,
        },
      };
    }
    case "chatMessage":
      return {
        labelChanged: false,
        state: {
          ...state,
          chat: [...state.chat, { from: String(data.from), message: String(data.message) }],
        },
      };
    case "serverMessage":
      return {
        labelChanged: false,
        state: {
          ...state,
          serverChat: [
            ...state.serverChat,
            { from: String(data.from), message: String(data.message) },
          ],
        },
      };
    case "privateMessage": {
      const partnerId = Number(data.partnerId);
      const existing = state.pmThreads[partnerId];
      const thread: PmThread = existing ?? {
        partnerId,
        partnerName: String(data.partnerName),
        messages: [],
        unread: false,
      };
      return {
        labelChanged: false,
        state: {
          ...state,
          pmThreads: {
            ...state.pmThreads,
            [partnerId]: {
              ...thread,
              partnerName: String(data.partnerName),
              messages: [
                ...thread.messages,
                { fromSelf: Boolean(data.fromSelf), message: String(data.message) },
              ],
              unread:
                thread.unread || (!data.fromSelf && opts.chatTab !== partnerId),
            },
          },
        },
      };
    }
    case "talkers":
      return {
        labelChanged: false,
        state: {
          ...state,
          talkers: Array.isArray(data.clients) ? (data.clients as number[]) : [],
        },
      };
    case "poke": {
      const id = Date.now() + Math.floor(Math.random() * 1000);
      return {
        labelChanged: false,
        state: {
          ...state,
          pokes: [
            ...state.pokes,
            { id, from: String(data.from), message: String(data.message ?? "") },
          ],
        },
      };
    }
    case "disconnected":
      return {
        labelChanged: true,
        state: {
          ...emptyParkedState({
            host: state.host,
            nickname: state.nickname,
          }),
          connecting: false,
          connected: false,
          hasConnected: false,
          log: [
            ...state.log,
            { text: `Disconnected: ${String(data.reason ?? "")}`, kind: "info" },
          ],
        },
      };
    case "error":
      if (state.hasConnected) {
        return {
          labelChanged: false,
          state: {
            ...state,
            log: [...state.log, { text: String(data.message), kind: "error" }],
          },
        };
      }
      return {
        labelChanged: false,
        state: {
          ...state,
          connecting: false,
          connectError: String(data.message),
        },
      };
    case "audioOut":
      // Background tabs never play audio (active-tab-only shortcut).
      return { state, labelChanged: false };
    default:
      return { state, labelChanged: false };
  }
}
