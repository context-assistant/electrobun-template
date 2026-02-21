import { readJSON, writeJSON } from "./localStorage";

const STORAGE_KEY = "context-assistant.editor-settings.v1";

export type EditorGlobalSettings = {
  lineNumbers: boolean;
  miniMap: boolean;
};

const DEFAULTS: EditorGlobalSettings = {
  lineNumbers: true,
  miniMap: false,
};

export function getStoredEditorSettings(): EditorGlobalSettings {
  const raw = readJSON<Partial<EditorGlobalSettings>>(STORAGE_KEY);
  if (!raw || typeof raw !== "object") return { ...DEFAULTS };
  return {
    lineNumbers: typeof raw.lineNumbers === "boolean" ? raw.lineNumbers : DEFAULTS.lineNumbers,
    miniMap: typeof raw.miniMap === "boolean" ? raw.miniMap : DEFAULTS.miniMap,
  };
}

export function setStoredEditorSettings(settings: EditorGlobalSettings) {
  writeJSON(STORAGE_KEY, settings);
}
