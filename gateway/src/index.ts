import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, appendFile, rename, stat } from "node:fs/promises";
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

// Opt-in only, off by default: this is an open-source, self-hostable image,
// and other instances shouldn't get connection logging just because it's in
// the codebase. Set LOG_CONNECTIONS=1 in the .env of the instance you want it
// on. Logs only host/server-name/timestamp — no nickname, no IP.
const LOG_CONNECTIONS = process.env.LOG_CONNECTIONS === "1";

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
  ".webmanifest": "application/manifest+json",
};

// --- Feedback endpoint ---------------------------------------------------
//
// Opt-in only, same convention as LOG_CONNECTIONS above: this is an open-
// source, self-hostable image, so other instances don't get a public
// feedback inbox (and potential GitHub-issue creator) just because it's in
// the codebase. Set FEEDBACK_ENABLED=1 on the instance you want it on. The
// web client only shows the "Feedback" menu entry on specific hostnames
// (see IS_OWN_HOSTED_INSTANCE in web/src/App.tsx), but this endpoint
// enforces its own opt-in independently since it's reachable directly over
// HTTP by anyone who finds the gateway's address, not just from that UI.
const FEEDBACK_ENABLED = process.env.FEEDBACK_ENABLED === "1";
// The web app is commonly hosted on a different origin than the gateway
// (see mem:deployment / GATEWAY_URL in web/), so this needs its own CORS
// allowance; default "*" since the endpoint is opt-in, rate-limited, and
// only ever accepts a feedback submission, nothing that reads data back.
const FEEDBACK_ALLOWED_ORIGIN = process.env.FEEDBACK_ALLOWED_ORIGIN ?? "*";
// A token with "Issues: write" access on the target repo. Without it,
// feedback is still accepted and logged, just never turned into an issue.
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO ?? "Moepchi/webspeak3";
// Plain JSON-lines file, not a database - this is a low-volume inbox, not
// analytics. Defaults under the container's WORKDIR (/app in the Docker
// image); mount a volume over it if you want submissions to survive a
// container recreate.
const FEEDBACK_LOG_FILE = process.env.FEEDBACK_LOG_FILE ?? path.resolve(process.cwd(), "feedback.log");
// Simple size-based rotation: once the log crosses this size, the current
// file is moved to feedback.log.1 (overwriting any previous one) and a
// fresh file is started. Keeps disk usage bounded on a plain JSON-lines
// file with no other retention policy.
const FEEDBACK_LOG_MAX_BYTES = 5 * 1024 * 1024;
const FEEDBACK_CATEGORIES = new Set(["bug", "idea", "other"]);
const FEEDBACK_MESSAGE_MAX_LENGTH = 4000;

async function rotateFeedbackLogIfNeeded(): Promise<void> {
  try {
    const { size } = await stat(FEEDBACK_LOG_FILE);
    if (size < FEEDBACK_LOG_MAX_BYTES) return;
    await rename(FEEDBACK_LOG_FILE, `${FEEDBACK_LOG_FILE}.1`);
  } catch (err) {
    // ENOENT just means there's no log yet - nothing to rotate.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error("[feedback] Failed to rotate feedback log:", err);
    }
  }
}

// Small in-memory rate limit: a handful of submissions per IP per hour is
// far more than any real user needs, and keeps one abusive client from
// spamming the log file or (worse) the GitHub issue tracker. In-memory is
// fine here - it only needs to survive as long as the process does.
const FEEDBACK_RATE_LIMIT = 5;
const FEEDBACK_RATE_WINDOW_MS = 60 * 60 * 1000;
const feedbackSubmissionTimes = new Map<string, number[]>();

function isFeedbackRateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (feedbackSubmissionTimes.get(ip) ?? []).filter((t) => now - t < FEEDBACK_RATE_WINDOW_MS);
  recent.push(now);
  feedbackSubmissionTimes.set(ip, recent);
  return recent.length > FEEDBACK_RATE_LIMIT;
}

async function createGithubIssue(payload: {
  category: string;
  message: string;
  email?: string;
}): Promise<string | undefined> {
  if (!GITHUB_TOKEN) return undefined;
  const title = `[Feedback/${payload.category}] ${payload.message.replace(/\s+/g, " ").trim().slice(0, 72)}`;
  const body = [
    payload.message,
    "",
    "---",
    `Category: ${payload.category}`,
    payload.email ? `Contact: ${payload.email}` : undefined,
    "_Submitted via the in-client feedback form._",
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");

  const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/issues`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "webspeak3-gateway",
    },
    // GitHub auto-creates labels that don't already exist in the repo, so
    // the category label needs no manual setup on first use.
    body: JSON.stringify({ title, body, labels: ["feedback", payload.category] }),
  });
  if (!res.ok) {
    console.error(`[feedback] GitHub issue creation failed (${res.status}): ${await res.text().catch(() => "")}`);
    return undefined;
  }
  const json = (await res.json()) as { html_url?: string };
  return json.html_url;
}

async function handleFeedback(req: IncomingMessage, res: ServerResponse) {
  res.setHeader("Access-Control-Allow-Origin", FEEDBACK_ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  if (!FEEDBACK_ENABLED) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "method_not_allowed" }));
    return;
  }

  const ip = (req.socket.remoteAddress ?? "unknown").replace(/^::ffff:/, "");
  if (isFeedbackRateLimited(ip)) {
    res.writeHead(429, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "rate_limited" }));
    return;
  }

  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 20_000) {
      res.writeHead(413, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "payload_too_large" }));
      return;
    }
  }

  let body: { category?: unknown; message?: unknown; email?: unknown; publishAsIssue?: unknown; website?: unknown };
  try {
    body = JSON.parse(raw || "{}");
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid_json" }));
    return;
  }

  // Honeypot: a field named to look attractive to form-filling bots, kept
  // hidden from real users via CSS. Any value here means a bot filled it in
  // blindly - report success without actually logging or filing anything,
  // so the bot has no signal to adapt on.
  if (typeof body.website === "string" && body.website.trim() !== "") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  const category = typeof body.category === "string" && FEEDBACK_CATEGORIES.has(body.category) ? body.category : "other";
  const message =
    typeof body.message === "string" ? body.message.trim().slice(0, FEEDBACK_MESSAGE_MAX_LENGTH) : "";
  const email = typeof body.email === "string" ? body.email.trim().slice(0, 200) || undefined : undefined;
  const publishAsIssue = body.publishAsIssue === true;

  if (!message) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "message_required" }));
    return;
  }

  try {
    await rotateFeedbackLogIfNeeded();
    const entry = { at: new Date().toISOString(), category, message, email };
    await appendFile(FEEDBACK_LOG_FILE, JSON.stringify(entry) + "\n", "utf-8");
  } catch (err) {
    console.error("[feedback] Failed to write feedback log:", err);
  }

  let githubIssueUrl: string | undefined;
  if (publishAsIssue) {
    try {
      githubIssueUrl = await createGithubIssue({ category, message, email });
    } catch (err) {
      console.error("[feedback] Failed to create GitHub issue:", err);
    }
  }

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, githubIssueUrl }));
}

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
      const requestUrl = new URL(req.url ?? "/", "http://localhost");
      if (requestUrl.pathname === "/api/feedback") {
        await handleFeedback(req, res);
        return;
      }

      if (!SERVE_STATIC) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(DEV_HINT);
        return;
      }
      let filePath = path.join(WEB_DIST, decodeURIComponent(requestUrl.pathname));
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

// Heartbeat: a browser tab that loses its network mid-session (mobile
// handover, Wi-Fi drop, backgrounded/frozen tab) often never sends a proper
// WS close frame — the OS-level TCP timeout that would eventually notice can
// take minutes, during which the connector child process (and the TS3/TeaSpeak
// session it holds open) stays alive even though the frontend has already
// given up and shown "disconnected". Standard `ws` ping/pong liveness check
// closes those zombie sockets (and their connector) promptly instead.
const HEARTBEAT_INTERVAL_MS = 20_000;

interface HeartbeatState {
  isAlive: boolean;
}

const heartbeats = new WeakMap<WebSocket, HeartbeatState>();

const heartbeatTimer = setInterval(() => {
  for (const socket of wss.clients) {
    const state = heartbeats.get(socket);
    if (!state) continue;
    if (!state.isAlive) {
      socket.terminate();
      continue;
    }
    state.isAlive = false;
    socket.ping();
  }
}, HEARTBEAT_INTERVAL_MS);

wss.on("close", () => clearInterval(heartbeatTimer));

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

  heartbeats.set(socket, { isAlive: true });
  socket.on("pong", () => {
    const state = heartbeats.get(socket);
    if (state) state.isAlive = true;
  });

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
        connection.onEvent((event) => {
          if (LOG_CONNECTIONS) {
            if (event.type === "connected") {
              console.log(
                `[connections] connected host=${options.host} server=${event.serverName} at=${new Date().toISOString()}`
              );
            } else if (event.type === "disconnected") {
              console.log(`[connections] disconnected host=${options.host} at=${new Date().toISOString()}`);
            }
          }
          socket.send(JSON.stringify(event));
        });
        await connection.connect();
        break;
      }
      case "switchChannel": {
        const channelId = Number(msg.channelId);
        if (Number.isFinite(channelId)) {
          await connection?.switchChannel(channelId, msg.channelPassword);
        }
        break;
      }
      case "moveClient": {
        const clientId = Number(msg.clientId);
        const channelId = Number(msg.channelId);
        if (Number.isFinite(clientId) && Number.isFinite(channelId)) {
          await connection?.moveClient(clientId, channelId, msg.channelPassword);
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
      case "requestStreamInfo": {
        const clientId = Number(msg.clientId);
        if (Number.isFinite(clientId)) await connection?.requestStreamInfo(clientId);
        break;
      }
      case "joinStream": {
        const clientId = Number(msg.clientId);
        if (Number.isFinite(clientId)) {
          await connection?.joinStream(String(msg.streamId ?? ""), clientId, msg.message ?? "");
        }
        break;
      }
      case "leaveStream": {
        const clientId = Number(msg.clientId);
        if (Number.isFinite(clientId)) {
          await connection?.leaveStream(String(msg.streamId ?? ""), clientId);
        }
        break;
      }
      case "streamSignal": {
        const clientId = Number(msg.clientId);
        if (Number.isFinite(clientId) && msg.payload !== undefined) {
          await connection?.sendStreamSignal(String(msg.streamId ?? ""), clientId, msg.payload);
        }
        break;
      }
      case "setupStream": {
        await connection?.setupStream({
          name: String(msg.name ?? "Stream"),
          type: Number(msg.streamType ?? 3),
          bitrate: Number(msg.bitrate ?? 1_500_000),
          accessibility: Number(msg.accessibility ?? 1),
          mode: Number(msg.mode ?? 1),
          viewerLimit: Number(msg.viewerLimit ?? 0),
          audio: Boolean(msg.audio),
        });
        break;
      }
      case "respondJoinStream": {
        const clientId = Number(msg.clientId);
        if (Number.isFinite(clientId)) {
          await connection?.respondJoinStream(
            String(msg.streamId ?? ""),
            clientId,
            Boolean(msg.accept),
            String(msg.offer ?? ""),
            String(msg.message ?? ""),
          );
        }
        break;
      }
      case "stopStream": {
        await connection?.stopStream(String(msg.streamId ?? ""), String(msg.reason ?? ""));
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
    heartbeats.delete(socket);
    connection?.disconnect();
  });
});
