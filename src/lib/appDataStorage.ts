/**
 * App data storage - uses Electrobun app data folder when available.
 * Shared across app instances (built app, dev server) for consistent settings.
 * Falls back to localStorage when backend is unavailable (static build, etc.).
 */

import { isElectrobun } from "../electrobun/env";
import { getRpcAsync } from "../electrobun/renderer";

const cache = new Map<string, string>();
let initPromise: Promise<void> | null = null;
/** True when backend (RPC or dev-server API) is available. When true, we use only backend, not localStorage. */
let useBackend = false;

function isDevServerOrigin(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.location?.hostname === "localhost" || window.location?.hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

async function loadFromBackend(): Promise<Record<string, string> | null> {
  if (isElectrobun()) {
    const r = await getRpcAsync();
    if (r) {
      const res = await r.request.storage_getAll({});
      return res.data;
    }
  }
  if (isDevServerOrigin()) {
    try {
      const res = await fetch("/api/storage/storage_getAll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (res.ok) {
        const json = await res.json();
        return json.data ?? {};
      }
    } catch {
      // Dev server not available
    }
  }
  return null;
}

async function init(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    try {
      const data = await loadFromBackend();
      if (data !== null) {
        useBackend = true;
        for (const [k, v] of Object.entries(data)) cache.set(k, v);
        // Migrate: copy any keys from localStorage into backend (one-time)
        if (typeof localStorage !== "undefined") {
          for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && !cache.has(key)) {
              const v = localStorage.getItem(key);
              if (v != null) {
                cache.set(key, v);
                void persist(key, v);
              }
            }
          }
        }
      } else {
        // No backend: use localStorage, populate cache from it
        if (typeof localStorage !== "undefined") {
          for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key) {
              const v = localStorage.getItem(key);
              if (v != null) cache.set(key, v);
            }
          }
        }
      }
    } catch {
      useBackend = false;
      if (typeof localStorage !== "undefined") {
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key) {
            const v = localStorage.getItem(key);
            if (v != null) cache.set(key, v);
          }
        }
      }
    }
  })();
  return initPromise;
}

async function persist(key: string, value: string): Promise<boolean> {
  if (isElectrobun()) {
    const r = await getRpcAsync();
    if (r) {
      await r.request.storage_set({ key, value });
      return true;
    }
  }
  if (isDevServerOrigin()) {
    try {
      const res = await fetch("/api/storage/storage_set", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, value }),
      });
      return res.ok;
    } catch {
      // ignore
    }
  }
  return false;
}

async function persistRemove(key: string): Promise<boolean> {
  if (isElectrobun()) {
    const r = await getRpcAsync();
    if (r) {
      await r.request.storage_remove({ key });
      return true;
    }
  }
  if (isDevServerOrigin()) {
    try {
      const res = await fetch("/api/storage/storage_remove", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key }),
      });
      return res.ok;
    } catch {
      // ignore
    }
  }
  return false;
}

/**
 * Initialize app data storage. Call early in app bootstrap.
 * Safe to call multiple times.
 */
export function initAppDataStorage(): void {
  void init();
}

/**
 * Ensure storage is initialized. Use before first read if you need backend data.
 */
export async function ensureStorageReady(): Promise<void> {
  await init();
}

/**
 * Sync read - uses cache (populated by init). Falls back to localStorage when !useBackend.
 */
export function getItem(key: string): string | null {
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  if (!useBackend && typeof localStorage !== "undefined") {
    return localStorage.getItem(key);
  }
  return null;
}

/**
 * Sync write - updates cache and persists. Uses backend when available; otherwise localStorage.
 */
export function setItem(key: string, value: string): void {
  cache.set(key, value);
  if (useBackend) {
    void persist(key, value);
  } else if (typeof localStorage !== "undefined") {
    localStorage.setItem(key, value);
  }
}

/**
 * Async write - updates cache and awaits backend persistence when available.
 */
export async function setItemAsync(key: string, value: string): Promise<void> {
  cache.set(key, value);
  if (useBackend) {
    await persist(key, value);
  } else if (typeof localStorage !== "undefined") {
    localStorage.setItem(key, value);
  }
}

/**
 * Sync remove - updates cache and persists.
 */
export function removeItem(key: string): void {
  cache.delete(key);
  if (typeof localStorage !== "undefined") {
    localStorage.removeItem(key);
  }
  if (useBackend) {
    void persistRemove(key);
  }
}

/**
 * Async remove - updates cache and awaits backend persistence when available.
 */
export async function removeItemAsync(key: string): Promise<void> {
  cache.delete(key);
  if (typeof localStorage !== "undefined") {
    localStorage.removeItem(key);
  }
  if (useBackend) {
    await persistRemove(key);
  }
}

/**
 * Remove specific keys from storage. Persists to backend when useBackend.
 */
export async function removeStorageKeys(keys: string[]): Promise<void> {
  for (const key of keys) {
    await removeItemAsync(key);
  }
}

/**
 * Reset window position and size (Electrobun only). No-op when not in Electrobun.
 */
export async function resetWindowState(): Promise<void> {
  if (!isElectrobun()) return;
  const r = await getRpcAsync();
  if (r) {
    try {
      await r.request.storage_resetWindowState({});
    } catch {
      // ignore
    }
  }
}

/**
 * Clear all storage. Persists to backend when useBackend.
 */
export async function clearStorage(): Promise<void> {
  cache.clear();
  if (useBackend) {
    if (isElectrobun()) {
      const r = await getRpcAsync();
      if (r) await r.request.storage_clear({});
    } else if (isDevServerOrigin()) {
      try {
        await fetch("/api/storage/storage_clear", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
      } catch {
        // Ignore
      }
    }
  }
  if (typeof localStorage !== "undefined") {
    localStorage.clear();
  }
}
