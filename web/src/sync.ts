// Options -> Konto: Mullvad-style account sync. A random 16-digit account number
// (+ an optional random password) is all there is. Both derive, on this device,
// the account id the server files the data under, the AES key and the auth
// secret, so the server only ever holds an encrypted blob (gateway/src/sync.ts).
//
// Pulled once at startup (main.tsx, before App reads localStorage) and pushed on
// a timer whenever a synced key changed. A remote change made while this tab is
// open shows up as a conflict on the next push, not live.

export type SyncCategory = "identities" | "favorites" | "settings" | "designs" | "whisper";
export const SYNC_CATEGORIES: SyncCategory[] = ["identities", "favorites", "settings", "designs", "whisper"];

// Device-specific keys (audio devices, volumes, PTT key, chat logs, caches) stay local.
const CATEGORY_KEYS: Record<SyncCategory, string[]> = {
  identities: ["webspeak3:identities", "webspeak3:identity", "webspeak3:active-identity"],
  favorites: ["webspeak3:favorites", "webspeak3:channel-passwords", "webspeak3:contacts"],
  settings: [
    "webspeak3:app-settings",
    "webspeak3:chat-settings",
    "webspeak3:chat-images",
    "webspeak3:server-banner",
    "webspeak3:download-settings",
    "webspeak3:notification-settings",
    "webspeak3:security-settings",
    "webspeak3:away-presets",
    "webspeak3:disconnect-message",
    "webspeak3:language",
    "webspeak3:sounds-enabled",
    "webspeak3:sounds-volume",
    "webspeak3:other-mic-clicks",
    "webspeak3:own-mic-clicks",
  ],
  designs: [
    "webspeak3:custom-themes",
    "webspeak3:design-selection",
    "webspeak3:design-theme",
    "webspeak3:icon-pack",
    "webspeak3:icon-packs",
    "webspeak3:ide-pixel-font",
    "webspeak3:tree-options",
  ],
  whisper: ["webspeak3:whisper-lists", "webspeak3:whisper-settings"],
};

/** Per-sound toggles are stored as "webspeak3:sounds-enabled:<id>". */
function categoryOf(key: string): SyncCategory | null {
  for (const c of SYNC_CATEGORIES)
    if (CATEGORY_KEYS[c].some((k) => key === k || (k === "webspeak3:sounds-enabled" && key.startsWith(`${k}:`)))) return c;
  return null;
}

export const SYNC_ACCOUNT_KEY = "webspeak3:sync-account";

const meta = (name: string) => document.querySelector<HTMLMetaElement>(`meta[name="webspeak3-${name}"]`)?.content;
export const DEFAULT_SYNC_SERVER =
  meta("sync-url") ||
  import.meta.env.VITE_SYNC_URL ||
  (import.meta.env.DEV ? "http://localhost:8081/api/sync" : "https://gateway.webspeak3.de/api/sync");

export interface SyncAccount {
  number: string;
  password?: string;
  server: string;
  categories: SyncCategory[];
  /** Server version this device last wrote or read. */
  version: number;
  /** Hash of the synced keys at that point; differs = local changes to push. */
  syncedHash: string;
  lastSync?: number;
}

export type SyncState = "off" | "idle" | "syncing" | "error" | "conflict";
export interface SyncStatus {
  state: SyncState;
  error?: string;
  lastSync?: number;
}

// --- tiny external store for the Konto panel ---------------------------------

let status: SyncStatus = { state: "off" };
const listeners = new Set<() => void>();
function setStatus(next: SyncStatus) {
  status = next;
  for (const l of listeners) l();
}
export const getSyncStatus = () => status;
export function subscribeSyncStatus(l: () => void) {
  listeners.add(l);
  return () => void listeners.delete(l);
}

export function loadSyncAccount(): SyncAccount | null {
  try {
    const raw = localStorage.getItem(SYNC_ACCOUNT_KEY);
    return raw ? (JSON.parse(raw) as SyncAccount) : null;
  } catch {
    return null;
  }
}

function saveSyncAccount(account: SyncAccount | null) {
  if (account) localStorage.setItem(SYNC_ACCOUNT_KEY, JSON.stringify(account));
  else localStorage.removeItem(SYNC_ACCOUNT_KEY);
}

// --- number, password, crypto -------------------------------------------------

function randomChars(alphabet: string, count: number): string {
  let out = "";
  const limit = 256 - (256 % alphabet.length); // reject to avoid modulo bias
  while (out.length < count) {
    for (const b of crypto.getRandomValues(new Uint8Array(count))) {
      if (b < limit && out.length < count) out += alphabet[b % alphabet.length];
    }
  }
  return out;
}

export const generateAccountNumber = () => randomChars("0123456789", 16);
/** 20 characters (~100 bits) without look-alikes, in groups of five. */
export const generatePassword = () => randomChars("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 20).replace(/(.{5})(?=.)/g, "$1-");
export const formatAccountNumber = (n: string) => n.replace(/(\d{4})(?=\d)/g, "$1 ");
/** null unless exactly 16 digits (spaces and dashes are ignored). */
export const normalizeAccountNumber = (s: string) => {
  const digits = s.replace(/[\s-]/g, "");
  return /^\d{16}$/.test(digits) ? digits : null;
};
export const normalizePassword = (s: string) => s.trim().toUpperCase();

const enc = (s: string) => new TextEncoder().encode(s);
const hex = (bytes: ArrayBuffer | Uint8Array) =>
  [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
const b64 = (bytes: Uint8Array) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const sha256Hex = async (s: string) => hex(await crypto.subtle.digest("SHA-256", enc(s)));

interface Keys {
  id: string;
  key: CryptoKey;
  auth: string;
}

const keyCache = new Map<string, Promise<Keys>>();
function deriveKeys(number: string, password = ""): Promise<Keys> {
  const cacheKey = `${number}\n${password}`;
  let keys = keyCache.get(cacheKey);
  if (!keys) {
    keys = (async () => {
      const base = await crypto.subtle.importKey("raw", enc(cacheKey), "PBKDF2", false, ["deriveBits"]);
      const bits = new Uint8Array(
        await crypto.subtle.deriveBits(
          { name: "PBKDF2", salt: enc(`webspeak3-sync:${number}`), iterations: 310_000, hash: "SHA-256" },
          base,
          512
        )
      );
      return {
        // The id depends on the number only, so a new device can ask whether a password is needed.
        id: await sha256Hex(`webspeak3-sync-id:${number}`),
        key: await crypto.subtle.importKey("raw", bits.slice(0, 32), "AES-GCM", false, ["encrypt", "decrypt"]),
        auth: hex(bits.slice(32)),
      };
    })();
    keyCache.set(cacheKey, keys);
  }
  return keys;
}

interface Payload {
  v: 1;
  categories: SyncCategory[];
  items: Record<string, string>;
}

/** Padded to a power of two (min 4 KB) so the blob size says little about its content. */
async function encrypt(key: CryptoKey, payload: Payload): Promise<string> {
  const json = enc(JSON.stringify(payload));
  let size = 4096;
  while (size < json.length) size *= 2;
  const plain = new Uint8Array(size).fill(0x20); // trailing spaces: JSON.parse ignores them
  plain.set(json);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain));
  const out = new Uint8Array(12 + data.length);
  out.set(iv);
  out.set(data, 12);
  return b64(out);
}

async function decrypt(key: CryptoKey, data: string): Promise<Payload> {
  const bytes = unb64(data);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.subarray(0, 12) }, key, bytes.subarray(12));
  return JSON.parse(new TextDecoder().decode(plain)) as Payload;
}

// --- local snapshot -------------------------------------------------------------

/** Goes through length/key(i), which the vault's stand-in Storage also answers for secrets. */
function snapshot(categories: SyncCategory[]): Record<string, string> {
  const items: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k) continue;
    const c = categoryOf(k);
    if (c && categories.includes(c)) items[k] = localStorage.getItem(k) ?? "";
  }
  return items;
}

const hashItems = (items: Record<string, string>) =>
  sha256Hex(JSON.stringify(Object.keys(items).sort().map((k) => [k, items[k]])));

/** Remote replaces local for every category both sides sync; keys gone remotely go locally too. */
function applyPayload(payload: Payload, categories: SyncCategory[]) {
  const shared = categories.filter((c) => payload.categories.includes(c));
  for (const k of Object.keys(snapshot(shared))) if (!(k in payload.items)) localStorage.removeItem(k);
  for (const [k, v] of Object.entries(payload.items)) {
    const c = categoryOf(k);
    if (c && shared.includes(c)) localStorage.setItem(k, v);
  }
}

// --- server calls ---------------------------------------------------------------

const ERROR_CODES = new Set(["password_required", "unreachable", "not_found", "rate_limited", "full", "pow_required", "conflict", "payload_too_large"]);
/** Locale key for an error thrown by the functions below. */
export const syncErrorKey = (err: unknown) => {
  const code = err instanceof Error ? err.message : String(err);
  return ERROR_CODES.has(code) ? `sync.error.${code}` : "sync.error.generic";
};

async function call(server: string, path: string, init: RequestInit = {}, auth?: string) {
  let res: Response;
  try {
    res = await fetch(`${server.replace(/\/$/, "")}${path}`, {
      ...init,
      headers: {
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
      },
    });
  } catch {
    throw new Error("unreachable");
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(String(body.error ?? res.status));
  return body;
}

export async function accountInfo(number: string, server: string): Promise<{ exists: boolean; hasPassword?: boolean }> {
  const { id } = await deriveKeys(number);
  return (await call(server, `/${id}/meta`)) as { exists: boolean; hasPassword?: boolean };
}

/** Same check as gateway/src/sync.ts: leading zero bits of sha256(challenge:nonce).
 *  Batched, because one awaited digest at a time is dominated by the await. */
async function solvePow(challenge: string, bits: number): Promise<string> {
  const zeroBits = (hash: Uint8Array) => {
    let zeros = 0;
    for (const b of hash) {
      if (b !== 0) return zeros + Math.clz32(b) - 24;
      zeros += 8;
    }
    return zeros;
  };
  for (let start = 0; ; start += 256) {
    const hashes = await Promise.all(
      Array.from({ length: 256 }, (_, i) => crypto.subtle.digest("SHA-256", enc(`${challenge}:${start + i}`)))
    );
    const hit = hashes.findIndex((h) => zeroBits(new Uint8Array(h)) >= bits);
    if (hit >= 0) return String(start + hit);
  }
}

async function push(account: SyncAccount, items: Record<string, string>, extra: Record<string, unknown> = {}) {
  const k = await deriveKeys(account.number, account.password);
  const data = await encrypt(k.key, { v: 1, categories: account.categories, items });
  return (await call(
    account.server,
    `/${k.id}`,
    { method: "PUT", body: JSON.stringify({ version: account.version, data, hasPassword: !!account.password, ...extra }) },
    k.auth
  )) as { version: number };
}

async function pull(account: Pick<SyncAccount, "number" | "password" | "server">) {
  const k = await deriveKeys(account.number, account.password);
  const body = (await call(account.server, `/${k.id}`, {}, k.auth)) as { version: number; data: string };
  return { version: body.version, payload: await decrypt(k.key, body.data) };
}

// --- what the Konto panel and main.tsx use ------------------------------------

export async function createSyncAccount(withPassword: boolean, server: string, categories: SyncCategory[]) {
  const account: SyncAccount = {
    number: generateAccountNumber(),
    password: withPassword ? generatePassword() : undefined,
    server,
    categories,
    version: 0,
    syncedHash: "",
  };
  const { challenge, bits } = (await call(server, "/challenge", { method: "POST" })) as { challenge: string; bits: number };
  const nonce = await solvePow(challenge, bits);
  const items = snapshot(categories);
  const { version } = await push(account, items, { pow: { challenge, nonce } });
  saveSyncAccount({ ...account, version, syncedHash: await hashItems(items), lastSync: Date.now() });
  setStatus({ state: "idle", lastSync: Date.now() });
}

/** Logs this device into an existing account: the account's data replaces the local one. Reload afterwards. */
export async function loginSyncAccount(number: string, password: string | undefined, server: string, categories: SyncCategory[]) {
  const { version, payload } = await pull({ number, password, server });
  applyPayload(payload, categories);
  saveSyncAccount({
    number,
    password,
    server,
    categories,
    version,
    syncedHash: await hashItems(snapshot(categories)),
    lastSync: Date.now(),
  });
}

/** Startup pull (main.tsx). Returns "conflict" when both sides changed. Past
 *  `deadline` App is already running on the local data, so nothing is applied. */
export async function pullAtStartup(deadline: number): Promise<"ok" | "conflict"> {
  const account = loadSyncAccount();
  if (!account) return "ok";
  setStatus({ state: "syncing", lastSync: account.lastSync });
  try {
    const { version, payload } = await pull(account);
    if (version === account.version || Date.now() > deadline) {
      setStatus({ state: "idle", lastSync: account.lastSync });
      return "ok";
    }
    if ((await hashItems(snapshot(account.categories))) !== account.syncedHash) {
      setStatus({ state: "conflict", lastSync: account.lastSync });
      return "conflict";
    }
    applyPayload(payload, account.categories);
    const lastSync = Date.now();
    saveSyncAccount({ ...account, version, syncedHash: await hashItems(snapshot(account.categories)), lastSync });
    setStatus({ state: "idle", lastSync });
    return "ok";
  } catch (err) {
    setStatus({ state: "error", error: (err as Error).message, lastSync: account.lastSync });
    return "ok";
  }
}

/** "server": take the account's data (reload afterwards). "local": overwrite it with this device's. */
export async function resolveConflict(take: "server" | "local") {
  const account = loadSyncAccount();
  if (!account) return;
  const { version, payload } = await pull(account);
  if (take === "server") {
    applyPayload(payload, account.categories);
    saveSyncAccount({ ...account, version, syncedHash: await hashItems(snapshot(account.categories)), lastSync: Date.now() });
    return;
  }
  saveSyncAccount({ ...account, version, syncedHash: "" });
  setStatus({ state: "idle", lastSync: account.lastSync });
  await syncNow();
}

let pushing = false;
/** Pushes when a synced key changed since the last sync. */
export async function syncNow() {
  const account = loadSyncAccount();
  if (!account || pushing || status.state === "conflict") return;
  const items = snapshot(account.categories);
  const hash = await hashItems(items);
  if (hash === account.syncedHash) return;
  pushing = true;
  setStatus({ state: "syncing", lastSync: account.lastSync });
  try {
    const { version } = await push(account, items);
    const lastSync = Date.now();
    saveSyncAccount({ ...account, version, syncedHash: hash, lastSync });
    setStatus({ state: "idle", lastSync });
  } catch (err) {
    const code = (err as Error).message;
    setStatus({ state: code === "conflict" ? "conflict" : "error", error: code, lastSync: account.lastSync });
  } finally {
    pushing = false;
  }
}

let timer: number | undefined;
export function startAutoSync() {
  if (timer !== undefined) return;
  if (loadSyncAccount() && status.state === "off") setStatus({ state: "idle", lastSync: loadSyncAccount()?.lastSync });
  timer = window.setInterval(() => void syncNow(), 15_000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") void syncNow();
  });
}

export async function setSyncCategories(categories: SyncCategory[]) {
  const account = loadSyncAccount();
  if (!account) return;
  // syncedHash no longer matches the new selection, so the next tick pushes it.
  saveSyncAccount({ ...account, categories, syncedHash: "" });
  await syncNow();
}

/** Adds (random) or removes the password. Re-encrypts under the new key on the server. */
export async function changeSyncPassword(withPassword: boolean) {
  const account = loadSyncAccount();
  if (!account) return;
  const next: SyncAccount = { ...account, password: withPassword ? generatePassword() : undefined };
  const newKeys = await deriveKeys(next.number, next.password);
  const items = snapshot(account.categories);
  // Encrypted with the new key, authorized with the old one, handing over the new auth.
  const k = await deriveKeys(account.number, account.password);
  const data = await encrypt(newKeys.key, { v: 1, categories: account.categories, items });
  const { version } = (await call(
    account.server,
    `/${k.id}`,
    { method: "PUT", body: JSON.stringify({ version: account.version, data, hasPassword: withPassword, newAuth: newKeys.auth }) },
    k.auth
  )) as { version: number };
  saveSyncAccount({ ...next, version, syncedHash: await hashItems(items), lastSync: Date.now() });
  setStatus({ state: "idle", lastSync: Date.now() });
}

/** Unlinks this device only; the account and its data stay on the server. */
export function logoutSyncAccount() {
  saveSyncAccount(null);
  setStatus({ state: "off" });
}

export async function deleteSyncAccount() {
  const account = loadSyncAccount();
  if (!account) return;
  const k = await deriveKeys(account.number, account.password);
  await call(account.server, `/${k.id}`, { method: "DELETE" }, k.auth);
  logoutSyncAccount();
}

/** Link for the QR code: the fragment never reaches any server. */
export function syncLink(account: SyncAccount): string {
  const params = new URLSearchParams({ sync: account.number });
  if (account.password) params.set("syncpw", account.password);
  if (account.server !== DEFAULT_SYNC_SERVER) params.set("syncserver", account.server);
  return `${location.origin}${location.pathname}#${params}`;
}

/** Reads (and strips from the address bar) a link made by syncLink(). */
export function takeSyncLink(): { number: string; password?: string; server: string } | null {
  const params = new URLSearchParams(location.hash.slice(1));
  const number = normalizeAccountNumber(params.get("sync") ?? "");
  if (!number) return null;
  const password = params.get("syncpw") ?? undefined;
  const server = params.get("syncserver") ?? DEFAULT_SYNC_SERVER;
  for (const k of ["sync", "syncpw", "syncserver"]) params.delete(k);
  history.replaceState(null, "", location.pathname + location.search + (params.size ? `#${params}` : ""));
  return { number, password, server };
}

export function recoveryText(account: SyncAccount): string {
  return [
    "WebSpeak3",
    "",
    `Account number: ${formatAccountNumber(account.number)}`,
    ...(account.password ? [`Password: ${account.password}`] : []),
    `Server: ${account.server}`,
    "",
  ].join("\n");
}
