const THEME_BYPASS_CHANGED_EVENT = "context-assistant:theme-bypass-changed";

let bypassActive = false;

export function isThemeBypassActive(): boolean {
  return bypassActive;
}

export function setThemeBypassActive(value: boolean): void {
  if (bypassActive === value) return;
  bypassActive = value;
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(THEME_BYPASS_CHANGED_EVENT));
  }
}

export function onThemeBypassChanged(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = () => listener();
  window.addEventListener(THEME_BYPASS_CHANGED_EVENT, handler);
  return () => window.removeEventListener(THEME_BYPASS_CHANGED_EVENT, handler);
}
