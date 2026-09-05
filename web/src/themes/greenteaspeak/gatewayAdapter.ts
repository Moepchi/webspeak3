/**
 * Maps WebSpeak gateway WebSocket payloads to the shape the GreenTeaSpeak
 * shell expects. The browser UI still uses App.tsx state; this module is the
 * contract layer so GTS chrome never talks to Electron IPC.
 */

export type GatewayServerType = "auto" | "teamspeak" | "teaspeak";

export type GatewayConnectPayload = {
  type: "connect";
  host: string;
  nickname: string;
  serverPassword?: string;
  channelPassword?: string;
  defaultChannel?: string;
  identity?: string;
  privilegeKey?: string;
  serverType?: GatewayServerType;
};

export type GatewayOutboundAction =
  | GatewayConnectPayload
  | { type: "disconnect" }
  | { type: "switchChannel"; channelId: number }
  | { type: "sendChat"; message: string; target?: "channel" | "server" | number }
  | { type: string; [key: string]: unknown };

/** Build the connect message sent on the WebSpeak gateway socket. */
export function buildGatewayConnect(input: {
  host: string;
  nickname: string;
  serverPassword?: string;
  channelPassword?: string;
  defaultChannel?: string;
  identity?: string;
  privilegeKey?: string;
  serverType?: GatewayServerType;
}): GatewayConnectPayload {
  return {
    type: "connect",
    host: input.host.trim(),
    nickname: input.nickname.trim(),
    serverPassword: input.serverPassword?.trim() || undefined,
    channelPassword: input.channelPassword?.trim() || undefined,
    defaultChannel: input.defaultChannel?.trim() || undefined,
    identity: input.identity || undefined,
    privilegeKey: input.privilegeKey?.trim() || undefined,
    serverType: input.serverType || "auto",
  };
}

export function sendGatewayAction(ws: WebSocket | null, action: GatewayOutboundAction): boolean {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(action));
  return true;
}
