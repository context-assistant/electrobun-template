/**
 * Storage keys grouped by category for selective reset.
 * Used when the user chooses which app data to delete.
 */

export type StorageCategoryId =
  | "theme"
  | "layout"
  | "editor"
  | "modelProviders"
  | "dockerContainer"
  | "workspace"
  | "terminal"
  | "windowPosition";

export type StorageCategory = {
  id: StorageCategoryId;
  label: string;
  keys: string[];
  /** When true, requires backend (Electrobun) - e.g. window state is stored by main process */
  requiresBackend?: boolean;
};

export const STORAGE_CATEGORIES: StorageCategory[] = [
  {
    id: "theme",
    label: "Theme preferences",
    keys: [
      "context-assistant.theme.v1",
      "context-assistant.theme.custom-colors.v1",
      "context-assistant.theme-brightness.v1",
      "context-assistant.theme-contrast.v1",
      "context-assistant.theme-saturation.v1",
      "context-assistant.theme-presets.v1",
    ],
  },
  {
    id: "layout",
    label: "Layout preferences",
    keys: [
      "context-assistant.layout.v2",
      "context-assistant.layout.v1",
      "context-assistant.frame-views.v2",
      "context-assistant.editor-split.v1",
      "context-assistant.bottom-maximized.v1",
    ],
  },
  {
    id: "editor",
    label: "Editor preferences",
    keys: [
      "context-assistant.editor-settings.v1",
      "context-assistant.font-size.v1",
    ],
  },
  {
    id: "modelProviders",
    label: "Model provider settings and integrations",
    keys: ["context-assistant.model-providers.v1"],
  },
  {
    id: "dockerContainer",
    label: "Docker and container preferences",
    keys: [
      "context-assistant.env-section.v1",
      "context-assistant.env-section-size.v1",
      "context-assistant.container-visibility.v1",
      "context-assistant.hidden-running-container-ids.v1",
      "context-assistant.active-container.v1",
      "context-assistant.active-container.local.v1",
      "context-assistant.active-container.remote.v1",
    ],
  },
  {
    id: "workspace",
    label: "Workspace settings",
    keys: [
      "context-assistant.workspace-state.v1",
      "context-assistant.files.open-sections.v1",
      "context-assistant.files.section-weights.v1",
      "context-assistant.files.workspace-project-root.v1",
    ],
  },
  {
    id: "terminal",
    label: "Terminal settings",
    keys: [
      "context-assistant.terminal-tabs.v1",
      "context-assistant.bash-aliases.v1",
    ],
  },
  {
    id: "windowPosition",
    label: "Window position and size",
    keys: [],
    requiresBackend: true,
  },
];
