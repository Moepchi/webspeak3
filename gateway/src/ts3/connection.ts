import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Bridges to the real TeamSpeak client protocol via the `ts-connector` Rust
 * binary (built on top of tsclientlib), since that protocol can't be spoken
 * from Node/the browser directly. This process is spawned per connection and
 * emits newline-delimited JSON events on stdout.
 */

export interface ChannelInfo {
  id: number;
  parent: number;
  order: number;
  name: string;
  topic: string;
  codec: string;
  maxClients: number | null;
  hasPassword: boolean;
}

export interface ClientInfo {
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

export interface GroupEntry {
  id: number;
  name: string;
  iconId: number;
}

export interface PermissionOverviewEntry {
  name: string;
  description: string;
  value: number;
  negated: boolean;
  skip: boolean;
}

export interface PermissionCatalogEntry {
  id: number;
  name: string;
  description: string;
}

export type PermScope = "server" | "channelgroup" | "channel" | "client" | "channelclient";

export interface BanListEntry {
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

export interface ComplainListEntry {
  targetClientDbId: number;
  targetName: string;
  fromClientDbId: number;
  fromName: string;
  message: string;
  timestamp: string;
}

export interface OfflineMessageListEntry {
  messageId: number;
  clientUid: string;
  subject: string;
  timestamp: string;
  isRead: boolean;
}

export interface FileListEntry {
  path: string;
  name: string;
  size: number;
  isFile: boolean;
  timestamp: string;
}

export type ServerLogEntry =
  | { kind: "clientJoin"; client: string; channel: string }
  | { kind: "clientLeave"; client: string }
  | { kind: "clientChannelSwitch"; client: string; fromChannel: string; toChannel: string }
  | { kind: "clientChannelGroupAssigned"; client: string; group: string }
  | { kind: "channelCreated"; channel: string }
  | { kind: "channelDeleted"; channel: string }
  | { kind: "channelEdited"; channel: string }
  | { kind: "serverEdited" }
  | { kind: "permissionError"; action: string };

export type Ts3ConnectionEvent =
  | {
      type: "connected";
      welcomeMessage: string;
      serverName: string;
      serverMaxClients: number;
      serverVersion: string;
      serverLicense: string;
      serverLicenseId: number;
      serverBannerUrl: string;
      identity: string;
    }
  | { type: "channels"; channels: ChannelInfo[]; clients: ClientInfo[]; ownClientId: number; serverMaxClients: number; serverClientsOnline: number; serverChannelsOnline: number }
  | { type: "chatMessage"; from: string; message: string }
  | { type: "serverMessage"; from: string; message: string }
  | { type: "privateMessage"; partnerId: number; partnerName: string; fromSelf: boolean; message: string }
  | { type: "poke"; from: string; message: string }
  | { type: "audioOut"; pcm: string }
  | { type: "talkers"; clients: number[] }
  | { type: "disconnected"; reason: string }
  | { type: "error"; message: string }
  | ({ type: "serverLog" } & ServerLogEntry)
  | {
      type: "clientConnectionInfo";
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
  | {
      type: "serverConnectionInfo";
      pingMs: number;
      connectedSecs: number;
      packetLossPercent: number;
      packetsSentTotal: number;
      bytesSentTotal: number;
      packetsReceivedTotal: number;
      bytesReceivedTotal: number;
      bandwidthSentLastSecond: number;
      bandwidthReceivedLastSecond: number;
      bandwidthSentLastMinute: number;
      bandwidthReceivedLastMinute: number;
      filetransferBandwidthSent: number;
      filetransferBandwidthReceived: number;
      filetransferBytesSent: number;
      filetransferBytesReceived: number;
    }
  | { type: "serverProtocolLog"; lines: string[] }
  | { type: "banList"; entries: BanListEntry[] }
  | { type: "complainList"; entries: ComplainListEntry[] }
  | { type: "offlineMessageList"; entries: OfflineMessageListEntry[] }
  | {
      type: "offlineMessage";
      messageId: number;
      clientUid: string;
      subject: string;
      message: string;
      timestamp: string;
    }
  | { type: "channelGroupList"; entries: GroupEntry[] }
  | { type: "serverGroupList"; entries: GroupEntry[] }
  | { type: "permissionOverview"; entries: PermissionOverviewEntry[] }
  | { type: "fileList"; cid: number; path: string; entries: FileListEntry[] }
  | { type: "fileDownloadData"; cid: number; path: string; data: string }
  | { type: "fileUploadDone"; cid: number; path: string }
  | { type: "permList"; scope: PermScope; id1: number; id2: number | null; entries: PermissionOverviewEntry[] }
  | { type: "permissionCatalog"; entries: PermissionCatalogEntry[] };

export type ServerType = "teamspeak" | "teaspeak" | "auto";

export interface Ts3ConnectOptions {
  host: string;
  nickname: string;
  serverPassword?: string;
  channelPassword?: string;
  defaultChannel?: string;
  /** Previously-issued identity (from a prior "connected" event) to keep
   *  the same client UID across sessions. Omit to get a freshly generated one. */
  identity?: string;
  /** Protocol / server dialect hint for the connector (`auto` when omitted). */
  serverType?: ServerType;
  /** One-time privilege key / token to redeem on connect. */
  privilegeKey?: string;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONNECTOR_BIN =
  process.env.CONNECTOR_BIN ??
  path.resolve(
    __dirname,
    "../../../connector/target/debug",
    process.platform === "win32" ? "ts-connector.exe" : "ts-connector"
  );

export class Ts3Connection {
  private listeners = new Set<(event: Ts3ConnectionEvent) => void>();
  private child?: ChildProcessWithoutNullStreams;

  constructor(private options: Ts3ConnectOptions) {}

  onEvent(listener: (event: Ts3ConnectionEvent) => void): void {
    this.listeners.add(listener);
  }

  private emit(event: Ts3ConnectionEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  async connect(): Promise<void> {
    const args = ["--address", this.options.host, "--nickname", this.options.nickname];
    if (this.options.serverPassword) args.push("--server-password", this.options.serverPassword);
    if (this.options.channelPassword) args.push("--channel-password", this.options.channelPassword);
    if (this.options.defaultChannel) args.push("--default-channel", this.options.defaultChannel);
    if (this.options.identity) args.push("--identity", this.options.identity);
    if (this.options.serverType) args.push("--server-type", this.options.serverType);
    if (this.options.privilegeKey) args.push("--privilege-key", this.options.privilegeKey);
    this.child = spawn(CONNECTOR_BIN, args);

    createInterface({ input: this.child.stdout }).on("line", (line) => {
      try {
        interface RawClientInfo {
          id: number;
          channel: number;
          name: string;
          input_muted: boolean;
          output_muted: boolean;
          input_hardware_enabled: boolean;
          away: boolean;
          away_message: string;
          is_channel_commander: boolean;
          country: string;
          uid: string;
          database_id: number;
          channel_group: number;
          server_groups: number[];
          has_talk_power: boolean;
        }

        interface RawChannelInfo {
          id: number;
          parent: number;
          order: number;
          name: string;
          topic: string;
          codec: string;
          max_clients: number | null;
          has_password: boolean;
        }

        const event = JSON.parse(line) as
          | {
              type: "connected";
              welcome_message: string;
              server_name: string;
              server_max_clients: number;
              server_version: string;
              server_license: string;
              server_license_id?: number;
              server_banner_url: string;
              identity: string;
            }
          | {
              type: "channels";
              channels: RawChannelInfo[];
              clients: RawClientInfo[];
              own_client_id?: number;
              server_max_clients?: number;
              server_clients_online?: number;
              server_channels_online?: number;
            }
          | { type: "chatMessage"; from: string; message: string }
          | { type: "serverMessage"; from: string; message: string }
          | { type: "privateMessage"; partner_id: number; partner_name: string; from_self: boolean; message: string }
          | { type: "poke"; from: string; message: string }
          | { type: "audioOut"; pcm: string }
          | { type: "talkers"; clients: number[] }
          | { type: "disconnected"; reason: string }
          | { type: "error"; message: string }
          | ({ type: "serverLog" } & ServerLogEntry)
          | {
              type: "clientConnectionInfo";
              client_id: number;
              ping_ms: number | null;
              connected_secs: number | null;
              ip: string | null;
              packets_sent: number;
              bytes_sent: number;
              packets_received: number;
              bytes_received: number;
              packet_loss_percent: number;
            }
          | {
              type: "serverConnectionInfo";
              ping_ms: number;
              connected_secs: number;
              packet_loss_percent: number;
              packets_sent_total: number;
              bytes_sent_total: number;
              packets_received_total: number;
              bytes_received_total: number;
              bandwidth_sent_last_second: number;
              bandwidth_received_last_second: number;
              bandwidth_sent_last_minute?: number;
              bandwidth_received_last_minute?: number;
              filetransfer_bandwidth_sent?: number;
              filetransfer_bandwidth_received?: number;
              filetransfer_bytes_sent?: number;
              filetransfer_bytes_received?: number;
            }
          | { type: "serverProtocolLog"; lines: string[] }
          | {
              type: "banList";
              entries: {
                ban_id: number;
                ip: string;
                name: string;
                uid: string;
                last_nickname: string;
                created: string;
                duration_secs: number;
                invoker_name: string;
                reason: string;
                enforcements: number;
              }[];
            }
          | {
              type: "complainList";
              entries: {
                target_client_db_id: number;
                target_name: string;
                from_client_db_id: number;
                from_name: string;
                message: string;
                timestamp: string;
              }[];
            }
          | {
              type: "offlineMessageList";
              entries: {
                message_id: number;
                client_uid: string;
                subject: string;
                timestamp: string;
                is_read: boolean;
              }[];
            }
          | {
              type: "offlineMessage";
              message_id: number;
              client_uid: string;
              subject: string;
              message: string;
              timestamp: string;
            }
          | { type: "channelGroupList"; entries: GroupEntry[] }
          | { type: "serverGroupList"; entries: GroupEntry[] }
          | {
              type: "permissionOverview";
              entries: { name: string; description: string; value: number; negated: boolean; skip: boolean }[];
            }
          | { type: "fileList"; cid: number; path: string; entries: FileListEntry[] }
          | { type: "fileDownloadData"; cid: number; path: string; data: string }
          | { type: "fileUploadDone"; cid: number; path: string }
          | { type: "permList"; scope: PermScope; id1: number; id2: number | null; entries: PermissionOverviewEntry[] }
          | { type: "permissionCatalog"; entries: PermissionCatalogEntry[] };

        if (event.type === "connected") {
          this.emit({
            type: "connected",
            welcomeMessage: event.welcome_message,
            serverName: event.server_name,
            serverMaxClients: event.server_max_clients,
            serverVersion: event.server_version,
            serverLicense: event.server_license,
            serverLicenseId: event.server_license_id ?? 0,
            serverBannerUrl: event.server_banner_url,
            identity: event.identity,
          });
        } else if (event.type === "channels") {
          this.emit({
            type: "channels",
            channels: event.channels.map((ch) => ({
              id: ch.id,
              parent: ch.parent,
              order: ch.order,
              name: ch.name,
              topic: ch.topic,
              codec: ch.codec,
              maxClients: ch.max_clients,
              hasPassword: ch.has_password,
            })),
            clients: event.clients.map((c) => ({
              id: c.id,
              channel: c.channel,
              name: c.name,
              inputMuted: c.input_muted,
              outputMuted: c.output_muted,
              inputHardwareEnabled: c.input_hardware_enabled,
              away: c.away,
              awayMessage: c.away_message,
              isChannelCommander: c.is_channel_commander,
              country: c.country,
              uid: c.uid,
              databaseId: c.database_id,
              channelGroup: c.channel_group,
              serverGroups: c.server_groups,
              hasTalkPower: c.has_talk_power,
            })),
            ownClientId: event.own_client_id ?? 0,
            serverMaxClients: event.server_max_clients ?? 0,
            serverClientsOnline: event.server_clients_online ?? event.clients.length,
            serverChannelsOnline: event.server_channels_online ?? event.channels.length,
          });
        } else if (event.type === "privateMessage") {
          this.emit({
            type: "privateMessage",
            partnerId: event.partner_id,
            partnerName: event.partner_name,
            fromSelf: event.from_self,
            message: event.message,
          });
        } else if (event.type === "clientConnectionInfo") {
          this.emit({
            type: "clientConnectionInfo",
            clientId: event.client_id,
            pingMs: event.ping_ms,
            connectedSecs: event.connected_secs,
            ip: event.ip,
            packetsSent: event.packets_sent,
            bytesSent: event.bytes_sent,
            packetsReceived: event.packets_received,
            bytesReceived: event.bytes_received,
            packetLossPercent: event.packet_loss_percent,
          });
        } else if (event.type === "serverConnectionInfo") {
          this.emit({
            type: "serverConnectionInfo",
            pingMs: event.ping_ms,
            connectedSecs: event.connected_secs,
            packetLossPercent: event.packet_loss_percent,
            packetsSentTotal: event.packets_sent_total,
            bytesSentTotal: event.bytes_sent_total,
            packetsReceivedTotal: event.packets_received_total,
            bytesReceivedTotal: event.bytes_received_total,
            bandwidthSentLastSecond: event.bandwidth_sent_last_second,
            bandwidthReceivedLastSecond: event.bandwidth_received_last_second,
            bandwidthSentLastMinute: event.bandwidth_sent_last_minute ?? 0,
            bandwidthReceivedLastMinute: event.bandwidth_received_last_minute ?? 0,
            filetransferBandwidthSent: event.filetransfer_bandwidth_sent ?? 0,
            filetransferBandwidthReceived: event.filetransfer_bandwidth_received ?? 0,
            filetransferBytesSent: event.filetransfer_bytes_sent ?? 0,
            filetransferBytesReceived: event.filetransfer_bytes_received ?? 0,
          });
        } else if (event.type === "banList") {
          this.emit({
            type: "banList",
            entries: event.entries.map((e) => ({
              banId: e.ban_id,
              ip: e.ip,
              name: e.name,
              uid: e.uid,
              lastNickname: e.last_nickname,
              created: e.created,
              durationSecs: e.duration_secs,
              invokerName: e.invoker_name,
              reason: e.reason,
              enforcements: e.enforcements,
            })),
          });
        } else if (event.type === "complainList") {
          this.emit({
            type: "complainList",
            entries: event.entries.map((e) => ({
              targetClientDbId: e.target_client_db_id,
              targetName: e.target_name,
              fromClientDbId: e.from_client_db_id,
              fromName: e.from_name,
              message: e.message,
              timestamp: e.timestamp,
            })),
          });
        } else if (event.type === "offlineMessageList") {
          this.emit({
            type: "offlineMessageList",
            entries: event.entries.map((e) => ({
              messageId: e.message_id,
              clientUid: e.client_uid,
              subject: e.subject,
              timestamp: e.timestamp,
              isRead: e.is_read,
            })),
          });
        } else if (event.type === "offlineMessage") {
          this.emit({
            type: "offlineMessage",
            messageId: event.message_id,
            clientUid: event.client_uid,
            subject: event.subject,
            message: event.message,
            timestamp: event.timestamp,
          });
        } else {
          this.emit(event);
        }
      } catch {
        this.emit({ type: "error", message: `Unparseable connector output: ${line}` });
      }
    });

    // stderr carries diagnostic tracing output from the connector (e.g. protocol
    // schema warnings), not application-level errors - keep it server-side only.
    this.child.stderr.on("data", (data) => {
      console.error(`[ts-connector] ${data.toString()}`);
    });

    this.child.on("exit", (code) => {
      if (code !== 0) {
        this.emit({ type: "error", message: `Connector exited with code ${code}` });
      }
    });
  }

  async switchChannel(channelId: number): Promise<void> {
    const id = Number(channelId);
    if (!Number.isFinite(id)) return;
    this.child?.stdin.write(`switch ${id}\n`);
  }

  async getClientConnectionInfo(clientId: number): Promise<void> {
    this.child?.stdin.write(`clientconninfo ${clientId}\n`);
  }

  async getServerConnectionInfo(): Promise<void> {
    this.child?.stdin.write(`serverconninfo\n`);
  }

  async kickFromChannel(clientId: number, reason: string): Promise<void> {
    const sanitized = reason.replace(/[\r\n]+/g, " ").trim();
    this.child?.stdin.write(`kickchannel ${clientId} ${sanitized}\n`);
  }

  async kickFromServer(clientId: number, reason: string): Promise<void> {
    const sanitized = reason.replace(/[\r\n]+/g, " ").trim();
    this.child?.stdin.write(`kickserver ${clientId} ${sanitized}\n`);
  }

  async banClient(clientId: number, seconds: number, reason: string): Promise<void> {
    const sanitized = reason.replace(/[\r\n]+/g, " ").trim();
    this.child?.stdin.write(`banclient ${clientId} ${Math.max(0, Math.floor(seconds))} ${sanitized}\n`);
  }

  /** Every field is optional - only send what actually changed. JSON.stringify
   *  already escapes embedded newlines, so this is safe as a single stdin line
   *  without extra sanitization. */
  async editServer(payload: {
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
  }): Promise<void> {
    this.child?.stdin.write(`serveredit ${JSON.stringify(payload)}\n`);
  }

  async getServerLog(): Promise<void> {
    this.child?.stdin.write(`serverlog\n`);
  }

  async getBanList(): Promise<void> {
    this.child?.stdin.write(`banlist\n`);
  }

  async deleteBan(banId: number): Promise<void> {
    this.child?.stdin.write(`bandel ${banId}\n`);
  }

  async deleteAllBans(): Promise<void> {
    this.child?.stdin.write(`bandelall\n`);
  }

  async getComplainList(): Promise<void> {
    this.child?.stdin.write(`complainlist\n`);
  }

  async deleteComplaint(targetClientDbId: number, fromClientDbId: number): Promise<void> {
    this.child?.stdin.write(`complaindel ${targetClientDbId} ${fromClientDbId}\n`);
  }

  async deleteAllComplaintsFor(targetClientDbId: number): Promise<void> {
    this.child?.stdin.write(`complaindelall ${targetClientDbId}\n`);
  }

  async getOfflineMessageList(): Promise<void> {
    this.child?.stdin.write(`messagelist\n`);
  }

  async getOfflineMessage(messageId: number): Promise<void> {
    this.child?.stdin.write(`messageget ${messageId}\n`);
  }

  async sendOfflineMessage(clientUid: string, subject: string, message: string): Promise<void> {
    const sanitize = (s: string) => s.replace(/[\r\n\t]+/g, " ").trim();
    this.child?.stdin.write(`messageadd ${sanitize(clientUid)}\t${sanitize(subject)}\t${sanitize(message)}\n`);
  }

  async deleteOfflineMessage(messageId: number): Promise<void> {
    this.child?.stdin.write(`messagedel ${messageId}\n`);
  }

  async markOfflineMessageRead(messageId: number): Promise<void> {
    this.child?.stdin.write(`messageupdateflag ${messageId} 1\n`);
  }

  async getChannelGroupList(): Promise<void> {
    this.child?.stdin.write(`channelgrouplist\n`);
  }

  async getServerGroupList(): Promise<void> {
    this.child?.stdin.write(`servergrouplist\n`);
  }

  async setChannelGroup(channelGroupId: number, channelId: number, clientDbId: number): Promise<void> {
    this.child?.stdin.write(`setchannelgroup ${channelGroupId} ${channelId} ${clientDbId}\n`);
  }

  async addServerGroup(serverGroupId: number, clientDbId: number): Promise<void> {
    this.child?.stdin.write(`addservergroup ${serverGroupId} ${clientDbId}\n`);
  }

  async removeServerGroup(serverGroupId: number, clientDbId: number): Promise<void> {
    this.child?.stdin.write(`delservergroup ${serverGroupId} ${clientDbId}\n`);
  }

  async serverQueryLogin(username: string, password: string): Promise<void> {
    const u = Buffer.from(username, "utf8").toString("base64");
    const p = Buffer.from(password, "utf8").toString("base64");
    this.child?.stdin.write(`serverquerylogin ${u} ${p}\n`);
  }

  async getPermissionOverview(): Promise<void> {
    this.child?.stdin.write(`permoverview\n`);
  }

  async getPermissionCatalog(): Promise<void> {
    this.child?.stdin.write(`permissionlist\n`);
  }

  async getPermList(scope: PermScope, id1: number, id2?: number): Promise<void> {
    const args = id2 !== undefined ? `${scope} ${id1} ${id2}` : `${scope} ${id1}`;
    this.child?.stdin.write(`permlist ${args}\n`);
  }

  /** `negated`/`skip` only apply to the "server" and "client" scopes - the
   *  connector ignores extra trailing args for scopes that don't use them, so
   *  it's safe to always pass through what the caller gave. */
  async addPermission(
    scope: PermScope,
    ids: number[],
    permId: number,
    value: number,
    negated = false,
    skip = false
  ): Promise<void> {
    let args = `${scope} ${ids.join(" ")} ${permId} ${value}`;
    if (scope === "server") args += ` ${negated ? 1 : 0} ${skip ? 1 : 0}`;
    else if (scope === "client") args += ` ${skip ? 1 : 0}`;
    this.child?.stdin.write(`permadd ${args}\n`);
  }

  async removePermission(scope: PermScope, ids: number[], permId: number): Promise<void> {
    this.child?.stdin.write(`permdel ${scope} ${ids.join(" ")} ${permId}\n`);
  }

  async getFileList(channelId: number, path: string): Promise<void> {
    const sanitized = (path || "/").replace(/[\r\n]+/g, " ").trim() || "/";
    this.child?.stdin.write(`ftlist ${channelId} ${sanitized}\n`);
  }

  async createDirectory(channelId: number, dirname: string): Promise<void> {
    const sanitized = dirname.replace(/[\r\n]+/g, " ").trim();
    if (sanitized) this.child?.stdin.write(`ftmkdir ${channelId} ${sanitized}\n`);
  }

  async deleteFile(channelId: number, name: string): Promise<void> {
    const sanitized = name.replace(/[\r\n]+/g, " ").trim();
    if (sanitized) this.child?.stdin.write(`ftdelete ${channelId} ${sanitized}\n`);
  }

  async renameFile(channelId: number, oldName: string, newName: string): Promise<void> {
    const sanitize = (s: string) => s.replace(/[\r\n\t]+/g, " ").trim();
    this.child?.stdin.write(`ftrename ${channelId}\t${sanitize(oldName)}\t${sanitize(newName)}\n`);
  }

  async downloadFile(channelId: number, path: string): Promise<void> {
    const sanitized = path.replace(/[\r\n]+/g, " ").trim();
    if (sanitized) this.child?.stdin.write(`ftdownload ${channelId} ${sanitized}\n`);
  }

  /** `dataBase64` is the raw file content, base64-encoded - the browser reads
   *  the picked File as a data URL/ArrayBuffer and sends it up already encoded. */
  async uploadFile(channelId: number, path: string, dataBase64: string): Promise<void> {
    const sanitizedPath = path.replace(/[\r\n\t]+/g, " ").trim();
    this.child?.stdin.write(`ftupload ${channelId}\t${sanitizedPath}\t${dataBase64}\n`);
  }

  async sendChatMessage(message: string): Promise<void> {
    const sanitized = message.replace(/[\r\n]+/g, " ").trim();
    if (sanitized) this.child?.stdin.write(`chat ${sanitized}\n`);
  }

  async sendServerMessage(message: string): Promise<void> {
    const sanitized = message.replace(/[\r\n]+/g, " ").trim();
    if (sanitized) this.child?.stdin.write(`serverchat ${sanitized}\n`);
  }

  async sendPrivateMessage(clientId: number, message: string): Promise<void> {
    const sanitized = message.replace(/[\r\n]+/g, " ").trim();
    if (sanitized) this.child?.stdin.write(`pm ${clientId} ${sanitized}\n`);
  }

  async sendPoke(clientId: number, message: string): Promise<void> {
    const sanitized = message.replace(/[\r\n]+/g, " ").trim();
    this.child?.stdin.write(`poke ${clientId} ${sanitized}\n`);
  }

  async sendAudio(pcmBase64: string): Promise<void> {
    this.child?.stdin.write(`audio ${pcmBase64}\n`);
  }

  async setAway(away: boolean, message: string): Promise<void> {
    if (away) {
      const sanitized = message.replace(/[\r\n]+/g, " ").trim();
      this.child?.stdin.write(`away ${sanitized}\n`);
    } else {
      this.child?.stdin.write("unaway\n");
    }
  }

  async setInputMuted(muted: boolean): Promise<void> {
    this.child?.stdin.write(`muteinput ${muted ? "1" : "0"}\n`);
  }

  async setOutputMuted(muted: boolean): Promise<void> {
    this.child?.stdin.write(`muteoutput ${muted ? "1" : "0"}\n`);
  }

  async setNickname(nickname: string): Promise<void> {
    const sanitized = nickname.replace(/[\r\n]+/g, " ").trim();
    if (sanitized) this.child?.stdin.write(`nickname ${sanitized}\n`);
  }

  /** Empty channelIds/clientIds clears whisper mode, returning outgoing
   *  voice to the normal current-channel broadcast. */
  async setWhisperTargets(channelIds: number[], clientIds: number[]): Promise<void> {
    if (channelIds.length === 0 && clientIds.length === 0) {
      this.child?.stdin.write("unwhisper\n");
    } else {
      this.child?.stdin.write(`whisper ${channelIds.join(",")};${clientIds.join(",")}\n`);
    }
  }

  async disconnect(message = ""): Promise<void> {
    if (this.child && !this.child.killed) {
      const sanitized = message.replace(/[\r\n]+/g, " ").trim();
      this.child.stdin.write(`disconnect ${sanitized}\n`);
      this.child.stdin.end();
    }
    this.listeners.clear();
  }
}
