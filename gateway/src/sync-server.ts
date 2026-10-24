// Standalone account sync server (Options -> Konto), same image as the gateway:
//   node dist/sync-server.js   (with SYNC_DATA_DIR set)
// Its own process so a restart never drops voice connections or the store.
import { createServer } from "node:http";
import { handleSync } from "./sync.js";

const PORT = Number(process.env.PORT ?? 8080);

createServer((req, res) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  const { pathname } = new URL(req.url ?? "/", "http://localhost");
  if (pathname === "/healthz") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("ok\n");
    return;
  }
  if (pathname.startsWith("/api/sync/")) {
    handleSync(req, res, pathname).catch((err) => {
      console.error("[sync] Request failed:", err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "internal" }));
      }
    });
    return;
  }
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
}).listen(PORT, () => console.log(`WebSpeak3 sync listening on http://localhost:${PORT}`));
