/** Options -> Download (TS3's "Downloads" page). */
export interface DownloadSettings {
  /** "dir": save into the picked folder (browser default when none); "ask": save dialog every time. */
  saveMode: "dir" | "ask";
  showWindowOnStart: boolean;
  closeWindowWhenDone: boolean;
  popupWhenDone: boolean;
  /** KiB/s, 0 = unlimited. */
  uploadLimit: number;
  downloadLimit: number;
  maxUploads: number;
  maxDownloads: number;
}

export const DEFAULT_DOWNLOAD_SETTINGS: DownloadSettings = {
  saveMode: "dir",
  showWindowOnStart: true,
  closeWindowWhenDone: false,
  popupWhenDone: true,
  uploadLimit: 0,
  downloadLimit: 0,
  maxUploads: 2,
  maxDownloads: 2,
};

const SETTINGS_KEY = "webspeak3:download-settings";

export function loadDownloadSettings(): DownloadSettings {
  try {
    return { ...DEFAULT_DOWNLOAD_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") };
  } catch {
    return DEFAULT_DOWNLOAD_SETTINGS;
  }
}

export function saveDownloadSettings(settings: DownloadSettings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

// File System Access API: Chromium only. Elsewhere downloads go wherever the browser puts them.
type PickerWindow = Window & {
  showDirectoryPicker?: (options?: { mode?: "readwrite" }) => Promise<FileSystemDirectoryHandle>;
  showSaveFilePicker?: (options?: { suggestedName?: string }) => Promise<FileSystemFileHandle>;
};
type PermissionHandle = FileSystemHandle & {
  queryPermission?: (d: { mode: "readwrite" }) => Promise<PermissionState>;
  requestPermission?: (d: { mode: "readwrite" }) => Promise<PermissionState>;
};

export const canPickFolder = typeof (window as PickerWindow).showDirectoryPicker === "function";

// A directory handle survives reloads only in IndexedDB (it can't be JSON'd).
function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("webspeak3-downloads", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("handles");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const req = run(open.result.transaction("handles", mode).objectStore("handles"));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    };
  });
}

export async function loadDownloadDir(): Promise<FileSystemDirectoryHandle | null> {
  if (!canPickFolder) return null;
  try {
    return (await withStore("readonly", (s) => s.get("dir"))) ?? null;
  } catch {
    return null;
  }
}

/** Opens the folder picker; null when cancelled. */
export async function pickDownloadDir(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const dir = await (window as PickerWindow).showDirectoryPicker!({ mode: "readwrite" });
    await withStore("readwrite", (s) => s.put(dir, "dir"));
    return dir;
  } catch {
    return null;
  }
}

export async function clearDownloadDir(): Promise<void> {
  await withStore("readwrite", (s) => s.delete("dir")).catch(() => {});
}

/** Where a finished download goes; resolved at click time, while the user gesture
 *  still lets us show a save dialog or ask for folder permission. null = browser default. */
export type SaveTarget = FileSystemFileHandle | null;

export async function resolveSaveTarget(
  settings: DownloadSettings,
  dir: FileSystemDirectoryHandle | null,
  filename: string
): Promise<SaveTarget | "cancelled"> {
  const w = window as PickerWindow;
  if (settings.saveMode === "ask" && w.showSaveFilePicker) {
    try {
      return await w.showSaveFilePicker({ suggestedName: filename });
    } catch {
      return "cancelled";
    }
  }
  if (!dir) return null;
  const handle = dir as PermissionHandle;
  try {
    if ((await handle.queryPermission?.({ mode: "readwrite" })) !== "granted" &&
        (await handle.requestPermission?.({ mode: "readwrite" })) !== "granted")
      return null;
    return await dir.getFileHandle(filename, { create: true });
  } catch {
    return null;
  }
}

/** Writes into the chosen file; false means fall back to a normal browser download. */
export async function writeToTarget(target: SaveTarget, blob: Blob): Promise<boolean> {
  if (!target) return false;
  try {
    const writable = await target.createWritable();
    await writable.write(blob);
    await writable.close();
    return true;
  } catch {
    return false;
  }
}
