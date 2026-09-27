// With storage blocked (privacy settings, some embedded webviews) merely
// touching `localStorage` throws, and dozens of module-level reads would
// leave a blank page. Swap in an in-memory stand-in so the app runs; settings
// just don't survive a reload then. Imported first thing in main.tsx.
try {
  const probe = "__webspeak3_probe__";
  localStorage.setItem(probe, probe);
  localStorage.removeItem(probe);
} catch {
  const data = new Map<string, string>();
  const memory: Storage = {
    get length() {
      return data.size;
    },
    key: (i) => [...data.keys()][i] ?? null,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, String(v)),
    removeItem: (k) => void data.delete(k),
    clear: () => data.clear(),
  };
  Object.defineProperty(window, "localStorage", { value: memory, configurable: true });
}
