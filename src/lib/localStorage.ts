import { getItem, setItem, removeItem, initAppDataStorage } from "./appDataStorage";

// Ensure app data storage is initialized (uses Electrobun app data folder when available)
initAppDataStorage();

/** Raw string get (use readJSON for JSON values) */
export { getItem } from "./appDataStorage";

/** Raw string set (use writeJSON for JSON values) */
export { setItem } from "./appDataStorage";

/** Raw string remove */
export { removeItem } from "./appDataStorage";

export function readJSON<T>(key: string): T | undefined {
  try {
    const raw = getItem(key);
    if (!raw) return undefined;
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function areStorageWritesSuspended() {
  return Boolean((globalThis as any).__contextAssistantStorageResetInProgress);
}

export function writeJSON(key: string, value: unknown) {
  if (areStorageWritesSuspended()) return;
  try {
    setItem(key, JSON.stringify(value));
  } catch {
    // ignore (private mode, quota exceeded, etc.)
  }
}
