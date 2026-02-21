export function readSessionJSON<T>(key: string): T | undefined {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return undefined;
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function areStorageWritesSuspended() {
  return Boolean((globalThis as any).__contextAssistantStorageResetInProgress);
}

export function writeSessionJSON(key: string, value: unknown) {
  if (areStorageWritesSuspended()) return;
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore (private mode, quota exceeded, etc.)
  }
}
