import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  Eye,
  PanelBottom,
  PanelLeft,
  Settings2,
} from "lucide-react";
import { CustomSelect } from "../components/CustomSelect";
import {
  FrameKebabMenu,
  FrameTabBar,
  type FrameTab,
} from "../components/FrameTabBar";
import { IconButton } from "../components/IconButton";
import { SettingsModal } from "../components/SettingsModal";
import {
  readJSON,
  writeJSON,
  getItem,
  setItem,
  removeItem,
} from "../lib/localStorage";
import { readSessionJSON } from "../lib/sessionStorage";
import {
  DEFAULT_MODEL_PROVIDER_INTEGRATIONS_STATE,
  onModelProvidersStateChanged,
  readModelProviderIntegrationsState,
  readModelProvidersState,
  type RemoteSshEndpoint,
  writeModelProviderIntegrationsState,
} from "../lib/appStorage";
import {
  applyTheme,
  getStoredTheme,
  onStoredThemeChanged,
  type AppTheme,
} from "../lib/theme";
import {
  getStoredThemeBrightness,
  onStoredThemeBrightnessChanged,
} from "../lib/themeBrightness";
import {
  getStoredThemeContrast,
  onStoredThemeContrastChanged,
} from "../lib/themeContrast";
import {
  getStoredThemeSaturation,
  onStoredThemeSaturationChanged,
} from "../lib/themeSaturation";
import { isThemeBypassActive, onThemeBypassChanged } from "../lib/themeBypass";
import { applyStoredFontSize } from "../lib/fontSize.ts";
import {
  EDITOR_THEME_OPTIONS,
  getEditorThemeSelectOptions,
  isEditorThemeOption,
  isMainEditorPaneTheme,
  MAIN_EDITOR_THEME_MATCH_APP,
  SPLIT_EDITOR_THEME_MATCH,
  TERMINAL_THEME_MATCH_MAIN,
  type MainEditorPaneTheme,
  type SplitEditorPaneTheme,
} from "../lib/editorThemes";
import { CodeEditor, type VimHost } from "../components/CodeEditor.tsx";
import { DiffViewer } from "../components/DiffViewer";
import { MarkdownPreviewPane } from "../components/MarkdownPreviewPane";
import { PreviewPane } from "../components/PreviewPane";
import { EnvironmentView } from "../components/EnvironmentView";
import { OllamaView } from "../components/OllamaView";
import {
  type TerminalTabDescriptor,
  SingleTerminalPane,
} from "../components/ContainerTerminal";
import { ContainerLogsTab } from "../components/ContainerLogsTab";
import {
  ContainerInspectTab,
  type InspectModelTarget,
} from "../components/ContainerInspectTab";
import { TerminalLaunchMenu } from "../components/TerminalLaunchMenu";
import * as dockerClient from "../lib/docker";
import * as ollamaClient from "../lib/ollama";
import { useDockerContainers } from "../lib/useDockerContainers";
import { type ModelProviderConfig, type ProviderModel } from "../lib/modelProviders";
import { getPrimaryContainerShell } from "../lib/containerShells";
import type { AIModelInfo, ContainerInfo } from "../electrobun/rpcSchema";
import { isElectrobun } from "../electrobun/env";
import {
  getStoredEditorSettings,
  setStoredEditorSettings,
  type EditorGlobalSettings,
} from "../lib/editorSettings";
import {
  getPreviewDescriptor,
  isLikelyBinaryDecodedContent,
  isMarkdownPath,
  isPreviewBackedByTextBufferPath,
} from "../lib/preview";
import { useInAppDialogs } from "../context/InAppDialogsContext";

import logoUrl from "../design/logo.svg";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type LayoutState = {
  showLeft: boolean;
  showRight: boolean;
  showBottom: boolean;
  leftWidth: number;
  rightWidth: number;
  bottomHeight: number;
};

type FrameId = "top" | "bottom";
type LeftView = "docker-local" | "ollama-local";
type TopView = "editor-split" | "diff-viewer";
type RightView = "chat" | "generate" | "sessions";

type FrameViewsState = {
  left: LeftView;
  top: TopView;
  right: RightView;
};
type FocusFrame = "left" | FrameId;

type SplitMode = "single" | "row" | "column";
type PaneId = "primary" | "secondary";
type EditorTabKind = "temporary" | "edit";
type EditorTabView = "editor" | "preview" | "terminal" | "logs" | "inspect";

/** Simplified file role — everything lives in /workspace now. */
type FileRole = "user";

type EditorPaneTheme = (typeof EDITOR_THEME_OPTIONS)[number];

type EditorPaneState = {
  lineWrap: boolean;
  vimMode: boolean;
  theme: SplitEditorPaneTheme;
};

type TopSplitState = {
  mode: SplitMode;
  splitRatio: number;
  primary: EditorPaneState;
  secondary: EditorPaneState;
};

type LogsTabState = {
  containerId: string | null;
};

type InspectTabState = {
  containerId: string | null;
  modelTarget: InspectModelTarget | null;
};

type EditorTab = {
  id: string;
  path: string;
  role: FileRole;
  label: string;
  kind: EditorTabKind;
  view: EditorTabView;
  terminalDescriptor?: TerminalTabDescriptor;
  logsState?: LogsTabState;
  inspectState?: InspectTabState;
};

type PaneTabsState = {
  tabs: EditorTab[];
  activeTabId: string | null;
  renameTabId: string | null;
  renameDraft: string;
};

type EditorTabsState = {
  primary: PaneTabsState;
  secondary: PaneTabsState;
};

type FileBufferState = {
  content: string;
  loading: boolean;
  dirty: boolean;
  saving: boolean;
  error: string | null;
};

type FileBrowserRevealRequest = {
  nonce: number;
  path: string;
  kind: "file" | "directory";
};

type EditorFocusRequest = {
  nonce: number;
  frameId: FrameId;
  paneId: PaneId;
};

type DiffViewerState = {
  path: string;
  leftLabel: string;
  rightLabel: string;
  leftValue: string;
  rightValue: string;
};

type PersistedPaneTabsState = {
  tabs: EditorTab[];
  activeTabId: string | null;
};

type PersistedEditorTabsState = {
  focusedPane: PaneId;
  primary: PersistedPaneTabsState;
  secondary: PersistedPaneTabsState;
};

type PersistedFocusedPaneByFrame = {
  top?: PaneId;
  bottom?: PaneId;
};

type PersistedContainerEditorState = {
  topSplit?: Partial<TopSplitState>;
  editorTabs?: PersistedEditorTabsState;
};

type PersistedWorkspaceState = {
  version: 1 | 2;
  topSplit?: Partial<TopSplitState>;
  bottomSplit?: Partial<TopSplitState>;
  focusedPane?: PaneId;
  focusedEditorFrame?: FrameId;
  focusedPaneByFrame?: PersistedFocusedPaneByFrame;
  editorTabs?: {
    primary?: PersistedPaneTabsState;
    secondary?: PersistedPaneTabsState;
  };
  bottomEditorTabs?: {
    primary?: PersistedPaneTabsState;
    secondary?: PersistedPaneTabsState;
  };
  fileBuffers?: Record<string, FileBufferState>;
  pendingSaveAsPaths?: Record<string, boolean>;
};

// ---------------------------------------------------------------------------
// Constants & helpers
// ---------------------------------------------------------------------------

const LAYOUT_SESSION_KEY = "context-assistant.layout.v2";
const LEGACY_LAYOUT_LOCAL_KEY = "context-assistant.layout.v1";
const VIEWS_SESSION_KEY = "context-assistant.frame-views.v2";
const TOP_SPLIT_SESSION_KEY = "context-assistant.editor-split.v1";
const BOTTOM_MAXIMIZED_SESSION_KEY = "context-assistant.bottom-maximized.v1";
const WORKSPACE_STATE_KEY = "context-assistant.workspace-state.v1";
const LEGACY_TERMINAL_TABS_STORAGE_KEY = "context-assistant.terminal-tabs.v1";
const LEGACY_ACTIVE_CONTAINER_KEY = "context-assistant.active-container.v1";
const LOCAL_ACTIVE_CONTAINER_KEY =
  "context-assistant.active-container.local.v1";
const CONTAINER_EDITOR_STATE_FILE =
  "/tmp/context-assistant-container-editor-state.v1.json";
const EDITOR_TAB_DRAG_MIME = "application/x-context-assistant-editor-tab";
const FILE_BROWSER_DND_MIME =
  "application/x-context-assistant-file-browser-entry";

type FileBrowserDragPayload = {
  kind: "file" | "folder";
  path: string;
  role: FileRole;
};

const DEFAULTS: LayoutState = {
  showLeft: true,
  showRight: false,
  showBottom: true,
  leftWidth: 320,
  rightWidth: 360,
  bottomHeight: 260,
};

const DEFAULT_FRAME_VIEWS: FrameViewsState = {
  left: "docker-local",
  top: "editor-split",
  right: "chat",
};

const DEFAULT_PANE_STATE: EditorPaneState = {
  lineWrap: false,
  // turn vim mode back on before prod
  vimMode: true,
  theme: MAIN_EDITOR_THEME_MATCH_APP,
};

const DEFAULT_SPLIT_STATE: TopSplitState = {
  mode: "single",
  splitRatio: 0,
  primary: DEFAULT_PANE_STATE,
  secondary: { ...DEFAULT_PANE_STATE, theme: MAIN_EDITOR_THEME_MATCH_APP },
};

const EMPTY_PANE_TABS: PaneTabsState = {
  tabs: [],
  activeTabId: null,
  renameTabId: null,
  renameDraft: "",
};

const clamp = (n: number, min: number, max: number) =>
  Math.min(max, Math.max(min, n));

const isEditorPaneTheme = isEditorThemeOption;

const coerceSplitRatio = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value)
    ? clamp(value, 0.1, 0.9)
    : 0.5;

const normalizeFilePath = (path: string) =>
  path.replaceAll("\\", "/").replace(/^\/+/, "").replace(/\/+/g, "/").trim();

const toBufferKey = (role: FileRole, path: string) =>
  `${role}:${normalizeFilePath(path)}`;

const toContainerAbsolutePath = (path: string) => {
  const normalized = normalizeFilePath(path);
  return normalized.length > 0 ? `/${normalized}` : "/";
};

const getFileName = (path: string) => {
  const segments = normalizeFilePath(path).split("/").filter(Boolean);
  return segments[segments.length - 1] ?? path;
};

const getParentPath = (path: string) => {
  const segments = normalizeFilePath(path).split("/").filter(Boolean);
  if (segments.length <= 1) return "";
  return segments.slice(0, -1).join("/");
};

const makeTabId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

const getDefaultEditViewForPath = (path: string): EditorTabView =>
  getPreviewDescriptor(path) ? "preview" : "editor";

const getTemporaryFileBrowserViewForPath = (path: string): EditorTabView =>
  isMarkdownPath(path) || getPreviewDescriptor(path) ? "preview" : "editor";

const getEditViewForPath = (path: string): EditorTabView =>
  isPreviewBackedByTextBufferPath(path)
    ? "editor"
    : getDefaultEditViewForPath(path);

const tabUsesTextBuffer = (tab: EditorTab): boolean =>
  tab.view === "editor"
  || (tab.view === "preview" && isPreviewBackedByTextBufferPath(tab.path));

const makeTerminalEditorTab = (
  descriptor: TerminalTabDescriptor,
  kind: EditorTabKind = "edit",
): EditorTab => {
  const id = makeTabId();
  const tabLabel = descriptor.label?.trim();
  const containerLabel = descriptor.containerName?.trim();
  const fallbackLabel =
    descriptor.modelName?.trim().split(/[/:]/).pop() ||
    (descriptor.kind === "shell" ? "terminal" : descriptor.kind);
  const label = [
    tabLabel && tabLabel.length > 0 ? tabLabel : fallbackLabel,
    containerLabel,
  ]
    .filter(Boolean)
    .join(" · ");
  return {
    id,
    path: `__terminal__/${id}`,
    role: "user",
    label,
    kind,
    view: "terminal",
    terminalDescriptor: descriptor,
  };
};

const getLogsTabLabel = (
  containers: ContainerInfo[],
  containerId: string | null,
): string => {
  if (!containerId) return "Logs";
  const container = containers.find((entry) => entry.id === containerId);
  return container?.name?.trim() ? `Logs · ${container.name}` : "Logs";
};

const getInspectTabLabel = (
  containers: ContainerInfo[],
  state: InspectTabState,
): string => {
  const modelName = state.modelTarget?.modelName?.trim();
  if (modelName) return `Inspect · ${modelName}`;
  if (!state.containerId) return "Inspect";
  const container = containers.find((entry) => entry.id === state.containerId);
  return container?.name?.trim() ? `Inspect · ${container.name}` : "Inspect";
};

const makeLogsEditorTab = (
  containers: ContainerInfo[],
  containerId: string | null,
  kind: EditorTabKind = "temporary",
): EditorTab => {
  const id = makeTabId();
  return {
    id,
    path: `__logs__/${id}`,
    role: "user",
    label: getLogsTabLabel(containers, containerId),
    kind,
    view: "logs",
    logsState: { containerId },
  };
};

const makeInspectEditorTab = (
  containers: ContainerInfo[],
  inspectState: InspectTabState,
  kind: EditorTabKind = "temporary",
): EditorTab => {
  const id = makeTabId();
  return {
    id,
    path: `__inspect__/${id}`,
    role: "user",
    label: getInspectTabLabel(containers, inspectState),
    kind,
    view: "inspect",
    inspectState,
  };
};

const isTerminalTabDescriptor = (
  value: unknown,
): value is TerminalTabDescriptor => {
  if (!value || typeof value !== "object") return false;
  const descriptor = value as Partial<TerminalTabDescriptor>;
  const kind = descriptor.kind;
  return (
    kind === "shell" ||
    kind === "local-shell" ||
    kind === "remote-shell" ||
    kind === "model-run" ||
    kind === "docker-run" ||
    kind === "ollama-run" ||
    kind === "ollama-pull" ||
    kind === "docker-image-pull" ||
    kind === "docker-model-pull"
  );
};

const isLogsTabState = (value: unknown): value is LogsTabState => {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<LogsTabState>;
  return state.containerId === null || typeof state.containerId === "string";
};

const isInspectTabState = (value: unknown): value is InspectTabState => {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<InspectTabState>;
  const modelTarget = state.modelTarget;
  const validModelTarget =
    modelTarget === null
    || modelTarget === undefined
    || (
      typeof modelTarget === "object"
      && (
        (modelTarget as Partial<InspectModelTarget>).source === "docker"
        || (modelTarget as Partial<InspectModelTarget>).source === "ollama"
      )
      && typeof (modelTarget as Partial<InspectModelTarget>).modelName === "string"
    );
  return (
    (state.containerId === null || state.containerId === undefined || typeof state.containerId === "string")
    && validModelTarget
  );
};

const sanitizePaneTabsState = (
  value: PersistedPaneTabsState | undefined,
): PaneTabsState => {
  const tabs: EditorTab[] = (value?.tabs ?? [])
    .map((tab) => {
      if (
        tab.view === "terminal" &&
        isTerminalTabDescriptor(tab.terminalDescriptor)
      ) {
        const id = typeof tab.id === "string" ? tab.id : makeTabId();
        const tabLabel = typeof tab.label === "string" ? tab.label.trim() : "";
        const descriptorLabel = tab.terminalDescriptor.label?.trim() ?? "";
        const containerLabel = tab.terminalDescriptor.containerName?.trim();
        const fallbackLabel =
          tab.terminalDescriptor.modelName?.trim().split(/[/:]/).pop() ||
          (tab.terminalDescriptor.kind === "shell"
            ? "terminal"
            : tab.terminalDescriptor.kind);
        const label =
          tabLabel ||
          descriptorLabel ||
          [fallbackLabel, containerLabel].filter(Boolean).join(" · ");
        return {
          id,
          path: `__terminal__/${id}`,
          role: "user" as FileRole,
          label,
          kind: "edit" as EditorTabKind,
          view: "terminal" as EditorTabView,
          terminalDescriptor: tab.terminalDescriptor,
        };
      }
      if (tab.view === "logs" && isLogsTabState(tab.logsState)) {
        const id = typeof tab.id === "string" ? tab.id : makeTabId();
        return {
          id,
          path: `__logs__/${id}`,
          role: "user" as FileRole,
          label:
            typeof tab.label === "string" && tab.label.trim().length > 0
              ? tab.label.trim()
              : "Logs",
          kind: (tab.kind === "edit" ? "edit" : "temporary") as EditorTabKind,
          view: "logs" as EditorTabView,
          logsState: {
            containerId: tab.logsState.containerId ?? null,
          },
        };
      }
      if (tab.view === "inspect" && isInspectTabState(tab.inspectState)) {
        const id = typeof tab.id === "string" ? tab.id : makeTabId();
        return {
          id,
          path: `__inspect__/${id}`,
          role: "user" as FileRole,
          label:
            typeof tab.label === "string" && tab.label.trim().length > 0
              ? tab.label.trim()
              : "Inspect",
          kind: (tab.kind === "edit" ? "edit" : "temporary") as EditorTabKind,
          view: "inspect" as EditorTabView,
          inspectState: {
            containerId: tab.inspectState.containerId ?? null,
            modelTarget: tab.inspectState.modelTarget ?? null,
          },
        };
      }
      return {
        id: typeof tab.id === "string" ? tab.id : makeTabId(),
        path: normalizeFilePath(String(tab.path ?? "")),
        role: "user" as FileRole,
        label: getFileName(String(tab.path ?? "")),
        kind: (tab.kind === "edit" ? "edit" : "temporary") as EditorTabKind,
        view:
          tab.view === "preview" || tab.view === "editor"
            ? tab.view
            : getDefaultEditViewForPath(String(tab.path ?? "")),
      };
    })
    .filter((tab) => tab.path.length > 0);
  const activeTabId =
    typeof value?.activeTabId === "string" &&
    tabs.some((tab) => tab.id === value.activeTabId)
      ? value.activeTabId
      : (tabs[0]?.id ?? null);
  return { tabs, activeTabId, renameTabId: null, renameDraft: "" };
};

const sanitizeTopSplitState = (
  value: Partial<TopSplitState> | undefined,
): TopSplitState => ({
  ...DEFAULT_SPLIT_STATE,
  ...value,
  splitRatio: coerceSplitRatio(value?.splitRatio),
  primary: {
    ...DEFAULT_PANE_STATE,
    ...value?.primary,
    theme: isMainEditorPaneTheme(value?.primary?.theme)
      ? value.primary.theme
      : DEFAULT_PANE_STATE.theme,
  },
  secondary: {
    ...DEFAULT_PANE_STATE,
    ...value?.secondary,
    theme:
      value?.secondary?.theme === SPLIT_EDITOR_THEME_MATCH ||
      isMainEditorPaneTheme(value?.secondary?.theme)
        ? value.secondary.theme
        : DEFAULT_SPLIT_STATE.secondary.theme,
  },
});

const sanitizeFileBufferState = (value: unknown): FileBufferState | null => {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<FileBufferState>;
  if (typeof candidate.content !== "string") return null;
  return {
    content: candidate.content,
    loading: Boolean(candidate.loading),
    dirty: Boolean(candidate.dirty),
    saving: Boolean(candidate.saving),
    error: typeof candidate.error === "string" ? candidate.error : null,
  };
};

const sanitizeFileBuffers = (
  value: unknown,
): Record<string, FileBufferState> => {
  if (!value || typeof value !== "object") return {};
  const result: Record<string, FileBufferState> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof key !== "string" || key.trim().length === 0) continue;
    const next = sanitizeFileBufferState(raw);
    if (!next) continue;
    result[key] = next;
  }
  return result;
};

const sanitizePendingSaveAsPaths = (
  value: unknown,
): Record<string, boolean> => {
  if (!value || typeof value !== "object") return {};
  const result: Record<string, boolean> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof key !== "string" || key.trim().length === 0) continue;
    if (typeof raw !== "boolean") continue;
    result[key] = raw;
  }
  return result;
};

const sanitizeFocusedPane = (value: unknown): PaneId =>
  value === "secondary" ? "secondary" : "primary";

const readLegacyBottomEditorTabs = (): EditorTabsState | null => {
  const persisted = readJSON<{
    tabs?: TerminalTabDescriptor[];
    activeSessionId?: string | null;
  }>(LEGACY_TERMINAL_TABS_STORAGE_KEY);
  const descriptors = Array.isArray(persisted?.tabs)
    ? persisted.tabs.filter(isTerminalTabDescriptor)
    : [];
  if (descriptors.length === 0) return null;
  const tabs = descriptors.map((descriptor) => makeTerminalEditorTab(descriptor));
  const activeBySession =
    typeof persisted?.activeSessionId === "string"
      ? tabs.find(
          (tab) => tab.terminalDescriptor?.sessionId === persisted.activeSessionId,
        )?.id ?? null
      : null;
  return {
    primary: {
      tabs,
      activeTabId: activeBySession ?? tabs[0]?.id ?? null,
      renameTabId: null,
      renameDraft: "",
    },
    secondary: { ...EMPTY_PANE_TABS },
  };
};

const readPersistedWorkspaceState = (): PersistedWorkspaceState | null => {
  const persisted = readJSON<PersistedWorkspaceState>(WORKSPACE_STATE_KEY);
  if (!persisted || typeof persisted !== "object") return null;
  if (persisted.version !== 1 && persisted.version !== 2) return null;
  return persisted;
};

// ============================================================================
// AppLayout
// ============================================================================

export function AppLayout() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [appTheme, setAppTheme] = useState<AppTheme>(() => getStoredTheme());
  const [appThemePreview, setAppThemePreview] = useState<AppTheme | null>(null);
  const [themeBrightness, setThemeBrightness] = useState(() =>
    getStoredThemeBrightness(),
  );
  const [themeContrast, setThemeContrast] = useState(() =>
    getStoredThemeContrast(),
  );
  const [themeSaturation, setThemeSaturation] = useState(() =>
    getStoredThemeSaturation(),
  );
  const [themeBypass, setThemeBypass] = useState(() => isThemeBypassActive());
  const [integrationSettings, setIntegrationSettings] = useState(
    DEFAULT_MODEL_PROVIDER_INTEGRATIONS_STATE,
  );
  const { askPrompt, askConfirm } = useInAppDialogs();
  const [vimMessageModal, setVimMessageModal] = useState<{
    title: string;
    message: string;
  } | null>(null);

  useEffect(() => {
    if (!vimMessageModal) return;
    const dismissVimMessageOnKeydown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      (
        event as KeyboardEvent & { stopImmediatePropagation?: () => void }
      ).stopImmediatePropagation?.();
      setVimMessageModal(null);
    };
    window.addEventListener("keydown", dismissVimMessageOnKeydown, true);
    return () =>
      window.removeEventListener("keydown", dismissVimMessageOnKeydown, true);
  }, [vimMessageModal]);

  // Apply persisted theme and font-size on initial mount.
  useEffect(() => {
    const cleanup = applyTheme(appTheme);
    applyStoredFontSize();
    return cleanup;
  }, [appTheme, themeBrightness, themeContrast, themeSaturation, themeBypass]);

  useEffect(() => {
    const unsub = onStoredThemeChanged(() => setAppTheme(getStoredTheme()));
    return unsub;
  }, []);

  useEffect(() => {
    const unsub = onStoredThemeBrightnessChanged(() =>
      setThemeBrightness(getStoredThemeBrightness()),
    );
    return unsub;
  }, []);

  useEffect(() => {
    const unsub = onStoredThemeContrastChanged(() =>
      setThemeContrast(getStoredThemeContrast()),
    );
    return unsub;
  }, []);

  useEffect(() => {
    const unsub = onStoredThemeSaturationChanged(() =>
      setThemeSaturation(getStoredThemeSaturation()),
    );
    return unsub;
  }, []);

  useEffect(() => {
    const unsub = onThemeBypassChanged(() =>
      setThemeBypass(isThemeBypassActive()),
    );
    return unsub;
  }, []);

  // ---- Layout state ----
  const [layout, setLayout] = useState<LayoutState>(() => {
    const raw =
      readJSON<Partial<LayoutState>>(LAYOUT_SESSION_KEY) ??
      readSessionJSON<Partial<LayoutState>>(LAYOUT_SESSION_KEY) ??
      readJSON<Partial<LayoutState>>(LEGACY_LAYOUT_LOCAL_KEY);
    return { ...DEFAULTS, ...raw };
  });
  const [bottomMaximized, setBottomMaximized] = useState<boolean>(() => {
    const persisted = readJSON<boolean>(BOTTOM_MAXIMIZED_SESSION_KEY);
    return typeof persisted === "boolean" ? persisted : false;
  });
  const bottomRestoreHeightRef = useRef<number | null>(null);
  const [frameViews, setFrameViews] = useState<FrameViewsState>(() => ({
    ...(() => {
      const persisted =
        readJSON<Partial<FrameViewsState>>(VIEWS_SESSION_KEY) ??
        readSessionJSON<Partial<FrameViewsState>>(VIEWS_SESSION_KEY);
      const persistedLeft = persisted?.left as unknown;
      const migratedLeft: LeftView | undefined =
        persistedLeft === "files" ||
        persistedLeft === "volumes" ||
        persistedLeft === "container-files"
          ? "docker-local"
          : persistedLeft === "environment"
            ? "docker-local"
            : persistedLeft === "ollama"
              ? "ollama-local"
              : persistedLeft === "docker-remote"
                ? "docker-local"
                : persistedLeft === "ollama-remote"
                  ? "ollama-local"
                  : (persisted?.left as LeftView | undefined);
      return {
        ...DEFAULT_FRAME_VIEWS,
        ...persisted,
        left: migratedLeft ?? DEFAULT_FRAME_VIEWS.left,
      };
    })(),
  }));
  const [topSplit, setTopSplit] = useState<TopSplitState>(() => {
    const workspace = readPersistedWorkspaceState();
    if (workspace?.topSplit) {
      return sanitizeTopSplitState(workspace.topSplit);
    }
    const persisted =
      readJSON<Partial<TopSplitState>>(TOP_SPLIT_SESSION_KEY) ??
      readSessionJSON<Partial<TopSplitState>>(TOP_SPLIT_SESSION_KEY);
    return sanitizeTopSplitState(persisted);
  });
  const [bottomSplit, setBottomSplit] = useState<TopSplitState>(() => {
    const workspace = readPersistedWorkspaceState();
    return sanitizeTopSplitState(workspace?.bottomSplit);
  });

  useEffect(() => {
    if (!layout.showBottom && bottomMaximized) {
      setBottomMaximized(false);
      bottomRestoreHeightRef.current = null;
    }
  }, [layout.showBottom, bottomMaximized]);

  // ---- Editor / buffer state ----
  const [focusedEditorFrame, setFocusedEditorFrame] = useState<FrameId>(() => {
    const workspace = readPersistedWorkspaceState();
    return workspace?.focusedEditorFrame === "bottom" ? "bottom" : "top";
  });
  const [focusedPane, setFocusedPane] = useState<PaneId>(() => {
    const workspace = readPersistedWorkspaceState();
    return sanitizeFocusedPane(
      workspace?.focusedPaneByFrame?.top ?? workspace?.focusedPane,
    );
  });
  const [focusedBottomPane, setFocusedBottomPane] = useState<PaneId>(() => {
    const workspace = readPersistedWorkspaceState();
    return sanitizeFocusedPane(workspace?.focusedPaneByFrame?.bottom);
  });
  const [editorTabs, setEditorTabs] = useState<EditorTabsState>(() => {
    const workspace = readPersistedWorkspaceState();
    if (!workspace?.editorTabs) {
      return {
        primary: { ...EMPTY_PANE_TABS },
        secondary: { ...EMPTY_PANE_TABS },
      };
    }
    return {
      primary: sanitizePaneTabsState(workspace.editorTabs.primary),
      secondary: sanitizePaneTabsState(workspace.editorTabs.secondary),
    };
  });
  const [bottomEditorTabs, setBottomEditorTabs] = useState<EditorTabsState>(() => {
    const workspace = readPersistedWorkspaceState();
    if (workspace?.bottomEditorTabs) {
      return {
        primary: sanitizePaneTabsState(workspace.bottomEditorTabs.primary),
        secondary: sanitizePaneTabsState(workspace.bottomEditorTabs.secondary),
      };
    }
    return (
      readLegacyBottomEditorTabs() ?? {
        primary: { ...EMPTY_PANE_TABS },
        secondary: { ...EMPTY_PANE_TABS },
      }
    );
  });
  const hasBottomTabs =
    bottomEditorTabs.primary.tabs.length > 0
    || bottomEditorTabs.secondary.tabs.length > 0;
  const [fileBuffers, setFileBuffers] = useState<
    Record<string, FileBufferState>
  >(() => {
    const workspace = readPersistedWorkspaceState();
    return sanitizeFileBuffers(workspace?.fileBuffers);
  });
  const [fileBrowserRefreshNonce, setFileBrowserRefreshNonce] = useState(0);
  const [fileBrowserRevealRequest, setFileBrowserRevealRequest] =
    useState<FileBrowserRevealRequest | null>(null);
  const [
    fileBrowserWorkingDirectoryByContainerId,
    setFileBrowserWorkingDirectoryByContainerId,
  ] = useState<Record<string, string>>({});
  const [editorFocusRequest, setEditorFocusRequest] =
    useState<EditorFocusRequest | null>(null);
  const [draggedEditorTab, setDraggedEditorTab] = useState<{
    frameId: FrameId;
    paneId: PaneId;
    tabId: string;
  } | null>(null);
  const [pendingSaveAsPaths, setPendingSaveAsPaths] = useState<
    Record<string, boolean>
  >(() => {
    const workspace = readPersistedWorkspaceState();
    return sanitizePendingSaveAsPaths(workspace?.pendingSaveAsPaths);
  });
  const [diffViewerState, setDiffViewerState] =
    useState<DiffViewerState | null>(null);
  const [canToggleRightFrame, setCanToggleRightFrame] = useState(false);
  const [editorSettings, setEditorSettings] = useState<EditorGlobalSettings>(
    () => getStoredEditorSettings(),
  );
  const fileBuffersRef = useRef<Record<string, FileBufferState>>({});
  const editorTabsRef = useRef<EditorTabsState>({
    primary: { ...EMPTY_PANE_TABS },
    secondary: { ...EMPTY_PANE_TABS },
  });
  const bottomEditorTabsRef = useRef<EditorTabsState>({
    primary: { ...EMPTY_PANE_TABS },
    secondary: { ...EMPTY_PANE_TABS },
  });

  useEffect(() => {
    let cancelled = false;
    let lastAppliedJson = "";
    const load = async () => {
      const next = await readModelProviderIntegrationsState();
      if (cancelled) return;
      const nextJson = JSON.stringify(next);
      if (nextJson === lastAppliedJson) return;
      lastAppliedJson = nextJson;
      setIntegrationSettings(next);
    };
    void load();
    const unsub = onModelProvidersStateChanged(() => {
      void load();
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, []);

  const [localOllamaAvailable, setLocalOllamaAvailable] =
    useState<boolean>(false);

  useEffect(() => {
    let cancelled = false;
    void ollamaClient
      .configureOllamaHost(null)
      .then(() => ollamaClient.isOllamaAvailable())
      .then((available) => {
        if (!cancelled) setLocalOllamaAvailable(Boolean(available));
      })
      .catch(() => {
        if (!cancelled) setLocalOllamaAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, [settingsOpen]);

  const hasDockerLocalTab = integrationSettings.dockerUiEnabled;
  const hasOllamaLocalTab =
    integrationSettings.ollamaLocalEnabled && localOllamaAvailable;

  const hasAnyDockerTab = hasDockerLocalTab;
  const effectiveAppTheme = appThemePreview ?? appTheme;
  const mainEditorThemeForTerminal =
    topSplit.primary.theme === MAIN_EDITOR_THEME_MATCH_APP
      ? effectiveAppTheme
      : isEditorPaneTheme(topSplit.primary.theme)
        ? topSplit.primary.theme
        : "tokyo-night";
  const effectiveTerminalTheme =
    integrationSettings.terminalTheme === MAIN_EDITOR_THEME_MATCH_APP
      ? effectiveAppTheme
      : integrationSettings.terminalTheme === TERMINAL_THEME_MATCH_MAIN
        ? mainEditorThemeForTerminal
        : integrationSettings.terminalTheme;
  const hasAnyLeftTabs = hasAnyDockerTab || hasOllamaLocalTab;
  const forceTerminalOnlyLayout = !hasAnyDockerTab;
  const fallbackLeftView: LeftView = hasDockerLocalTab
    ? "docker-local"
    : hasOllamaLocalTab
      ? "ollama-local"
      : "docker-local";
  const activeLeftViewForContext: LeftView =
    (frameViews.left === "docker-local" && hasDockerLocalTab) ||
    (frameViews.left === "ollama-local" && hasOllamaLocalTab)
      ? frameViews.left
      : fallbackLeftView;

  const activeDockerHost: string | null = null;
  const activeOllamaHost: string | null = null;

  const dockerLocalModels = integrationSettings.dockerLocalModels;
  const ollamaLocalModels = integrationSettings.ollamaLocalModels;

  const dockerLocalFallbackAiModels = useMemo<AIModelInfo[]>(
    () =>
      dockerLocalModels.map((model) => ({
        name: model.id,
        id: model.id,
        size: model.size === "Unknown" ? "" : model.size,
        modifiedAt: "",
        status: model.details || "",
        running: false,
      })),
    [dockerLocalModels],
  );

  // ---- Docker environment state ----
  const {
    containers: dockerLocalContainers,
    dockerAvailable: dockerLocalAvailable,
    loading: dockerLocalLoading,
    refresh: refreshDockerLocalContainers,
  } = useDockerContainers(hasDockerLocalTab, null);
  const activeDockerPanelContainers = dockerLocalContainers;
  const effectiveShowLeft = hasAnyLeftTabs && layout.showLeft;
  const effectiveShowBottom = layout.showBottom;
  const effectiveBottomMaximized = effectiveShowBottom && bottomMaximized;
  const [dockerLocalActiveContainerId, setDockerLocalActiveContainerId] =
    useState<string | null>(() => {
      try {
        return (
          getItem(LOCAL_ACTIVE_CONTAINER_KEY) ??
          getItem(LEGACY_ACTIVE_CONTAINER_KEY)
        );
      } catch {
        return null;
      }
    });
  const [activeContainerId, setActiveContainerId] = useState<string | null>(
    () => {
      try {
        return getItem(LEGACY_ACTIVE_CONTAINER_KEY);
      } catch {
        return null;
      }
    },
  );
  const [activeContainerEnvironment, setActiveContainerEnvironment] = useState<
    "docker-local" | null
  >(() => {
    try {
      const localId = getItem(LOCAL_ACTIVE_CONTAINER_KEY);
      const activeId = getItem(LEGACY_ACTIVE_CONTAINER_KEY);
      if (!activeId) return null;
      if (localId && localId === activeId) return "docker-local";
      return "docker-local";
    } catch {
      return null;
    }
  });

  const HOST_CONTAINER_NAME = "context-assistant-host";
  const HIDDEN_RUNNING_CONTAINER_IDS_KEY =
    "context-assistant.hidden-running-container-ids.v1";
  const HIDDEN_RUNNING_CONTAINERS_EVENT =
    "context-assistant:hidden-running-containers-changed";
  const DEFAULT_HIDDEN_RUNNING_CONTAINER_NAMES = new Set<string>([
    "docker-model-runner",
  ]);
  const [hiddenRunningContainerNonce, setHiddenRunningContainerNonce] =
    useState(0);
  const filterHiddenContainers = useCallback((list: ContainerInfo[]) => {
    let hiddenIds = new Set<string>();
    try {
      const stored = getItem(HIDDEN_RUNNING_CONTAINER_IDS_KEY);
      if (stored) {
        const parsed = JSON.parse(stored) as unknown;
        if (Array.isArray(parsed)) {
          hiddenIds = new Set(
            parsed.filter(
              (id): id is string =>
                typeof id === "string" && id.trim().length > 0,
            ),
          );
        }
      }
    } catch {
      // ignore localStorage parsing failures
    }
    return list.filter((c) => {
      if (c.name === HOST_CONTAINER_NAME) return false;
      if (c.state !== "running") return true;
      if (DEFAULT_HIDDEN_RUNNING_CONTAINER_NAMES.has(c.name)) return false;
      return !hiddenIds.has(c.id);
    });
  }, []);
  const visibleContainers = useMemo(
    () => filterHiddenContainers(activeDockerPanelContainers),
    [
      activeDockerPanelContainers,
      filterHiddenContainers,
      hiddenRunningContainerNonce,
    ],
  );
  useEffect(() => {
    const onHiddenChanged = () =>
      setHiddenRunningContainerNonce((prev) => prev + 1);
    window.addEventListener(HIDDEN_RUNNING_CONTAINERS_EVENT, onHiddenChanged);
    return () =>
      window.removeEventListener(
        HIDDEN_RUNNING_CONTAINERS_EVENT,
        onHiddenChanged,
      );
  }, []);
  const anyRunningContainer = visibleContainers.some(
    (c) => c.state === "running",
  );
  const activeContainerPool = useMemo(
    () => dockerLocalContainers,
    [dockerLocalContainers],
  );
  const selectedContainer = useMemo(
    () =>
      activeContainerPool.find(
        (container) => container.id === activeContainerId,
      ) ?? null,
    [activeContainerId, activeContainerPool],
  );
  const selectedRunningContainer =
    selectedContainer?.state === "running" ? selectedContainer : null;
  const dockerLocalSelectedRunningContainer = useMemo(
    () =>
      dockerLocalContainers.find(
        (container) =>
          container.id === dockerLocalActiveContainerId &&
          container.state === "running",
      ) ?? null,
    [dockerLocalActiveContainerId, dockerLocalContainers],
  );
  const [activeFocusFrame, setActiveFocusFrame] = useState<FocusFrame>("top");
  const leftFrameRef = useRef<HTMLElement | null>(null);
  const topFrameRef = useRef<HTMLDivElement | null>(null);
  const bottomFrameRef = useRef<HTMLDivElement | null>(null);
  const ctrlWPendingUntilRef = useRef(0);

  // Editor + file browser I/O prefer the active running container, but fall back
  // to the running selection shown in the current Docker context.
  const fileSystemContainerId = useMemo(() => {
    if (selectedRunningContainer?.id) return selectedRunningContainer.id;
    return dockerLocalSelectedRunningContainer?.id ?? null;
  }, [dockerLocalSelectedRunningContainer?.id, selectedRunningContainer?.id]);
  const hasAttemptedLegacyContainerEditorMigrationRef = useRef(false);

  const getFocusedEditorTarget = useCallback(
    (): { frameId: FrameId; paneId: PaneId } => ({
      frameId: focusedEditorFrame,
      paneId: focusedEditorFrame === "top" ? focusedPane : focusedBottomPane,
    }),
    [focusedBottomPane, focusedEditorFrame, focusedPane],
  );

  function focusOpenedPane(frameId: FrameId, paneId: PaneId) {
    setActiveFocusFrame(frameId);
    if (frameId === "top") {
      setFocusedPane(paneId);
      setFocusedEditorFrame("top");
      setFrameViews((prev) =>
        prev.top === "editor-split" ? prev : { ...prev, top: "editor-split" },
      );
      setBottomMaximized(false);
      setEditorFocusRequest({ nonce: Date.now(), frameId, paneId });
      return;
    }
    setFocusedBottomPane(paneId);
    setFocusedEditorFrame("bottom");
    setLayout((prev) => ({ ...prev, showBottom: true }));
    setEditorFocusRequest({ nonce: Date.now(), frameId, paneId });
  }

  function openCustomTabInPane(
    frameId: FrameId,
    paneId: PaneId,
    nextTab: EditorTab,
  ) {
    setFramePaneTabs(frameId, paneId, (pane) => {
      let nextTabs = pane.tabs;
      if (nextTab.kind === "temporary") {
        nextTabs = nextTabs.filter((tab) => tab.kind !== "temporary");
      }
      return {
        ...pane,
        tabs: [...nextTabs, nextTab],
        activeTabId: nextTab.id,
        renameTabId: null,
        renameDraft: "",
      };
    });
    focusOpenedPane(frameId, paneId);
  }

  function openTerminalDescriptorInPane(
    frameId: FrameId,
    paneId: PaneId,
    descriptor: TerminalTabDescriptor,
    kind: EditorTabKind = "edit",
  ) {
    openCustomTabInPane(frameId, paneId, makeTerminalEditorTab(descriptor, kind));
  }

  const openAndFocusTerminal = useCallback(() => {
    const target = getFocusedEditorTarget();
    const preferredContainer =
      (activeContainerId
        ? visibleContainers.find(
            (container) =>
              container.id === activeContainerId && container.state === "running",
          )
        : undefined) ??
      selectedRunningContainer ??
      visibleContainers.find((container) => container.state === "running") ??
      null;
    if (!preferredContainer) return;
    const preferredShell = getPrimaryContainerShell(preferredContainer);
    openTerminalDescriptorInPane(target.frameId, target.paneId, {
      kind: "shell",
      containerId: preferredContainer.id,
      containerName:
        preferredContainer.name || preferredContainer.id.slice(0, 12),
      label: preferredShell?.name ?? "shell",
      shell: preferredShell?.command ?? null,
      fixedLabel: Boolean(preferredShell),
      modelName: null,
      cwd:
        fileBrowserWorkingDirectoryByContainerId[preferredContainer.id]
        ?? preferredContainer.execShellWorkdir?.trim()
        ?? null,
      sessionId: null,
      dockerHost: activeDockerHost,
      ollamaHost: null,
    });
  }, [
    activeContainerId,
    activeDockerHost,
    fileBrowserWorkingDirectoryByContainerId,
    getFocusedEditorTarget,
    selectedRunningContainer,
    visibleContainers,
  ]);

  const focusTopFrame = useCallback(
    (paneId: PaneId = focusedPane) => {
      setFocusedEditorFrame("top");
      setFocusedPane(paneId);
      setActiveFocusFrame("top");
      if (bottomMaximized && !forceTerminalOnlyLayout) {
        setBottomMaximized(false);
      }
      requestAnimationFrame(() => {
        // Don't steal focus from CodeMirror — on Linux/Chromium, focusing the top frame
        // div would blur the editor. The editor pane already has focus via the contenteditable.
        const active = document.activeElement as HTMLElement | null;
        if (active?.closest?.(".cm-editor")) return;
        topFrameRef.current?.focus({ preventScroll: true });
      });
      if (frameViews.top === "editor-split") {
        setEditorFocusRequest({ nonce: Date.now(), frameId: "top", paneId });
      }
    },
    [bottomMaximized, forceTerminalOnlyLayout, focusedPane, frameViews.top],
  );

  const focusLeftFrame = useCallback(() => {
    if (!hasAnyLeftTabs) return false;
    setActiveFocusFrame("left");
    setLayout((prev) => ({ ...prev, showLeft: true }));
    requestAnimationFrame(() => {
      leftFrameRef.current?.focus({ preventScroll: true });
    });
    return true;
  }, [hasAnyLeftTabs]);

  const focusBottomFrame = useCallback(() => {
    setFocusedEditorFrame("bottom");
    setActiveFocusFrame("bottom");
    setLayout((prev) => ({ ...prev, showBottom: true }));
    requestAnimationFrame(() => {
      bottomFrameRef.current?.focus({ preventScroll: true });
    });
    setEditorFocusRequest({
      nonce: Date.now(),
      frameId: "bottom",
      paneId: focusedBottomPane,
    });
  }, [focusedBottomPane]);

  const focusEditorPane = useCallback(
    (paneId: PaneId) => {
      setFocusedPane(paneId);
      setFocusedEditorFrame("top");
      focusTopFrame(paneId);
    },
    [focusTopFrame],
  );

  const focusBottomEditorPane = useCallback(
    (paneId: PaneId) => {
      setFocusedBottomPane(paneId);
      setFocusedEditorFrame("bottom");
      setActiveFocusFrame("bottom");
      setLayout((prev) => ({ ...prev, showBottom: true }));
      setEditorFocusRequest({
        nonce: Date.now(),
        frameId: "bottom",
        paneId,
      });
    },
    [],
  );

  const navigateVimWindow = useCallback(
    (direction: "left" | "right" | "up" | "down") => {
      const hasSplitSecondary = topSplit.mode !== "single";
      if (activeFocusFrame === "top") {
        if (direction === "left") {
          if (
            topSplit.mode === "row" &&
            hasSplitSecondary &&
            focusedPane === "secondary"
          ) {
            focusEditorPane("primary");
            return;
          }
          void focusLeftFrame();
          return;
        }
        if (direction === "right") {
          if (
            topSplit.mode === "row" &&
            hasSplitSecondary &&
            focusedPane === "primary"
          ) {
            focusEditorPane("secondary");
            return;
          }
          return;
        }
        if (direction === "down") {
          focusBottomFrame();
          return;
        }
        return;
      }
      if (activeFocusFrame === "left") {
        if (direction === "right" || direction === "up") {
          focusTopFrame();
          return;
        }
        if (direction === "down") {
          focusBottomFrame();
        }
        return;
      }
      if (activeFocusFrame === "bottom") {
        if (
          direction === "right" &&
          bottomSplit.mode === "row" &&
          focusedBottomPane === "primary"
        ) {
          focusBottomEditorPane("secondary");
          return;
        }
        if (
          direction === "left" &&
          bottomSplit.mode === "row" &&
          focusedBottomPane === "secondary"
        ) {
          focusBottomEditorPane("primary");
          return;
        }
        if (direction === "up" || direction === "right") {
          focusTopFrame();
          return;
        }
        if (direction === "left") {
          if (!focusLeftFrame()) focusTopFrame();
        }
      }
    },
    [
      activeFocusFrame,
      bottomSplit.mode,
      focusBottomEditorPane,
      focusBottomFrame,
      focusEditorPane,
      focusLeftFrame,
      focusTopFrame,
      focusedBottomPane,
      focusedPane,
      topSplit.mode,
    ],
  );

  const cycleActivePaneTab = useCallback(
    (delta: -1 | 1) => {
      const activePaneId =
        focusedEditorFrame === "top" ? focusedPane : focusedBottomPane;
      const frameTabs =
        focusedEditorFrame === "top" ? editorTabs : bottomEditorTabs;
      const paneTabs = frameTabs[activePaneId];
      if (paneTabs.tabs.length <= 1) return;
      const currentIndex = Math.max(
        0,
        paneTabs.tabs.findIndex((tab) => tab.id === paneTabs.activeTabId),
      );
      const nextIndex =
        (currentIndex + delta + paneTabs.tabs.length) % paneTabs.tabs.length;
      const nextTab = paneTabs.tabs[nextIndex];
      if (!nextTab) return;
      const setTabsState =
        focusedEditorFrame === "top" ? setEditorTabs : setBottomEditorTabs;
      setTabsState((prev) => ({
        ...prev,
        [activePaneId]: {
          ...prev[activePaneId],
          activeTabId: nextTab.id,
        },
      }));
      if (focusedEditorFrame === "top") {
        focusTopFrame(activePaneId);
      } else {
        focusBottomEditorPane(activePaneId);
      }
    },
    [
      bottomEditorTabs,
      editorTabs,
      focusBottomEditorPane,
      focusTopFrame,
      focusedBottomPane,
      focusedEditorFrame,
      focusedPane,
    ],
  );

  const openAndRunTerminalCommand = useCallback((command: string) => {
    const target = getFocusedEditorTarget();
    const preferredContainer =
      (activeContainerId
        ? visibleContainers.find(
            (container) =>
              container.id === activeContainerId && container.state === "running",
          )
        : undefined) ??
      selectedRunningContainer ??
      visibleContainers.find((container) => container.state === "running") ??
      null;
    if (!preferredContainer) return;
    const preferredShell = getPrimaryContainerShell(preferredContainer);
    openTerminalDescriptorInPane(target.frameId, target.paneId, {
      kind: "shell",
      containerId: preferredContainer.id,
      containerName:
        preferredContainer.name || preferredContainer.id.slice(0, 12),
      label: preferredShell?.name ?? "shell",
      shell: preferredShell?.command ?? null,
      fixedLabel: Boolean(preferredShell),
      modelName: null,
      cwd:
        fileBrowserWorkingDirectoryByContainerId[preferredContainer.id]
        ?? preferredContainer.execShellWorkdir?.trim()
        ?? null,
      sessionId: null,
      dockerHost: activeDockerHost,
      ollamaHost: null,
      initialCommands: [command],
    });
  }, [
    activeContainerId,
    activeDockerHost,
    fileBrowserWorkingDirectoryByContainerId,
    getFocusedEditorTarget,
    selectedRunningContainer,
    visibleContainers,
  ]);

  const openAndRunModelTerminal = useCallback(
    (modelName: string, dockerHost: string | null) => {
      const target = getFocusedEditorTarget();
      openTerminalDescriptorInPane(target.frameId, target.paneId, {
        kind: "model-run",
        containerId: "__model-run__",
        containerName: "docker",
        label: modelName,
        shell: null,
        modelName,
        cwd: null,
        sessionId: null,
        dockerHost,
        ollamaHost: null,
      });
    },
    [getFocusedEditorTarget],
  );

  const openAndRunOllamaModelTerminal = useCallback(
    (modelName: string, ollamaHost: string | null) => {
      const target = getFocusedEditorTarget();
      openTerminalDescriptorInPane(target.frameId, target.paneId, {
        kind: "ollama-run",
        containerId: "__ollama__",
        containerName: "ollama",
        label: modelName,
        shell: null,
        modelName,
        cwd: null,
        sessionId: null,
        dockerHost: null,
        ollamaHost,
      });
    },
    [getFocusedEditorTarget],
  );

  const openAndPullOllamaModelTerminal = useCallback(
    (modelName: string, ollamaHost: string | null) => {
      const target = getFocusedEditorTarget();
      openTerminalDescriptorInPane(target.frameId, target.paneId, {
        kind: "ollama-pull",
        containerId: "__ollama__",
        containerName: "ollama",
        label: `pull: ${modelName}`,
        shell: null,
        modelName,
        cwd: null,
        sessionId: null,
        dockerHost: null,
        ollamaHost,
      });
    },
    [getFocusedEditorTarget],
  );

  const openAndPullDockerImageTerminal = useCallback(
    (imageName: string, dockerHost: string | null) => {
      const target = getFocusedEditorTarget();
      openTerminalDescriptorInPane(target.frameId, target.paneId, {
        kind: "docker-image-pull",
        containerId: "__docker-pull__",
        containerName: "docker",
        label: `pull: ${imageName}`,
        shell: null,
        modelName: imageName,
        cwd: null,
        sessionId: null,
        dockerHost,
        ollamaHost: null,
      });
    },
    [getFocusedEditorTarget],
  );

  const openAndPullDockerAiModelTerminal = useCallback(
    (modelName: string, dockerHost: string | null) => {
      const target = getFocusedEditorTarget();
      openTerminalDescriptorInPane(target.frameId, target.paneId, {
        kind: "docker-model-pull",
        containerId: "__docker-pull__",
        containerName: "docker",
        label: `pull: ${modelName}`,
        shell: null,
        modelName,
        cwd: null,
        sessionId: null,
        dockerHost,
        ollamaHost: null,
      });
    },
    [getFocusedEditorTarget],
  );

  const openContainerLogs = useCallback(
    (containerId: string) => {
      if (activeLeftViewForContext === "docker-local") {
        setDockerLocalActiveContainerId(containerId);
        setActiveContainerEnvironment("docker-local");
      }
      setActiveContainerId(containerId);
      const target = getFocusedEditorTarget();
      openCustomTabInPane(
        target.frameId,
        target.paneId,
        makeLogsEditorTab(visibleContainers, containerId),
      );
    },
    [activeLeftViewForContext, getFocusedEditorTarget, visibleContainers],
  );

  const openContainerInspect = useCallback(
    (_containerId: string) => {
      if (activeLeftViewForContext === "docker-local") {
        setDockerLocalActiveContainerId(_containerId);
        setActiveContainerEnvironment("docker-local");
      }
      setActiveContainerId(_containerId);
      const target = getFocusedEditorTarget();
      openCustomTabInPane(
        target.frameId,
        target.paneId,
        makeInspectEditorTab(visibleContainers, {
          containerId: _containerId,
          modelTarget: null,
        }),
      );
    },
    [activeLeftViewForContext, getFocusedEditorTarget, visibleContainers],
  );

  const openModelInspect = useCallback(
    (source: "docker" | "ollama", modelName: string) => {
      const nextModelName = modelName.trim();
      if (!nextModelName) return;
      const target = getFocusedEditorTarget();
      openCustomTabInPane(
        target.frameId,
        target.paneId,
        makeInspectEditorTab(visibleContainers, {
          containerId: null,
          modelTarget: { source, modelName: nextModelName },
        }),
      );
    },
    [getFocusedEditorTarget, visibleContainers],
  );

  const openContainerTerminal = useCallback(
    (containerId: string, shell?: string | null, shellName?: string | null) => {
      if (activeLeftViewForContext === "docker-local") {
        setDockerLocalActiveContainerId(containerId);
        setActiveContainerEnvironment("docker-local");
      }
      setActiveContainerId(containerId);
      const container = visibleContainers.find(
        (entry) => entry.id === containerId && entry.state === "running",
      );
      if (!container) return;
      const preferredShell = shell?.trim()
        ? { name: shellName?.trim() || "shell", command: shell.trim() }
        : getPrimaryContainerShell(container);
      const target = getFocusedEditorTarget();
      openTerminalDescriptorInPane(target.frameId, target.paneId, {
        kind: "shell",
        containerId: container.id,
        containerName: container.name || container.id.slice(0, 12),
        label: preferredShell?.name ?? "shell",
        shell: preferredShell?.command ?? null,
        fixedLabel: Boolean(preferredShell),
        modelName: null,
        cwd:
          fileBrowserWorkingDirectoryByContainerId[container.id]
          ?? container.execShellWorkdir?.trim()
          ?? null,
        sessionId: null,
        dockerHost: activeDockerHost,
        ollamaHost: null,
      });
    },
    [
      activeDockerHost,
      activeLeftViewForContext,
      fileBrowserWorkingDirectoryByContainerId,
      getFocusedEditorTarget,
      visibleContainers,
    ],
  );

  const onEnvironmentSelectContainer = useCallback(
    (containerId: string | null) => {
      setDockerLocalActiveContainerId(containerId);
      if (activeLeftViewForContext === "docker-local") {
        setActiveContainerId(containerId);
        setActiveContainerEnvironment("docker-local");
      }
    },
    [activeLeftViewForContext],
  );

  const onToggleTerminalMaximize = useCallback(() => {
    if (!layout.showBottom) {
      setLayout((prev) => ({ ...prev, showBottom: true }));
    }

    if (!bottomMaximized) {
      bottomRestoreHeightRef.current = layout.bottomHeight;
      setBottomMaximized(true);
      return;
    }

    setBottomMaximized(false);
    const restoreHeight = bottomRestoreHeightRef.current;
    bottomRestoreHeightRef.current = null;
    if (restoreHeight != null) {
      setLayout((prev) => ({
        ...prev,
        bottomHeight: restoreHeight,
        showBottom: true,
      }));
    }
  }, [bottomMaximized, layout.bottomHeight, layout.showBottom]);

  useEffect(() => {
    try {
      if (activeContainerId) {
        setItem(LEGACY_ACTIVE_CONTAINER_KEY, activeContainerId);
      } else {
        removeItem(LEGACY_ACTIVE_CONTAINER_KEY);
      }
    } catch {
      // ignore
    }
  }, [activeContainerId]);
  useEffect(() => {
    try {
      if (dockerLocalActiveContainerId) {
        setItem(LOCAL_ACTIVE_CONTAINER_KEY, dockerLocalActiveContainerId);
      } else {
        removeItem(LOCAL_ACTIVE_CONTAINER_KEY);
      }
    } catch {
      // ignore
    }
  }, [dockerLocalActiveContainerId]);

  // ---- Model provider ----
  useEffect(() => {
    const toDockerProviderBaseUrl = (dockerHost: string | null) => {
      if (!dockerHost) return "http://localhost:12434/v1";
      try {
        const parsed = new URL(dockerHost);
        if (
          (parsed.protocol === "ssh:" || parsed.protocol === "tcp:") &&
          parsed.hostname
        ) {
          return `http://${parsed.hostname}:12434/v1`;
        }
      } catch {
        // Fall through to localhost for unexpected host formats.
      }
      return "http://localhost:12434/v1";
    };
    let cancelled = false;
    const refreshModelProviderState = async () => {
      const storedProviders =
        (await readModelProvidersState<ModelProviderConfig[]>()) ?? [];
      const effectiveStoredProviders = storedProviders.map((provider) => ({
        ...provider,
        enabled:
          integrationSettings.aiApiModelProvidersEnabled && provider.enabled,
      }));
      const localProviders: ModelProviderConfig[] = [];
      if (hasDockerLocalTab) {
        localProviders.push({
          id: "local-docker",
          name: "Local Docker",
          providerType: "openaiCompatible",
          config: { baseUrl: toDockerProviderBaseUrl(null) },
          secretRefs: {},
          enabled: integrationSettings.dockerLocalEnabled,
          models: integrationSettings.dockerLocalModels,
          updatedAt: Date.now(),
        });
      }
      if (hasOllamaLocalTab) {
        localProviders.push({
          id: "local-ollama",
          name: "Local Ollama",
          providerType: "ollama",
          config: { baseUrl: "http://localhost:11434" },
          secretRefs: {},
          enabled: integrationSettings.ollamaLocalEnabled,
          models: integrationSettings.ollamaLocalModels,
          updatedAt: Date.now(),
        });
      }
      const providers = [...localProviders, ...effectiveStoredProviders];
      if (cancelled) return;
      const hasEnabledProviderWithEnabledModel = providers.some(
        (provider) =>
          provider.enabled &&
          provider.models.some((model) =>
            Object.values(model.enabledTypes).some(Boolean),
          ),
      );
      setCanToggleRightFrame(hasEnabledProviderWithEnabledModel);
      if (!hasEnabledProviderWithEnabledModel) {
        setLayout((prev) =>
          prev.showRight ? { ...prev, showRight: false } : prev,
        );
      }
    };

    void refreshModelProviderState();
    return () => {
      cancelled = true;
    };
  }, [hasDockerLocalTab, hasOllamaLocalTab, integrationSettings, settingsOpen]);

  // Persist editor settings.
  useEffect(() => {
    setStoredEditorSettings(editorSettings);
  }, [editorSettings]);

  // Persist layout on change.
  useEffect(() => {
    const t = window.setTimeout(
      () => writeJSON(LAYOUT_SESSION_KEY, layout),
      150,
    );
    return () => window.clearTimeout(t);
  }, [layout]);
  useEffect(() => {
    const t = window.setTimeout(
      () => writeJSON(VIEWS_SESSION_KEY, frameViews),
      150,
    );
    return () => window.clearTimeout(t);
  }, [frameViews]);
  useEffect(() => {
    const t = window.setTimeout(
      () => writeJSON(BOTTOM_MAXIMIZED_SESSION_KEY, bottomMaximized),
      150,
    );
    return () => window.clearTimeout(t);
  }, [bottomMaximized]);
  useEffect(() => {
    const t = window.setTimeout(
      () => writeJSON(TOP_SPLIT_SESSION_KEY, topSplit),
      150,
    );
    return () => window.clearTimeout(t);
  }, [topSplit]);

  // One-time migration from legacy container-scoped editor state when no global workspace exists yet.
  useEffect(() => {
    if (hasAttemptedLegacyContainerEditorMigrationRef.current) return;
    if (readPersistedWorkspaceState()) {
      hasAttemptedLegacyContainerEditorMigrationRef.current = true;
      return;
    }
    if (!fileSystemContainerId) return;
    let cancelled = false;
    void (async () => {
      try {
        const raw = await dockerClient.readFile(
          fileSystemContainerId,
          CONTAINER_EDITOR_STATE_FILE,
        );
        const parsed = JSON.parse(raw) as PersistedContainerEditorState;
        if (cancelled || !parsed || typeof parsed !== "object") return;
        if (parsed.editorTabs) {
          const nextPrimary = sanitizePaneTabsState(parsed.editorTabs.primary);
          const nextSecondary = sanitizePaneTabsState(
            parsed.editorTabs.secondary,
          );
          setEditorTabs({ primary: nextPrimary, secondary: nextSecondary });
          const requestedFocus =
            parsed.editorTabs.focusedPane === "secondary"
              ? "secondary"
              : "primary";
          const fallbackFocus: PaneId =
            requestedFocus === "secondary" &&
            nextSecondary.tabs.length === 0 &&
            nextPrimary.tabs.length > 0
              ? "primary"
              : requestedFocus;
          setFocusedPane(fallbackFocus);
        }
        if (parsed.topSplit) {
          setTopSplit(sanitizeTopSplitState(parsed.topSplit));
        }
      } catch {
        // ignore legacy migration failures
      } finally {
        if (!cancelled)
          hasAttemptedLegacyContainerEditorMigrationRef.current = true;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fileSystemContainerId]);

  // Persist global workspace state (editor tabs, buffers, preview/editor state).
  useEffect(() => {
    const t = window.setTimeout(() => {
      const payload: PersistedWorkspaceState = {
        version: 2,
        topSplit,
        bottomSplit,
        focusedPane,
        focusedEditorFrame,
        focusedPaneByFrame: {
          top: focusedPane,
          bottom: focusedBottomPane,
        },
        editorTabs: {
          primary: {
            tabs: editorTabs.primary.tabs,
            activeTabId: editorTabs.primary.activeTabId,
          },
          secondary: {
            tabs: editorTabs.secondary.tabs,
            activeTabId: editorTabs.secondary.activeTabId,
          },
        },
        bottomEditorTabs: {
          primary: {
            tabs: bottomEditorTabs.primary.tabs,
            activeTabId: bottomEditorTabs.primary.activeTabId,
          },
          secondary: {
            tabs: bottomEditorTabs.secondary.tabs,
            activeTabId: bottomEditorTabs.secondary.activeTabId,
          },
        },
        fileBuffers,
        pendingSaveAsPaths,
      };
      writeJSON(WORKSPACE_STATE_KEY, payload);
    }, 180);
    return () => window.clearTimeout(t);
  }, [
    bottomEditorTabs,
    bottomSplit,
    editorTabs,
    fileBuffers,
    focusedBottomPane,
    focusedEditorFrame,
    focusedPane,
    pendingSaveAsPaths,
    topSplit,
  ]);

  // Fall back to editor-split if diff viewer state goes away.
  useEffect(() => {
    if (diffViewerState || frameViews.top !== "diff-viewer") return;
    setFrameViews((prev) =>
      prev.top === "diff-viewer" ? { ...prev, top: "editor-split" } : prev,
    );
  }, [diffViewerState, frameViews.top]);

  // ---- Resize ----
  const mainRef = useRef<HTMLDivElement | null>(null);
  const centerRef = useRef<HTMLDivElement | null>(null);
  const [mainSize, setMainSize] = useState({ width: 0, height: 0 });
  const [centerSize, setCenterSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    if (!mainRef.current) return;
    const ro = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect) return;
      setMainSize({ width: rect.width, height: rect.height });
    });
    ro.observe(mainRef.current);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!centerRef.current) return;
    const ro = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect) return;
      setCenterSize({ width: rect.width, height: rect.height });
    });
    ro.observe(centerRef.current);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const minCenterWidth = 240;
    const minTopHeight = 120;
    const leftMin = 180;
    const leftMax = 500;
    const rightMin = 320;
    const rightMax =
      mainSize.width > 0
        ? Math.max(
            rightMin,
            mainSize.width - minCenterWidth - (effectiveShowLeft ? leftMin : 0),
          )
        : Number.POSITIVE_INFINITY;
    const bottomMin = 200;
    const bottomMax =
      centerSize.height > 0
        ? Math.max(bottomMin, centerSize.height - minTopHeight)
        : Number.POSITIVE_INFINITY;

    setLayout((prev) => {
      const nextLeft = clamp(prev.leftWidth, leftMin, leftMax);
      const nextRight =
        mainSize.width > 0
          ? clamp(prev.rightWidth, rightMin, rightMax)
          : prev.rightWidth;
      const nextBottom =
        centerSize.height > 0
          ? clamp(prev.bottomHeight, bottomMin, bottomMax)
          : prev.bottomHeight;
      if (
        prev.leftWidth === nextLeft &&
        prev.rightWidth === nextRight &&
        prev.bottomHeight === nextBottom
      ) {
        return prev;
      }
      return {
        ...prev,
        leftWidth: nextLeft,
        rightWidth: nextRight,
        bottomHeight: nextBottom,
      };
    });
  }, [mainSize.width, centerSize.height, effectiveShowLeft]);

  const constraints = useMemo(() => {
    const minCenterWidth = 240;
    const minTopHeight = 120;
    const leftMin = 180;
    const leftMax = 500;
    const rightMin = 320;
    const rightMax =
      mainSize.width > 0
        ? Math.max(
            rightMin,
            mainSize.width - minCenterWidth - (effectiveShowLeft ? leftMin : 0),
          )
        : Number.POSITIVE_INFINITY;
    const bottomMin = 200;
    const bottomMax =
      centerSize.height > 0
        ? Math.max(bottomMin, centerSize.height - minTopHeight)
        : Number.POSITIVE_INFINITY;
    return { leftMin, leftMax, rightMin, rightMax, bottomMin, bottomMax };
  }, [centerSize.height, effectiveShowLeft, mainSize.width]);

  const dragRef = useRef<
    | null
    | { kind: "left"; startX: number; startWidth: number }
    | { kind: "right"; startX: number; startWidth: number }
    | { kind: "bottom"; startY: number; startHeight: number }
  >(null);

  const setGlobalNoSelect = (enabled: boolean) => {
    const root = document.documentElement;
    if (enabled) root.classList.add("electrobun-no-select");
    else root.classList.remove("electrobun-no-select");
  };

  const onLeftHandlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setGlobalNoSelect(true);
    dragRef.current = {
      kind: "left",
      startX: e.clientX,
      startWidth: layout.leftWidth,
    };
  };

  const onRightHandlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setGlobalNoSelect(true);
    dragRef.current = {
      kind: "right",
      startX: e.clientX,
      startWidth: layout.rightWidth,
    };
  };

  const onBottomHandlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setGlobalNoSelect(true);
    dragRef.current = {
      kind: "bottom",
      startY: e.clientY,
      startHeight: layout.bottomHeight,
    };
  };

  const onHandlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    setLayout((prev) => {
      if (drag.kind === "left") {
        const next = drag.startWidth + (e.clientX - drag.startX);
        return {
          ...prev,
          leftWidth: clamp(next, constraints.leftMin, constraints.leftMax),
        };
      }
      if (drag.kind === "right") {
        const next = drag.startWidth - (e.clientX - drag.startX);
        return {
          ...prev,
          rightWidth: clamp(next, constraints.rightMin, constraints.rightMax),
        };
      }
      const next = drag.startHeight - (e.clientY - drag.startY);
      return {
        ...prev,
        bottomHeight: clamp(next, constraints.bottomMin, constraints.bottomMax),
      };
    });
  };

  const onHandlePointerUp = () => {
    dragRef.current = null;
    setGlobalNoSelect(false);
  };

  const onHandlePointerCancel = () => {
    dragRef.current = null;
    setGlobalNoSelect(false);
  };

  const onTitlebarMouseDownCapture = (e: React.MouseEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement | null;
    if (!target) return;
    if (target.closest("button,a,input,textarea,select,[role='button']"))
      return;
    e.preventDefault();
  };

  // ---- Tabs + availability-driven frame visibility ----
  const leftTabs: FrameTab<LeftView>[] = [
    ...(hasDockerLocalTab
      ? ([
          {
            id: "docker-local" as const,
            label: "Docker",
            meta: dockerLocalLoading ? "Syncing" : undefined,
          },
        ] satisfies FrameTab<LeftView>[])
      : []),
    ...(hasOllamaLocalTab
      ? ([
          { id: "ollama-local" as const, label: "Ollama" },
        ] satisfies FrameTab<LeftView>[])
      : []),
  ];
  const activeLeftView: LeftView = leftTabs.some(
    (tab) => tab.id === activeLeftViewForContext,
  )
    ? activeLeftViewForContext
    : (leftTabs[0]?.id ?? "docker-local");

  const topTabs: FrameTab<TopView>[] = [
    { id: "editor-split", label: "Editor" },
    ...(diffViewerState
      ? ([
          { id: "diff-viewer", label: "Diff Viewer" },
        ] satisfies FrameTab<TopView>[])
      : []),
  ];

  const rightTabs: FrameTab<RightView>[] = [
    { id: "chat", label: "Chat" },
    { id: "generate", label: "Generate" },
    { id: "sessions", label: "Sessions" },
  ];

  // Note: We intentionally do not coerce `frameViews.left` here.
  // If a left tab is temporarily unavailable, `activeLeftView` falls back to
  // the first currently visible tab, while preserving the user's last selection.

  // ---- Editor tab helpers ----
  useEffect(() => {
    fileBuffersRef.current = fileBuffers;
  }, [fileBuffers]);
  useEffect(() => {
    editorTabsRef.current = editorTabs;
  }, [editorTabs]);
  useEffect(() => {
    bottomEditorTabsRef.current = bottomEditorTabs;
  }, [bottomEditorTabs]);

  const setFramePaneTabs = useCallback(
    (
      frameId: FrameId,
      paneId: PaneId,
      updater: (pane: PaneTabsState) => PaneTabsState,
    ) => {
      if (frameId === "top") {
        setEditorTabs((prev) => ({
          ...prev,
          [paneId]: updater(prev[paneId]),
        }));
        return;
      }
      setBottomEditorTabs((prev) => ({
        ...prev,
        [paneId]: updater(prev[paneId]),
      }));
    },
    [],
  );

  const setPaneTabs = useCallback(
    (paneId: PaneId, updater: (pane: PaneTabsState) => PaneTabsState) => {
      setFramePaneTabs("top", paneId, updater);
    },
    [setFramePaneTabs],
  );

  useEffect(() => {
    const referencedBufferKeys = new Set<string>();
    const referencedPendingSaveAsPaths = new Set<string>();
    const collectReferencedBuffers = (tabs: EditorTab[]) => {
      for (const tab of tabs) {
        if (!tabUsesTextBuffer(tab)) continue;
        referencedBufferKeys.add(toBufferKey(tab.role, tab.path));
        referencedPendingSaveAsPaths.add(normalizeFilePath(tab.path));
      }
    };

    collectReferencedBuffers(editorTabs.primary.tabs);
    collectReferencedBuffers(editorTabs.secondary.tabs);
    collectReferencedBuffers(bottomEditorTabs.primary.tabs);
    collectReferencedBuffers(bottomEditorTabs.secondary.tabs);

    setFileBuffers((prev) => {
      let changed = false;
      const next: Record<string, FileBufferState> = {};
      for (const [key, value] of Object.entries(prev)) {
        if (!referencedBufferKeys.has(key)) {
          changed = true;
          continue;
        }
        next[key] = value;
      }
      return changed ? next : prev;
    });

    setPendingSaveAsPaths((prev) => {
      let changed = false;
      const next: Record<string, boolean> = {};
      for (const [path, value] of Object.entries(prev)) {
        if (!referencedPendingSaveAsPaths.has(normalizeFilePath(path))) {
          changed = true;
          continue;
        }
        next[path] = value;
      }
      return changed ? next : prev;
    });
  }, [bottomEditorTabs, editorTabs]);

  const saveBufferNow = useCallback(
    async (role: FileRole, path: string, contentOverride?: string) => {
      const normalized = normalizeFilePath(path);
      const bufferKey = toBufferKey(role, normalized);
      const content = contentOverride ?? fileBuffers[bufferKey]?.content ?? "";
      setFileBuffers((prev) => ({
        ...prev,
        [bufferKey]: {
          ...(prev[bufferKey] ?? {
            content,
            loading: false,
            dirty: true,
            saving: false,
            error: null,
          }),
          content,
          saving: true,
          error: null,
        },
      }));
      try {
        if (!fileSystemContainerId) {
          throw new Error("Host container not ready yet.");
        }
        await dockerClient.writeFile(
          fileSystemContainerId,
          toContainerAbsolutePath(normalized),
          content,
        );
        setFileBuffers((prev) => {
          const current = prev[bufferKey];
          if (!current) return prev;
          const unchanged = current.content === content;
          return {
            ...prev,
            [bufferKey]: {
              ...current,
              dirty: unchanged ? false : current.dirty,
              saving: false,
              error: null,
            },
          };
        });
        // Don't refresh the file browser for a normal save; it causes the tree
        // to reload and lose UX state. File browser refreshes are triggered by
        // file-structure actions (Save As, create/delete/rename) elsewhere.
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to save file.";
        setFileBuffers((prev) => ({
          ...prev,
          [bufferKey]: {
            ...(prev[bufferKey] ?? {
              content,
              loading: false,
              dirty: true,
              saving: false,
              error: null,
            }),
            content,
            saving: false,
            error: message,
          },
        }));
      }
    },
    [fileBuffers, fileSystemContainerId],
  );

  const ensureBufferLoaded = useCallback(
    (role: FileRole, path: string) => {
      const normalized = normalizeFilePath(path);
      const bufferKey = toBufferKey(role, normalized);
      const existing = fileBuffersRef.current[bufferKey];
      if (
        existing &&
        (existing.loading || (!existing.error && existing.content.length >= 0))
      ) {
        return;
      }
      setFileBuffers((prev) => ({
        ...prev,
        [bufferKey]: {
          ...(prev[bufferKey] ?? {
            content: "",
            loading: false,
            dirty: false,
            saving: false,
            error: null,
          }),
          loading: true,
          error: null,
        },
      }));
      if (!fileSystemContainerId) {
        // Host container not ready — keep whatever content we already have.
        setFileBuffers((prev) => ({
          ...prev,
          [bufferKey]: {
            ...(prev[bufferKey] ?? {
              content: "",
              loading: false,
              dirty: false,
              saving: false,
              error: null,
            }),
            content: prev[bufferKey]?.content ?? "",
            loading: false,
            error: "Host container not ready yet.",
          },
        }));
        return;
      }
      void (async () => {
        try {
          const content = await dockerClient.readFile(
            fileSystemContainerId,
            toContainerAbsolutePath(normalized),
          );
          if (isLikelyBinaryDecodedContent(content)) {
            const previewDescriptor = getPreviewDescriptor(normalized);
            if (previewDescriptor) {
              setEditorTabs((prev) => {
                const remapPane = (pane: PaneTabsState): PaneTabsState => ({
                  ...pane,
                  tabs: pane.tabs.map((tab) =>
                    tab.role === role && tab.path === normalized
                      ? { ...tab, view: "preview" }
                      : tab,
                  ),
                });
                return {
                  primary: remapPane(prev.primary),
                  secondary: remapPane(prev.secondary),
                };
              });
            }
            setFileBuffers((prev) => ({
              ...prev,
              [bufferKey]: {
                ...(prev[bufferKey] ?? {
                  content: "",
                  loading: false,
                  dirty: false,
                  saving: false,
                  error: null,
                }),
                content: "",
                loading: false,
                error: previewDescriptor
                  ? "Binary file detected. Opened in Preview tab instead of text editor."
                  : "Binary file detected. This file can't be opened in the text editor.",
              },
            }));
            return;
          }
          setFileBuffers((prev) => ({
            ...prev,
            [bufferKey]: {
              ...(prev[bufferKey] ?? {
                content: "",
                loading: false,
                dirty: false,
                saving: false,
                error: null,
              }),
              content,
              loading: false,
              error: null,
            },
          }));
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Failed to load file.";
          setFileBuffers((prev) => ({
            ...prev,
            [bufferKey]: {
              ...(prev[bufferKey] ?? {
                content: "",
                loading: false,
                dirty: false,
                saving: false,
                error: null,
              }),
              loading: false,
              error: message,
            },
          }));
        }
      })();
    },
    [fileSystemContainerId],
  );

  useEffect(() => {
    const uniqueBuffers = new Set<string>();
    for (const tab of editorTabs.primary.tabs) {
      if (tabUsesTextBuffer(tab)) uniqueBuffers.add(`${tab.role}:${tab.path}`);
    }
    for (const tab of editorTabs.secondary.tabs) {
      if (tabUsesTextBuffer(tab)) uniqueBuffers.add(`${tab.role}:${tab.path}`);
    }
    for (const tab of bottomEditorTabs.primary.tabs) {
      if (tabUsesTextBuffer(tab)) uniqueBuffers.add(`${tab.role}:${tab.path}`);
    }
    for (const tab of bottomEditorTabs.secondary.tabs) {
      if (tabUsesTextBuffer(tab)) uniqueBuffers.add(`${tab.role}:${tab.path}`);
    }
    for (const entry of uniqueBuffers) {
      const [, ...rest] = entry.split(":");
      ensureBufferLoaded("user", rest.join(":"));
    }
  }, [bottomEditorTabs, editorTabs, ensureBufferLoaded]);

  const openFileInPane = useCallback(
    (
      role: FileRole,
      filePath: string,
      paneId: PaneId,
      requestedKind: EditorTabKind,
      requestedView: EditorTabView,
      alternateViewBehavior: "activate" | "convert" | "ignore" = "convert",
      frameId: FrameId = "top",
    ) => {
      const normalizedPath = normalizeFilePath(filePath);
      if (!normalizedPath) return;
      if (
        requestedView === "editor" ||
        (requestedView === "preview" &&
          isPreviewBackedByTextBufferPath(normalizedPath))
      ) {
        ensureBufferLoaded(role, normalizedPath);
      }
      setFramePaneTabs(frameId, paneId, (pane) => {
        const exactExisting = pane.tabs.find(
          (tab) =>
            tab.path === normalizedPath &&
            tab.role === role &&
            tab.view === requestedView,
        );
        if (exactExisting) {
          const nextTabs = pane.tabs.map((tab) =>
            tab.id === exactExisting.id
              ? {
                  ...tab,
                  kind: (requestedKind === "edit" ? "edit" : tab.kind) as EditorTabKind,
                }
              : tab,
          );
          return { ...pane, tabs: nextTabs, activeTabId: exactExisting.id };
        }

        const alternateExisting = pane.tabs.find(
          (tab) =>
            tab.path === normalizedPath &&
            tab.role === role &&
            tab.view !== requestedView,
        );
        if (alternateExisting) {
          if (alternateViewBehavior === "activate") {
            const nextTabs = pane.tabs.map((tab) =>
              tab.id === alternateExisting.id && requestedKind === "edit"
                ? { ...tab, kind: "edit" as EditorTabKind }
                : tab,
            );
            return {
              ...pane,
              tabs: nextTabs,
              activeTabId: alternateExisting.id,
            };
          }
          if (alternateViewBehavior === "convert") {
            const nextTabs = pane.tabs.map((tab) =>
              tab.id === alternateExisting.id
                ? {
                    ...tab,
                    kind: (requestedKind === "edit" ? "edit" : tab.kind) as EditorTabKind,
                    view: requestedView as EditorTabView,
                  }
                : tab,
            );
            return {
              ...pane,
              tabs: nextTabs,
              activeTabId: alternateExisting.id,
            };
          }
        }

        const nextTab: EditorTab = {
          id: makeTabId(),
          path: normalizedPath,
          role,
          label: getFileName(normalizedPath),
          kind: requestedKind,
          view: requestedView,
        };
        let nextTabs = pane.tabs;
        if (requestedKind === "temporary") {
          nextTabs = nextTabs.filter((tab) => tab.kind !== "temporary");
        }
        return {
          ...pane,
          tabs: [...nextTabs, nextTab],
          activeTabId: nextTab.id,
          renameTabId: null,
          renameDraft: "",
        };
      });
      if (frameId === "top") {
        setFocusedPane(paneId);
        setFrameViews((prev) =>
          prev.top === "editor-split" ? prev : { ...prev, top: "editor-split" },
        );
        setBottomMaximized(false);
      } else {
        setFocusedBottomPane(paneId);
        setLayout((prev) => ({ ...prev, showBottom: true }));
      }
      setFocusedEditorFrame(frameId);
    },
    [ensureBufferLoaded, setFramePaneTabs],
  );

  const onOpenFileTemporary = useCallback(
    (filePath: string): boolean => {
      const normalizedPath = normalizeFilePath(filePath);
      if (!normalizedPath) return false;
      const target = getFocusedEditorTarget();
      openFileInPane(
        "user",
        filePath,
        target.paneId,
        "temporary",
        getTemporaryFileBrowserViewForPath(normalizedPath),
        "activate",
        target.frameId,
      );
      return true;
    },
    [getFocusedEditorTarget, openFileInPane],
  );

  const onOpenFileEdit = useCallback(
    (filePath: string): boolean => {
      const normalizedPath = normalizeFilePath(filePath);
      if (!normalizedPath) return false;
      const target = getFocusedEditorTarget();
      openFileInPane(
        "user",
        filePath,
        target.paneId,
        "edit",
        getEditViewForPath(normalizedPath),
        "convert",
        target.frameId,
      );
      return true;
    },
    [getFocusedEditorTarget, openFileInPane],
  );

  const onOpenTextPreviewTab = useCallback(
    (paneId: PaneId, filePath: string, frameId: FrameId = "top") => {
      const normalizedPath = normalizeFilePath(filePath);
      if (!normalizedPath || !isPreviewBackedByTextBufferPath(normalizedPath))
        return;
      openFileInPane(
        "user",
        normalizedPath,
        paneId,
        "edit",
        "preview",
        "ignore",
        frameId,
      );
    },
    [openFileInPane],
  );

  const onFileBrowserWorkingDirectoryChange = useCallback(
    (containerId: string, cwd: string | null) => {
      setFileBrowserWorkingDirectoryByContainerId((prev) => {
        if (cwd === null) {
          if (!(containerId in prev)) return prev;
          const next = { ...prev };
          delete next[containerId];
          return next;
        }
        if (prev[containerId] === cwd) return prev;
        return { ...prev, [containerId]: cwd };
      });
    },
    [],
  );

  const onOpenPathFromTerminal = useCallback(
    (containerId: string, path: string, kind: "file" | "directory") => {
      if (!path) return;
      if (activeContainerId && containerId !== activeContainerId) return;

      if (kind === "file") {
        const normalizedPath = normalizeFilePath(path);
        if (!normalizedPath) return;
        const target = getFocusedEditorTarget();
        openFileInPane(
          "user",
          normalizedPath,
          target.paneId,
          "edit",
        getEditViewForPath(normalizedPath),
          "convert",
          target.frameId,
        );
        setEditorFocusRequest({
          nonce: Date.now(),
          frameId: target.frameId,
          paneId: target.paneId,
        });
        return;
      }

      setFrameViews((prev) => ({ ...prev, left: "docker-local" }));
      setLayout((prev) => ({ ...prev, showLeft: true }));
      setFileBrowserRevealRequest({
        nonce: Date.now(),
        path,
        kind: "directory",
      });
    },
    [activeContainerId, getFocusedEditorTarget, openFileInPane],
  );

  const replaceTabPathEverywhere = useCallback(
    (oldPath: string, newPath: string, role: FileRole = "user") => {
      const normalizedOld = normalizeFilePath(oldPath);
      const normalizedNew = normalizeFilePath(newPath);
      if (!normalizedOld || !normalizedNew || normalizedOld === normalizedNew)
        return;
      setEditorTabs((prev) => {
        const remapPane = (pane: PaneTabsState): PaneTabsState => ({
          ...pane,
          tabs: pane.tabs.map((tab) =>
            tab.path === normalizedOld && tab.role === role
              ? {
                  ...tab,
                  path: normalizedNew,
                  label: getFileName(normalizedNew),
                }
              : tab,
          ),
        });
        return {
          primary: remapPane(prev.primary),
          secondary: remapPane(prev.secondary),
        };
      });
      setFileBuffers((prev) => {
        const sourceKey = toBufferKey(role, normalizedOld);
        const targetKey = toBufferKey(role, normalizedNew);
        const existing = prev[sourceKey];
        if (!existing) return prev;
        const { [sourceKey]: removed, ...rest } = prev;
        return { ...rest, [targetKey]: existing };
      });
    },
    [],
  );

  const closeTabInFrame = useCallback(
    (
      frameId: FrameId,
      paneId: PaneId,
      tabId: string,
      opts?: { preserveTerminalSession?: boolean },
    ) => {
      const currentTabs =
        frameId === "top" ? editorTabsRef.current : bottomEditorTabsRef.current;
      let shouldHideBottom = false;
      const tabToClose = currentTabs[paneId].tabs.find((tab) => tab.id === tabId);
      if (
        !opts?.preserveTerminalSession &&
        tabToClose?.view === "terminal" &&
        tabToClose.terminalDescriptor?.sessionId
      ) {
        void dockerClient
          .destroyTerminalSession(tabToClose.terminalDescriptor.sessionId)
          .catch(() => {});
      }
      const setTabsState =
        frameId === "top" ? setEditorTabs : setBottomEditorTabs;
      const splitMode = frameId === "top" ? topSplit.mode : bottomSplit.mode;
      const setSplitState = frameId === "top" ? setTopSplit : setBottomSplit;
      const setFocusedPaneForFrame =
        frameId === "top" ? setFocusedPane : setFocusedBottomPane;
      setTabsState((prev) => {
        const pane = prev[paneId];
        const index = pane.tabs.findIndex((tab) => tab.id === tabId);
        if (index < 0) return prev;
        const nextTabs = pane.tabs.filter((tab) => tab.id !== tabId);
        let nextActive = pane.activeTabId;
        if (pane.activeTabId === tabId) {
          const fallback = nextTabs[index] ?? nextTabs[index - 1] ?? null;
          nextActive = fallback?.id ?? null;
        }
        const nextPane: PaneTabsState = {
          ...pane,
          tabs: nextTabs,
          activeTabId: nextActive,
          renameTabId: pane.renameTabId === tabId ? null : pane.renameTabId,
          renameDraft: pane.renameTabId === tabId ? "" : pane.renameDraft,
        };
        const nextState: EditorTabsState = { ...prev, [paneId]: nextPane };
        if (splitMode === "single" || nextPane.tabs.length > 0) {
          if (
            frameId === "bottom"
            && nextState.primary.tabs.length === 0
            && nextState.secondary.tabs.length === 0
          ) {
            shouldHideBottom = true;
          }
          return nextState;
        }
        const remainingPaneId: PaneId =
          paneId === "primary" ? "secondary" : "primary";
        const remainingPane = nextState[remainingPaneId];
        setSplitState((prevSplit) => ({
          ...prevSplit,
          mode: "single",
          primary:
            remainingPaneId === "primary"
              ? prevSplit.primary
              : prevSplit.secondary,
        }));
        setFocusedPaneForFrame("primary");
        if (remainingPane.tabs.length === 0) {
          if (frameId === "bottom") shouldHideBottom = true;
          return {
            primary: { ...EMPTY_PANE_TABS },
            secondary: { ...EMPTY_PANE_TABS },
          };
        }
        return {
          primary: { ...remainingPane },
          secondary: { ...EMPTY_PANE_TABS },
        };
      });
      if (frameId === "bottom" && shouldHideBottom) {
        setLayout((prev) => ({ ...prev, showBottom: false }));
        if (activeFocusFrame === "bottom") {
          setActiveFocusFrame("top");
          setFocusedEditorFrame("top");
        }
      }
    },
    [activeFocusFrame, bottomSplit.mode, topSplit.mode],
  );

  const onCloseTab = useCallback(
    (
      paneId: PaneId,
      tabId: string,
      opts?: { preserveTerminalSession?: boolean },
    ) => {
      closeTabInFrame("top", paneId, tabId, opts);
    },
    [closeTabInFrame],
  );

  const moveEditorTab = useCallback(
    (
      sourceFrameId: FrameId,
      sourcePaneId: PaneId,
      targetFrameId: FrameId,
      targetPaneId: PaneId,
      tabId: string,
      targetIndex?: number,
    ) => {
      const currentTop = editorTabsRef.current;
      const currentBottom = bottomEditorTabsRef.current;
      const sourceState = sourceFrameId === "top" ? currentTop : currentBottom;
      const targetState = targetFrameId === "top" ? currentTop : currentBottom;
      const sourcePane = sourceState[sourcePaneId];
      const targetPane = targetState[targetPaneId];
      const sourceIndex = sourcePane.tabs.findIndex((tab) => tab.id === tabId);
      if (sourceIndex < 0) return;
      const movedTab = sourcePane.tabs[sourceIndex];
      if (!movedTab) return;

      const nextSourceTabs = sourcePane.tabs.filter((tab) => tab.id !== tabId);
      const nextTargetTabs =
        sourceFrameId === targetFrameId && sourcePaneId === targetPaneId
          ? nextSourceTabs
          : [...targetPane.tabs];
      const safeIndex = Math.max(
        0,
        Math.min(targetIndex ?? nextTargetTabs.length, nextTargetTabs.length),
      );
      nextTargetTabs.splice(safeIndex, 0, movedTab);

      const nextSourceActive =
        sourcePane.activeTabId === tabId
          ? (nextSourceTabs[sourceIndex] ?? nextSourceTabs[sourceIndex - 1] ?? null)
          : (sourcePane.tabs.find((tab) => tab.id === sourcePane.activeTabId) ?? null);

      const nextSourcePane: PaneTabsState = {
        ...sourcePane,
        tabs: nextSourceTabs,
        activeTabId:
          sourceFrameId === targetFrameId && sourcePaneId === targetPaneId
            ? tabId
            : nextSourceActive?.id ?? null,
        renameTabId:
          sourcePane.renameTabId === tabId ? null : sourcePane.renameTabId,
        renameDraft:
          sourcePane.renameTabId === tabId ? "" : sourcePane.renameDraft,
      };
      const nextTargetPane: PaneTabsState = {
        ...targetPane,
        tabs: nextTargetTabs,
        activeTabId: tabId,
      };

      const apply = (frameId: FrameId, nextState: EditorTabsState) => {
        if (frameId === "top") setEditorTabs(nextState);
        else setBottomEditorTabs(nextState);
      };

      if (sourceFrameId === targetFrameId) {
        const nextState: EditorTabsState =
          sourcePaneId === targetPaneId
            ? { ...sourceState, [sourcePaneId]: nextTargetPane }
            : {
                ...sourceState,
                [sourcePaneId]: nextSourcePane,
                [targetPaneId]: nextTargetPane,
              };
        apply(sourceFrameId, nextState);
      } else {
        apply(sourceFrameId, {
          ...sourceState,
          [sourcePaneId]: nextSourcePane,
        });
        apply(targetFrameId, {
          ...targetState,
          [targetPaneId]: nextTargetPane,
        });
      }

      focusOpenedPane(targetFrameId, targetPaneId);
    },
    [],
  );

  const dropEditorTabToNewSplitInFrame = useCallback(
    (
      frameId: FrameId,
      sourcePaneId: PaneId,
      tabId: string,
      edge: "right" | "bottom",
    ) => {
      const splitMode = frameId === "top" ? topSplit.mode : bottomSplit.mode;
      if (splitMode !== "single") return;
      const setTabsState =
        frameId === "top" ? setEditorTabs : setBottomEditorTabs;
      const setSplitState = frameId === "top" ? setTopSplit : setBottomSplit;
      const setFocusedPaneForFrame =
        frameId === "top" ? setFocusedPane : setFocusedBottomPane;
      setTabsState((prev) => {
        const sourcePane = prev[sourcePaneId];
        const sourceIndex = sourcePane.tabs.findIndex((tab) => tab.id === tabId);
        if (sourceIndex < 0) return prev;
        const movedTab = sourcePane.tabs[sourceIndex];
        if (!movedTab) return prev;
        const nextSourceTabs = sourcePane.tabs.filter((tab) => tab.id !== tabId);
        const nextSourceActive =
          sourcePane.activeTabId === tabId
            ? (nextSourceTabs[sourceIndex] ?? nextSourceTabs[sourceIndex - 1] ?? null)
            : (sourcePane.tabs.find((tab) => tab.id === sourcePane.activeTabId) ?? null);
        return {
          primary: {
            ...sourcePane,
            tabs: nextSourceTabs,
            activeTabId: nextSourceActive?.id ?? null,
            renameTabId:
              sourcePane.renameTabId === tabId ? null : sourcePane.renameTabId,
            renameDraft:
              sourcePane.renameTabId === tabId ? "" : sourcePane.renameDraft,
          },
          secondary: {
            tabs: [movedTab],
            activeTabId: movedTab.id,
            renameTabId: null,
            renameDraft: "",
          },
        };
      });
      setSplitState((prev) => ({
        ...prev,
        mode: edge === "right" ? "row" : "column",
      }));
      setFocusedPaneForFrame("secondary");
      focusOpenedPane(frameId, "secondary");
    },
    [bottomSplit.mode, topSplit.mode],
  );

  const dropEditorTabToNewSplit = useCallback(
    (sourcePaneId: PaneId, tabId: string, edge: "right" | "bottom") => {
      dropEditorTabToNewSplitInFrame("top", sourcePaneId, tabId, edge);
    },
    [dropEditorTabToNewSplitInFrame],
  );

  const dropFileToNewSplitInFrame = useCallback(
    (
      frameId: FrameId,
      path: string,
      role: FileRole,
      edge: "right" | "bottom",
    ) => {
      const splitMode = frameId === "top" ? topSplit.mode : bottomSplit.mode;
      if (splitMode !== "single") return;
      const setSplitState = frameId === "top" ? setTopSplit : setBottomSplit;
      setSplitState((prev) => ({
        ...prev,
        mode: edge === "right" ? "row" : "column",
      }));
      const normalizedPath = normalizeFilePath(path);
      if (!normalizedPath) return;
      openFileInPane(
        role,
        normalizedPath,
        "secondary",
        "edit",
        getEditViewForPath(normalizedPath),
        "convert",
        frameId,
      );
    },
    [bottomSplit.mode, openFileInPane, topSplit.mode],
  );

  const dropFileToNewSplit = useCallback(
    (path: string, role: FileRole, edge: "right" | "bottom") => {
      dropFileToNewSplitInFrame("top", path, role, edge);
    },
    [dropFileToNewSplitInFrame],
  );

  const onSplitTerminalDescriptorSessionIdChange = useCallback(
    (
      frameId: FrameId,
      paneId: PaneId,
      tabId: string,
      sessionId: string | null,
    ) => {
      setFramePaneTabs(frameId, paneId, (pane) => ({
        ...pane,
        tabs: pane.tabs.map((tab) => {
          if (
            tab.id !== tabId ||
            tab.view !== "terminal" ||
            !tab.terminalDescriptor
          )
            return tab;
          return {
            ...tab,
            terminalDescriptor: {
              ...tab.terminalDescriptor,
              sessionId,
            },
          };
        }),
      }));
    },
    [setFramePaneTabs],
  );

  const promoteTabToEdit = useCallback(
    (paneId: PaneId, tabId: string, frameId: FrameId = "top") => {
      setFramePaneTabs(frameId, paneId, (pane) => ({
        ...pane,
        tabs: pane.tabs.map((tab) =>
          tab.id === tabId
            ? {
                ...tab,
                kind: "edit",
                view:
                  tab.view === "preview" &&
                  isPreviewBackedByTextBufferPath(tab.path)
                    ? "editor"
                    : tab.view,
              }
            : tab,
        ),
      }));
    },
    [setFramePaneTabs],
  );

  const onEditorChange = useCallback(
    (
      paneId: PaneId,
      role: FileRole,
      path: string,
      nextContent: string,
      frameId: FrameId = "top",
    ) => {
      const normalized = normalizeFilePath(path);
      const bufferKey = toBufferKey(role, normalized);
      setFileBuffers((prev) => ({
        ...prev,
        [bufferKey]: {
          ...(prev[bufferKey] ?? {
            content: "",
            loading: false,
            dirty: false,
            saving: false,
            error: null,
          }),
          content: nextContent,
          dirty: true,
          error: null,
        },
      }));
      setFramePaneTabs(frameId, paneId, (pane) => ({
        ...pane,
        tabs: pane.tabs.map((tab) =>
          tab.path === normalized &&
          tab.role === role &&
          tab.kind === "temporary"
            ? { ...tab, kind: "edit" }
            : tab,
        ),
      }));
    },
    [setFramePaneTabs],
  );

  const onStartRenameTab = useCallback(
    (paneId: PaneId, tabId: string, frameId: FrameId = "top") => {
      setFramePaneTabs(frameId, paneId, (pane) => {
        const tab = pane.tabs.find((item) => item.id === tabId);
        if (!tab || tab.kind !== "edit" || tab.view !== "editor") return pane;
        return {
          ...pane,
          renameTabId: tabId,
          renameDraft: tab.label,
          activeTabId: tabId,
        };
      });
      if (frameId === "top") setFocusedPane(paneId);
      else setFocusedBottomPane(paneId);
    },
    [setFramePaneTabs],
  );

  const onChangeRenameDraft = useCallback(
    (paneId: PaneId, value: string, frameId: FrameId = "top") => {
      setFramePaneTabs(frameId, paneId, (pane) => ({ ...pane, renameDraft: value }));
    },
    [setFramePaneTabs],
  );

  const onCancelRename = useCallback(
    (paneId: PaneId, frameId: FrameId = "top") => {
      setFramePaneTabs(frameId, paneId, (pane) => ({
        ...pane,
        renameTabId: null,
        renameDraft: "",
      }));
    },
    [setFramePaneTabs],
  );

  const onCommitRename = useCallback(
    async (paneId: PaneId, frameId: FrameId = "top") => {
      const frameTabs =
        frameId === "top" ? editorTabsRef.current : bottomEditorTabsRef.current;
      const pane = frameTabs[paneId];
      const renameTabId = pane.renameTabId;
      if (!renameTabId) return;
      const targetTab = pane.tabs.find((tab) => tab.id === renameTabId);
      if (
        !targetTab ||
        targetTab.kind !== "edit" ||
        targetTab.view !== "editor"
      )
        return;
      const nextName = pane.renameDraft.trim();
      if (!nextName || nextName.includes("/")) {
        onCancelRename(paneId, frameId);
        return;
      }
      const parent = getParentPath(targetTab.path);
      const nextPath = normalizeFilePath(
        parent ? `${parent}/${nextName}` : nextName,
      );
      if (nextPath === targetTab.path) {
        onCancelRename(paneId, frameId);
        return;
      }
      // TODO: Phase 5 — docker_renameFile RPC
      replaceTabPathEverywhere(targetTab.path, nextPath, targetTab.role);
      setFramePaneTabs(frameId, paneId, (p) => ({
        ...p,
        renameTabId: null,
        renameDraft: "",
      }));
      setFileBrowserRefreshNonce((prev) => prev + 1);
    },
    [onCancelRename, replaceTabPathEverywhere, setFramePaneTabs],
  );

  const saveTabByPath = useCallback(
    async (path: string, role: FileRole = "user") => {
      const normalized = normalizeFilePath(path);
      const shouldPromptSaveAs = Boolean(pendingSaveAsPaths[normalized]);
      if (!shouldPromptSaveAs) {
        await saveBufferNow(role, normalized);
        return;
      }
      const nextPath = await askPrompt({
        title: "Save File As",
        message: "Enter a file path",
        defaultValue: normalized,
        confirmLabel: "Save",
      });
      if (nextPath === null) return;
      const dest = normalizeFilePath(nextPath);
      if (!dest) return;
      const sourceKey = toBufferKey(role, normalized);
      const content = fileBuffersRef.current[sourceKey]?.content ?? "";
      await saveBufferNow(role, dest, content);
      replaceTabPathEverywhere(normalized, dest, role);
      setPendingSaveAsPaths((prev) => {
        const next = { ...prev };
        delete next[normalized];
        delete next[dest];
        return next;
      });
      setFileBrowserRefreshNonce((prev) => prev + 1);
    },
    [
      askPrompt,
      pendingSaveAsPaths,
      replaceTabPathEverywhere,
      saveBufferNow,
    ],
  );

  const saveAllDirtyTabs = useCallback(async () => {
    const uniqueEntries = new Set<string>();
    for (const tab of editorTabs.primary.tabs) {
      if (tab.view === "editor") uniqueEntries.add(`${tab.role}:${tab.path}`);
    }
    for (const tab of editorTabs.secondary.tabs) {
      if (tab.view === "editor") uniqueEntries.add(`${tab.role}:${tab.path}`);
    }
    for (const tab of bottomEditorTabs.primary.tabs) {
      if (tab.view === "editor") uniqueEntries.add(`${tab.role}:${tab.path}`);
    }
    for (const tab of bottomEditorTabs.secondary.tabs) {
      if (tab.view === "editor") uniqueEntries.add(`${tab.role}:${tab.path}`);
    }
    for (const entry of uniqueEntries) {
      const [, ...rest] = entry.split(":");
      const normalized = normalizeFilePath(rest.join(":"));
      const bufferKey = toBufferKey("user", normalized);
      const needsSaveAs = Boolean(pendingSaveAsPaths[normalized]);
      const isDirty = Boolean(fileBuffersRef.current[bufferKey]?.dirty);
      if (!needsSaveAs && !isDirty) continue;
      await saveTabByPath(normalized, "user");
    }
  }, [bottomEditorTabs, editorTabs, pendingSaveAsPaths, saveTabByPath]);

  const closeCurrentPaneTab = useCallback(
    (frameId: FrameId, paneId: PaneId, force: boolean) => {
      const frameTabs =
        frameId === "top" ? editorTabsRef.current : bottomEditorTabsRef.current;
      const pane = frameTabs[paneId];
      const activeTab =
        pane.tabs.find((tab) => tab.id === pane.activeTabId) ?? pane.tabs[0];
      if (!activeTab) return;
      if (activeTab.view !== "editor") {
        closeTabInFrame(frameId, paneId, activeTab.id);
        return undefined;
      }
      const bufferKey = toBufferKey(activeTab.role, activeTab.path);
      if (!force && fileBuffersRef.current[bufferKey]?.dirty) {
        return "No write since last change (add ! to override)";
      }
      closeTabInFrame(frameId, paneId, activeTab.id);
      return undefined;
    },
    [closeTabInFrame],
  );

  // ---- Vim host builder ----
  const buildPaneVimHost = useCallback(
    (frameId: FrameId, paneId: PaneId, activeTab: EditorTab | null): VimHost => ({
      resolvePathKind: async () => "file" as const,
      write: async () => {
        if (!activeTab) return;
        await saveTabByPath(activeTab.path, activeTab.role);
      },
      saveAs: async (path: string) => {
        if (!activeTab) return;
        const normalizedNewPath = normalizeFilePath(path);
        if (!normalizedNewPath) return;
        const sourceKey = toBufferKey(activeTab.role, activeTab.path);
        const content = fileBuffersRef.current[sourceKey]?.content ?? "";
        await saveBufferNow(activeTab.role, normalizedNewPath, content);
        replaceTabPathEverywhere(
          activeTab.path,
          normalizedNewPath,
          activeTab.role,
        );
        setFileBrowserRefreshNonce((prev) => prev + 1);
      },
      closeSplit: () => {
        // Match the UI "close split" behavior: collapse to a single pane and
        // ensure focus returns to the remaining CodeMirror instance.
        const setSplitState = frameId === "top" ? setTopSplit : setBottomSplit;
        const clearSecondary =
          frameId === "top"
            ? (updater: (pane: PaneTabsState) => PaneTabsState) =>
                setFramePaneTabs("top", "secondary", updater)
            : (updater: (pane: PaneTabsState) => PaneTabsState) =>
                setFramePaneTabs("bottom", "secondary", updater);
        setSplitState((prev) =>
          prev.mode === "single" ? prev : { ...prev, mode: "single" },
        );
        clearSecondary(() => ({ ...EMPTY_PANE_TABS }));
        if (frameId === "top") setFocusedPane("primary");
        else setFocusedBottomPane("primary");
        setEditorFocusRequest({ nonce: Date.now(), frameId, paneId: "primary" });
      },
      split: (direction, path) => {
        const setSplitState = frameId === "top" ? setTopSplit : setBottomSplit;
        setSplitState((prev) => ({
          ...prev,
          mode: direction === "vertical" ? "row" : "column",
        }));
        const targetPane: PaneId =
          paneId === "primary" ? "secondary" : "primary";
        const targetPath = normalizeFilePath(path ?? activeTab?.path ?? "");
        if (!targetPath) return;
        openFileInPane(
          "user",
          targetPath,
          targetPane,
          "edit",
          getEditViewForPath(targetPath),
          "convert",
          frameId,
        );
        setEditorFocusRequest({ nonce: Date.now(), frameId, paneId: targetPane });
      },
      editFile: (path: string) => {
        const normalizedPath = normalizeFilePath(path);
        if (!normalizedPath) return;
        openFileInPane(
          "user",
          normalizedPath,
          paneId,
          "edit",
          getEditViewForPath(normalizedPath),
          "convert",
          frameId,
        );
      },
      reloadCurrentBuffer: async () => {
        if (!activeTab) return;
        const normalized = normalizeFilePath(activeTab.path);
        if (!normalized) return;

        const bufferKey = toBufferKey(activeTab.role, normalized);
        setFileBuffers((prev) => ({
          ...prev,
          [bufferKey]: {
            ...(prev[bufferKey] ?? {
              content: "",
              loading: false,
              dirty: false,
              saving: false,
              error: null,
            }),
            content: prev[bufferKey]?.content ?? "",
            loading: true,
            error: null,
          },
        }));

        if (!fileSystemContainerId) {
          setFileBuffers((prev) => ({
            ...prev,
            [bufferKey]: {
              ...(prev[bufferKey] ?? {
                content: "",
                loading: false,
                dirty: false,
                saving: false,
                error: null,
              }),
              loading: false,
              error: "No selected running container available to reload from.",
            },
          }));
          setVimMessageModal({
            title: "Vim",
            message: "No selected running container available to reload from.",
          });
          return;
        }

        try {
          const content = await dockerClient.readFile(
            fileSystemContainerId,
            toContainerAbsolutePath(normalized),
          );
          setFileBuffers((prev) => ({
            ...prev,
            [bufferKey]: {
              ...(prev[bufferKey] ?? {
                content: "",
                loading: false,
                dirty: false,
                saving: false,
                error: null,
              }),
              content,
              loading: false,
              dirty: false,
              saving: false,
              error: null,
            },
          }));
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Failed to reload file.";
          setFileBuffers((prev) => ({
            ...prev,
            [bufferKey]: {
              ...(prev[bufferKey] ?? {
                content: "",
                loading: false,
                dirty: false,
                saving: false,
                error: null,
              }),
              loading: false,
              error: message,
            },
          }));
          setVimMessageModal({ title: "Vim", message });
        }
      },
      focusDirectory: async () => {
        setFrameViews((prev) => ({ ...prev, left: "docker-local" }));
        setLayout((prev) => ({ ...prev, showLeft: true }));
      },
      openTemporaryBuffer: async (path: string) => {
        const normalized = normalizeFilePath(path);
        if (!normalized) return;
        const bufferKey = toBufferKey("user", normalized);
        setFileBuffers((prev) => ({
          ...prev,
          [bufferKey]: {
            ...(prev[bufferKey] ?? {
              content: "",
              loading: false,
              dirty: false,
              saving: false,
              error: null,
            }),
            content: prev[bufferKey]?.content ?? "",
            loading: false,
            error: null,
          },
        }));
        setPendingSaveAsPaths((prev) => ({ ...prev, [normalized]: true }));
        setPaneTabs(paneId, (pane) => {
          const existing = pane.tabs.find(
            (tab) => tab.path === normalized && tab.role === "user",
          );
          if (existing) return { ...pane, activeTabId: existing.id };
          const nextTab: EditorTab = {
            id: makeTabId(),
            path: normalized,
            role: "user",
            label: getFileName(normalized),
            kind: "temporary",
            view: "editor",
          };
          return {
            ...pane,
            tabs: [
              ...pane.tabs.filter((tab) => tab.kind !== "temporary"),
              nextTab,
            ],
            activeTabId: nextTab.id,
            renameTabId: null,
            renameDraft: "",
          };
        });
        setFocusedPane(paneId);
        setFrameViews((prev) =>
          prev.top === "editor-split" ? prev : { ...prev, top: "editor-split" },
        );
      },
      showMessage: (message: string) => {
        setVimMessageModal({ title: "Vim", message });
      },
      quit: (force: boolean) => closeCurrentPaneTab(frameId, paneId, force),
      terminalFocus: () => openAndFocusTerminal(),
      terminalRun: (command: string) => openAndRunTerminalCommand(command),
      writeQuit: async () => {
        if (!activeTab) return;
        await saveTabByPath(activeTab.path, activeTab.role);
        closeTabInFrame(frameId, paneId, activeTab.id);
      },
      writeQuitAll: async () => {
        await saveAllDirtyTabs();
        if (frameId === "top") {
          setEditorTabs({
            primary: { ...EMPTY_PANE_TABS },
            secondary: { ...EMPTY_PANE_TABS },
          });
          setTopSplit((prev) => ({ ...prev, mode: "single" }));
          setFocusedPane("primary");
        } else {
          setBottomEditorTabs({
            primary: { ...EMPTY_PANE_TABS },
            secondary: { ...EMPTY_PANE_TABS },
          });
          setBottomSplit((prev) => ({ ...prev, mode: "single" }));
          setFocusedBottomPane("primary");
        }
      },
    }),
    [
      closeCurrentPaneTab,
      fileSystemContainerId,
      onCloseTab,
      openFileInPane,
      openAndFocusTerminal,
      openAndRunTerminalCommand,
      replaceTabPathEverywhere,
      saveAllDirtyTabs,
      saveBufferNow,
      saveTabByPath,
      setPaneTabs,
    ],
  );

  // Keyboard shortcuts
  useEffect(() => {
    const movementDirectionByKey: Record<
      string,
      "left" | "right" | "up" | "down"
    > = {
      h: "left",
      ArrowLeft: "left",
      l: "right",
      ArrowRight: "right",
      k: "up",
      ArrowUp: "up",
      j: "down",
      ArrowDown: "down",
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const now = Date.now();
      if (
        ctrlWPendingUntilRef.current > 0 &&
        now > ctrlWPendingUntilRef.current
      ) {
        ctrlWPendingUntilRef.current = 0;
      }

      const isCtrlWPrefix =
        event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === "w";
      if (isCtrlWPrefix) {
        ctrlWPendingUntilRef.current = now + 1400;
        event.preventDefault();
        return;
      }

      if (ctrlWPendingUntilRef.current > now) {
        const direction =
          movementDirectionByKey[event.key] ??
          movementDirectionByKey[event.key.toLowerCase()];
        if (direction) {
          ctrlWPendingUntilRef.current = 0;
          event.preventDefault();
          navigateVimWindow(direction);
          return;
        }
        if (
          event.key !== "Control" &&
          event.key !== "Meta" &&
          event.key !== "Alt" &&
          event.key !== "Shift"
        ) {
          ctrlWPendingUntilRef.current = 0;
        }
      }

      const isCyclePrevTabCommand =
        event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        event.shiftKey &&
        (event.key.toLowerCase() === "h" || event.key === "ArrowLeft");
      if (isCyclePrevTabCommand) {
        event.preventDefault();
        cycleActivePaneTab(-1);
        return;
      }
      const isCycleNextTabCommand =
        event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        event.shiftKey &&
        (event.key.toLowerCase() === "l" || event.key === "ArrowRight");
      if (isCycleNextTabCommand) {
        event.preventDefault();
        cycleActivePaneTab(1);
        return;
      }

      const isCloseTabCommand =
        event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === "w";
      if (isCloseTabCommand) {
        const target = event.target;
        const inCodeEditor =
          target instanceof Element && Boolean(target.closest(".cm-editor"));
        if (!inCodeEditor) return;
        const activePaneId =
          focusedEditorFrame === "top" ? focusedPane : focusedBottomPane;
        const frameTabs =
          focusedEditorFrame === "top" ? editorTabs : bottomEditorTabs;
        const pane = frameTabs[activePaneId];
        const activeTab =
          pane.tabs.find((tab) => tab.id === pane.activeTabId) ??
          pane.tabs[0] ??
          null;
        if (!activeTab) return;
        event.preventDefault();
        closeTabInFrame(focusedEditorFrame, activePaneId, activeTab.id);
        return;
      }
      const isSaveCommand =
        (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s";
      if (!isSaveCommand) return;
      event.preventDefault();
      const activePaneId =
        focusedEditorFrame === "top" ? focusedPane : focusedBottomPane;
      const frameTabs =
        focusedEditorFrame === "top" ? editorTabs : bottomEditorTabs;
      const pane = frameTabs[activePaneId];
      const activeTab =
        pane.tabs.find((tab) => tab.id === pane.activeTabId) ??
        pane.tabs[0] ??
        null;
      if (!activeTab || activeTab.view !== "editor") return;
      void saveTabByPath(activeTab.path, activeTab.role);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    bottomEditorTabs,
    closeTabInFrame,
    cycleActivePaneTab,
    editorTabs,
    focusedBottomPane,
    focusedEditorFrame,
    focusedPane,
    navigateVimWindow,
    saveTabByPath,
  ]);

  // ============================
  // RENDER
  // ============================

  return (
    <div className="h-screen w-screen flex flex-col bg-background text-foreground">
      {/* Top nav (40px) */}
      <header
        className="h-10 shrink-0 border-b px-3 flex items-center electrobun-webkit-app-region-drag select-none"
        onMouseDownCapture={onTitlebarMouseDownCapture}
      >
        <div className="flex-1 pointer-events-none flex items-center gap-2" />
        <div className="flex items-center pointer-events-auto titlebar-controls gap-2">
          {hasAnyLeftTabs ? (
            <IconButton
              label={effectiveShowLeft ? "Hide left frame" : "Show left frame"}
              active={effectiveShowLeft}
              onClick={() =>
                setLayout((prev) => ({ ...prev, showLeft: !prev.showLeft }))
              }
            >
              <PanelLeft />
            </IconButton>
          ) : null}
          {!forceTerminalOnlyLayout ? (
            <IconButton
              label={
                effectiveShowBottom ? "Hide bottom frame" : "Show bottom frame"
              }
              active={effectiveShowBottom}
              onClick={() =>
                setLayout((prev) => ({ ...prev, showBottom: !prev.showBottom }))
              }
            >
              <PanelBottom />
            </IconButton>
          ) : null}
          <IconButton
            label="Settings"
            active
            onClick={() => setSettingsOpen(true)}
          >
            <Settings2 />
          </IconButton>
          {canToggleRightFrame ? (
            <button
              type="button"
              aria-label={
                layout.showRight ? "Hide right frame" : "Show right frame"
              }
              title={layout.showRight ? "Hide right frame" : "Show right frame"}
              className={[
                "inline-flex h-8 w-8 items-center justify-center rounded-sm border-none",
                "bg-background hover:bg-secondary",
                layout.showRight ? "" : "opacity-50",
              ].join(" ")}
              onClick={() =>
                setLayout((prev) => ({ ...prev, showRight: !prev.showRight }))
              }
            >
              <img
                src={logoUrl}
                alt="Toggle right frame"
                className="h-[20px] w-[20px] cursor-pointer"
              />
            </button>
          ) : null}
        </div>
      </header>

      {/* Main */}
      <div ref={mainRef} className="flex-1 min-h-0 flex">
        {/* Left */}
        {effectiveShowLeft && (
          <aside
            ref={leftFrameRef}
            tabIndex={-1}
            className="shrink-0 min-w-0 bg-muted/20 h-full outline-none"
            style={{ width: layout.leftWidth }}
            onMouseDownCapture={() => setActiveFocusFrame("left")}
          >
            <div className="h-full flex flex-col">
              <FrameTabBar
                tabs={leftTabs}
                activeTab={activeLeftView}
                onTabChange={(left) =>
                  setFrameViews((prev) => ({ ...prev, left }))
                }
                onClose={() =>
                  setLayout((prev) => ({ ...prev, showLeft: false }))
                }
              />
              <div className="flex-1 min-h-0 overflow-auto text-sm text-muted-foreground relative">
                {hasDockerLocalTab && activeLeftView === "docker-local" ? (
                  <div className="absolute inset-0 overflow-auto">
                    <EnvironmentView
                      dockerContainers={dockerLocalContainers}
                      dockerAvailable={dockerLocalAvailable}
                      dockerHost={null}
                      fallbackAiModels={dockerLocalFallbackAiModels}
                      configuredAiModels={dockerLocalModels}
                      dockerSectionVisibility={{
                        ...integrationSettings.dockerSectionVisibility,
                        aiModel:
                          integrationSettings.dockerSectionVisibility.aiModel &&
                          integrationSettings.dockerLocalEnabled,
                      }}
                      onUpdateDockerSectionVisibility={(section, visible) => {
                        setIntegrationSettings((prev) => {
                          if (prev.dockerSectionVisibility[section] === visible)
                            return prev;
                          const next = {
                            ...prev,
                            dockerSectionVisibility: {
                              ...prev.dockerSectionVisibility,
                              [section]: visible,
                            },
                          };
                          void writeModelProviderIntegrationsState(next);
                          return next;
                        });
                      }}
                      onRefreshContainers={refreshDockerLocalContainers}
                      activeContainerId={dockerLocalActiveContainerId}
                      onSelectContainer={onEnvironmentSelectContainer}
                      onShowContainerLogs={openContainerLogs}
                      onShowContainerInspect={openContainerInspect}
                      onShowModelInspect={(modelName) =>
                        openModelInspect("docker", modelName)
                      }
                      onShowContainerTerminal={openContainerTerminal}
                      onRunAiModel={(modelName) =>
                        openAndRunModelTerminal(modelName, null)
                      }
                      onPullImage={(imageName) =>
                        openAndPullDockerImageTerminal(imageName, null)
                      }
                      onPullAiModel={(modelName) =>
                        openAndPullDockerAiModelTerminal(modelName, null)
                      }
                      selectedRunningContainerId={
                        dockerLocalSelectedRunningContainer?.id ?? null
                      }
                      selectedRunningContainerName={
                        dockerLocalSelectedRunningContainer?.name ?? null
                      }
                      onOpenFileTemporary={onOpenFileTemporary}
                      onOpenFileEdit={onOpenFileEdit}
                      fileBrowserRefreshNonce={fileBrowserRefreshNonce}
                      onFileBrowserRefresh={() =>
                        setFileBrowserRefreshNonce((prev) => prev + 1)
                      }
                      onFileBrowserWorkingDirectoryChange={
                        onFileBrowserWorkingDirectoryChange
                      }
                      fileBrowserRevealRequest={fileBrowserRevealRequest}
                    />
                  </div>
                ) : null}
                {hasOllamaLocalTab ? (
                  <div
                    className="absolute inset-0 overflow-auto"
                    style={{
                      display:
                        activeLeftView === "ollama-local" ? undefined : "none",
                    }}
                  >
                    <OllamaView
                      onRunModel={(modelName) =>
                        openAndRunOllamaModelTerminal(modelName, null)
                      }
                      onPullModel={(modelName) =>
                        openAndPullOllamaModelTerminal(modelName, null)
                      }
                      onShowModelInspect={(modelName) =>
                        openModelInspect("ollama", modelName)
                      }
                      configuredAiModels={ollamaLocalModels}
                      ollamaHost={null}
                    />
                  </div>
                ) : null}
              </div>
            </div>
          </aside>
        )}

        {/* Left resize handle */}
        {effectiveShowLeft && (
          <ResizeHandle
            orientation="vertical"
            onPointerDown={onLeftHandlePointerDown}
            onPointerMove={onHandlePointerMove}
            onPointerUp={onHandlePointerUp}
            onPointerCancel={onHandlePointerCancel}
          />
        )}

        {/* Center */}
        <section
          ref={centerRef}
          className="flex-1 min-w-0 min-h-0 flex flex-col"
        >
          {/* Top frame */}
          <div
            ref={topFrameRef}
            tabIndex={-1}
            className="flex-1 min-h-0 bg-muted/10 outline-none"
            style={{ display: effectiveBottomMaximized ? "none" : undefined }}
            onMouseDownCapture={() => setActiveFocusFrame("top")}
          >
            <div className="h-full flex flex-col">
              {topTabs.length > 1 ? (
                <FrameTabBar
                  tabs={topTabs}
                  activeTab={frameViews.top}
                  onTabChange={(top) =>
                    setFrameViews((prev) => ({ ...prev, top }))
                  }
                />
              ) : null}
              <div className="flex-1 min-h-0">
                {frameViews.top === "editor-split" ? (
                  <EditorSplitView
                    frameId="top"
                    visible={!effectiveBottomMaximized}
                    split={topSplit}
                    onChange={setTopSplit}
                    appTheme={effectiveAppTheme}
                    fileSystemContainerId={fileSystemContainerId}
                    focusedPane={focusedPane}
                    onFocusPane={focusEditorPane}
                    focusRequest={editorFocusRequest}
                    tabsState={editorTabs}
                    buffers={fileBuffers}
                    editorSettings={editorSettings}
                    onEditorSettingsChange={setEditorSettings}
                    onPaneTabsChange={setPaneTabs}
                    onEditorChange={onEditorChange}
                    onPromoteTabToEdit={promoteTabToEdit}
                    onCloseTab={onCloseTab}
                    onMoveTab={moveEditorTab}
                    onDropTabToNewSplit={dropEditorTabToNewSplit}
                    onDropFileToNewSplit={dropFileToNewSplit}
                    onOpenPathFromTerminal={onOpenPathFromTerminal}
                    onSplitTerminalDescriptorSessionIdChange={
                      onSplitTerminalDescriptorSessionIdChange
                    }
                    onOpenTextPreviewTab={onOpenTextPreviewTab}
                    onOpenTerminalDescriptor={(paneId, descriptor) =>
                      openTerminalDescriptorInPane("top", paneId, descriptor)
                    }
                    onStartRenameTab={onStartRenameTab}
                    onChangeRenameDraft={onChangeRenameDraft}
                    onCancelRename={onCancelRename}
                    onCommitRename={onCommitRename}
                    draggedTab={draggedEditorTab}
                    onDraggedTabChange={setDraggedEditorTab}
                    onBuildPaneVimHost={buildPaneVimHost}
                    onSaveTabPath={(tab) =>
                      void saveTabByPath(tab.path, tab.role)
                    }
                    activeContainerId={activeContainerId}
                    visibleContainers={visibleContainers}
                    dockerHost={activeDockerHost}
                    ollamaHost={activeOllamaHost}
                    localTerminalEnabled={integrationSettings.terminalEnabled}
                    dockerLocalEnabled={hasDockerLocalTab}
                    dockerModelEnabled={integrationSettings.dockerLocalEnabled}
                    ollamaLocalEnabled={hasOllamaLocalTab}
                    ollamaModelEnabled={integrationSettings.ollamaLocalEnabled}
                    enabledLocalShells={
                      integrationSettings.terminalEnabledShells
                    }
                    remoteEndpoints={integrationSettings.remoteEndpoints}
                    dockerLocalModels={integrationSettings.dockerLocalModels}
                    ollamaLocalModels={integrationSettings.ollamaLocalModels}
                    terminalTheme={effectiveTerminalTheme}
                    preferredShellCwdByContainerId={
                      fileBrowserWorkingDirectoryByContainerId
                    }
                  />
                ) : null}
                {frameViews.top === "diff-viewer" && diffViewerState ? (
                  <DiffViewer
                    path={diffViewerState.path}
                    leftLabel={diffViewerState.leftLabel}
                    rightLabel={diffViewerState.rightLabel}
                    leftValue={diffViewerState.leftValue}
                    rightValue={diffViewerState.rightValue}
                    onClose={() => {
                      setDiffViewerState(null);
                      setFrameViews((prev) => ({
                        ...prev,
                        top: "editor-split",
                      }));
                    }}
                  />
                ) : null}
              </div>
            </div>
          </div>

          {/* Bottom resize handle */}
          {effectiveShowBottom && !effectiveBottomMaximized && (
            <ResizeHandle
              orientation="horizontal"
              onPointerDown={onBottomHandlePointerDown}
              onPointerMove={onHandlePointerMove}
              onPointerUp={onHandlePointerUp}
              onPointerCancel={onHandlePointerCancel}
            />
          )}

          {/* Bottom frame */}
          <div
            ref={bottomFrameRef}
            tabIndex={-1}
            className={[
              effectiveBottomMaximized
                ? "flex-1 min-h-0 bg-muted/20 outline-none"
                : "shrink-0 bg-muted/20 outline-none",
            ].join(" ")}
            style={{
              height: effectiveBottomMaximized
                ? undefined
                : effectiveShowBottom
                  ? layout.bottomHeight
                  : 0,
              display: effectiveShowBottom ? undefined : "none",
            }}
            onMouseDownCapture={() => setActiveFocusFrame("bottom")}
          >
            <div className="h-full min-h-0 relative">
              {!forceTerminalOnlyLayout ? (
                <div className="absolute right-2 top-2 z-20">
                  <IconButton
                    label={
                      bottomMaximized
                        ? "Minimize bottom frame"
                        : "Maximize bottom frame"
                    }
                    active={bottomMaximized}
                    onClick={onToggleTerminalMaximize}
                  >
                    {bottomMaximized ? (
                      <ChevronDown className="h-4 w-4" />
                    ) : (
                      <ChevronUp className="h-4 w-4" />
                    )}
                  </IconButton>
                </div>
              ) : null}
              <EditorSplitView
                frameId="bottom"
                visible={effectiveShowBottom}
                split={bottomSplit}
                onChange={setBottomSplit}
                appTheme={effectiveAppTheme}
                fileSystemContainerId={fileSystemContainerId}
                focusedPane={focusedBottomPane}
                onFocusPane={focusBottomEditorPane}
                focusRequest={editorFocusRequest}
                tabsState={bottomEditorTabs}
                buffers={fileBuffers}
                editorSettings={editorSettings}
                onEditorSettingsChange={setEditorSettings}
                onPaneTabsChange={(paneId, updater) =>
                  setFramePaneTabs("bottom", paneId, updater)
                }
                onEditorChange={(paneId, role, path, nextContent) =>
                  onEditorChange(paneId, role, path, nextContent, "bottom")
                }
                onPromoteTabToEdit={(paneId, tabId) =>
                  promoteTabToEdit(paneId, tabId, "bottom")
                }
                onCloseTab={(paneId, tabId, opts) =>
                  closeTabInFrame("bottom", paneId, tabId, opts)
                }
                onMoveTab={moveEditorTab}
                onDropTabToNewSplit={(sourcePaneId, tabId, edge) =>
                  dropEditorTabToNewSplitInFrame(
                    "bottom",
                    sourcePaneId,
                    tabId,
                    edge,
                  )
                }
                onDropFileToNewSplit={(path, role, edge) =>
                  dropFileToNewSplitInFrame("bottom", path, role, edge)
                }
                onOpenPathFromTerminal={onOpenPathFromTerminal}
                onSplitTerminalDescriptorSessionIdChange={
                  onSplitTerminalDescriptorSessionIdChange
                }
                onOpenTextPreviewTab={(paneId, filePath) =>
                  onOpenTextPreviewTab(paneId, filePath, "bottom")
                }
                onOpenTerminalDescriptor={(paneId, descriptor) =>
                  openTerminalDescriptorInPane("bottom", paneId, descriptor)
                }
                onStartRenameTab={(paneId, tabId) =>
                  onStartRenameTab(paneId, tabId, "bottom")
                }
                onChangeRenameDraft={(paneId, value) =>
                  onChangeRenameDraft(paneId, value, "bottom")
                }
                onCancelRename={(paneId) => onCancelRename(paneId, "bottom")}
                onCommitRename={(paneId) => onCommitRename(paneId, "bottom")}
                draggedTab={draggedEditorTab}
                onDraggedTabChange={setDraggedEditorTab}
                onBuildPaneVimHost={buildPaneVimHost}
                onSaveTabPath={(tab) => void saveTabByPath(tab.path, tab.role)}
                activeContainerId={activeContainerId}
                visibleContainers={visibleContainers}
                dockerHost={activeDockerHost}
                ollamaHost={activeOllamaHost}
                localTerminalEnabled={integrationSettings.terminalEnabled}
                dockerLocalEnabled={hasDockerLocalTab}
                dockerModelEnabled={integrationSettings.dockerLocalEnabled}
                ollamaLocalEnabled={hasOllamaLocalTab}
                ollamaModelEnabled={integrationSettings.ollamaLocalEnabled}
                enabledLocalShells={integrationSettings.terminalEnabledShells}
                remoteEndpoints={integrationSettings.remoteEndpoints}
                dockerLocalModels={integrationSettings.dockerLocalModels}
                ollamaLocalModels={integrationSettings.ollamaLocalModels}
                terminalTheme={effectiveTerminalTheme}
                preferredShellCwdByContainerId={
                  fileBrowserWorkingDirectoryByContainerId
                }
              />
            </div>
          </div>
        </section>

        {/* Right resize handle */}
        {layout.showRight && (
          <ResizeHandle
            orientation="vertical"
            onPointerDown={onRightHandlePointerDown}
            onPointerMove={onHandlePointerMove}
            onPointerUp={onHandlePointerUp}
            onPointerCancel={onHandlePointerCancel}
          />
        )}

        {/* Right */}
        {layout.showRight && (
          <aside
            className="shrink-0 min-w-0 bg-muted/20 h-full"
            style={{ width: layout.rightWidth }}
          >
            <div className="h-full flex flex-col">
              <FrameTabBar
                tabs={rightTabs}
                activeTab={frameViews.right}
                onTabChange={(right) =>
                  setFrameViews((prev) => ({ ...prev, right }))
                }
                onClose={() =>
                  setLayout((prev) => ({ ...prev, showRight: false }))
                }
              />
              <div className="flex-1 min-h-0 overflow-auto text-sm text-muted-foreground">
                {frameViews.right === "chat" ? <ChatView /> : null}
                {frameViews.right === "generate" ? <GenerateView /> : null}
                {frameViews.right === "sessions" ? <SessionsView /> : null}
              </div>
            </div>
          </aside>
        )}
      </div>

      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        mainEditorTheme={topSplit.primary.theme as MainEditorPaneTheme}
        splitEditorTheme={topSplit.secondary.theme}
        onMainEditorThemeChange={(theme: MainEditorPaneTheme) =>
          setTopSplit((prev) => ({
            ...prev,
            primary: { ...prev.primary, theme },
          }))
        }
        onSplitEditorThemeChange={(theme: SplitEditorPaneTheme) =>
          setTopSplit((prev) => ({
            ...prev,
            secondary: { ...prev.secondary, theme },
          }))
        }
        onAppThemePreview={setAppThemePreview}
        askPrompt={askPrompt}
        askConfirm={askConfirm}
      />

      {vimMessageModal ? (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/45 p-4">
          <button
            type="button"
            className="absolute inset-0"
            aria-label="Close Vim help"
            onClick={() => setVimMessageModal(null)}
          />
          <div className="relative z-[81] w-full max-w-2xl rounded-md border bg-background p-4 shadow-xl">
            <div className="text-sm font-semibold text-foreground">
              {vimMessageModal.title}
            </div>
            <pre className="mt-2 max-h-[60vh] overflow-auto whitespace-pre-wrap text-xs text-muted-foreground">
              {vimMessageModal.message}
            </pre>
            <div className="mt-4 flex items-center justify-end">
              <button
                type="button"
                className="rounded-md border border-primary bg-primary/15 px-3 py-1.5 text-xs text-primary"
                onClick={() => setVimMessageModal(null)}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ============================================================================
// Placeholder views — to be implemented in subsequent phases
// ============================================================================

function ChatView() {
  return (
    <div className="p-3 text-xs text-muted-foreground">
      Chat interface placeholder.
    </div>
  );
}

function GenerateView() {
  return (
    <div className="p-3 text-xs text-muted-foreground">
      Generate interface placeholder.
    </div>
  );
}

function SessionsView() {
  return (
    <div className="p-3 text-xs text-muted-foreground">
      Sessions placeholder.
    </div>
  );
}

// ============================================================================
// ResizeHandle
// ============================================================================

function ResizeHandle({
  orientation,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
}: {
  orientation: "vertical" | "horizontal";
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerCancel: (e: React.PointerEvent<HTMLDivElement>) => void;
}) {
  return (
    <div
      role="separator"
      aria-orientation={orientation}
      className={[
        "shrink-0 bg-border",
        "touch-none select-none",
        orientation === "vertical"
          ? "cursor-col-resize separator-vertical"
          : "cursor-row-resize separator-horizontal",
      ].join(" ")}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={onPointerCancel}
    />
  );
}

// ============================================================================
// EditorSplitView
// ============================================================================

function EditorSplitView({
  frameId,
  visible,
  split,
  onChange,
  appTheme,
  fileSystemContainerId,
  focusedPane,
  onFocusPane,
  focusRequest,
  tabsState,
  buffers,
  editorSettings,
  onEditorSettingsChange,
  onPaneTabsChange,
  onEditorChange,
  onPromoteTabToEdit,
  onCloseTab,
  onMoveTab,
  onStartRenameTab,
  onChangeRenameDraft,
  onCancelRename,
  onCommitRename,
  draggedTab,
  onDraggedTabChange,
  onBuildPaneVimHost,
  onSaveTabPath,
  onOpenPathFromTerminal,
  onSplitTerminalDescriptorSessionIdChange,
  onOpenTextPreviewTab,
  onOpenTerminalDescriptor,
  activeContainerId,
  visibleContainers,
  dockerHost,
  ollamaHost,
  localTerminalEnabled,
  dockerLocalEnabled,
  dockerModelEnabled,
  ollamaLocalEnabled,
  ollamaModelEnabled,
  enabledLocalShells,
  remoteEndpoints,
  dockerLocalModels,
  ollamaLocalModels,
  terminalTheme = "tokyo-night",
  preferredShellCwdByContainerId,
}: {
  frameId: FrameId;
  visible: boolean;
  split: TopSplitState;
  onChange: React.Dispatch<React.SetStateAction<TopSplitState>>;
  appTheme: AppTheme;
  fileSystemContainerId: string | null;
  focusedPane: PaneId;
  onFocusPane: (paneId: PaneId) => void;
  focusRequest: EditorFocusRequest | null;
  tabsState: EditorTabsState;
  buffers: Record<string, FileBufferState>;
  editorSettings: EditorGlobalSettings;
  onEditorSettingsChange: React.Dispatch<
    React.SetStateAction<EditorGlobalSettings>
  >;
  onPaneTabsChange: (
    paneId: PaneId,
    updater: (pane: PaneTabsState) => PaneTabsState,
  ) => void;
  onEditorChange: (
    paneId: PaneId,
    role: FileRole,
    path: string,
    nextContent: string,
  ) => void;
  onPromoteTabToEdit: (paneId: PaneId, tabId: string) => void;
  onCloseTab: (
    paneId: PaneId,
    tabId: string,
    opts?: { preserveTerminalSession?: boolean },
  ) => void;
  onMoveTab: (
    sourceFrameId: FrameId,
    sourcePaneId: PaneId,
    targetFrameId: FrameId,
    targetPaneId: PaneId,
    tabId: string,
    targetIndex?: number,
  ) => void;
  onDropTabToNewSplit: (
    sourcePaneId: PaneId,
    tabId: string,
    edge: "right" | "bottom",
  ) => void;
  onDropFileToNewSplit: (
    path: string,
    role: FileRole,
    edge: "right" | "bottom",
  ) => void;
  onStartRenameTab: (paneId: PaneId, tabId: string) => void;
  onChangeRenameDraft: (paneId: PaneId, value: string) => void;
  onCancelRename: (paneId: PaneId) => void;
  onCommitRename: (paneId: PaneId) => Promise<void>;
  draggedTab: {
    frameId: FrameId;
    paneId: PaneId;
    tabId: string;
  } | null;
  onDraggedTabChange: (
    next: {
      frameId: FrameId;
      paneId: PaneId;
      tabId: string;
    } | null,
  ) => void;
  onBuildPaneVimHost: (
    frameId: FrameId,
    paneId: PaneId,
    activeTab: EditorTab | null,
  ) => VimHost;
  onSaveTabPath: (tab: EditorTab) => void;
  onOpenPathFromTerminal: (
    containerId: string,
    path: string,
    kind: "file" | "directory",
  ) => void;
  onSplitTerminalDescriptorSessionIdChange: (
    frameId: FrameId,
    paneId: PaneId,
    tabId: string,
    sessionId: string | null,
  ) => void;
  onOpenTextPreviewTab: (paneId: PaneId, filePath: string) => void;
  onOpenTerminalDescriptor: (
    paneId: PaneId,
    descriptor: TerminalTabDescriptor,
  ) => void;
  activeContainerId: string | null;
  visibleContainers: ContainerInfo[];
  dockerHost: string | null;
  ollamaHost: string | null;
  localTerminalEnabled: boolean;
  dockerLocalEnabled: boolean;
  dockerModelEnabled: boolean;
  ollamaLocalEnabled: boolean;
  ollamaModelEnabled: boolean;
  enabledLocalShells: string[];
  remoteEndpoints: RemoteSshEndpoint[];
  dockerLocalModels: ProviderModel[];
  ollamaLocalModels: ProviderModel[];
  terminalTheme?: (typeof EDITOR_THEME_OPTIONS)[number];
  preferredShellCwdByContainerId?: Record<string, string>;
}) {
  const [menuPane, setMenuPane] = useState<PaneId | null>(null);
  const [fileDragActive, setFileDragActive] = useState(false);
  const [dropTarget, setDropTarget] = useState<{
    paneId: PaneId;
    index: number;
  } | null>(null);
  const [fileDropPane, setFileDropPane] = useState<PaneId | null>(null);
  const [singleSplitDropEdge, setSingleSplitDropEdge] = useState<
    "right" | "bottom" | null
  >(null);
  const hasSecondary = split.mode !== "single";
  const splitContainerRef = useRef<HTMLDivElement | null>(null);
  const splitDragRef = useRef<{
    pointerId: number;
    mode: Exclude<SplitMode, "single">;
  } | null>(null);

  const setGlobalNoSelect = useCallback((enabled: boolean) => {
    const root = document.documentElement;
    if (enabled) root.classList.add("electrobun-no-select");
    else root.classList.remove("electrobun-no-select");
  }, []);

  const updateSplitRatioFromPointer = useCallback(
    (clientX: number, clientY: number, mode: Exclude<SplitMode, "single">) => {
      const container = splitContainerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      if (mode === "row") {
        if (rect.width <= 0) return;
        const minRatio = clamp(180 / rect.width, 0.1, 0.45);
        const maxRatio = 1 - minRatio;
        const ratio = (clientX - rect.left) / rect.width;
        const nextRatio =
          maxRatio <= minRatio ? 0.5 : clamp(ratio, minRatio, maxRatio);
        onChange((prev) => ({ ...prev, splitRatio: nextRatio }));
      } else {
        if (rect.height <= 0) return;
        const minRatio = clamp(100 / rect.height, 0.1, 0.45);
        const maxRatio = 1 - minRatio;
        const ratio = (clientY - rect.top) / rect.height;
        const nextRatio =
          maxRatio <= minRatio ? 0.5 : clamp(ratio, minRatio, maxRatio);
        onChange((prev) => ({ ...prev, splitRatio: nextRatio }));
      }
    },
    [onChange],
  );

  const setPane = useCallback(
    (
      paneId: "primary" | "secondary",
      updater: (p: EditorPaneState) => EditorPaneState,
    ) => {
      onChange((prev) => {
        const nextPane = updater(prev[paneId]);
        if (prev.mode === "single") {
          return {
            ...prev,
            primary: nextPane,
            secondary: { ...nextPane },
          };
        }
        return { ...prev, [paneId]: nextPane };
      });
    },
    [onChange],
  );

  const splitInto = useCallback(
    (mode: "row" | "column") => {
      onChange((prev) => (prev.mode === mode ? prev : { ...prev, mode }));
    },
    [onChange],
  );

  const closeSplit = useCallback(() => {
    if (split.mode === "single") return;
    onChange((prev) => ({ ...prev, mode: "single" }));
    onPaneTabsChange("secondary", () => ({ ...EMPTY_PANE_TABS }));
    onFocusPane("primary");
  }, [onChange, onFocusPane, onPaneTabsChange, split.mode]);

  // Drag & drop helpers for editor tabs
  const readDraggedTabPayload = (event: React.DragEvent<HTMLElement>) => {
    try {
      const raw =
        event.dataTransfer.getData(EDITOR_TAB_DRAG_MIME) ||
        event.dataTransfer.getData("text/plain");
      if (!raw) return null;
      const parsed = JSON.parse(raw) as {
        frameId: FrameId;
        paneId: PaneId;
        tabId: string;
      };
      if (
        (parsed.frameId !== "top" && parsed.frameId !== "bottom") ||
        (parsed.paneId !== "primary" && parsed.paneId !== "secondary") ||
        typeof parsed.tabId !== "string"
      ) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  };

  const readDraggedFilePayload = (
    event: React.DragEvent<HTMLElement>,
  ): FileBrowserDragPayload | null => {
    try {
      const raw = event.dataTransfer.getData(FILE_BROWSER_DND_MIME);
      if (!raw) return null;
      return JSON.parse(raw) as FileBrowserDragPayload;
    } catch {
      return null;
    }
  };

  const clearDragState = () => {
    onDraggedTabChange(null);
    setDropTarget(null);
    setFileDragActive(false);
    setFileDropPane(null);
    setSingleSplitDropEdge(null);
  };

  const makeTabDragStart =
    (paneId: PaneId) =>
    (tabId: string, event: React.DragEvent<HTMLButtonElement>) => {
      const serializedEditorPayload = JSON.stringify({ frameId, paneId, tabId });
      event.dataTransfer.setData(EDITOR_TAB_DRAG_MIME, serializedEditorPayload);
      // WebKit drag/drop is more reliable when text/plain is present.
      event.dataTransfer.setData("text/plain", serializedEditorPayload);
      event.dataTransfer.effectAllowed = "move";
      onDraggedTabChange({ frameId, paneId, tabId });
    };

  const makeTabDragOver =
    (targetPaneId: PaneId) =>
    (tabId: string, event: React.DragEvent<HTMLButtonElement>) => {
      const payload = readDraggedTabPayload(event);
      if (!payload && !draggedTab) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "move";
      const pane = tabsState[targetPaneId];
      const index = pane.tabs.findIndex((tab) => tab.id === tabId);
      if (index >= 0) setDropTarget({ paneId: targetPaneId, index });
    };

  const makeTabDrop =
    (targetPaneId: PaneId) =>
    (tabId: string, event: React.DragEvent<HTMLButtonElement>) => {
      const payload = readDraggedTabPayload(event) ?? draggedTab;
      if (!payload) return;
      event.preventDefault();
      event.stopPropagation();
      const pane = tabsState[targetPaneId];
      const targetIndex = pane.tabs.findIndex((tab) => tab.id === tabId);
      onMoveTab(
        payload.frameId,
        payload.paneId,
        frameId,
        targetPaneId,
        payload.tabId,
        targetIndex >= 0 ? targetIndex : undefined,
      );
      clearDragState();
    };

  const makeTabsDragOver =
    (targetPaneId: PaneId) => (event: React.DragEvent<HTMLDivElement>) => {
      const payload = readDraggedTabPayload(event);
      if (!payload && !draggedTab) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      const pane = tabsState[targetPaneId];
      setDropTarget({ paneId: targetPaneId, index: pane.tabs.length });
    };

  const makeTabsDrop =
    (targetPaneId: PaneId) => (event: React.DragEvent<HTMLDivElement>) => {
      const payload = readDraggedTabPayload(event) ?? draggedTab;
      if (!payload) return;
      event.preventDefault();
      event.stopPropagation();
      const pane = tabsState[targetPaneId];
      onMoveTab(
        payload.frameId,
        payload.paneId,
        frameId,
        targetPaneId,
        payload.tabId,
        pane.tabs.length,
      );
      clearDragState();
    };

  const primaryDrop =
    dropTarget?.paneId === "primary" ? dropTarget.index : null;
  const secondaryDrop =
    dropTarget?.paneId === "secondary" ? dropTarget.index : null;

  const flexDirection = split.mode === "column" ? "flex-col" : "";
  const primarySize = hasSecondary
    ? split.mode === "row"
      ? { width: `${split.splitRatio * 100}%` }
      : { height: `${split.splitRatio * 100}%` }
    : {};

  const secondarySize = hasSecondary
    ? split.mode === "row"
      ? { width: `${(1 - split.splitRatio) * 100}%` }
      : { height: `${(1 - split.splitRatio) * 100}%` }
    : {};
  const mainEditorThemeSetting: MainEditorPaneTheme = isMainEditorPaneTheme(
    split.primary.theme,
  )
    ? split.primary.theme
    : MAIN_EDITOR_THEME_MATCH_APP;
  const mainEditorTheme: EditorPaneTheme =
    mainEditorThemeSetting === MAIN_EDITOR_THEME_MATCH_APP
      ? appTheme
      : mainEditorThemeSetting;
  const splitEditorTheme: SplitEditorPaneTheme = split.secondary.theme;
  const resolvedSplitEditorTheme: EditorPaneTheme =
    splitEditorTheme === SPLIT_EDITOR_THEME_MATCH
      ? mainEditorTheme
      : isMainEditorPaneTheme(splitEditorTheme)
        ? splitEditorTheme === MAIN_EDITOR_THEME_MATCH_APP
          ? appTheme
          : splitEditorTheme
        : appTheme;

  return (
    <div
      ref={splitContainerRef}
      className={["h-full min-h-0 flex", flexDirection].join(" ")}
      onDragEnd={clearDragState}
    >
      <div
        style={primarySize}
        className={
          hasSecondary
            ? "min-w-0 min-h-0 overflow-hidden"
            : "flex-1 min-w-0 min-h-0"
        }
      >
        <EditorPane
          frameId={frameId}
          paneId="primary"
          visible={visible}
          title="Primary"
          fileSystemContainerId={fileSystemContainerId}
          pane={split.primary}
          paneTabs={tabsState.primary}
          buffers={buffers}
          focused={focusedPane === "primary"}
          splitMode={split.mode}
          menuOpen={menuPane === "primary"}
          focusNonce={
            focusRequest?.frameId === frameId && focusRequest?.paneId === "primary"
              ? focusRequest.nonce
              : undefined
          }
          onFocusPane={() => onFocusPane("primary")}
          onPaneTabsChange={onPaneTabsChange}
          onEditorChange={onEditorChange}
          onPromoteTabToEdit={onPromoteTabToEdit}
          onCloseTab={onCloseTab}
          tabDropIndex={primaryDrop}
          onTabDragStart={makeTabDragStart("primary")}
          onTabDragEnd={clearDragState}
          onTabDragOver={makeTabDragOver("primary")}
          onTabDrop={makeTabDrop("primary")}
          onTabsDragOver={makeTabsDragOver("primary")}
          onTabsDrop={makeTabsDrop("primary")}
          onToggleMenu={() =>
            setMenuPane((prev) => (prev === "primary" ? null : "primary"))
          }
          onCloseMenu={() => setMenuPane(null)}
          onStartRenameTab={onStartRenameTab}
          onChangeRenameDraft={onChangeRenameDraft}
          onCancelRename={onCancelRename}
          onCommitRename={onCommitRename}
          onBuildVimHost={onBuildPaneVimHost}
          onOpenTextPreviewTab={onOpenTextPreviewTab}
          onOpenTerminalDescriptor={onOpenTerminalDescriptor}
          onSaveTabPath={onSaveTabPath}
          onOpenPathFromTerminal={onOpenPathFromTerminal}
          onSplitTerminalDescriptorSessionIdChange={
            onSplitTerminalDescriptorSessionIdChange
          }
          activeContainerId={activeContainerId}
          visibleContainers={visibleContainers}
          dockerHost={dockerHost}
          ollamaHost={ollamaHost}
          localTerminalEnabled={localTerminalEnabled}
          dockerLocalEnabled={dockerLocalEnabled}
          dockerModelEnabled={dockerModelEnabled}
          ollamaLocalEnabled={ollamaLocalEnabled}
          ollamaModelEnabled={ollamaModelEnabled}
          enabledLocalShells={enabledLocalShells}
          remoteEndpoints={remoteEndpoints}
          dockerLocalModels={dockerLocalModels}
          ollamaLocalModels={ollamaLocalModels}
          terminalTheme={terminalTheme}
          preferredShellCwdByContainerId={preferredShellCwdByContainerId}
          editorSettings={editorSettings}
          onEditorSettingsChange={onEditorSettingsChange}
          onSetLineWrap={(value) =>
            setPane("primary", (pane) => ({ ...pane, lineWrap: value }))
          }
          onSetVimMode={(value) =>
            setPane("primary", (pane) => ({ ...pane, vimMode: value }))
          }
          effectiveTheme={mainEditorTheme}
          mainEditorTheme={mainEditorThemeSetting}
          splitEditorTheme={splitEditorTheme}
          onSetMainTheme={(theme) =>
            onChange((prev) => ({
              ...prev,
              primary: { ...prev.primary, theme },
            }))
          }
          onSetSplitTheme={(theme) =>
            onChange((prev) => ({
              ...prev,
              secondary: { ...prev.secondary, theme },
            }))
          }
          onSplitVertical={() => splitInto("row")}
          onSplitHorizontal={() => splitInto("column")}
          onCloseSplit={closeSplit}
          disableCloseSplit={split.mode === "single"}
        />
      </div>
      {hasSecondary ? (
        <>
          <div
            className={[
              "shrink-0 bg-border touch-none select-none",
              split.mode === "row"
                ? "cursor-col-resize separator-vertical"
                : "cursor-row-resize separator-horizontal",
            ].join(" ")}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              e.preventDefault();
              e.currentTarget.setPointerCapture(e.pointerId);
              setGlobalNoSelect(true);
              splitDragRef.current = {
                pointerId: e.pointerId,
                mode: split.mode as Exclude<SplitMode, "single">,
              };
            }}
            onPointerMove={(e) => {
              if (!splitDragRef.current) return;
              updateSplitRatioFromPointer(
                e.clientX,
                e.clientY,
                splitDragRef.current.mode,
              );
            }}
            onPointerUp={() => {
              splitDragRef.current = null;
              setGlobalNoSelect(false);
            }}
            onPointerCancel={() => {
              splitDragRef.current = null;
              setGlobalNoSelect(false);
            }}
            onLostPointerCapture={() => {
              splitDragRef.current = null;
              setGlobalNoSelect(false);
            }}
          />
          <div
            style={secondarySize}
            className="min-w-0 min-h-0 overflow-hidden"
          >
            <EditorPane
              frameId={frameId}
              paneId="secondary"
              visible={visible}
              title="Secondary"
              fileSystemContainerId={fileSystemContainerId}
              pane={split.secondary}
              paneTabs={tabsState.secondary}
              buffers={buffers}
              focused={focusedPane === "secondary"}
              splitMode={split.mode}
              menuOpen={menuPane === "secondary"}
              focusNonce={
                focusRequest?.frameId === frameId &&
                focusRequest?.paneId === "secondary"
                  ? focusRequest.nonce
                  : undefined
              }
              onFocusPane={() => onFocusPane("secondary")}
              onPaneTabsChange={onPaneTabsChange}
              onEditorChange={onEditorChange}
              onPromoteTabToEdit={onPromoteTabToEdit}
              onCloseTab={onCloseTab}
              tabDropIndex={secondaryDrop}
              onTabDragStart={makeTabDragStart("secondary")}
              onTabDragEnd={clearDragState}
              onTabDragOver={makeTabDragOver("secondary")}
              onTabDrop={makeTabDrop("secondary")}
              onTabsDragOver={makeTabsDragOver("secondary")}
              onTabsDrop={makeTabsDrop("secondary")}
              onToggleMenu={() =>
                setMenuPane((prev) =>
                  prev === "secondary" ? null : "secondary",
                )
              }
              onCloseMenu={() => setMenuPane(null)}
              onStartRenameTab={onStartRenameTab}
              onChangeRenameDraft={onChangeRenameDraft}
              onCancelRename={onCancelRename}
              onCommitRename={onCommitRename}
              onBuildVimHost={onBuildPaneVimHost}
              onOpenTextPreviewTab={onOpenTextPreviewTab}
              onOpenTerminalDescriptor={onOpenTerminalDescriptor}
              onSaveTabPath={onSaveTabPath}
              onOpenPathFromTerminal={onOpenPathFromTerminal}
              onSplitTerminalDescriptorSessionIdChange={
                onSplitTerminalDescriptorSessionIdChange
              }
              activeContainerId={activeContainerId}
              visibleContainers={visibleContainers}
              dockerHost={dockerHost}
              ollamaHost={ollamaHost}
              localTerminalEnabled={localTerminalEnabled}
              dockerLocalEnabled={dockerLocalEnabled}
              dockerModelEnabled={dockerModelEnabled}
              ollamaLocalEnabled={ollamaLocalEnabled}
              ollamaModelEnabled={ollamaModelEnabled}
              enabledLocalShells={enabledLocalShells}
              remoteEndpoints={remoteEndpoints}
              dockerLocalModels={dockerLocalModels}
              ollamaLocalModels={ollamaLocalModels}
              terminalTheme={terminalTheme}
              preferredShellCwdByContainerId={preferredShellCwdByContainerId}
              editorSettings={editorSettings}
              onEditorSettingsChange={onEditorSettingsChange}
              onSetLineWrap={(value) =>
                setPane("secondary", (pane) => ({ ...pane, lineWrap: value }))
              }
              onSetVimMode={(value) =>
                setPane("secondary", (pane) => ({ ...pane, vimMode: value }))
              }
              effectiveTheme={resolvedSplitEditorTheme}
              mainEditorTheme={mainEditorThemeSetting}
              splitEditorTheme={splitEditorTheme}
              onSetMainTheme={(theme) =>
                onChange((prev) => ({
                  ...prev,
                  primary: { ...prev.primary, theme },
                }))
              }
              onSetSplitTheme={(theme) =>
                onChange((prev) => ({
                  ...prev,
                  secondary: { ...prev.secondary, theme },
                }))
              }
              onSplitVertical={() => splitInto("row")}
              onSplitHorizontal={() => splitInto("column")}
              onCloseSplit={closeSplit}
              disableCloseSplit={false}
            />
          </div>
        </>
      ) : null}
    </div>
  );
}

// ============================================================================
// EditorPane
// ============================================================================

function EditorPane({
  frameId,
  paneId,
  visible,
  title,
  fileSystemContainerId,
  pane,
  paneTabs,
  buffers,
  focused,
  splitMode,
  menuOpen,
  focusNonce,
  onFocusPane,
  onPaneTabsChange,
  onEditorChange,
  onPromoteTabToEdit,
  onCloseTab,
  tabDropIndex,
  onTabDragStart,
  onTabDragEnd,
  onTabDragOver,
  onTabDrop,
  onTabsDragOver,
  onTabsDrop,
  onFileDragOver,
  onFileDrop,
  onFileDragLeave,
  fileDropActive,
  onStartRenameTab,
  onChangeRenameDraft,
  onCancelRename,
  onCommitRename,
  onBuildVimHost,
  onOpenTextPreviewTab,
  onOpenTerminalDescriptor,
  onSaveTabPath,
  onOpenPathFromTerminal,
  onSplitTerminalDescriptorSessionIdChange,
  activeContainerId,
  visibleContainers,
  dockerHost,
  ollamaHost,
  localTerminalEnabled,
  dockerLocalEnabled,
  dockerModelEnabled,
  ollamaLocalEnabled,
  ollamaModelEnabled,
  enabledLocalShells,
  remoteEndpoints,
  dockerLocalModels,
  ollamaLocalModels,
  terminalTheme = "tokyo-night",
  preferredShellCwdByContainerId,
  editorSettings,
  onEditorSettingsChange,
  onToggleMenu,
  onCloseMenu,
  onSetLineWrap,
  onSetVimMode,
  effectiveTheme,
  mainEditorTheme,
  splitEditorTheme,
  onSetMainTheme,
  onSetSplitTheme,
  onSplitVertical,
  onSplitHorizontal,
  onCloseSplit,
  disableCloseSplit,
}: {
  frameId: FrameId;
  paneId: PaneId;
  visible: boolean;
  title: string;
  fileSystemContainerId: string | null;
  pane: EditorPaneState;
  paneTabs: PaneTabsState;
  buffers: Record<string, FileBufferState>;
  focused: boolean;
  splitMode: SplitMode;
  menuOpen: boolean;
  focusNonce?: number;
  onFocusPane: () => void;
  onPaneTabsChange: (
    paneId: PaneId,
    updater: (pane: PaneTabsState) => PaneTabsState,
  ) => void;
  onEditorChange: (
    paneId: PaneId,
    role: FileRole,
    path: string,
    nextContent: string,
  ) => void;
  onPromoteTabToEdit: (paneId: PaneId, tabId: string) => void;
  onCloseTab: (
    paneId: PaneId,
    tabId: string,
    opts?: { preserveTerminalSession?: boolean },
  ) => void;
  tabDropIndex: number | null;
  onTabDragStart: (
    tabId: string,
    event: React.DragEvent<HTMLButtonElement>,
  ) => void;
  onTabDragEnd: () => void;
  onTabDragOver: (
    tabId: string,
    event: React.DragEvent<HTMLButtonElement>,
  ) => void;
  onTabDrop: (tabId: string, event: React.DragEvent<HTMLButtonElement>) => void;
  onTabsDragOver: (event: React.DragEvent<HTMLDivElement>) => void;
  onTabsDrop: (event: React.DragEvent<HTMLDivElement>) => void;
  onFileDragOver?: (event: React.DragEvent<HTMLDivElement>) => void;
  onFileDrop?: (event: React.DragEvent<HTMLDivElement>) => void;
  onFileDragLeave?: (event: React.DragEvent<HTMLDivElement>) => void;
  fileDropActive?: boolean;
  onStartRenameTab: (paneId: PaneId, tabId: string) => void;
  onChangeRenameDraft: (paneId: PaneId, value: string) => void;
  onCancelRename: (paneId: PaneId) => void;
  onCommitRename: (paneId: PaneId) => Promise<void>;
  onBuildVimHost: (
    frameId: FrameId,
    paneId: PaneId,
    activeTab: EditorTab | null,
  ) => VimHost;
  onOpenTextPreviewTab: (paneId: PaneId, filePath: string) => void;
  onOpenTerminalDescriptor: (
    paneId: PaneId,
    descriptor: TerminalTabDescriptor,
  ) => void;
  onSaveTabPath: (tab: EditorTab) => void;
  onOpenPathFromTerminal: (
    containerId: string,
    path: string,
    kind: "file" | "directory",
  ) => void;
  onSplitTerminalDescriptorSessionIdChange: (
    frameId: FrameId,
    paneId: PaneId,
    tabId: string,
    sessionId: string | null,
  ) => void;
  activeContainerId: string | null;
  visibleContainers: ContainerInfo[];
  dockerHost: string | null;
  ollamaHost: string | null;
  localTerminalEnabled: boolean;
  dockerLocalEnabled: boolean;
  dockerModelEnabled: boolean;
  ollamaLocalEnabled: boolean;
  ollamaModelEnabled: boolean;
  enabledLocalShells: string[];
  remoteEndpoints: RemoteSshEndpoint[];
  dockerLocalModels: ProviderModel[];
  ollamaLocalModels: ProviderModel[];
  terminalTheme?: (typeof EDITOR_THEME_OPTIONS)[number];
  preferredShellCwdByContainerId?: Record<string, string>;
  editorSettings: EditorGlobalSettings;
  onEditorSettingsChange: React.Dispatch<
    React.SetStateAction<EditorGlobalSettings>
  >;
  onToggleMenu: () => void;
  onCloseMenu: () => void;
  onSetLineWrap: (next: boolean) => void;
  onSetVimMode: (next: boolean) => void;
  effectiveTheme: EditorPaneTheme;
  mainEditorTheme: MainEditorPaneTheme;
  splitEditorTheme: SplitEditorPaneTheme;
  onSetMainTheme: (next: MainEditorPaneTheme) => void;
  onSetSplitTheme: (next: SplitEditorPaneTheme) => void;
  onSplitVertical: () => void;
  onSplitHorizontal: () => void;
  onCloseSplit: () => void;
  disableCloseSplit: boolean;
}) {
  const activeTab =
    paneTabs.tabs.find((tab) => tab.id === paneTabs.activeTabId) ??
    paneTabs.tabs[0] ??
    null;
  const isActiveMarkdownPreview =
    activeTab !== null &&
    activeTab.view === "preview" &&
    isMarkdownPath(activeTab.path);
  const activeBuffer =
    activeTab && (activeTab.view === "editor" || isActiveMarkdownPreview)
      ? buffers[`${activeTab.role}:${activeTab.path}`]
      : undefined;
  const vimHost = onBuildVimHost(frameId, paneId, activeTab);
  const activeTabId = activeTab?.id ?? "__none__";
  const activePreviewDescriptor =
    activeTab && activeTab.view === "preview" && !isActiveMarkdownPreview
      ? getPreviewDescriptor(activeTab.path)
      : null;
  const terminalTabs = paneTabs.tabs.filter(
    (tab) => tab.view === "terminal" && tab.terminalDescriptor,
  );
  const isPrimaryPane = paneId === "primary";
  const isSecondaryPane = paneId === "secondary";
  const [showTerminalLauncher, setShowTerminalLauncher] = useState(false);
  const showPreviewButton =
    activeTab !== null &&
    activeTab.view !== "terminal" &&
    isPreviewBackedByTextBufferPath(activeTab.path);

  useEffect(() => {
    if (!menuOpen) setShowTerminalLauncher(false);
  }, [menuOpen]);

  const editorTabs: FrameTab<string>[] = paneTabs.tabs.map((tab) => ({
    id: tab.id,
    label: tab.label,
    temporary: tab.kind === "temporary",
    dirty:
      tab.view === "editor"
        ? Boolean(buffers[`${tab.role}:${tab.path}`]?.dirty)
        : false,
    closable: true,
  }));

  return (
    <div
      className={[
        "min-h-0 overflow-hidden bg-muted/20 flex flex-col h-full",
        splitMode === "single" ? "flex-1 min-w-0" : "",
        fileDropActive ? "ring-2 ring-primary/40 bg-primary/5" : "",
      ].join(" ")}
      onMouseDown={onFocusPane}
      onDragOver={onFileDragOver}
      onDrop={onFileDrop}
      onDragLeave={onFileDragLeave}
    >
      <FrameTabBar
        tabs={editorTabs}
        activeTab={activeTabId}
        getTabProps={(tab, index) => ({
          draggable: paneTabs.renameTabId !== tab.id,
          onDragStart: (event) => onTabDragStart(tab.id, event),
          onDragEnd: onTabDragEnd,
          onDragOver: (event) => onTabDragOver(tab.id, event),
          onDrop: (event) => onTabDrop(tab.id, event),
          className: [
            paneTabs.renameTabId !== tab.id ? "cursor-grab" : "",
            tabDropIndex === index ? "border-l-primary" : "",
          ].join(" "),
        })}
        tabsContainerProps={{ onDragOver: onTabsDragOver, onDrop: onTabsDrop }}
        tabsTrailingDropProps={{
          className:
            tabDropIndex === editorTabs.length
              ? "border-l-2 border-l-primary bg-primary/5"
              : "",
          onDragOver: onTabsDragOver,
          onDrop: onTabsDrop,
        }}
        onTabChange={(tabId) => {
          onFocusPane();
          onPaneTabsChange(paneId, (paneState) => ({
            ...paneState,
            activeTabId: tabId,
          }));
        }}
        onTabDoubleClick={(tabId) => {
          onFocusPane();
          const tab = paneTabs.tabs.find((item) => item.id === tabId);
          if (!tab) return;
          if (
            tab.view === "preview" &&
            isPreviewBackedByTextBufferPath(tab.path)
          ) {
            onPromoteTabToEdit(paneId, tabId);
            return;
          }
          if (tab.view !== "editor") return;
          if (tab.kind === "temporary") {
            onPromoteTabToEdit(paneId, tabId);
            return;
          }
          onStartRenameTab(paneId, tabId);
        }}
        onTabClose={(tabId) => {
          onFocusPane();
          onCloseTab(paneId, tabId);
        }}
        renderTabLabel={(tab) => {
          if (paneTabs.renameTabId !== tab.id) return tab.label;
          return (
            <input
              autoFocus
              value={paneTabs.renameDraft}
              className="w-full min-w-24 rounded border bg-background px-1 py-0.5 text-xs text-foreground"
              onChange={(e) => onChangeRenameDraft(paneId, e.target.value)}
              onBlur={() => void onCommitRename(paneId)}
              onClick={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void onCommitRename(paneId);
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  onCancelRename(paneId);
                }
              }}
            />
          );
        }}
        actions={
          <>
            {showPreviewButton && activeTab ? (
              <IconButton
                label="Open preview tab"
                onClick={() => onOpenTextPreviewTab(paneId, activeTab.path)}
              >
                <Eye className="h-4 w-4" />
              </IconButton>
            ) : null}
            <FrameKebabMenu
              open={menuOpen}
              onToggle={onToggleMenu}
              onClose={onCloseMenu}
              label={`${title} split options`}
              items={
                showTerminalLauncher
                  ? []
                  : [
                      {
                        id: "close",
                        label: "Close split view",
                        onSelect: onCloseSplit,
                        disabled: disableCloseSplit,
                        danger: true,
                      },
                      {
                        id: "split-vertical",
                        label: "Split vertically",
                        dividerBefore: true,
                        onSelect: onSplitVertical,
                      },
                      {
                        id: "split-horizontal",
                        label: "Split horizontally",
                        onSelect: onSplitHorizontal,
                      },
                      {
                        id: "new-terminal",
                        label: "New Terminal",
                        onSelect: () => setShowTerminalLauncher(true),
                        keepOpen: true,
                      },
                      {
                        id: "line-wrap",
                        label: `Line wrap: ${pane.lineWrap ? "On" : "Off"}`,
                        onSelect: () => onSetLineWrap(!pane.lineWrap),
                        dividerBefore: true,
                      },
                      {
                        id: "vim-mode",
                        label: `Vim mode: ${pane.vimMode ? "On" : "Off"}`,
                        onSelect: () => onSetVimMode(!pane.vimMode),
                      },
                      {
                        id: "line-numbers",
                        label: `Line numbers: ${editorSettings.lineNumbers ? "On" : "Off"}`,
                        onSelect: () =>
                          onEditorSettingsChange((prev) => ({
                            ...prev,
                            lineNumbers: !prev.lineNumbers,
                          })),
                      },
                      {
                        id: "mini-map",
                        label: `Mini map: ${editorSettings.miniMap ? "On" : "Off"}`,
                        onSelect: () =>
                          onEditorSettingsChange((prev) => ({
                            ...prev,
                            miniMap: !prev.miniMap,
                          })),
                      },
                    ]
              }
              content={
                showTerminalLauncher ? (
                  <div className="min-w-72">
                    <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
                      <span>New Terminal</span>
                      <button
                        type="button"
                        className="rounded px-1 py-0.5 hover:bg-muted"
                        onClick={() => setShowTerminalLauncher(false)}
                      >
                        Back
                      </button>
                    </div>
                    <TerminalLaunchMenu
                      localTerminalEnabled={localTerminalEnabled}
                      dockerLocalEnabled={dockerLocalEnabled}
                      dockerModelEnabled={dockerModelEnabled}
                      ollamaLocalEnabled={ollamaLocalEnabled}
                      ollamaModelEnabled={ollamaModelEnabled}
                      enabledLocalShells={enabledLocalShells}
                      remoteEndpoints={remoteEndpoints}
                      dockerLocalContainers={visibleContainers}
                      dockerLocalModels={dockerLocalModels}
                      ollamaLocalModels={ollamaLocalModels}
                      preferredShellCwdByContainerId={
                        preferredShellCwdByContainerId
                      }
                      onSelectDescriptor={(descriptor) => {
                        onOpenTerminalDescriptor(paneId, descriptor);
                        onCloseMenu();
                      }}
                    />
                  </div>
                ) : (
                  <>
                    {isPrimaryPane ? (
                      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                        <span>Main Editor theme</span>
                        <CustomSelect
                          value={mainEditorTheme}
                          onChange={(v) =>
                            onSetMainTheme(v as MainEditorPaneTheme)
                          }
                          options={[
                            {
                              value: MAIN_EDITOR_THEME_MATCH_APP,
                              label: "Match App Theme",
                            },
                            ...getEditorThemeSelectOptions(),
                          ]}
                          className="rounded px-2 py-1 text-xs"
                        />
                      </label>
                    ) : null}
                    {isSecondaryPane ? (
                      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                        <span>Split Editor Theme</span>
                        <CustomSelect
                          value={splitEditorTheme}
                          onChange={(v) =>
                            onSetSplitTheme(v as SplitEditorPaneTheme)
                          }
                          options={[
                            {
                              value: MAIN_EDITOR_THEME_MATCH_APP,
                              label: "Match App Theme",
                            },
                            {
                              value: SPLIT_EDITOR_THEME_MATCH,
                              label: "Match Main Editor",
                            },
                            ...getEditorThemeSelectOptions(),
                          ]}
                          className="rounded px-2 py-1 text-xs"
                        />
                      </label>
                    ) : null}
                  </>
                )
              }
            />
          </>
        }
      />
      <div className="flex-1 min-h-0 overflow-hidden">
        {activeTab ? (
          <div className="h-full min-h-0 flex flex-col">
            <div className="relative flex-1 min-h-0">
              {terminalTabs.map((tab) => (
                <SplitTerminalTabView
                  key={tab.id}
                  frameId={frameId}
                  visible={visible && activeTab?.id === tab.id}
                  descriptor={tab.terminalDescriptor!}
                  paneId={paneId}
                  tabId={tab.id}
                  activeContainerId={activeContainerId}
                  visibleContainers={visibleContainers}
                  dockerHost={dockerHost}
                  ollamaHost={ollamaHost}
                  terminalTheme={terminalTheme}
                  preferredShellCwdByContainerId={
                    preferredShellCwdByContainerId
                  }
                  onOpenPathFromTerminal={onOpenPathFromTerminal}
                  onDescriptorSessionIdChange={
                    onSplitTerminalDescriptorSessionIdChange
                  }
                />
              ))}
              {activeTab.view === "terminal" ? (
                activeTab.terminalDescriptor ? null : (
                  <div className="h-full p-3 text-xs text-muted-foreground">
                    Terminal tab data is unavailable.
                  </div>
                )
              ) : activeTab.view === "logs" ? (
                <ContainerLogsTab
                  containers={visibleContainers}
                  selectedContainerId={activeTab.logsState?.containerId ?? null}
                  onSelectContainerId={(containerId) =>
                    onPaneTabsChange(paneId, (paneState) => ({
                      ...paneState,
                      tabs: paneState.tabs.map((tab) =>
                        tab.id === activeTab.id
                          ? {
                              ...tab,
                              label: getLogsTabLabel(
                                visibleContainers,
                                containerId,
                              ),
                              logsState: { containerId },
                            }
                          : tab,
                      ),
                    }))
                  }
                  dockerHost={dockerHost}
                  visible
                />
              ) : activeTab.view === "inspect" ? (
                <ContainerInspectTab
                  containers={visibleContainers}
                  containerId={activeTab.inspectState?.containerId ?? null}
                  modelTarget={activeTab.inspectState?.modelTarget ?? null}
                  dockerHost={dockerHost}
                  visible
                />
              ) : activeTab.view === "preview" ? (
                isActiveMarkdownPreview ? (
                  <MarkdownPreviewPane
                    path={activeTab.path}
                    content={activeBuffer?.content ?? ""}
                    loading={Boolean(activeBuffer?.loading)}
                    error={activeBuffer?.error ?? null}
                  />
                ) : activePreviewDescriptor ? (
                  <PreviewPane
                    containerId={fileSystemContainerId}
                    path={activeTab.path}
                    descriptor={activePreviewDescriptor}
                  />
                ) : (
                  <div className="h-full p-3 text-xs text-muted-foreground">
                    Unsupported preview type for this file.
                  </div>
                )
              ) : (
                <div className="flex h-full min-h-0 flex-col">
                  {activeBuffer?.error ? (
                    <div className="border-b border-border bg-destructive/10 px-3 py-2 text-xs text-destructive">
                      {activeBuffer.error}
                    </div>
                  ) : null}
                  <div className="min-h-0 flex-1">
                    <CodeEditor
                      path={activeTab.path}
                      value={activeBuffer?.content ?? ""}
                      lineWrap={pane.lineWrap}
                      vimMode={pane.vimMode}
                      showLineNumbers={editorSettings.lineNumbers}
                      showMiniMap={editorSettings.miniMap}
                      theme={effectiveTheme}
                      readOnly={Boolean(
                        activeBuffer?.loading ||
                        (activeBuffer?.error && !activeBuffer?.content),
                      )}
                      onFocus={onFocusPane}
                      focusNonce={focusNonce}
                      onSave={() => {
                        if (!activeTab) return;
                        onSaveTabPath(activeTab);
                      }}
                      vimHost={vimHost}
                      onChange={(nextValue: string) => {
                        if (activeTab.kind === "temporary") {
                          onPromoteTabToEdit(paneId, activeTab.id);
                        }
                        onEditorChange(
                          paneId,
                          activeTab.role,
                          activeTab.path,
                          nextValue,
                        );
                      }}
                    />
                  </div>
                </div>
              )}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function SplitTerminalTabView({
  frameId,
  visible,
  descriptor,
  paneId,
  tabId,
  activeContainerId,
  visibleContainers,
  dockerHost,
  ollamaHost,
  terminalTheme = "tokyo-night",
  preferredShellCwdByContainerId,
  onOpenPathFromTerminal,
  onDescriptorSessionIdChange,
}: {
  frameId: FrameId;
  visible: boolean;
  descriptor: TerminalTabDescriptor;
  paneId: PaneId;
  tabId: string;
  activeContainerId: string | null;
  visibleContainers: ContainerInfo[];
  dockerHost: string | null;
  ollamaHost: string | null;
  terminalTheme?: (typeof EDITOR_THEME_OPTIONS)[number];
  preferredShellCwdByContainerId?: Record<string, string>;
  onOpenPathFromTerminal: (
    containerId: string,
    path: string,
    kind: "file" | "directory",
  ) => void;
  onDescriptorSessionIdChange: (
    frameId: FrameId,
    paneId: PaneId,
    tabId: string,
    sessionId: string | null,
  ) => void;
}) {
  return (
    <SingleTerminalPane
      visible={visible}
      descriptor={descriptor}
      activeContainerId={activeContainerId}
      containers={visibleContainers}
      dockerHost={dockerHost}
      ollamaHost={ollamaHost}
      terminalTheme={terminalTheme}
      onOpenPathCommand={onOpenPathFromTerminal}
      preferredShellCwdByContainerId={preferredShellCwdByContainerId}
      onDescriptorSessionIdChange={(sessionId) =>
        onDescriptorSessionIdChange(frameId, paneId, tabId, sessionId)
      }
    />
  );
}
