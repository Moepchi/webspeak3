// --- Design Store endpoint -------------------------------------------------
//
// Opt-in only, same convention as LOG_CONNECTIONS/FEEDBACK_ENABLED/BROADCAST_TOKEN
// in index.ts: public CSS uploads need moderation attention a plain self-hosted
// instance shouldn't inherit just because the code exists. Set STORE_ENABLED=1
// to turn it on.
//
// Kept in its own module (unlike feedback/broadcast, which stay inline in
// index.ts) so the private VPS overlay - a hand-patched fork of index.ts that
// swaps feedback/connection persistence to SQLite - never needs this file
// touched. It has zero private modifications, so the overlay just copies it
// verbatim; only index.ts's small SQLite-persistence sections need patching.
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { timingSafeEqual, randomUUID } from "node:crypto";
import path from "node:path";

const STORE_ENABLED = process.env.STORE_ENABLED === "1";
const STORE_ALLOWED_ORIGIN = process.env.STORE_ALLOWED_ORIGIN ?? "*";
// Plain JSON file (whole-array read-modify-write, not JSON-lines like
// feedback.log in index.ts): the store needs to list and look up by id, and
// the expected volume (community theme submissions) is small enough that
// rewriting the whole file each time is simpler than a real DB - see the
// "never add SQLite to the public gateway" note in mem:reference_webspeak3_private_sqlite_persistence.
const STORE_DATA_FILE = process.env.STORE_DATA_FILE ?? path.resolve(process.cwd(), "store-themes.json");
const STORE_NAME_MAX_LENGTH = 60;
const STORE_AUTHOR_MAX_LENGTH = 40;
const STORE_DESCRIPTION_MAX_LENGTH = 300;
const STORE_CSS_MAX_LENGTH = 50_000;
// ~300KB image after base64 overhead - screenshots live inline in the same
// flat JSON file as everything else, so this also bounds that file's growth.
const STORE_SCREENSHOT_MAX_DATA_URL_LENGTH = 400_000;
const STORE_SCREENSHOT_RE = /^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/]+=*$/;
// Hard cap so the flat file - and the in-memory cache mirroring it - can't
// grow unbounded from spam that slips past rate limiting (a fresh IP per
// submission, say). Bounds worst case to ~300 * 450KB =~ 135MB in RAM.
const STORE_MAX_THEMES = 300;
const STORE_BASE_THEMES = new Set(["standard", "nova", "greenteaspeak", "pulse"]);

// A handful of names (the operator's own) that only whoever holds
// STORE_ADMIN_TOKEN may publish under - stops anyone else from impersonating
// the maintainer in the author field. Everyone else's name is first-come,
// unenforced, same as any other free-text field here.
const STORE_RESERVED_AUTHORS = new Set(
  (process.env.STORE_RESERVED_AUTHORS ?? "Möpchi,Moepchi")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
);
const STORE_ADMIN_TOKEN = process.env.STORE_ADMIN_TOKEN;

function isValidStoreAdminToken(provided: string): boolean {
  if (!STORE_ADMIN_TOKEN) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(STORE_ADMIN_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

interface StoreTheme {
  id: string;
  name: string;
  baseTheme: string;
  css: string;
  author: string;
  description: string;
  screenshot: string | null;
  ratingSum: number;
  ratingCount: number;
  createdAt: string;
  // ponytail: no moderation queue/admin UI yet - everything publishes as
  // "approved" immediately. The field exists so a bad submission can be
  // hidden by hand-editing STORE_DATA_FILE (status: "rejected") without a
  // schema change, once there's an actual admin surface to do that from.
  status: "approved" | "rejected";
}

// Rendered CSS reaches other users' browsers, so block the two ways a
// stylesheet can reach outside itself. Everything else (colors, selectors,
// animations, pseudo-elements) is harmless - it only ever applies inside the
// app's own theme wrapper class.
const CSS_IMPORT_RE = /@import/i;
const CSS_REMOTE_URL_RE = /url\s*\(\s*["']?\s*(?:https?:)?\/\//i;

function sanitizeThemeCss(css: string): string | null {
  return CSS_IMPORT_RE.test(css) || CSS_REMOTE_URL_RE.test(css) ? null : css;
}

let storeCache: StoreTheme[] | null = null;

async function loadStoreThemes(): Promise<StoreTheme[]> {
  if (storeCache) return storeCache;
  try {
    storeCache = JSON.parse(await readFile(STORE_DATA_FILE, "utf-8")) as StoreTheme[];
  } catch {
    storeCache = [];
  }
  return storeCache;
}

async function saveStoreThemes(themes: StoreTheme[]): Promise<void> {
  storeCache = themes;
  await writeFile(STORE_DATA_FILE, JSON.stringify(themes), "utf-8");
}

// Same in-memory-per-IP approach as FEEDBACK_RATE_LIMIT in index.ts; kept as a
// separate map since the two endpoints are independent.
const STORE_RATE_LIMIT = 5;
const STORE_RATE_WINDOW_MS = 60 * 60 * 1000;
const storeSubmissionTimes = new Map<string, number[]>();

function isStoreRateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (storeSubmissionTimes.get(ip) ?? []).filter((t) => now - t < STORE_RATE_WINDOW_MS);
  recent.push(now);
  storeSubmissionTimes.set(ip, recent);
  return recent.length > STORE_RATE_LIMIT;
}

// One rating per IP per theme - not robust against a determined multi-IP
// spammer, but it stops the trivial "click again" case with no accounts to
// build. Memory-only, so it resets on redeploy; a repeat vote after that just
// counts twice, which is an acceptable ceiling for a beta feature.
const storeRatingsSeen = new Set<string>();

function setStoreCors(res: ServerResponse) {
  res.setHeader("Access-Control-Allow-Origin", STORE_ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function storeRating(theme: StoreTheme): { average: number; count: number } {
  // theme.ratingCount is undefined for themes submitted before this field existed.
  const count = theme.ratingCount ?? 0;
  return { average: count ? theme.ratingSum / count : 0, count };
}

async function handleStoreList(res: ServerResponse) {
  const themes = await loadStoreThemes();
  const listing = themes
    .filter((t) => t.status === "approved")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((t) => ({
      id: t.id,
      name: t.name,
      baseTheme: t.baseTheme,
      author: t.author,
      description: t.description ?? "",
      hasScreenshot: Boolean(t.screenshot),
      rating: storeRating(t),
      createdAt: t.createdAt,
    }));
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(listing));
}

async function handleStoreDownload(res: ServerResponse, id: string) {
  const themes = await loadStoreThemes();
  const theme = themes.find((t) => t.id === id && t.status === "approved");
  if (!theme) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
    return;
  }
  // Same shape as the client's own .webspeak3theme.json export/import, so the
  // browsed result feeds straight into the existing import validator.
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ name: theme.name, baseTheme: theme.baseTheme, css: theme.css }));
}

async function handleStoreScreenshot(res: ServerResponse, id: string) {
  const themes = await loadStoreThemes();
  const theme = themes.find((t) => t.id === id && t.status === "approved");
  if (!theme?.screenshot) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
    return;
  }
  const match = /^data:(image\/[a-z]+);base64,(.+)$/.exec(theme.screenshot);
  if (!match) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
    return;
  }
  res.writeHead(200, { "Content-Type": match[1], "Cache-Control": "public, max-age=3600" });
  res.end(Buffer.from(match[2], "base64"));
}

async function handleStoreRate(req: IncomingMessage, res: ServerResponse, id: string) {
  const ip = (req.socket.remoteAddress ?? "unknown").replace(/^::ffff:/, "");
  const seenKey = `${ip}:${id}`;
  if (storeRatingsSeen.has(seenKey)) {
    res.writeHead(409, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "already_rated" }));
    return;
  }

  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 200) {
      res.writeHead(413, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "payload_too_large" }));
      return;
    }
  }

  let body: { stars?: unknown };
  try {
    body = JSON.parse(raw || "{}");
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid_json" }));
    return;
  }

  const stars = typeof body.stars === "number" ? Math.round(body.stars) : NaN;
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid_stars" }));
    return;
  }

  const themes = await loadStoreThemes();
  const theme = themes.find((t) => t.id === id && t.status === "approved");
  if (!theme) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
    return;
  }

  theme.ratingSum = (theme.ratingSum ?? 0) + stars;
  theme.ratingCount = (theme.ratingCount ?? 0) + 1;
  try {
    await saveStoreThemes(themes);
  } catch (err) {
    console.error("[store] Failed to save rating:", err);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "save_failed" }));
    return;
  }
  storeRatingsSeen.add(seenKey);

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, rating: storeRating(theme) }));
}

async function handleStoreSubmit(req: IncomingMessage, res: ServerResponse) {
  const ip = (req.socket.remoteAddress ?? "unknown").replace(/^::ffff:/, "");
  if (isStoreRateLimited(ip)) {
    res.writeHead(429, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "rate_limited" }));
    return;
  }

  let raw = "";
  const maxBytes = STORE_CSS_MAX_LENGTH + STORE_SCREENSHOT_MAX_DATA_URL_LENGTH + 5_000;
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > maxBytes) {
      res.writeHead(413, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "payload_too_large" }));
      return;
    }
  }

  let body: {
    name?: unknown;
    baseTheme?: unknown;
    css?: unknown;
    author?: unknown;
    description?: unknown;
    screenshot?: unknown;
    website?: unknown;
  };
  try {
    body = JSON.parse(raw || "{}");
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid_json" }));
    return;
  }

  // Honeypot, same as /api/feedback in index.ts.
  if (typeof body.website === "string" && body.website.trim() !== "") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  const name = typeof body.name === "string" ? body.name.trim().slice(0, STORE_NAME_MAX_LENGTH) : "";
  const baseTheme = typeof body.baseTheme === "string" && STORE_BASE_THEMES.has(body.baseTheme) ? body.baseTheme : "";
  const rawCss = typeof body.css === "string" ? body.css.slice(0, STORE_CSS_MAX_LENGTH) : "";
  const author =
    typeof body.author === "string" ? body.author.trim().slice(0, STORE_AUTHOR_MAX_LENGTH) || "Anonymous" : "Anonymous";
  const description = typeof body.description === "string" ? body.description.trim().slice(0, STORE_DESCRIPTION_MAX_LENGTH) : "";

  if (!name || !baseTheme || !rawCss) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid_theme" }));
    return;
  }

  if (STORE_RESERVED_AUTHORS.has(author.toLowerCase())) {
    const authHeader = req.headers.authorization ?? "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : "";
    if (!isValidStoreAdminToken(token)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "author_reserved" }));
      return;
    }
  }

  const css = sanitizeThemeCss(rawCss);
  if (css === null) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "css_rejected" }));
    return;
  }

  let screenshot: string | null = null;
  if (typeof body.screenshot === "string" && body.screenshot !== "") {
    if (body.screenshot.length > STORE_SCREENSHOT_MAX_DATA_URL_LENGTH || !STORE_SCREENSHOT_RE.test(body.screenshot)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_screenshot" }));
      return;
    }
    screenshot = body.screenshot;
  }

  const themes = await loadStoreThemes();
  if (themes.length >= STORE_MAX_THEMES) {
    res.writeHead(507, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "store_full" }));
    return;
  }

  const theme: StoreTheme = {
    id: randomUUID(),
    name,
    baseTheme,
    css,
    author,
    description,
    screenshot,
    ratingSum: 0,
    ratingCount: 0,
    createdAt: new Date().toISOString(),
    status: "approved",
  };
  themes.push(theme);
  try {
    await saveStoreThemes(themes);
  } catch (err) {
    console.error("[store] Failed to save theme:", err);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "save_failed" }));
    return;
  }

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, id: theme.id }));
}

export async function handleStore(req: IncomingMessage, res: ServerResponse, pathname: string) {
  setStoreCors(res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  if (!STORE_ENABLED) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
    return;
  }

  if (pathname === "/api/store/themes") {
    if (req.method === "GET") return handleStoreList(res);
    if (req.method === "POST") return handleStoreSubmit(req, res);
  } else {
    const [id, sub] = pathname.slice("/api/store/themes/".length).split("/");
    if (id && !sub && req.method === "GET") return handleStoreDownload(res, id);
    if (id && sub === "screenshot" && req.method === "GET") return handleStoreScreenshot(res, id);
    if (id && sub === "rate" && req.method === "POST") return handleStoreRate(req, res, id);
  }

  res.writeHead(405, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "method_not_allowed" }));
}
