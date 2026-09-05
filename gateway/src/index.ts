import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { Ts3Connection, type ServerType, type Ts3ConnectOptions } from "./ts3/connection.js";

const SERVER_TYPES = new Set<ServerType>(["teamspeak", "teaspeak", "auto"]);

function parseServerType(value: unknown): ServerType | undefined {
  return typeof value === "string" && SERVER_TYPES.has(value as ServerType)
    ? (value as ServerType)
    : undefined;
}

function parsePrivilegeKey(msg: { privilegeKey?: unknown; token?: unknown }): string | undefined {
  const raw = msg.privilegeKey ?? msg.token;
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed || undefined;
}

const PORT = Number(process.env.PORT ?? 8080);

// In production (Docker), the built web app lives alongside the gateway and
// is served from the same port as the WebSocket endpoint, so a single
// reverse-proxied origin (e.g. a Zoraxy subdomain) is enough for everything.
// Local Vite dev (`npm run dev` in web/) is a separate UI on :5173 that talks
// to this gateway only via WebSocket — do not use :8080's HTML for UI work
// unless you rebuilt web/dist. Set WEB_STATIC=0 to serve API/WS only.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIST = process.env.WEB_DIST ?? path.resolve(__dirname, "../../web/dist");
const SERVE_STATIC = process.env.WEB_STATIC !== "0";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

const DEV_HINT = `<!doctype html><html><body style="font:14px system-ui;padding:2rem;max-width:40rem">
<h1>WebSpeak3 gateway</h1>
<p>WebSocket: <code>/ws</code></p>
<p>Static UI is disabled (<code>WEB_STATIC=0</code>) or <code>web/dist</code> is missing.</p>
<p>For local development open the Vite app at <a href="http://localhost:5173/">http://localhost:5173/</a>
(run <code>npm run dev</code> in <code>web/</code>). Rebuild with <code>npm run build</code> in <code>web/</code>
to serve the UI from this port again.</p>
</body></html>`;

const server = createServer((req, res) => {
  void (async () => {
    try {
      if (!SERVE_STATIC) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(DEV_HINT);
        return;
      }
      const url = new URL(req.url ?? "/", "http://localhost");
      let filePath = path.join(WEB_DIST, decodeURIComponent(url.pathname));
      if (!filePath.startsWith(WEB_DIST)) {
        res.writeHead(403);
        res.end();
        return;
      }
      let body: Buffer;
      try {
        body = await readFile(filePath);
      } catch {
        // SPA fallback: unknown paths (client-side routes, or "/") serve index.html.
        filePath = path.join(WEB_DIST, "index.html");
        body = await readFile(filePath);
      }
      res.writeHead(200, { "Content-Type": MIME_TYPES[path.extname(filePath)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(DEV_HINT);
    }
  })();
});

const wss = new WebSocketServer({ server, path: "/ws" });

server.listen(PORT, () => {
  console.log(`WebSpeak3 gateway listening on http://localhost:${PORT} (WebSocket at /ws)`);
  if (SERVE_STATIC) {
    console.log(`Serving static UI from ${WEB_DIST}`);
    console.log(`Dev tip: use http://localhost:5173/ for live UI; rebuild web/dist after UI changes if you open :${PORT}`);
  } else {
    console.log(`Static UI disabled (WEB_STATIC=0) — open http://localhost:5173/ for the Vite dev UI`);
  }
});

wss.on("connection", (socket: WebSocket) => {
  // One browser WebSocket ↔ one Rust connector. Multi-join in the UI opens
  // multiple /ws connections in parallel (one per server tab).
  let connection: Ts3Connection | undefined;

  socket.on("message", async (raw) => {
    const msg = JSON.parse(raw.toString());

    switch (msg.type) {
      case "connect": {
        // Replacing a connection on the same socket: tear down the previous
        // connector so we don't leak processes.
        if (connection) {
          try {
            await connection.disconnect();
          } catch {
            /* ignore */
          }
          connection = undefined;
        }
        const options: Ts3ConnectOptions = {
          host: msg.host,
          nickname: msg.nickname,
          serverPassword: msg.serverPassword,
          channelPassword: msg.channelPassword,
          defaultChannel: msg.defaultChannel,
          identity: msg.identity,
          serverType: parseServerType(msg.serverType),
          privilegeKey: parsePrivilegeKey(msg),
        };
        connection = new Ts3Connection(options);
        connection.onEvent((event) => socket.send(JSON.stringify(event)));
        await connection.connect();
        break;
      }
      case "switchChannel": {
        const channelId = Number(msg.channelId);
        if (Number.isFinite(channelId)) {
          await connection?.switchChannel(channelId);
        }
        break;
      }
      case "sendChatMessage": {
        await connection?.sendChatMessage(msg.message);
        break;
      }
      case "sendServerMessage": {
        await connection?.sendServerMessage(msg.message);
        break;
      }
      case "sendPrivateMessage": {
        await connection?.sendPrivateMessage(msg.clientId, msg.message);
        break;
      }
      case "sendPoke": {
        await connection?.sendPoke(msg.clientId, msg.message ?? "");
        break;
      }
      case "sendAudio": {
        await connection?.sendAudio(msg.pcm);
        break;
      }
      case "setAway": {
        await connection?.setAway(msg.away, msg.message ?? "");
        break;
      }
      case "setInputMuted": {
        await connection?.setInputMuted(msg.muted);
        break;
      }
      case "setOutputMuted": {
        await connection?.setOutputMuted(msg.muted);
        break;
      }
      case "setNickname": {
        await connection?.setNickname(msg.nickname);
        break;
      }
      case "setWhisperTargets": {
        await connection?.setWhisperTargets(msg.channelIds ?? [], msg.clientIds ?? []);
        break;
      }
      case "getClientConnectionInfo": {
        await connection?.getClientConnectionInfo(msg.clientId);
        break;
      }
      case "getServerConnectionInfo": {
        await connection?.getServerConnectionInfo();
        break;
      }
      case "kickFromChannel": {
        await connection?.kickFromChannel(msg.clientId, msg.reason ?? "");
        break;
      }
      case "kickFromServer": {
        await connection?.kickFromServer(msg.clientId, msg.reason ?? "");
        break;
      }
      case "banClient": {
        await connection?.banClient(msg.clientId, msg.seconds ?? 0, msg.reason ?? "");
        break;
      }
      case "editServer": {
        await connection?.editServer(msg.payload ?? {});
        break;
      }
      case "getServerLog": {
        await connection?.getServerLog();
        break;
      }
      case "getBanList": {
        await connection?.getBanList();
        break;
      }
      case "deleteBan": {
        await connection?.deleteBan(msg.banId);
        break;
      }
      case "deleteAllBans": {
        await connection?.deleteAllBans();
        break;
      }
      case "getComplainList": {
        await connection?.getComplainList();
        break;
      }
      case "deleteComplaint": {
        await connection?.deleteComplaint(msg.targetClientDbId, msg.fromClientDbId);
        break;
      }
      case "deleteAllComplaintsFor": {
        await connection?.deleteAllComplaintsFor(msg.targetClientDbId);
        break;
      }
      case "getOfflineMessageList": {
        await connection?.getOfflineMessageList();
        break;
      }
      case "getOfflineMessage": {
        await connection?.getOfflineMessage(msg.messageId);
        break;
      }
      case "sendOfflineMessage": {
        await connection?.sendOfflineMessage(msg.clientUid, msg.subject, msg.message);
        break;
      }
      case "deleteOfflineMessage": {
        await connection?.deleteOfflineMessage(msg.messageId);
        break;
      }
      case "markOfflineMessageRead": {
        await connection?.markOfflineMessageRead(msg.messageId);
        break;
      }
      case "getChannelGroupList": {
        await connection?.getChannelGroupList();
        break;
      }
      case "getServerGroupList": {
        await connection?.getServerGroupList();
        break;
      }
      case "setChannelGroup": {
        await connection?.setChannelGroup(msg.channelGroupId, msg.channelId, msg.clientDbId);
        break;
      }
      case "addServerGroup": {
        await connection?.addServerGroup(msg.serverGroupId, msg.clientDbId);
        break;
      }
      case "removeServerGroup": {
        await connection?.removeServerGroup(msg.serverGroupId, msg.clientDbId);
        break;
      }
      case "serverQueryLogin": {
        await connection?.serverQueryLogin(msg.username, msg.password);
        break;
      }
      case "getPermissionOverview": {
        await connection?.getPermissionOverview();
        break;
      }
      case "getFileList": {
        await connection?.getFileList(msg.channelId, msg.path);
        break;
      }
      case "createDirectory": {
        await connection?.createDirectory(msg.channelId, msg.dirname);
        break;
      }
      case "deleteFile": {
        await connection?.deleteFile(msg.channelId, msg.name);
        break;
      }
      case "renameFile": {
        await connection?.renameFile(msg.channelId, msg.oldName, msg.newName);
        break;
      }
      case "downloadFile": {
        await connection?.downloadFile(msg.channelId, msg.path);
        break;
      }
      case "uploadFile": {
        await connection?.uploadFile(msg.channelId, msg.path, msg.dataBase64);
        break;
      }
      case "getPermissionCatalog": {
        await connection?.getPermissionCatalog();
        break;
      }
      case "getPermList": {
        await connection?.getPermList(msg.scope, msg.id1, msg.id2);
        break;
      }
      case "addPermission": {
        await connection?.addPermission(msg.scope, msg.ids, msg.permId, msg.value, msg.negated, msg.skip);
        break;
      }
      case "removePermission": {
        await connection?.removePermission(msg.scope, msg.ids, msg.permId);
        break;
      }
      case "disconnect": {
        await connection?.disconnect(msg.message ?? "");
        break;
      }
      default:
        socket.send(
          JSON.stringify({ type: "error", message: `Unknown message type: ${msg.type}` })
        );
    }
  });

  socket.on("close", () => {
    connection?.disconnect();
  });
});
