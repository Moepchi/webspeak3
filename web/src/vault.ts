// Options -> Sicherheit -> "Master Passwort benutzen". The keys below hold secrets
// (identity private keys, server/channel passwords, the store admin token). With a
// master password they live AES-GCM encrypted in one localStorage entry and only in
// memory once unlocked. Like storageFallback.ts, this swaps window.localStorage for
// a stand-in, so the dozens of plain localStorage reads in the app keep working.
// main.tsx unlocks before importing App, whose module-level code reads these keys.

export const PROTECTED_KEYS = [
  "webspeak3:identities",
  "webspeak3:identity",
  "webspeak3:favorites",
  "webspeak3:channel-passwords",
  "webspeak3:store-admin-token",
];

const VAULT_KEY = "webspeak3:vault";
const ITERATIONS = 310_000;

interface StoredVault {
  salt: string;
  iv: string;
  data: string;
}

const real = window.localStorage;
let unlocked: { key: CryptoKey; salt: Uint8Array; secrets: Map<string, string> } | null = null;

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations: ITERATIONS, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export const hasVault = () => real.getItem(VAULT_KEY) !== null;
export const isVaultUnlocked = () => unlocked !== null;

// Writes are chained so an older encryption never lands after a newer one.
let writing: Promise<void> = Promise.resolve();
function persist(): Promise<void> {
  writing = writing.then(async () => {
    if (!unlocked) return;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plain = new TextEncoder().encode(JSON.stringify(Object.fromEntries(unlocked.secrets)));
    const data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, unlocked.key, plain));
    real.setItem(VAULT_KEY, JSON.stringify({ salt: b64(unlocked.salt), iv: b64(iv), data: b64(data) } satisfies StoredVault));
  });
  return writing;
}

function installProxy(): void {
  const secrets = () => unlocked!.secrets;
  const isProtected = (k: string) => PROTECTED_KEYS.includes(k);
  const proxy: Storage = {
    get length() {
      return real.length + secrets().size;
    },
    key: (i) => (i < real.length ? real.key(i) : ([...secrets().keys()][i - real.length] ?? null)),
    getItem: (k) => (isProtected(k) ? (secrets().get(k) ?? null) : real.getItem(k)),
    setItem: (k, v) => {
      if (!isProtected(k)) return real.setItem(k, v);
      secrets().set(k, String(v));
      void persist();
    },
    removeItem: (k) => {
      if (!isProtected(k)) return real.removeItem(k);
      secrets().delete(k);
      void persist();
    },
    clear: () => {
      real.clear();
      secrets().clear();
    },
  };
  // Object.keys(localStorage) has to see real keys too.
  for (let i = 0; i < real.length; i++) {
    const k = real.key(i)!;
    if (k !== VAULT_KEY) Object.defineProperty(proxy, k, { get: () => real.getItem(k), enumerable: true, configurable: true });
  }
  Object.defineProperty(window, "localStorage", { value: proxy, configurable: true });
}

async function openStored(password: string) {
  await writing;
  const stored: StoredVault = JSON.parse(real.getItem(VAULT_KEY)!);
  const salt = unb64(stored.salt);
  const key = await deriveKey(password, salt);
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(stored.iv) as BufferSource }, key, unb64(stored.data) as BufferSource);
    return { key, salt, secrets: new Map<string, string>(Object.entries(JSON.parse(new TextDecoder().decode(plain)))) };
  } catch {
    return null; // wrong password
  }
}

/** false = wrong password. */
export async function unlockVault(password: string): Promise<boolean> {
  unlocked = await openStored(password);
  if (unlocked) installProxy();
  return unlocked !== null;
}

/** Re-asks the current password before changing or removing it. */
export const checkMasterPassword = async (password: string) => (await openStored(password)) !== null;

/** Turns the master password on, or changes it when already on. */
export async function setMasterPassword(password: string): Promise<void> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(password, salt);
  if (unlocked) {
    unlocked = { ...unlocked, key, salt };
  } else {
    const secrets = new Map<string, string>();
    for (const k of PROTECTED_KEYS) {
      const v = real.getItem(k);
      if (v !== null) secrets.set(k, v);
    }
    unlocked = { key, salt, secrets };
    installProxy();
  }
  await persist();
  for (const k of PROTECTED_KEYS) real.removeItem(k);
}

/** Turns it off: secrets go back to plain localStorage. */
export async function removeMasterPassword(): Promise<void> {
  if (!unlocked) return;
  await writing;
  for (const [k, v] of unlocked.secrets) real.setItem(k, v);
  real.removeItem(VAULT_KEY);
  unlocked = null;
  Object.defineProperty(window, "localStorage", { value: real, configurable: true });
}

/** "Passwort vergessen": drops the encrypted data for good. */
export function discardVault(): void {
  real.removeItem(VAULT_KEY);
}
