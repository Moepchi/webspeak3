// Standalone Design Store: the same /api/store/* routes index.ts serves, in a
// process of its own. Lets the store be redeployed or restarted without
// dropping anyone's voice connection. Same image, different command:
//   node dist/store-server.js   (with STORE_ENABLED=1)
// The gateway in front of the same hostname then runs with STORE_ENABLED off
// and the reverse proxy routes /api/store/* here.
import { createServer } from "node:http";
import { handleStore } from "./store.js";
import { handlePing } from "./ping.js";

const PORT = Number(process.env.PORT ?? 8080);

createServer((req, res) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  const { pathname } = new URL(req.url ?? "/", "http://localhost");
  if (pathname === "/healthz") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("ok\n");
    return;
  }
  if (pathname === "/api/store/admin" || pathname === "/api/store/themes" || pathname.startsWith("/api/store/themes/")) {
    handleStore(req, res, pathname).catch((err) => {
      console.error("[store] Request failed:", err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "internal" }));
      }
    });
    return;
  }
  if (pathname === "/api/ping" || pathname === "/api/ping/stats") {
    handlePing(req, res, pathname).catch((err) => {
      console.error("[ping] Request failed:", err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "internal" }));
      }
    });
    return;
  }
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
}).listen(PORT, () => console.log(`WebSpeak3 store listening on http://localhost:${PORT}`));
