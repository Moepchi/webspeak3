// Standalone frontend demo: no gateway, no real TeamSpeak server. Everything
// below simulates the WebSocket protocol the real gateway speaks (see
// gateway/src/index.ts) so App.tsx doesn't need to know it isn't talking to
// a real backend. Only enabled in the GitHub Pages build (VITE_DEMO_MODE=true)
// so the normal Docker image is completely unaffected.
export const DEMO_MODE = import.meta.env.VITE_DEMO_MODE === "true";

export const DEMO_HOST = "demo.webspeak3.example";

interface DemoChannel {
  id: number;
  parent: number;
  order: number;
  name: string;
  topic: string;
  codec: string;
  maxClients: number | null;
  hasPassword: boolean;
}

interface DemoClient {
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

const DEMO_CHANNELS: DemoChannel[] = [
  { id: 1, parent: 0, order: 0, name: "Lobby", topic: "Welcome to the WebSpeak3 demo!", codec: "Opus Voice", maxClients: null, hasPassword: false },
  { id: 2, parent: 0, order: 1, name: "Gaming", topic: "", codec: "Opus Voice", maxClients: 10, hasPassword: false },
  { id: 3, parent: 0, order: 2, name: "AFK", topic: "", codec: "Opus Voice", maxClients: null, hasPassword: false },
];

const DEMO_CHANNEL_GROUPS = [
  { id: 1, name: "Channel Admin", iconId: 0 },
  { id: 2, name: "Operator", iconId: 0 },
  { id: 3, name: "Voice", iconId: 0 },
  { id: 4, name: "Guest", iconId: 0 },
];

const DEMO_SERVER_GROUPS = [
  { id: 1, name: "Server Admin", iconId: 0 },
  { id: 2, name: "Moderator", iconId: 0 },
  { id: 3, name: "Trusted", iconId: 0 },
  { id: 4, name: "Guest", iconId: 0 },
];

const DEMO_NPCS: DemoClient[] = [
  { id: 102, channel: 1, name: "Alex", inputMuted: false, outputMuted: false, inputHardwareEnabled: true, away: false, awayMessage: "", isChannelCommander: true, country: "US", uid: "demo-uid-alex", databaseId: 2, channelGroup: 2, serverGroups: [2], hasTalkPower: true },
  { id: 103, channel: 2, name: "Sam", inputMuted: false, outputMuted: false, inputHardwareEnabled: true, away: false, awayMessage: "", isChannelCommander: false, country: "GB", uid: "demo-uid-sam", databaseId: 3, channelGroup: 4, serverGroups: [4], hasTalkPower: true },
  { id: 104, channel: 2, name: "Jordan", inputMuted: true, outputMuted: false, inputHardwareEnabled: true, away: false, awayMessage: "", isChannelCommander: false, country: "CA", uid: "demo-uid-jordan", databaseId: 4, channelGroup: 4, serverGroups: [4], hasTalkPower: true },
  { id: 105, channel: 3, name: "Riley", inputMuted: false, outputMuted: false, inputHardwareEnabled: true, away: true, awayMessage: "brb, grabbing coffee", isChannelCommander: false, country: "DE", uid: "demo-uid-riley", databaseId: 5, channelGroup: 4, serverGroups: [3, 4], hasTalkPower: true },
];

interface DemoFileEntry {
  path: string;
  name: string;
  size: number;
  isFile: boolean;
  timestamp: string;
}

/** Keyed by "<channelId>:<path>" - a tiny in-memory filesystem so the
 *  channel file browser has something real to navigate/mutate in the demo. */
const DEMO_FILES: Record<string, DemoFileEntry[]> = {
  "1:/": [
    { path: "/", name: "readme.txt", size: 182, isFile: true, timestamp: "2024-01-01 12:00:00" },
    { path: "/", name: "Musik", size: 0, isFile: false, timestamp: "2024-01-01 12:00:00" },
  ],
  "1:/Musik": [
    { path: "/Musik", name: "lobby-theme.mp3", size: 4 * 1024 * 1024, isFile: true, timestamp: "2024-01-02 09:30:00" },
  ],
  "2:/": [],
  "3:/": [],
  // Channel 0 is TS3's special server-wide icon repository, not a real channel.
  "0:/": [
    { path: "/", name: "icon_100", size: 68, isFile: true, timestamp: "2024-01-01 12:00:00" },
    { path: "/", name: "icon_200", size: 68, isFile: true, timestamp: "2024-01-01 12:00:00" },
  ],
};

// A tiny 1x1 transparent PNG, reused as the fake image data for every demo icon.
const DEMO_ICON_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function demoFileKey(channelId: number, path: string): string {
  return `${channelId}:${path}`;
}

function demoNowTimestamp(): string {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

interface DemoPermEntry {
  name: string;
  description: string;
  value: number;
  negated: boolean;
  skip: boolean;
}

// A small fake permission catalog (real TS3 servers expose ~500 of these) -
// enough for the permissions editor's "add permission" picker to be usable.
const DEMO_PERMISSION_CATALOG: { id: number; name: string; description: string }[] = [
  { id: 1, name: "b_client_info_view", description: "View own client info" },
  { id: 2, name: "b_client_permissionoverview_view", description: "View permission overview" },
  { id: 3, name: "i_channel_join_power", description: "Power to join channels" },
  { id: 4, name: "i_client_talk_power", description: "Talk power" },
  { id: 5, name: "b_client_use_priority_speaker", description: "Use priority speaker" },
  { id: 6, name: "i_client_max_channel_subscriptions", description: "Max channel subscriptions" },
  { id: 7, name: "b_channel_join_permanent", description: "Join permanent channels" },
  { id: 8, name: "b_client_kick_from_channel", description: "Kick client from channel" },
  { id: 9, name: "b_client_kick_from_server", description: "Kick client from server" },
  { id: 10, name: "b_client_ban_client", description: "Ban client" },
  { id: 11, name: "i_channel_create_modify_power", description: "Power to create/modify channels" },
  { id: 12, name: "b_virtualserver_modify_name", description: "Modify server name" },
  { id: 13, name: "b_ft_file_upload", description: "Upload files" },
  { id: 14, name: "b_ft_file_download", description: "Download files" },
];

// Keyed by "<scope>:<id1>:<id2 ?? ->" - the fake permission set currently
// assigned to one server group / channel group / channel / client /
// channel+client combination.
const DEMO_PERM_LISTS: Record<string, DemoPermEntry[]> = {
  "server:1:-": [
    { name: "b_client_kick_from_server", description: "Kick client from server", value: 1, negated: false, skip: false },
    { name: "b_client_ban_client", description: "Ban client", value: 1, negated: false, skip: false },
  ],
  "server:4:-": [
    { name: "i_channel_join_power", description: "Power to join channels", value: 25, negated: false, skip: false },
  ],
  "channelgroup:1:-": [
    { name: "i_channel_create_modify_power", description: "Power to create/modify channels", value: 75, negated: false, skip: false },
  ],
  "client:1:-": [
    { name: "b_client_info_view", description: "View own client info", value: 1, negated: false, skip: false },
  ],
};

function demoPermKey(scope: string, id1: number, id2?: number): string {
  return `${scope}:${id1}:${id2 ?? "-"}`;
}

const SELF_ID = 101;

/**
 * Drop-in stand-in for a real WebSocket. Implements the subset of the
 * WebSocket interface App.tsx actually uses (onopen/onmessage/onerror/
 * onclose/send/close/readyState), so it can be assigned to the same
 * socketRef without any changes to the event-handling code.
 */
export class DemoSocket {
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  readyState: number = WebSocket.CONNECTING;

  private closed = false;
  private timers: number[] = [];
  private selfChannel = 1;
  private selfChannelGroup = 4;
  private selfServerGroups = new Set<number>([4]);

  constructor() {
    this.after(400, () => {
      this.readyState = WebSocket.OPEN;
      this.onopen?.(new Event("open"));
    });
  }

  send(raw: string) {
    if (this.closed) return;
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    this.handle(msg);
  }

  close() {
    if (this.closed) return;
    // Mirrors the real gateway: a "disconnected" event arrives before the
    // socket itself finishes closing (see gateway's disconnected event vs.
    // the client-initiated WebSocket close in handleDisconnect).
    this.emit({ type: "disconnected", reason: "client requested" });
    this.closed = true;
    this.readyState = WebSocket.CLOSED;
    this.timers.forEach((id) => window.clearTimeout(id));
    this.timers = [];
    this.onclose?.({} as CloseEvent);
  }

  private after(ms: number, fn: () => void) {
    const id = window.setTimeout(() => {
      if (this.closed) return;
      fn();
    }, ms);
    this.timers.push(id);
  }

  private emit(data: unknown) {
    if (this.closed) return;
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent);
  }

  private handle(msg: any) {
    switch (msg.type) {
      case "connect": {
        const nickname = String(msg.nickname || "Guest").trim() || "Guest";
        this.after(900, () => {
          this.emit({
            type: "connected",
            serverName: "WebSpeak3 Demo Server",
            serverMaxClients: 32,
            serverVersion: "3.13.7 [Build: demo]",
            serverLicense: "Demo License",
            serverLicenseId: 2,
            serverBannerUrl: null,
            welcomeMessage: "This is a simulated demo - no real TeamSpeak server is involved. Connect with any name/address you like.",
          });
          this.after(150, () => this.sendChannels(nickname));
          this.scriptServerLog(nickname);
        });
        break;
      }
      case "switchChannel": {
        const fromChannel = this.channelName(this.selfChannel);
        this.selfChannel = msg.channelId;
        const toChannel = this.channelName(this.selfChannel);
        this.emit({
          type: "serverLog",
          kind: "clientChannelSwitch",
          client: this.lastNickname,
          fromChannel,
          toChannel,
        });
        this.after(120, () => this.sendChannels(this.lastNickname));
        break;
      }
      case "sendChatMessage":
        this.after(80, () => this.emit({ type: "chatMessage", from: this.lastNickname, message: msg.message }));
        break;
      case "sendServerMessage":
        this.after(80, () => this.emit({ type: "serverMessage", from: this.lastNickname, message: msg.message }));
        break;
      case "sendPrivateMessage": {
        const partner = DEMO_NPCS.find((c) => c.id === msg.clientId);
        this.after(80, () =>
          this.emit({
            type: "privateMessage",
            partnerId: msg.clientId,
            partnerName: partner?.name ?? "Unknown",
            message: msg.message,
            fromSelf: true,
          })
        );
        break;
      }
      case "sendPoke": {
        const partner = DEMO_NPCS.find((c) => c.id === msg.clientId);
        this.after(400, () =>
          this.emit({ type: "poke", from: partner?.name ?? "Someone", message: "(demo poke - no reply expected)" })
        );
        break;
      }
      case "getClientConnectionInfo": {
        this.after(400, () =>
          this.emit({
            type: "clientConnectionInfo",
            clientId: msg.clientId,
            pingMs: 12.4,
            connectedSecs: 217,
            ip: msg.clientId === SELF_ID ? "127.0.0.1" : null,
            packetsSent: 4213,
            bytesSent: 512_340,
            packetsReceived: 3987,
            bytesReceived: 498_120,
            packetLossPercent: 0,
          })
        );
        break;
      }
      case "getServerConnectionInfo": {
        this.after(400, () =>
          this.emit({
            type: "serverConnectionInfo",
            pingMs: 8.1,
            connectedSecs: 217,
            packetLossPercent: 0,
            packetsSentTotal: 21_004,
            bytesSentTotal: 2_411_000,
            packetsReceivedTotal: 19_872,
            bytesReceivedTotal: 2_198_500,
            bandwidthSentLastSecond: 4200,
            bandwidthReceivedLastSecond: 3900,
          })
        );
        break;
      }
      case "getServerLog": {
        this.after(400, () =>
          this.emit({
            type: "serverProtocolLog",
            lines: [
              "2026-08-05 10:12:03.421128|INFO    |VirtualServerBase|1   |connect to server successful, connection accepted",
              "2026-08-05 10:12:04.001912|INFO    |VirtualServerBase|1   |client 'Guest'(id:101) connected",
              "2026-08-05 10:14:19.552031|INFO    |VirtualServerBase|1   |client 'Sam'(id:103) connected",
              "2026-08-05 10:15:02.884120|INFO    |VirtualServerBase|1   |client 'Jordan'(id:104) switched channel",
            ],
          })
        );
        break;
      }
      case "getBanList": {
        this.after(400, () =>
          this.emit({
            type: "banList",
            entries: [
              {
                banId: 1,
                ip: "203.0.113.42",
                name: "TrollUser",
                uid: "demo-uid-troll",
                lastNickname: "TrollUser",
                created: "2026-07-28 14:02:11",
                durationSecs: 0,
                invokerName: "Alex",
                reason: "Spamming the server chat",
                enforcements: 0,
              },
              {
                banId: 2,
                ip: "198.51.100.7",
                name: "",
                uid: "demo-uid-annoying",
                lastNickname: "AnnoyingGuest",
                created: "2026-08-01 09:44:53",
                durationSecs: 3600,
                invokerName: "Sam",
                reason: "Repeated channel spam",
                enforcements: 1,
              },
            ],
          })
        );
        break;
      }
      case "deleteBan":
      case "deleteAllBans":
        // No observable effect - the frontend already optimistically removes
        // the deleted row(s) from its own state.
        break;
      case "getComplainList": {
        this.after(400, () =>
          this.emit({
            type: "complainList",
            entries: [
              {
                targetClientDbId: 104,
                targetName: "Jordan",
                fromClientDbId: 103,
                fromName: "Sam",
                message: "Kept talking over everyone in voice chat.",
                timestamp: "2026-08-02 18:21:07",
              },
            ],
          })
        );
        break;
      }
      case "deleteComplaint":
      case "deleteAllComplaintsFor":
        break;
      case "getOfflineMessageList": {
        this.after(400, () =>
          this.emit({
            type: "offlineMessageList",
            entries: [
              {
                messageId: 1,
                clientUid: "demo-uid-sam",
                subject: "Missed you online",
                timestamp: "2026-08-03 20:11:44",
                isRead: false,
              },
            ],
          })
        );
        break;
      }
      case "getOfflineMessage": {
        this.after(300, () =>
          this.emit({
            type: "offlineMessage",
            messageId: msg.messageId,
            clientUid: "demo-uid-sam",
            subject: "Missed you online",
            message: "Hey, we were on last night in the Gaming channel - join us next time!",
            timestamp: "2026-08-03 20:11:44",
          })
        );
        break;
      }
      case "sendOfflineMessage":
      case "deleteOfflineMessage":
      case "markOfflineMessageRead":
        // No observable effect - the frontend already optimistically updates
        // its own state for delete/read, and there's no NPC to reply to a send.
        break;
      case "getChannelGroupList":
        this.after(300, () => this.emit({ type: "channelGroupList", entries: DEMO_CHANNEL_GROUPS }));
        break;
      case "getServerGroupList":
        this.after(300, () => this.emit({ type: "serverGroupList", entries: DEMO_SERVER_GROUPS }));
        break;
      case "setChannelGroup": {
        const npc = DEMO_NPCS.find((c) => c.databaseId === msg.clientDbId);
        if (npc) npc.channelGroup = msg.channelGroupId;
        else if (msg.clientDbId === 1) this.selfChannelGroup = msg.channelGroupId;
        this.after(200, () => this.sendChannels(this.lastNickname));
        break;
      }
      case "addServerGroup": {
        const npc = DEMO_NPCS.find((c) => c.databaseId === msg.clientDbId);
        if (npc) {
          if (!npc.serverGroups.includes(msg.serverGroupId)) npc.serverGroups.push(msg.serverGroupId);
        } else if (msg.clientDbId === 1) {
          this.selfServerGroups.add(msg.serverGroupId);
        }
        this.after(200, () => this.sendChannels(this.lastNickname));
        break;
      }
      case "removeServerGroup": {
        const npc = DEMO_NPCS.find((c) => c.databaseId === msg.clientDbId);
        if (npc) {
          npc.serverGroups = npc.serverGroups.filter((g) => g !== msg.serverGroupId);
        } else if (msg.clientDbId === 1) {
          this.selfServerGroups.delete(msg.serverGroupId);
        }
        this.after(200, () => this.sendChannels(this.lastNickname));
        break;
      }
      case "serverQueryLogin":
        // No observable effect - the demo has no real ServerQuery backend to
        // authenticate against.
        break;
      case "getPermissionOverview": {
        this.after(400, () =>
          this.emit({
            type: "permissionOverview",
            entries: [
              { name: "b_client_info_view", description: "View own client info", value: 1, negated: false, skip: false },
              { name: "b_client_permissionoverview_view", description: "View permission overview", value: 1, negated: false, skip: false },
              { name: "i_channel_join_power", description: "Power to join channels", value: 25, negated: false, skip: false },
              { name: "i_client_talk_power", description: "Talk power", value: 25, negated: false, skip: false },
              { name: "b_client_use_priority_speaker", description: "Use priority speaker", value: 0, negated: true, skip: false },
              { name: "i_client_max_channel_subscriptions", description: "Max channel subscriptions", value: -1, negated: false, skip: false },
              { name: "b_channel_join_permanent", description: "Join permanent channels", value: 1, negated: false, skip: false },
            ],
          })
        );
        break;
      }
      case "getPermissionCatalog": {
        this.after(300, () => this.emit({ type: "permissionCatalog", entries: DEMO_PERMISSION_CATALOG }));
        break;
      }
      case "getPermList": {
        const key = demoPermKey(msg.scope, msg.id1, msg.id2);
        this.after(300, () =>
          this.emit({ type: "permList", scope: msg.scope, id1: msg.id1, id2: msg.id2 ?? null, entries: DEMO_PERM_LISTS[key] ?? [] })
        );
        break;
      }
      case "addPermission": {
        const [id1, id2] = msg.ids as number[];
        const key = demoPermKey(msg.scope, id1, id2);
        const catalogEntry = DEMO_PERMISSION_CATALOG.find((p) => p.id === msg.permId);
        const name = catalogEntry?.name ?? `#${msg.permId}`;
        const description = catalogEntry?.description ?? "";
        const list = (DEMO_PERM_LISTS[key] ?? []).filter((e) => e.name !== name);
        list.push({ name, description, value: msg.value, negated: !!msg.negated, skip: !!msg.skip });
        DEMO_PERM_LISTS[key] = list;
        break;
      }
      case "removePermission": {
        const [id1, id2] = msg.ids as number[];
        const key = demoPermKey(msg.scope, id1, id2);
        const catalogEntry = DEMO_PERMISSION_CATALOG.find((p) => p.id === msg.permId);
        const name = catalogEntry?.name ?? `#${msg.permId}`;
        if (DEMO_PERM_LISTS[key]) DEMO_PERM_LISTS[key] = DEMO_PERM_LISTS[key].filter((e) => e.name !== name);
        break;
      }
      case "getFileList": {
        const key = demoFileKey(msg.channelId, msg.path);
        this.after(300, () =>
          this.emit({ type: "fileList", cid: msg.channelId, path: msg.path, entries: DEMO_FILES[key] ?? [] })
        );
        break;
      }
      case "createDirectory": {
        const dir = msg.dirname as string;
        const parent = dir.slice(0, dir.lastIndexOf("/")) || "/";
        const name = dir.slice(dir.lastIndexOf("/") + 1);
        const parentKey = demoFileKey(msg.channelId, parent);
        DEMO_FILES[parentKey] = (DEMO_FILES[parentKey] ?? []).filter((e) => e.name !== name);
        DEMO_FILES[parentKey].push({ path: parent, name, size: 0, isFile: false, timestamp: demoNowTimestamp() });
        DEMO_FILES[demoFileKey(msg.channelId, dir)] = [];
        break;
      }
      case "deleteFile": {
        const full = msg.name as string;
        const parent = full.slice(0, full.lastIndexOf("/")) || "/";
        const name = full.slice(full.lastIndexOf("/") + 1);
        const parentKey = demoFileKey(msg.channelId, parent);
        if (DEMO_FILES[parentKey]) DEMO_FILES[parentKey] = DEMO_FILES[parentKey].filter((e) => e.name !== name);
        break;
      }
      case "renameFile": {
        const oldFull = msg.oldName as string;
        const newFull = msg.newName as string;
        const parent = oldFull.slice(0, oldFull.lastIndexOf("/")) || "/";
        const oldName = oldFull.slice(oldFull.lastIndexOf("/") + 1);
        const newName = newFull.slice(newFull.lastIndexOf("/") + 1);
        const entry = DEMO_FILES[demoFileKey(msg.channelId, parent)]?.find((e) => e.name === oldName);
        if (entry) entry.name = newName;
        break;
      }
      case "downloadFile": {
        const full = msg.path as string;
        const name = full.slice(full.lastIndexOf("/") + 1);
        const data =
          msg.channelId === 0
            ? DEMO_ICON_PNG_BASE64
            : btoa(`This is a demo file. There is no real content behind "${name}" in WebSpeak3's demo mode.`);
        this.after(400, () => this.emit({ type: "fileDownloadData", cid: msg.channelId, path: full, data }));
        break;
      }
      case "uploadFile": {
        const full = msg.path as string;
        const parent = full.slice(0, full.lastIndexOf("/")) || "/";
        const name = full.slice(full.lastIndexOf("/") + 1);
        const parentKey = demoFileKey(msg.channelId, parent);
        const sizeBytes = Math.floor(((msg.dataBase64 as string).length * 3) / 4);
        DEMO_FILES[parentKey] = (DEMO_FILES[parentKey] ?? []).filter((e) => e.name !== name);
        DEMO_FILES[parentKey].push({ path: parent, name, size: sizeBytes, isFile: true, timestamp: demoNowTimestamp() });
        this.after(400, () => this.emit({ type: "fileUploadDone", cid: msg.channelId, path: full }));
        break;
      }
      // "disconnect" is intentionally unhandled here: handleDisconnect() in
      // App.tsx always calls socket.close() right after sending it, and
      // close() already emits the "disconnected" event below.
      // setAway, setInputMuted, setOutputMuted, sendAudio: no observable effect
      // in a simulated single-user session, intentionally no-ops.
      default:
        break;
    }
  }

  private lastNickname = "Guest";

  private channelName(id: number): string {
    return DEMO_CHANNELS.find((c) => c.id === id)?.name ?? "";
  }

  /** A short, scripted burst of Server-tab log lines so the feature is visible
   *  in the demo without needing a second real user to trigger them. */
  private scriptServerLog(nickname: string) {
    this.after(2500, () =>
      this.emit({ type: "serverLog", kind: "clientJoin", client: "Sam", channel: this.channelName(2) })
    );
    this.after(5000, () =>
      this.emit({
        type: "serverLog",
        kind: "clientChannelSwitch",
        client: "Jordan",
        fromChannel: this.channelName(2),
        toChannel: this.channelName(1),
      })
    );
    this.after(7500, () =>
      this.emit({
        type: "serverLog",
        kind: "clientChannelGroupAssigned",
        client: nickname,
        group: "Guest",
      })
    );
  }

  private sendChannels(nickname: string) {
    this.lastNickname = nickname;
    const self: DemoClient = {
      id: SELF_ID,
      channel: this.selfChannel,
      name: nickname,
      inputMuted: false,
      outputMuted: false,
      inputHardwareEnabled: true,
      away: false,
      awayMessage: "",
      isChannelCommander: false,
      country: "",
      uid: "demo-uid-self",
      databaseId: 1,
      channelGroup: this.selfChannelGroup,
      serverGroups: [...this.selfServerGroups],
      hasTalkPower: true,
    };
    this.emit({
      type: "channels",
      channels: DEMO_CHANNELS,
      clients: [self, ...DEMO_NPCS],
      ownClientId: SELF_ID,
      serverMaxClients: 32,
      serverClientsOnline: 1 + DEMO_NPCS.length,
      serverChannelsOnline: DEMO_CHANNELS.length,
    });
  }
}
