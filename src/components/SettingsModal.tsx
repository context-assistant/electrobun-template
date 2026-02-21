import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useInAppDialogsOptional } from "../context/InAppDialogsContext";
import { CustomSelect } from "./CustomSelect";
import { InAppColorPicker } from "./InAppColorPicker";
import { IconButton } from "./IconButton";
import * as dockerClient from "../lib/docker";
import * as ollamaClient from "../lib/ollama";
import {
  onUpdateInfoChanged,
  updaterApplyUpdate,
  updaterCheckForUpdate,
  updaterDownloadUpdate,
  updaterGetUpdateInfo,
} from "../electrobun/renderer";
import { isElectrobun } from "../electrobun/env";
import {
  getItem,
  removeItemAsync,
  removeStorageKeys,
  resetWindowState,
  setItemAsync,
} from "../lib/appDataStorage";
import {
  STORAGE_CATEGORIES,
  type StorageCategoryId,
} from "../lib/storageCategories";
import {
  applyTheme,
  applyCustomThemeColors,
  computeThemePalette,
  cssColorToHex,
  getStoredCustomColors,
  getStoredTheme,
  onStoredThemeChanged,
  setStoredCustomColors,
  setStoredTheme,
  type AppTheme,
  type ThemePaletteColors,
} from "../lib/theme";
import type { UpdateInfo } from "../electrobun/rpcSchema";
import {
  fetchProviderModels,
  getModelProviderDescriptor,
  MODEL_PROVIDER_DESCRIPTORS,
  MODEL_TYPE_LABELS,
  MODEL_TYPE_DISPLAY,
  type ModelProviderConfigValues,
  type ModelProviderSecretRefs,
  type ModelProviderSecretValues,
  type ModelProviderType,
  type ModelProviderConfig,
  type ProviderModel,
  type ProviderModelType,
} from "../lib/modelProviders";
import {
  deleteModelProviderSecrets,
  persistModelProviderSecretValues,
  resolveModelProviderSecret,
} from "../lib/modelProviderSecrets";
import {
  DEFAULT_MODEL_PROVIDER_INTEGRATIONS_STATE,
  readModelProviderIntegrationsState,
  readModelProvidersState,
  type ModelProviderIntegrationsState,
  type RemoteSshEndpoint,
  writeModelProviderIntegrationsState,
  writeModelProvidersState,
} from "../lib/appStorage";
import {
  applyFontSize,
  FONT_SIZE_RANGE,
  getStoredFontSize,
  setStoredFontSize,
} from "../lib/fontSize";
import {
  getStoredThemeBrightness,
  onStoredThemeBrightnessChanged,
  setStoredThemeBrightness,
  THEME_BRIGHTNESS_RANGE,
} from "../lib/themeBrightness";
import {
  getStoredThemeContrast,
  onStoredThemeContrastChanged,
  setStoredThemeContrast,
  THEME_CONTRAST_RANGE,
} from "../lib/themeContrast";
import {
  getStoredThemeSaturation,
  onStoredThemeSaturationChanged,
  setStoredThemeSaturation,
  THEME_SATURATION_RANGE,
} from "../lib/themeSaturation";
import {
  BUILT_IN_PRESETS,
  createPresetId,
  deleteThemePreset,
  getPresetData,
  getStoredThemePresets,
  saveThemePreset,
  type BuiltInPresetId,
  type ThemePresetData,
} from "../lib/themePresets";
import {
  getEditorThemeSelectOptions,
  MAIN_EDITOR_THEME_MATCH_APP,
  SPLIT_EDITOR_THEME_MATCH,
  TERMINAL_THEME_MATCH_MAIN,
  type MainEditorPaneTheme,
  type SplitEditorPaneTheme,
  type TerminalThemeSetting,
  type ThemeGroup,
} from "../lib/editorThemes";
type InAppConfirmRequest = {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
};

type InAppPromptRequest = {
  title: string;
  message?: string;
  defaultValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  cancelLabel?: string;
};

type Props = {
  open: boolean;
  onClose: () => void;
  mainEditorTheme?: MainEditorPaneTheme;
  splitEditorTheme?: SplitEditorPaneTheme;
  onMainEditorThemeChange?: (theme: MainEditorPaneTheme) => void;
  onSplitEditorThemeChange?: (theme: SplitEditorPaneTheme) => void;
  onAppThemePreview?: (theme: AppTheme | null) => void;
  askPrompt?: (request: InAppPromptRequest) => Promise<string | null>;
  askConfirm?: (request: InAppConfirmRequest) => Promise<boolean>;
};

type SettingsGroup =
  | "general"
  | "environment"
  | "modelProviders"
  | "reset";
type ProviderDraft = {
  id?: string;
  name: string;
  providerType: ModelProviderType;
  config: ModelProviderConfigValues;
  secretRefs: ModelProviderSecretRefs;
  secretValues: ModelProviderSecretValues;
  legacyApiToken?: string;
  enabled: boolean;
  models: ProviderModel[];
};

type SettingsImportExportCategory = {
  id: StorageCategoryId;
  values: Record<string, string | null>;
};

type SettingsImportExportPayload = {
  version: 1;
  exportedAt: number;
  categories: SettingsImportExportCategory[];
};

type LocalIntegrationKey = "dockerLocal" | "ollamaLocal";

type LocalIntegrationDraft = {
  key: LocalIntegrationKey;
  name: string;
  models: ProviderModel[];
};

const compareResourceNames = (a: string, b: string) =>
  a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

const createRemoteEndpointId = () => {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `remote-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
};

const DOCKER_SECTION_LABELS: Array<{
  key: keyof ModelProviderIntegrationsState["dockerSectionVisibility"];
  label: string;
}> = [
    { key: "image", label: "Images" },
    { key: "app", label: "Apps" },
    { key: "container", label: "Containers" },
    { key: "files", label: "Files" },
    { key: "volume", label: "Volumes" },
    { key: "aiModel", label: "AI Models" },
    { key: "network", label: "Networks" },
  ];

const STORAGE_CATEGORY_ID_SET = new Set<StorageCategoryId>(STORAGE_CATEGORIES.map((c) => c.id));
const EXPORTABLE_STORAGE_CATEGORIES = STORAGE_CATEGORIES.filter((c) => c.keys.length > 0);

function isStorageCategoryId(value: unknown): value is StorageCategoryId {
  return typeof value === "string" && STORAGE_CATEGORY_ID_SET.has(value as StorageCategoryId);
}

function emptyDraft(providerType: ModelProviderType = "openaiCompatible"): ProviderDraft {
  const descriptor = getModelProviderDescriptor(providerType);
  return {
    name: "",
    providerType,
    config: { ...descriptor.defaultConfig },
    secretRefs: {},
    secretValues: {},
    enabled: true,
    models: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toSettingsImportExportPayload(
  selectedCategoryIds: StorageCategoryId[],
): SettingsImportExportPayload {
  const categories = selectedCategoryIds
    .map((categoryId) => STORAGE_CATEGORIES.find((cat) => cat.id === categoryId))
    .filter((cat): cat is (typeof STORAGE_CATEGORIES)[number] => Boolean(cat))
    .filter((cat) => cat.keys.length > 0)
    .map((cat) => ({
      id: cat.id,
      values: Object.fromEntries(
        cat.keys.map((key) => {
          const value = getItem(key);
          return [key, value];
        }),
      ) as Record<string, string | null>,
    }));
  return {
    version: 1,
    exportedAt: Date.now(),
    categories,
  };
}

function parseSettingsImportExportPayload(raw: unknown): SettingsImportExportPayload | null {
  if (!isRecord(raw)) return null;
  if (raw.version !== 1) return null;
  if (!Array.isArray(raw.categories)) return null;
  const categories = raw.categories
    .map((entry) => {
      if (!isRecord(entry) || !isStorageCategoryId(entry.id)) return null;
      const valuesRaw = isRecord(entry.values) ? entry.values : {};
      const values: Record<string, string | null> = {};
      for (const [key, value] of Object.entries(valuesRaw)) {
        if (typeof value === "string" || value === null) {
          values[key] = value;
        }
      }
      return {
        id: entry.id,
        values,
      } satisfies SettingsImportExportCategory;
    })
    .filter((entry): entry is SettingsImportExportCategory => entry !== null);
  if (categories.length === 0) return null;
  return {
    version: 1,
    exportedAt: typeof raw.exportedAt === "number" ? raw.exportedAt : Date.now(),
    categories,
  };
}

function toSafeSettingsExportFileName(exportedAt: number) {
  const date = new Date(exportedAt).toISOString().slice(0, 10);
  return `context-assistant-settings-${date}.json`;
}

export function SettingsModal({
  open,
  onClose,
  mainEditorTheme,
  splitEditorTheme,
  onMainEditorThemeChange,
  onSplitEditorThemeChange,
  onAppThemePreview,
  askPrompt: askPromptProp,
  askConfirm: askConfirmProp,
}: Props) {
  const ctx = useInAppDialogsOptional();
  const askPrompt = ctx?.askPrompt ?? askPromptProp;
  const askConfirm = ctx?.askConfirm ?? askConfirmProp;

  const [group, setGroup] = useState<SettingsGroup>("general");
  const [theme, setTheme] = useState<AppTheme>(() => getStoredTheme());
  const [themeBrightness, setThemeBrightness] = useState<number>(() =>
    getStoredThemeBrightness(),
  );
  const [themeContrast, setThemeContrast] = useState<number>(() =>
    getStoredThemeContrast(),
  );
  const [themeSaturation, setThemeSaturation] = useState<number>(() =>
    getStoredThemeSaturation(),
  );
  const [themeColors, setThemeColors] = useState<ThemePaletteColors>(() => {
    const computed = computeThemePalette(
      getStoredTheme(),
      getStoredThemeBrightness(),
      getStoredThemeContrast(),
      getStoredThemeSaturation(),
    );
    const stored = getStoredCustomColors();
    return stored ? { ...computed, ...stored } : computed;
  });
  const [customOverrides, setCustomOverrides] = useState<Partial<ThemePaletteColors> | null>(
    () => getStoredCustomColors(),
  );
  const [isTestPreviewOn, setIsTestPreviewOn] = useState(false);
  const [appThemeFilter, setAppThemeFilter] = useState<ThemeGroup | "all">("all");
  const [selectedPresetId, setSelectedPresetId] = useState<string>(() => "default");
  const [presetsVersion, setPresetsVersion] = useState(0);
  const [fontSize, setFontSize] = useState<number>(() => getStoredFontSize());
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [providers, setProviders] = useState<ModelProviderConfig[]>([]);
  const [integrations, setIntegrations] = useState<ModelProviderIntegrationsState>(
    DEFAULT_MODEL_PROVIDER_INTEGRATIONS_STATE,
  );
  const [editorOpen, setEditorOpen] = useState(false);
  const [draft, setDraft] = useState<ProviderDraft>(() => emptyDraft());
  const [newProviderType, setNewProviderType] = useState<ModelProviderType>("openaiCompatible");
  const [refreshBusy, setRefreshBusy] = useState(false);
  const [editorBusy, setEditorBusy] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [localIntegrationAvailability, setLocalIntegrationAvailability] = useState<{
    docker: boolean;
    ollama: boolean;
  }>({ docker: false, ollama: false });
  const [terminalShellsLoading, setTerminalShellsLoading] = useState(false);
  const [terminalShellsError, setTerminalShellsError] = useState<string | null>(null);
  const [terminalShells, setTerminalShells] = useState<string[]>([]);
  const [remoteEndpointDraft, setRemoteEndpointDraft] = useState("");
  const [remoteEndpointEditorOpen, setRemoteEndpointEditorOpen] = useState(false);
  const [remoteEndpointEditorDraft, setRemoteEndpointEditorDraft] = useState<{
    id: string;
    name: string;
    host: string;
  } | null>(null);
  const [remoteEndpointEditorError, setRemoteEndpointEditorError] = useState<string | null>(null);
  const [localEditorOpen, setLocalEditorOpen] = useState(false);
  const [localDraft, setLocalDraft] = useState<LocalIntegrationDraft | null>(null);
  const [localRefreshBusy, setLocalRefreshBusy] = useState(false);
  const [localEditorError, setLocalEditorError] = useState<string | null>(null);
  const [resetBusy, setResetBusy] = useState<"appData" | "settingsExport" | "settingsImport" | null>(
    null,
  );
  const [resetError, setResetError] = useState<string | null>(null);
  const [deleteAppDataModalOpen, setDeleteAppDataModalOpen] = useState(false);
  const [exportSettingsModalOpen, setExportSettingsModalOpen] = useState(false);
  const [deleteCategoriesSelected, setDeleteCategoriesSelected] = useState<Set<StorageCategoryId>>(
    () => new Set(STORAGE_CATEGORIES.map((c) => c.id)),
  );
  const [exportCategoriesSelected, setExportCategoriesSelected] = useState<Set<StorageCategoryId>>(
    () => new Set(EXPORTABLE_STORAGE_CATEGORIES.map((c) => c.id)),
  );
  const settingsImportInputRef = useRef<HTMLInputElement | null>(null);
  const lastWrittenIntegrationsRef = useRef<string>("");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [storedProviders, storedIntegrations] = await Promise.all([
        readModelProvidersState<ModelProviderConfig[]>(),
        readModelProviderIntegrationsState(),
      ]);
      if (cancelled) return;
      setProviders(storedProviders ?? []);
      setIntegrations(storedIntegrations);
      lastWrittenIntegrationsRef.current = JSON.stringify(storedIntegrations);
      await ollamaClient.configureOllamaHost(null);
      const ollamaAvailable = await ollamaClient.isOllamaAvailable().catch(() => false);
      if (cancelled) return;
      setLocalIntegrationAvailability((prev) => ({ ...prev, ollama: ollamaAvailable }));
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!open || group !== "environment") return;
    let cancelled = false;
    setTerminalShellsLoading(true);
    setTerminalShellsError(null);
    void dockerClient
      .listLocalShells()
      .then((shells) => {
        if (cancelled) return;
        setTerminalShells(shells);
      })
      .catch((error) => {
        if (cancelled) return;
        const msg = error instanceof Error ? error.message : "Failed to load local shells";
        setTerminalShellsError(msg);
        setTerminalShells([]);
      })
      .finally(() => {
        if (cancelled) return;
        setTerminalShellsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [group, open]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [dockerAvailable, ollamaAvailable] = await Promise.all([
        dockerClient.isDockerAvailable().catch(() => false),
        ollamaClient.isOllamaAvailable().catch(() => false),
      ]);
      if (cancelled) return;
      setLocalIntegrationAvailability({
        docker: dockerAvailable,
        ollama: ollamaAvailable,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const t = window.setTimeout(
      () => void writeModelProvidersState(providers),
      120,
    );
    return () => window.clearTimeout(t);
  }, [providers]);

  useEffect(() => {
    if (isTestPreviewOn) return;
    const serialized = JSON.stringify(integrations);
    if (serialized === lastWrittenIntegrationsRef.current) return;
    const t = window.setTimeout(() => {
      lastWrittenIntegrationsRef.current = serialized;
      void writeModelProviderIntegrationsState(integrations);
    }, 120);
    return () => window.clearTimeout(t);
  }, [integrations, isTestPreviewOn]);

  const toggleIntegration = (
    key:
      | "dockerLocalEnabled"
      | "ollamaLocalEnabled"
      | "dockerUiEnabled"
      | "terminalEnabled"
      | "aiApiModelProvidersEnabled",
  ) => {
    setIntegrations((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const setTerminalShellEnabledValues = (shellNames: string[]) => {
    const normalized = shellNames
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0);
    setIntegrations((prev) => ({
      ...prev,
      terminalEnabledShells: Array.from(new Set(normalized)).sort((a, b) => compareResourceNames(a, b)),
    }));
  };

  const setTerminalTheme = (theme: TerminalThemeSetting) => {
    setIntegrations((prev) => ({ ...prev, terminalTheme: theme }));
  };

  const sortedRemoteEndpoints = useMemo(
    () =>
      [...(integrations.remoteEndpoints ?? [])].sort((a, b) => {
        const byName = compareResourceNames(a.name, b.name);
        if (byName !== 0) return byName;
        return compareResourceNames(a.host, b.host);
      }),
    [integrations.remoteEndpoints],
  );
  const saveRemoteEndpoints = (
    mutator: (current: RemoteSshEndpoint[]) => RemoteSshEndpoint[],
  ) => {
    setIntegrations((prev) => {
      const nextEndpoints = mutator(prev.remoteEndpoints ?? []);
      return { ...prev, remoteEndpoints: nextEndpoints };
    });
  };

  const addRemoteEndpoint = () => {
    const host = remoteEndpointDraft.trim();
    if (!host) return;
    if (
      (integrations.remoteEndpoints ?? []).some(
        (endpoint) => endpoint.host.toLowerCase() === host.toLowerCase(),
      )
    ) {
      return;
    }
    const nextEntry: RemoteSshEndpoint = {
      id: createRemoteEndpointId(),
      name: host,
      host,
      enabled: true,
    };
    saveRemoteEndpoints((current) => [...current, nextEntry]);
    setRemoteEndpointDraft("");
  };

  const toggleRemoteEndpointEnabled = (id: string) => {
    saveRemoteEndpoints((current) =>
      current.map((endpoint) =>
        endpoint.id !== id ? endpoint : { ...endpoint, enabled: !endpoint.enabled },
      ),
    );
  };

  const editRemoteEndpoint = (id: string) => {
    const current = (integrations.remoteEndpoints ?? []).find((endpoint) => endpoint.id === id);
    if (!current) return;
    setRemoteEndpointEditorDraft({
      id: current.id,
      name: current.name,
      host: current.host,
    });
    setRemoteEndpointEditorError(null);
    setRemoteEndpointEditorOpen(true);
  };

  const closeRemoteEndpointEditor = () => {
    setRemoteEndpointEditorOpen(false);
    setRemoteEndpointEditorError(null);
    setRemoteEndpointEditorDraft(null);
  };

  const saveRemoteEndpointEditor = () => {
    if (!remoteEndpointEditorDraft) return;
    const nextName = remoteEndpointEditorDraft.name.trim();
    const nextHost = remoteEndpointEditorDraft.host.trim();
    if (!nextName) {
      setRemoteEndpointEditorError("Endpoint name is required.");
      return;
    }
    if (!nextHost) {
      setRemoteEndpointEditorError("SSH URL is required.");
      return;
    }
    const hasDuplicateHost = (integrations.remoteEndpoints ?? []).some(
      (endpoint) =>
        endpoint.id !== remoteEndpointEditorDraft.id &&
        endpoint.host.toLowerCase() === nextHost.toLowerCase(),
    );
    if (hasDuplicateHost) {
      setRemoteEndpointEditorError("An endpoint with that SSH URL already exists.");
      return;
    }
    const current = (integrations.remoteEndpoints ?? []).find(
      (endpoint) => endpoint.id === remoteEndpointEditorDraft.id,
    );
    if (!current) {
      closeRemoteEndpointEditor();
      return;
    }
    saveRemoteEndpoints((entries) =>
      entries.map((entry) =>
        entry.id !== remoteEndpointEditorDraft.id ? entry : { ...entry, name: nextName, host: nextHost },
      ),
    );
    closeRemoteEndpointEditor();
  };

  const deleteRemoteEndpoint = async (id: string) => {
    const current = (integrations.remoteEndpoints ?? []).find((endpoint) => endpoint.id === id);
    if (!current) return;
    const shouldDelete = askConfirm
      ? await askConfirm({
        title: "Delete remote endpoint",
        message: `Delete remote endpoint "${current.name}"?`,
        confirmLabel: "Delete",
        danger: true,
      })
      : window.confirm(`Delete remote endpoint "${current.name}"?`);
    if (!shouldDelete) return;
    saveRemoteEndpoints((entries) => entries.filter((entry) => entry.id !== id));
  };

  const toggleDockerSectionVisibility = (
    key: keyof ModelProviderIntegrationsState["dockerSectionVisibility"],
  ) => {
    setIntegrations((prev) => ({
      ...prev,
      dockerSectionVisibility: {
        ...prev.dockerSectionVisibility,
        [key]: !prev.dockerSectionVisibility[key],
      },
    }));
  };

  const enabledTerminalShells = new Set(
    (integrations.terminalEnabledShells ?? [])
      .map((entry) => {
        const normalized = entry.trim().toLowerCase();
        return normalized.includes("/") ? (normalized.split("/").pop() ?? "") : normalized;
      })
      .filter((entry) => entry.length > 0),
  );
  const terminalShellEntries = terminalShells.map((shellPath) => {
    const shellName = shellPath.split("/").pop() || shellPath;
    return {
      path: shellPath,
      name: shellName.toLowerCase(),
      displayName: shellName,
    };
  });
  const localDockerIntegrationTitle = "Docker";
  const localOllamaIntegrationTitle = "Ollama";

  const localIntegrationCards = useMemo(
    () =>
      [
        {
          key: "dockerLocal" as const,
          visible: localIntegrationAvailability.docker,
          title: localDockerIntegrationTitle,
          enabled: integrations.dockerLocalEnabled,
          models: integrations.dockerLocalModels,
        },
        {
          key: "ollamaLocal" as const,
          visible: localIntegrationAvailability.ollama,
          title: localOllamaIntegrationTitle,
          enabled: integrations.ollamaLocalEnabled,
          models: integrations.ollamaLocalModels,
        },
      ].filter((integration) => integration.visible),
    [
      integrations,
      localDockerIntegrationTitle,
      localIntegrationAvailability,
      localOllamaIntegrationTitle,
    ],
  );
  const sortedProviders = useMemo(
    () =>
      [...providers].sort((a, b) => compareResourceNames(a.name, b.name)),
    [providers],
  );
  const localTerminalEnabled = integrations.terminalEnabled;
  const localTerminalDisabled = !localTerminalEnabled;
  const aiApiModelProvidersEnabled = integrations.aiApiModelProvidersEnabled;
  const aiApiModelProvidersDisabled = !aiApiModelProvidersEnabled;
  const sortedLocalDraftModels = useMemo(
    () => (localDraft ? [...localDraft.models].sort((a, b) => compareResourceNames(a.id, b.id)) : []),
    [localDraft],
  );
  const sortedDraftModels = useMemo(
    () => [...draft.models].sort((a, b) => compareResourceNames(a.id, b.id)),
    [draft.models],
  );

  const openLocalEditor = (key: LocalIntegrationKey) => {
    setLocalEditorError(null);
    setLocalRefreshBusy(false);
    const draftByKey: Record<LocalIntegrationKey, LocalIntegrationDraft> = {
      dockerLocal: {
        key: "dockerLocal",
        name: "Local Docker",
        models: integrations.dockerLocalModels,
      },
      ollamaLocal: {
        key: "ollamaLocal",
        name: "Local Ollama",
        models: integrations.ollamaLocalModels,
      },
    };
    setLocalDraft(draftByKey[key]);
    setLocalEditorOpen(true);
  };

  const closeLocalEditor = () => {
    setLocalEditorOpen(false);
    setLocalDraft(null);
    setLocalRefreshBusy(false);
    setLocalEditorError(null);
  };

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (isTestPreviewOn) {
          setIsTestPreviewOn(false);
          return;
        }
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose, isTestPreviewOn]);

  const restoreThemeFromStorage = () => {
    const storedTheme = getStoredTheme();
    const storedBrightness = getStoredThemeBrightness();
    const storedContrast = getStoredThemeContrast();
    const storedSaturation = getStoredThemeSaturation();
    const storedCustomColors = getStoredCustomColors();
    const computed = computeThemePalette(
      storedTheme,
      storedBrightness,
      storedContrast,
      storedSaturation,
    );
    setTheme(storedTheme);
    setThemeBrightness(storedBrightness);
    setThemeContrast(storedContrast);
    setThemeSaturation(storedSaturation);
    setThemeColors(storedCustomColors ? { ...computed, ...storedCustomColors } : computed);
    setCustomOverrides(storedCustomColors);
    applyTheme(storedTheme);
    applyCustomThemeColors(storedCustomColors ?? computed);
  };

  useEffect(() => {
    if (!open) {
      if (isTestPreviewOn) {
        // Persist preview changes before closing so they are not lost
        setStoredTheme(theme);
        setStoredThemeBrightness(themeBrightness);
        setStoredThemeContrast(themeContrast);
        setStoredThemeSaturation(themeSaturation);
        const computed = computeThemePalette(
          theme,
          themeBrightness,
          themeContrast,
          themeSaturation,
        );
        const keys = ["background", "foreground", "primary", "primaryForeground", "secondary", "secondaryForeground", "muted", "border", "accent"] as const;
        const overrides: Partial<ThemePaletteColors> = {};
        for (const k of keys) {
          if (themeColors[k] !== computed[k]) overrides[k] = themeColors[k];
        }
        setStoredCustomColors(Object.keys(overrides).length > 0 ? overrides : null);
      }
      setIsTestPreviewOn(false);
      restoreThemeFromStorage();
      void readModelProviderIntegrationsState().then((stored) => {
        setIntegrations(stored);
        lastWrittenIntegrationsRef.current = JSON.stringify(stored);
      });
    }
  }, [open]);

  const prevGroupRef = useRef<SettingsGroup>(group);
  useEffect(() => {
    if (prevGroupRef.current === "general" && group !== "general") {
      setIsTestPreviewOn(false);
      restoreThemeFromStorage();
      void readModelProviderIntegrationsState().then((stored) => {
        setIntegrations(stored);
        lastWrittenIntegrationsRef.current = JSON.stringify(stored);
      });
    }
    prevGroupRef.current = group;
  }, [group]);

  useEffect(() => {
    if (open && !isTestPreviewOn) setStoredTheme(theme);
    return applyTheme(theme);
  }, [open, theme, isTestPreviewOn]);

  // When toggling preview off, persist current theme state so we don't lose unsaved edits
  const prevPreviewRef = useRef(isTestPreviewOn);
  useEffect(() => {
    if (prevPreviewRef.current && !isTestPreviewOn) {
      const computed = computeThemePalette(
        theme,
        themeBrightness,
        themeContrast,
        themeSaturation,
      );
      const keys = ["background", "foreground", "primary", "primaryForeground", "secondary", "secondaryForeground", "muted", "border", "accent"] as const;
      const overrides: Partial<ThemePaletteColors> = {};
      for (const k of keys) {
        if (themeColors[k] !== computed[k]) overrides[k] = themeColors[k];
      }
      const next = Object.keys(overrides).length > 0 ? overrides : null;
      setStoredCustomColors(next);
      setCustomOverrides(next);
    }
    prevPreviewRef.current = isTestPreviewOn;
  }, [isTestPreviewOn, theme, themeBrightness, themeContrast, themeSaturation, themeColors]);

  useEffect(() => {
    if (!onAppThemePreview) return;
    if (open && isTestPreviewOn) {
      onAppThemePreview(theme);
    } else {
      onAppThemePreview(null);
    }
    return () => onAppThemePreview(null);
  }, [open, isTestPreviewOn, theme, onAppThemePreview]);

  useEffect(() => {
    if (!isTestPreviewOn) return;
    const palette = computeThemePalette(
      theme,
      themeBrightness,
      themeContrast,
      themeSaturation,
    );
    // In preview mode, always merge themeColors so unsaved edits are applied
    const toApply = { ...palette, ...themeColors };
    applyCustomThemeColors(toApply);
  }, [
    isTestPreviewOn,
    theme,
    themeBrightness,
    themeContrast,
    themeSaturation,
    themeColors,
  ]);

  useEffect(() => {
    const computed = computeThemePalette(theme, themeBrightness, themeContrast, themeSaturation);
    const stored = customOverrides ?? getStoredCustomColors();
    if (isTestPreviewOn && stored) {
      // In preview with custom: merge computed (non-custom) with current themeColors (custom keys may have unsaved edits)
      setThemeColors((prev) => {
        const merged = { ...computed };
        for (const k of Object.keys(stored) as (Exclude<keyof ThemePaletteColors, "fileBrowser">)[]) {
          merged[k] = prev[k];
        }
        return merged;
      });
    } else {
      const next = stored ? { ...computed, ...stored } : computed;
      setThemeColors((prev) => {
        const keys = (["background", "foreground", "primary", "primaryForeground", "secondary", "secondaryForeground", "muted", "border", "accent"] as const);
        if (keys.every((k) => prev[k] === next[k])) return prev;
        return next;
      });
    }
  }, [theme, themeBrightness, themeContrast, themeSaturation, isTestPreviewOn, customOverrides]);

  useEffect(() => {
    const unsub = onStoredThemeChanged(() => setTheme(getStoredTheme()));
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
    if (!open) return;
    const clamped = Math.min(
      THEME_BRIGHTNESS_RANGE.max,
      Math.max(THEME_BRIGHTNESS_RANGE.min, themeBrightness),
    );
    if (!isTestPreviewOn && getStoredThemeBrightness() !== clamped) {
      setStoredThemeBrightness(clamped);
    }
    if (clamped !== themeBrightness) {
      setThemeBrightness(clamped);
    }
  }, [open, themeBrightness, isTestPreviewOn]);

  useEffect(() => {
    if (!open) return;
    const clamped = Math.min(
      THEME_CONTRAST_RANGE.max,
      Math.max(THEME_CONTRAST_RANGE.min, themeContrast),
    );
    if (!isTestPreviewOn && getStoredThemeContrast() !== clamped) {
      setStoredThemeContrast(clamped);
    }
    if (clamped !== themeContrast) {
      setThemeContrast(clamped);
    }
  }, [open, themeContrast, isTestPreviewOn]);

  useEffect(() => {
    if (!open) return;
    const clamped = Math.min(
      THEME_SATURATION_RANGE.max,
      Math.max(THEME_SATURATION_RANGE.min, themeSaturation),
    );
    if (!isTestPreviewOn && getStoredThemeSaturation() !== clamped) {
      setStoredThemeSaturation(clamped);
    }
    if (clamped !== themeSaturation) {
      setThemeSaturation(clamped);
    }
  }, [open, themeSaturation, isTestPreviewOn]);

  useEffect(() => {
    const clamped = Math.min(FONT_SIZE_RANGE.max, Math.max(FONT_SIZE_RANGE.min, fontSize));
    setStoredFontSize(clamped);
    applyFontSize(clamped);
    if (clamped !== fontSize) {
      setFontSize(clamped);
    }
  }, [fontSize]);

  const storedPresets = useMemo(
    () => getStoredThemePresets(),
    [presetsVersion],
  );

  const appThemeOptions = useMemo(() => getEditorThemeSelectOptions(), []);

  const filteredAppThemeOptions = useMemo(
    () =>
      appThemeFilter === "all"
        ? appThemeOptions
        : appThemeOptions.filter((o) => o.group === appThemeFilter),
    [appThemeOptions, appThemeFilter]
  );

  useEffect(() => {
    if (filteredAppThemeOptions.length === 0) return;
    const inFiltered = filteredAppThemeOptions.some((o) => o.value === theme);
    if (!inFiltered) {
      setTheme(filteredAppThemeOptions[0]!.value as AppTheme);
    }
  }, [appThemeFilter, filteredAppThemeOptions, theme]);

  const cycleAppTheme = useCallback(
    (direction: 1 | -1) => {
      const opts = filteredAppThemeOptions;
      const idx = opts.findIndex((o) => o.value === theme);
      const nextIdx = idx < 0 ? 0 : (idx + direction + opts.length) % opts.length;
      setTheme(opts[nextIdx]!.value as AppTheme);
    },
    [filteredAppThemeOptions, theme]
  );

  useEffect(() => {
    if (!open || !isTestPreviewOn) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (
        target.closest("input") ||
        target.closest("select") ||
        target.closest("textarea") ||
        target.closest("[contenteditable]")
      ) {
        return;
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        e.stopPropagation();
        cycleAppTheme(-1);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        e.stopPropagation();
        cycleAppTheme(1);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, isTestPreviewOn, cycleAppTheme]);

  const presetSelectOptions = useMemo(() => {
    const opts: Array<{ value: string; label: string; group?: string }> = [
      { value: "default", label: "Default" },
    ];
    if (storedPresets.length > 0) {
      storedPresets.forEach((p) => {
        opts.push({ value: p.id, label: p.name, group: "Saved presets" });
      });
    }
    return opts;
  }, [storedPresets]);

  const selectedPresetData = useMemo(
    () => getPresetData(selectedPresetId as BuiltInPresetId | string),
    [selectedPresetId],
  );

  const presetHasChanges = useMemo(() => {
    const data = selectedPresetData;
    if (!data) return false;
    const mainTheme = mainEditorTheme ?? MAIN_EDITOR_THEME_MATCH_APP;
    const splitTheme = splitEditorTheme ?? SPLIT_EDITOR_THEME_MATCH;
    const baseChanged =
      theme !== data.appTheme ||
      themeBrightness !== data.brightness ||
      themeContrast !== data.contrast ||
      themeSaturation !== data.saturation ||
      mainTheme !== data.mainEditorTheme ||
      splitTheme !== data.splitEditorTheme ||
      integrations.terminalTheme !== data.terminalTheme ||
      fontSize !== data.fontSize;
    if (baseChanged) return true;
    const presetColors = data.customColors ?? {};
    const computed = computeThemePalette(
      data.appTheme,
      data.brightness,
      data.contrast,
      data.saturation,
    );
    const keys: (keyof ThemePaletteColors)[] = [
      "background",
      "foreground",
      "primary",
      "primaryForeground",
      "secondary",
      "secondaryForeground",
      "muted",
      "border",
      "accent",
    ];
    for (const k of keys) {
      const a = themeColors[k];
      const b = presetColors[k] ?? computed[k];
      if (a !== b) return true;
    }
    return false;
  }, [
    selectedPresetId,
    selectedPresetData,
    theme,
    themeBrightness,
    themeContrast,
    themeSaturation,
    mainEditorTheme,
    splitEditorTheme,
    integrations.terminalTheme,
    fontSize,
    themeColors,
  ]);

  const isUserPreset = storedPresets.some((p) => p.id === selectedPresetId);

  const applyPreset = (presetId: string) => {
    const data = getPresetData(presetId as BuiltInPresetId | string);
    if (!data) return;
    setTheme(data.appTheme as AppTheme);
    setThemeBrightness(data.brightness);
    setThemeContrast(data.contrast);
    setThemeSaturation(data.saturation);
    onMainEditorThemeChange?.(data.mainEditorTheme);
    onSplitEditorThemeChange?.(data.splitEditorTheme);
    setIntegrations((prev) => ({ ...prev, terminalTheme: data.terminalTheme }));
    setFontSize(data.fontSize);
    const computed = computeThemePalette(
      data.appTheme,
      data.brightness,
      data.contrast,
      data.saturation,
    );
    if (data.customColors && Object.keys(data.customColors).length > 0) {
      const merged = { ...computed, ...data.customColors };
      setThemeColors(merged);
      applyCustomThemeColors(merged);
      setStoredCustomColors(data.customColors);
      setCustomOverrides(data.customColors);
    } else {
      setThemeColors(computed);
      setStoredCustomColors(null);
      setCustomOverrides(null);
    }
  };

  const handlePresetSelect = (value: string) => {
    setSelectedPresetId(value);
    applyPreset(value);
  };

  const getPresetCustomColors = (): Partial<ThemePaletteColors> | undefined =>
    customOverrides && Object.keys(customOverrides).length > 0 ? { ...customOverrides } : undefined;

  const createPresetFromCurrent = (name: string): ThemePresetData => ({
    id: createPresetId(),
    name: name.trim(),
    appTheme: theme,
    brightness: themeBrightness,
    contrast: themeContrast,
    saturation: themeSaturation,
    mainEditorTheme: mainEditorTheme ?? MAIN_EDITOR_THEME_MATCH_APP,
    splitEditorTheme: splitEditorTheme ?? SPLIT_EDITOR_THEME_MATCH,
    terminalTheme: integrations.terminalTheme,
    fontSize,
    customColors: getPresetCustomColors(),
  });

  const handleSavePreset = async () => {
    if (isUserPreset) {
      const preset = storedPresets.find((p) => p.id === selectedPresetId);
      if (preset) {
        const updated: ThemePresetData = {
          ...preset,
          appTheme: theme,
          brightness: themeBrightness,
          contrast: themeContrast,
          saturation: themeSaturation,
          mainEditorTheme: mainEditorTheme ?? MAIN_EDITOR_THEME_MATCH_APP,
          splitEditorTheme: splitEditorTheme ?? SPLIT_EDITOR_THEME_MATCH,
          terminalTheme: integrations.terminalTheme,
          fontSize,
          customColors: getPresetCustomColors(),
        };
        saveThemePreset(updated);
        setPresetsVersion((v) => v + 1);
      }
    } else {
      const name = askPrompt
        ? await askPrompt({ title: "Save as new preset", placeholder: "Enter preset name" })
        : window.prompt("Save as new preset. Name:");
      if (!name?.trim()) return;
      const preset = createPresetFromCurrent(name);
      saveThemePreset(preset);
      setPresetsVersion((v) => v + 1);
      setSelectedPresetId(preset.id);
    }
  };

  const handleNewPreset = async () => {
    const name = askPrompt
      ? await askPrompt({ title: "New preset", placeholder: "Enter preset name" })
      : window.prompt("New preset. Name:");
    if (!name?.trim()) return;
    const preset = createPresetFromCurrent(name);
    saveThemePreset(preset);
    setPresetsVersion((v) => v + 1);
    setSelectedPresetId(preset.id);
  };

  const handleDeletePreset = async () => {
    if (!isUserPreset) return;
    const presetName = storedPresets.find((p) => p.id === selectedPresetId)?.name ?? selectedPresetId;
    const confirmed = askConfirm
      ? await askConfirm({
        title: "Delete preset",
        message: `Delete preset "${presetName}"?`,
        confirmLabel: "Delete",
        danger: true,
      })
      : window.confirm(`Delete preset "${presetName}"?`);
    if (!confirmed) return;
    deleteThemePreset(selectedPresetId);
    setPresetsVersion((v) => v + 1);
    setSelectedPresetId("default");
    applyPreset("default");
  };

  const applyPreviewThemeWithCurrentAdjustments = useCallback(() => {
    const palette = computeThemePalette(
      theme,
      themeBrightness,
      themeContrast,
      themeSaturation,
    );
    applyTheme(theme);
    applyCustomThemeColors({ ...palette, ...themeColors });
  }, [theme, themeBrightness, themeContrast, themeSaturation, themeColors]);

  const handleThemeABStart = useCallback(() => {
    const neutralPalette = computeThemePalette(theme, 100, 100, 100);
    applyTheme(theme);
    applyCustomThemeColors(neutralPalette);
  }, [theme]);

  const handleThemeABEnd = useCallback(() => {
    applyPreviewThemeWithCurrentAdjustments();
  }, [applyPreviewThemeWithCurrentAdjustments]);

  useEffect(() => {
    if (!open) return;
    if (!isElectrobun()) return;

    const unsub = onUpdateInfoChanged((info) => setUpdateInfo(info));
    updaterGetUpdateInfo()
      .then((info) => setUpdateInfo(info))
      .catch(() => {
        // ignore
      });

    return () => {
      unsub();
    };
  }, [open]);

  const openCreateProvider = (providerType: ModelProviderType = newProviderType) => {
    setEditorError(null);
    setDraft(emptyDraft(providerType));
    setEditorOpen(true);
  };

  const openEditProvider = (provider: ModelProviderConfig) => {
    setEditorError(null);
    setDraft({
      id: provider.id,
      name: provider.name,
      providerType: provider.providerType,
      config: { ...provider.config },
      secretRefs: { ...provider.secretRefs },
      secretValues: {},
      legacyApiToken: provider.legacyApiToken,
      enabled: provider.enabled,
      models: provider.models,
    });
    setEditorOpen(true);
  };

  const closeProviderEditor = () => {
    setEditorOpen(false);
    setEditorError(null);
    setRefreshBusy(false);
    setEditorBusy(false);
  };

  const descriptor = getModelProviderDescriptor(draft.providerType);
  const missingRequiredConfigField = descriptor.configFields.find(
    (field) => field.required && !draft.config[field.key]?.trim(),
  );
  const missingRequiredSecretField = descriptor.secretFields.find((field) => {
    if (!field.required) return false;
    const typed = draft.secretValues[field.key]?.trim();
    const saved = draft.secretRefs[field.key]?.trim();
    const migrated = field.key === "apiKey" ? draft.legacyApiToken?.trim() : "";
    return !typed && !saved && !migrated;
  });
  const canRefreshModels =
    draft.name.trim().length > 0 &&
    !missingRequiredConfigField &&
    !missingRequiredSecretField;

  const toggleProviderEnabled = (providerId: string) => {
    setProviders((prev) =>
      prev.map((provider) =>
        provider.id === providerId
          ? { ...provider, enabled: !provider.enabled }
          : provider,
      ),
    );
  };

  const deleteProvider = async (providerId: string) => {
    const provider = providers.find((candidate) => candidate.id === providerId);
    if (!provider) return;
    await deleteModelProviderSecrets(provider.secretRefs);
    setProviders((prev) => prev.filter((candidate) => candidate.id !== providerId));
  };

  const triggerBlobDownload = (blob: Blob, fileName: string) => {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    anchor.rel = "noopener";
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 200);
  };

  const toggleDeleteCategory = (id: StorageCategoryId) => {
    setDeleteCategoriesSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAllDeleteCategories = () => {
    setDeleteCategoriesSelected(new Set(STORAGE_CATEGORIES.map((c) => c.id)));
  };

  const deselectAllDeleteCategories = () => {
    setDeleteCategoriesSelected(new Set());
  };

  const toggleExportCategory = (id: StorageCategoryId) => {
    setExportCategoriesSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAllExportCategories = () => {
    setExportCategoriesSelected(new Set(EXPORTABLE_STORAGE_CATEGORIES.map((c) => c.id)));
  };

  const deselectAllExportCategories = () => {
    setExportCategoriesSelected(new Set());
  };

  const confirmExportSettings = async () => {
    const selected = [...exportCategoriesSelected];
    if (selected.length === 0) return;
    setResetError(null);
    setResetBusy("settingsExport");
    setExportSettingsModalOpen(false);
    try {
      const payload = toSettingsImportExportPayload(selected);
      const blob = new Blob([JSON.stringify(payload, null, 2)], {
        type: "application/json",
      });
      triggerBlobDownload(blob, toSafeSettingsExportFileName(payload.exportedAt));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to export settings.";
      setResetError(message);
    } finally {
      setResetBusy(null);
    }
  };

  const importSettingsFromFile = async (file: File) => {
    setResetError(null);
    setResetBusy("settingsImport");
    try {
      const rawText = await file.text();
      const rawJson = JSON.parse(rawText) as unknown;
      const imported = parseSettingsImportExportPayload(rawJson);
      if (!imported) {
        throw new Error("Selected file is not a valid settings export.");
      }
      for (const category of imported.categories) {
        const storageCategory = STORAGE_CATEGORIES.find((cat) => cat.id === category.id);
        if (!storageCategory || storageCategory.keys.length === 0) continue;
        for (const key of storageCategory.keys) {
          if (!(key in category.values)) continue;
          const value = category.values[key];
          if (typeof value === "string") await setItemAsync(key, value);
          else await removeItemAsync(key);
        }
      }
      window.location.reload();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to import settings.";
      setResetError(message);
      setResetBusy(null);
    } finally {
      if (settingsImportInputRef.current) {
        settingsImportInputRef.current.value = "";
      }
    }
  };

  const beginImportSettings = async () => {
    setResetError(null);
    const hasOpenFilePicker = typeof (window as any).showOpenFilePicker === "function";
    if (hasOpenFilePicker) {
      setResetBusy("settingsImport");
      try {
        const [fileHandle] = await (window as any).showOpenFilePicker({
          multiple: false,
          types: [
            {
              description: "JSON",
              accept: {
                "application/json": [".json"],
              },
            },
          ],
        });
        const file = (await fileHandle.getFile()) as File;
        await importSettingsFromFile(file);
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          setResetBusy(null);
          return;
        }
        const message = error instanceof Error ? error.message : "Failed to select file.";
        setResetError(message);
        setResetBusy(null);
      }
      return;
    }
    settingsImportInputRef.current?.click();
  };

  const onSettingsImportInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    void importSettingsFromFile(file);
  };

  const confirmDeleteAppUserData = async () => {
    const selected = [...deleteCategoriesSelected];
    if (selected.length === 0) return;
    setResetError(null);
    setResetBusy("appData");
    (globalThis as any).__contextAssistantStorageResetInProgress = true;
    setDeleteAppDataModalOpen(false);
    try {
      for (const catId of selected) {
        const cat = STORAGE_CATEGORIES.find((c) => c.id === catId);
        if (!cat) continue;
        if (cat.keys.length > 0) {
          await removeStorageKeys(cat.keys);
        }
        if (cat.requiresBackend && isElectrobun()) {
          await resetWindowState();
        }
      }
      window.location.reload();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to delete app user data.";
      setResetError(message);
      setResetBusy(null);
    } finally {
      (globalThis as any).__contextAssistantStorageResetInProgress = false;
    }
  };

  const toggleDraftModelType = (modelId: string, type: ProviderModelType) => {
    setDraft((prev) => ({
      ...prev,
      models: prev.models.map((model) =>
        model.id !== modelId
          ? model
          : {
            ...model,
            enabledTypes: {
              ...model.enabledTypes,
              [type]: !model.enabledTypes[type],
            },
          },
      ),
    }));
  };

  const toggleLocalDraftModelType = (modelId: string, type: ProviderModelType) => {
    setLocalDraft((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        models: prev.models.map((model) =>
          model.id !== modelId
            ? model
            : {
              ...model,
              enabledTypes: {
                ...model.enabledTypes,
                [type]: !model.enabledTypes[type],
              },
            },
        ),
      };
    });
  };

  const refreshLocalModels = async () => {
    if (!localDraft) return;
    setLocalEditorError(null);
    setLocalRefreshBusy(true);
    try {
      const existingModels = new Map(localDraft.models.map((model) => [model.id, model]));
      const isDockerDraft = localDraft.key === "dockerLocal";
      const fetched = isDockerDraft
        ? ((await (async () => {
          await dockerClient.configureDockerHost(null);
          return await dockerClient.listAiModels();
        })()).map((model) => ({
          id: model.name,
          size: model.size || "Unknown",
          details: model.status || "Docker AI model",
          enabledTypes: MODEL_TYPE_LABELS.reduce(
            (acc, type) => {
              acc[type] = false;
              return acc;
            },
            {} as Record<ProviderModelType, boolean>,
          ),
        })))
        : ((await (async () => {
          await ollamaClient.configureOllamaHost(null);
          return await ollamaClient.listModels();
        })()).map((model) => ({
          id: model.name,
          size: model.size || "Unknown",
          details: "Ollama model",
          enabledTypes: MODEL_TYPE_LABELS.reduce(
            (acc, type) => {
              acc[type] = false;
              return acc;
            },
            {} as Record<ProviderModelType, boolean>,
          ),
        })));
      const merged = fetched.map((model) => {
        const existing = existingModels.get(model.id);
        if (!existing) return model;
        return {
          ...model,
          enabledTypes: existing.enabledTypes,
        };
      });
      setLocalDraft((prev) => (prev ? { ...prev, models: merged } : prev));
    } catch (error) {
      setLocalEditorError(error instanceof Error ? error.message : "Failed to refresh model list");
    } finally {
      setLocalRefreshBusy(false);
    }
  };

  const saveLocalIntegration = () => {
    if (!localDraft) return;
    setIntegrations((prev) => {
      if (localDraft.key === "dockerLocal") {
        return { ...prev, dockerLocalModels: localDraft.models };
      }
      return { ...prev, ollamaLocalModels: localDraft.models };
    });
    closeLocalEditor();
  };

  const refreshModels = async () => {
    if (!canRefreshModels) return;
    setEditorError(null);
    setRefreshBusy(true);
    try {
      const resolvedSecrets: ModelProviderSecretValues = {};
      for (const field of descriptor.secretFields) {
        const typedValue = draft.secretValues[field.key]?.trim();
        if (typedValue) {
          resolvedSecrets[field.key] = typedValue;
          continue;
        }
        const secretRef = draft.secretRefs[field.key]?.trim();
        if (secretRef) {
          const value = await resolveModelProviderSecret(secretRef);
          if (value) resolvedSecrets[field.key] = value;
          continue;
        }
        if (field.key === "apiKey" && draft.legacyApiToken?.trim()) {
          resolvedSecrets[field.key] = draft.legacyApiToken.trim();
        }
      }
      const existingModels = new Map(draft.models.map((model) => [model.id, model]));
      const fetched = await fetchProviderModels({
        providerType: draft.providerType,
        config: draft.config,
        secrets: resolvedSecrets,
      });
      const merged = fetched.map((model) => {
        const existing = existingModels.get(model.id);
        if (!existing) return model;
        return {
          ...model,
          enabledTypes: existing.enabledTypes,
        };
      });
      setDraft((prev) => ({ ...prev, models: merged }));
    } catch (error) {
      setEditorError(
        error instanceof Error ? error.message : "Failed to refresh model list",
      );
    } finally {
      setRefreshBusy(false);
    }
  };

  const saveProvider = async () => {
    const name = draft.name.trim();
    if (!name) {
      setEditorError("Provider name is required.");
      return;
    }
    if (missingRequiredConfigField) {
      setEditorError(`${missingRequiredConfigField.label} is required.`);
      return;
    }
    setEditorError(null);
    setEditorBusy(true);
    try {
      const id =
        draft.id ??
        (typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `${Date.now()}`);
      const typedSecrets: ModelProviderSecretValues = {};
      for (const field of descriptor.secretFields) {
        const typed = draft.secretValues[field.key]?.trim();
        if (typed) typedSecrets[field.key] = typed;
      }
      if (!typedSecrets.apiKey && draft.legacyApiToken?.trim()) {
        typedSecrets.apiKey = draft.legacyApiToken.trim();
      }
      const persistedSecretRefs =
        Object.keys(typedSecrets).length > 0 ? await persistModelProviderSecretValues(id, typedSecrets) : {};
      const nextSecretRefs = {
        ...draft.secretRefs,
        ...persistedSecretRefs,
      };
      const stillMissingSecretField = descriptor.secretFields.find(
        (field) => field.required && !nextSecretRefs[field.key]?.trim(),
      );
      if (stillMissingSecretField) {
        setEditorError(`${stillMissingSecretField.label} is required.`);
        return;
      }

      const nextProvider: ModelProviderConfig = {
        id,
        name,
        providerType: draft.providerType,
        config: Object.fromEntries(
          Object.entries(draft.config)
            .filter(([, value]) => typeof value === "string" && value.trim())
            .map(([key, value]) => [key, value.trim()]),
        ) as ModelProviderConfigValues,
        secretRefs: nextSecretRefs,
        enabled: draft.enabled,
        models: draft.models,
        updatedAt: Date.now(),
      };

      setProviders((prev) => {
        const exists = prev.some((provider) => provider.id === id);
        if (!exists) return [nextProvider, ...prev];
        return prev.map((provider) => (provider.id === id ? nextProvider : provider));
      });
      closeProviderEditor();
    } catch (error) {
      setEditorError(error instanceof Error ? error.message : "Failed to save model provider.");
    } finally {
      setEditorBusy(false);
    }
  };

  const body = useMemo(() => {
    if (!open) return null;

    // Preview HUD: show only App Theme UI as floating panel, hide full modal
    if (isTestPreviewOn) {
      return (
        <div
          className="fixed bottom-4 right-4 z-50 max-w-lg rounded-xl border bg-background/95 backdrop-blur-sm shadow-xl p-4 shadow-xl/50"
          role="dialog"
          aria-label="Theme preview"
        >
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-medium text-muted-foreground">Theme Preview</span>
            <IconButton label="Close preview" onClick={() => setIsTestPreviewOn(false)}>
              <X className="h-4 w-4" />
            </IconButton>
          </div>
          {/* <div className="rounded-lg p-4 mb-4">
            <div className="text-sm font-medium mb-2">App Theme Presets</div>
            <div className="flex gap-2 items-center">
              <div className="flex-1 min-w-0">
                <CustomSelect
                  value={selectedPresetId}
                  onChange={handlePresetSelect}
                  options={presetSelectOptions}
                  className="w-full"
                />
              </div>
              <button
                type="button"
                className="rounded-md border px-3 py-1.5 text-xs hover:bg-muted shrink-0"
                onClick={handleNewPreset}
              >
                New
              </button>
              {presetHasChanges && (
                <button
                  type="button"
                  className="rounded-md border px-3 py-1.5 text-xs hover:bg-muted shrink-0"
                  onClick={handleSavePreset}
                >
                  Save
                </button>
              )}
              {isUserPreset && (
                <button
                  type="button"
                  className="rounded-md border px-3 py-1.5 text-xs hover:bg-muted shrink-0 text-destructive border-destructive/50 hover:bg-destructive/10"
                  onClick={handleDeletePreset}
                >
                  Delete
                </button>
              )}
            </div>
          </div> */}
          <div className="gap-1 mx-2">
            <div className="rounded-lg p-4" title="Double-click theme to reset">
              <div className="text-sm font-medium mb-2 flex">
                  <span className="flex-1">App Theme</span>
                  {(["all", "Dark", "Color", "Light"] as const).map((f) => (
                  <button
                    key={f}
                    type="button"
                    onClick={() => setAppThemeFilter(f === "all" ? "all" : f)}
                    className={`rounded-md border px-2 py-1 text-xs capitalize ${appThemeFilter === (f === "all" ? "all" : f)
                      ? "bg-muted font-medium"
                      : "hover:bg-muted/60"
                      }`}
                  >
                    {f}
                  </button>
                ))}

              </div>
              <div className="flex gap-1 mb-2">
                <button
                  type="button"
                  onClick={() => cycleAppTheme(-1)}
                  className="rounded-md border border-border bg-background p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                  aria-label="Previous theme"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <CustomSelect
                  value={theme}
                  onChange={(v) => setTheme(v as AppTheme)}
                  options={filteredAppThemeOptions}
                  className="flex-1 min-w-0"
                  onDoubleClick={() => setTheme("tokyo-night")}
                />
                <button
                  type="button"
                  onClick={() => cycleAppTheme(1)}
                  className="rounded-md border border-border bg-background p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                  aria-label="Next theme"
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>
              <div className="rounded-lg p-4 flex flex-col justify-center">
                <div className="space-y-3">
                  <label className="flex flex-col text-xs text-muted-foreground" title="Double-click to reset">
                    <span>Brightness</span>
                    <div className="grid grid-cols-[1fr_64px] gap-2 items-center">
                      <input
                        type="range"
                        min={THEME_BRIGHTNESS_RANGE.min}
                        max={THEME_BRIGHTNESS_RANGE.max}
                        value={themeBrightness}
                        className="w-full"
                        onChange={(e) => setThemeBrightness(Number(e.target.value))}
                        onDoubleClick={() => setThemeBrightness(THEME_BRIGHTNESS_RANGE.defaultValue)}
                      />
                      <span className="text-xs text-muted-foreground tabular-nums">
                        {themeBrightness}
                      </span>
                    </div>
                  </label>
                  <label className="flex flex-col text-xs text-muted-foreground" title="Double-click to reset">
                    <span>Contrast</span>
                    <div className="grid grid-cols-[1fr_64px] gap-2 items-center">
                      <input
                        type="range"
                        min={THEME_CONTRAST_RANGE.min}
                        max={THEME_CONTRAST_RANGE.max}
                        value={themeContrast}
                        className="w-full"
                        onChange={(e) => setThemeContrast(Number(e.target.value))}
                        onDoubleClick={() => setThemeContrast(THEME_CONTRAST_RANGE.defaultValue)}
                      />
                      <span className="text-xs text-muted-foreground tabular-nums">
                        {themeContrast}
                      </span>
                    </div>
                  </label>
                  <label className="flex flex-col text-xs text-muted-foreground" title="Double-click to reset">
                    <span>Saturation</span>
                    <div className="grid grid-cols-[1fr_64px] gap-2 items-center">
                      <input
                        type="range"
                        min={THEME_SATURATION_RANGE.min}
                        max={THEME_SATURATION_RANGE.max}
                        value={themeSaturation}
                        className="w-full"
                        onChange={(e) => setThemeSaturation(Number(e.target.value))}
                        onDoubleClick={() => setThemeSaturation(THEME_SATURATION_RANGE.defaultValue)}
                      />
                      <span className="text-xs text-muted-foreground tabular-nums">
                        {themeSaturation}
                      </span>
                    </div>
                  </label>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      className="rounded-md border px-3 py-1.5 text-xs hover:bg-muted flex-1"
                      onClick={() => {
                        setThemeBrightness(THEME_BRIGHTNESS_RANGE.defaultValue);
                        setThemeContrast(THEME_CONTRAST_RANGE.defaultValue);
                        setThemeSaturation(THEME_SATURATION_RANGE.defaultValue);
                      }}
                    >
                      Reset settings
                    </button>
                    <button
                      type="button"
                      className="rounded-md border px-3 py-1.5 text-xs hover:bg-muted flex-1"
                      onPointerDown={(e) => {
                        e.currentTarget.setPointerCapture(e.pointerId);
                        handleThemeABStart();
                      }}
                      onPointerUp={(e) => {
                        if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                          e.currentTarget.releasePointerCapture(e.pointerId);
                        }
                        handleThemeABEnd();
                      }}
                      onPointerCancel={handleThemeABEnd}
                      onLostPointerCapture={handleThemeABEnd}
                    >
                      A/B
                    </button>
                  </div>
                </div>
              </div>
              <div>
                <div className="grid grid-cols-2 gap-2 mt-3">
                  {(
                    [
                      ["background", "Background"],
                      ["foreground", "Foreground"],
                      ["primary", "Primary"],
                      ["primaryForeground", "Primary text"],
                      ["secondary", "Secondary"],
                      ["secondaryForeground", "Secondary text"],
                      ["muted", "Muted"],
                      ["border", "Border"],
                      ["accent", "Accent"],
                    ] as const
                  ).map(([key, label]) => {
                    const isCustom = !!(customOverrides && key in customOverrides);
                    const handleRevert = () => {
                      const stored = customOverrides ?? {};
                      const nextOverrides = { ...stored };
                      delete nextOverrides[key as keyof ThemePaletteColors];
                      const next = Object.keys(nextOverrides).length > 0 ? nextOverrides : null;
                      setStoredCustomColors(next);
                      setCustomOverrides(next);
                      const computed = computeThemePalette(
                        theme,
                        themeBrightness,
                        themeContrast,
                        themeSaturation,
                      );
                      const merged = { ...computed, ...(next ?? {}) };
                      setThemeColors(merged);
                      applyCustomThemeColors(merged);
                    };
                    return (
                      <label
                        key={key}
                        className="flex items-center gap-2 text-xs text-muted-foreground"
                        title="Click to edit color, double-click to reset"
                      >
                        <div className={`relative inline-flex shrink-0 group/colorbox ${isCustom ? "ring-2 ring-primary rounded" : ""}`}>
                          <InAppColorPicker
                            value={cssColorToHex(themeColors[key])}
                            onChange={(hex) => {
                              const next = { ...themeColors, [key]: hex };
                              setThemeColors(next);
                              applyCustomThemeColors({ [key]: hex });
                              const overrides = { ...(customOverrides ?? {}), [key]: hex };
                              setStoredCustomColors(overrides);
                              setCustomOverrides(overrides);
                            }}
                            onDoubleClick={handleRevert}
                          />
                          {isCustom && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                handleRevert();
                              }}
                              className="absolute -top-1 -right-1 h-4 w-4 rounded-full bg-muted border border-border flex items-center justify-center hover:bg-destructive hover:text-destructive-foreground hover:border-destructive transition-colors z-10 opacity-0 group-hover/colorbox:opacity-100"
                              title="Revert to theme color"
                            >
                              <X className="h-2.5 w-2.5" />
                            </button>
                          )}
                        </div>
                        <span className="truncate">{label}</span>
                      </label>
                    );
                  })}
                  <button
                    type="button"
                    className="rounded-md border px-3 py-1.5 text-xs hover:bg-muted"
                    onClick={() => {
                      const computed = computeThemePalette(
                        theme,
                        themeBrightness,
                        themeContrast,
                        themeSaturation,
                      );
                      setThemeColors(computed);
                      applyCustomThemeColors(computed);
                      setStoredCustomColors(null);
                      setCustomOverrides(null);
                    }}
                  >
                    Reset colors
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      );
    }

    return (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center p-4 lightbox-container"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <div className="flex w-full max-w-3xl max-h-[85vh] flex-col overflow-hidden rounded-xl border bg-background text-foreground shadow-lg">
          <div className="flex items-center justify-between border-b px-4 py-3">
            <div className="font-semibold">Settings</div>
            <IconButton label="Close settings" onClick={onClose}>
              <X className="h-4 w-4" />
            </IconButton>
          </div>

          <div className="grid min-h-0 flex-1 grid-cols-[220px_1fr] min-h-[360px]">
            <nav className="overflow-y-auto border-r bg-muted/30 p-2">
              <button
                type="button"
                className={[
                  "w-full rounded-md px-3 py-2 text-left text-sm hover:bg-muted",
                  group === "general" ? "bg-muted font-medium" : "",
                ].join(" ")}
                onClick={() => setGroup("general")}
              >
                General
              </button>
              <button
                type="button"
                className={[
                  "mt-1 w-full rounded-md px-3 py-2 text-left text-sm hover:bg-muted",
                  group === "environment" ? "bg-muted font-medium" : "",
                ].join(" ")}
                onClick={() => setGroup("environment")}
              >
                Environment
              </button>
              <button
                type="button"
                className={[
                  "mt-1 w-full rounded-md px-3 py-2 text-left text-sm hover:bg-muted",
                  group === "modelProviders" ? "bg-muted font-medium" : "",
                ].join(" ")}
                onClick={() => setGroup("modelProviders")}
              >
                Model Providers
              </button>
              <button
                type="button"
                className={[
                  "mt-1 w-full rounded-md px-3 py-2 text-left text-sm hover:bg-muted",
                  group === "reset" ? "bg-muted font-medium" : "",
                ].join(" ")}
                onClick={() => setGroup("reset")}
              >
                Backup / Reset
              </button>
            </nav>

            <div className="overflow-y-auto p-4">
              {group === "general" && (
                <div className="max-w-xl">
                  <div className="rounded-lg p-4 mb-4">
                    <div className="text-sm font-medium mb-2">App Theme Presets</div>
                    <div className="flex gap-2 items-center">
                      <div className="flex-1 min-w-0">
                        <CustomSelect
                          value={selectedPresetId}
                          onChange={handlePresetSelect}
                          options={presetSelectOptions}
                          className="w-full"
                        />
                      </div>
                      <button
                        type="button"
                        className="rounded-md border px-3 py-1.5 text-xs hover:bg-muted shrink-0"
                        onClick={() => setIsTestPreviewOn(true)}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="rounded-md border px-3 py-1.5 text-xs hover:bg-muted shrink-0"
                        onClick={handleNewPreset}
                      >
                        New
                      </button>
                      {presetHasChanges && (
                        <button
                          type="button"
                          className="rounded-md border px-3 py-1.5 text-xs hover:bg-muted shrink-0"
                          onClick={handleSavePreset}
                        >
                          Save
                        </button>
                      )}
                      {isUserPreset && (
                        <button
                          type="button"
                          className="rounded-md border px-3 py-1.5 text-xs hover:bg-muted shrink-0 text-destructive border-destructive/50 hover:bg-destructive/10"
                          onClick={handleDeletePreset}
                        >
                          Delete
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="grid grid-cols-3 gap-4 mt-4">
                    {typeof mainEditorTheme !== "undefined" && onMainEditorThemeChange && (
                      <div className="rounded-lg p-4">
                        <div className="text-sm font-medium mb-2">Main Editor Theme</div>
                        <CustomSelect
                          value={mainEditorTheme}
                          onChange={(v) => onMainEditorThemeChange(v as MainEditorPaneTheme)}
                          options={[
                            { value: MAIN_EDITOR_THEME_MATCH_APP, label: "Match App Theme" },
                            ...getEditorThemeSelectOptions(),
                          ]}
                          className="w-full"
                        />
                      </div>
                    )}

                    {typeof splitEditorTheme !== "undefined" && onSplitEditorThemeChange && (
                      <div className="rounded-lg p-4">
                        <div className="text-sm font-medium mb-2">Split Editor Theme</div>
                        <CustomSelect
                          value={splitEditorTheme}
                          onChange={(v) => onSplitEditorThemeChange(v as SplitEditorPaneTheme)}
                          options={[
                            { value: MAIN_EDITOR_THEME_MATCH_APP, label: "Match App Theme" },
                            { value: SPLIT_EDITOR_THEME_MATCH, label: "Match Main Editor" },
                            ...getEditorThemeSelectOptions(),
                          ]}
                          className="w-full"
                        />
                      </div>
                    )}

                    <div className="rounded-lg p-4">
                      <div className="text-sm font-medium mb-2">Terminal Theme</div>
                      <CustomSelect
                        value={integrations.terminalTheme}
                        onChange={(v) => setTerminalTheme(v as TerminalThemeSetting)}
                        options={[
                          { value: MAIN_EDITOR_THEME_MATCH_APP, label: "Match App Theme" },
                          { value: TERMINAL_THEME_MATCH_MAIN, label: "Match Main Editor" },
                          ...getEditorThemeSelectOptions(),
                        ]}
                        className="w-full"
                      />
                    </div>
                  </div>

                  <div className="rounded-lg p-4 mt-4">
                    <div className="text-sm font-medium mb-2">Font size</div>
                    <div className="flex items-center">
                      <input
                        type="range"
                        min={FONT_SIZE_RANGE.min}
                        max={FONT_SIZE_RANGE.max}
                        value={fontSize}
                        className="w-full"
                        onChange={(e) => setFontSize(Number(e.target.value))}
                      />
                    </div>
                  </div>

                  {isElectrobun() && (
                    <div className="rounded-lg border p-4 mt-4">
                      <div className="text-sm font-medium mb-2">Updates</div>
                      <div className="text-sm text-muted-foreground mb-4">
                        Check for updates and apply them (Electrobun Updater).
                      </div>

                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          className="rounded-md border px-3 py-2 text-sm hover:bg-muted disabled:opacity-50"
                          disabled={updateBusy}
                          onClick={async () => {
                            setUpdateBusy(true);
                            try {
                              await updaterCheckForUpdate();
                            } finally {
                              setUpdateBusy(false);
                            }
                          }}
                        >
                          Check for update
                        </button>

                        <button
                          type="button"
                          className="rounded-md border px-3 py-2 text-sm hover:bg-muted disabled:opacity-50"
                          disabled={updateBusy || !updateInfo?.updateAvailable}
                          onClick={async () => {
                            setUpdateBusy(true);
                            try {
                              await updaterDownloadUpdate();
                            } finally {
                              setUpdateBusy(false);
                            }
                          }}
                        >
                          Download
                        </button>

                        <button
                          type="button"
                          className="rounded-md border px-3 py-2 text-sm hover:bg-muted disabled:opacity-50"
                          disabled={updateBusy || !updateInfo?.updateReady}
                          onClick={async () => {
                            setUpdateBusy(true);
                            try {
                              await updaterApplyUpdate();
                            } finally {
                              setUpdateBusy(false);
                            }
                          }}
                        >
                          Restart & apply
                        </button>
                      </div>

                      <div className="mt-3 text-xs text-muted-foreground">
                        <div>
                          <span className="font-medium text-foreground">
                            Status:
                          </span>{" "}
                          {updateInfo
                            ? updateInfo.error
                              ? `Error: ${updateInfo.error}`
                              : updateInfo.updateReady
                                ? "Ready to apply"
                                : updateInfo.updateAvailable
                                  ? "Update available"
                                  : "Up to date"
                            : "—"}
                        </div>
                        {updateInfo?.version ? (
                          <div>
                            <span className="font-medium text-foreground">
                              Latest:
                            </span>{" "}
                            {updateInfo.version}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  )}
                </div>
              )}
              {group === "environment" && (
                <div className="max-w-4xl space-y-5">
                  <section className="rounded-lg border bg-muted/10 p-4 space-y-4">
                    <div>
                      <div className="text-[11px] uppercase tracking-wide font-semibold text-muted-foreground">Local</div>
                    </div>
                    <div className="rounded-md bg-background/60 p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="text-sm font-medium">Enable Local Terminal Shells</div>
                          <div className="text-xs text-muted-foreground mt-1">
                            Globally enable or disable local terminal shells.
                          </div>
                        </div>
                        <button
                          type="button"
                          className={[
                            "rounded-md border px-2 py-1 text-xs",
                            localTerminalEnabled ? "bg-primary text-primary-foreground" : "bg-background text-foreground",
                          ].join(" ")}
                          onClick={() => toggleIntegration("terminalEnabled")}
                        >
                          {localTerminalEnabled ? "Enabled" : "Disabled"}
                        </button>
                      </div>
                    </div>
                    <div
                      aria-disabled={localTerminalDisabled}
                      className={[
                        "transition-opacity",
                        localTerminalDisabled ? "pointer-events-none select-none opacity-45 grayscale-[35%]" : "",
                      ].join(" ")}
                    >
                      <div className="rounded-md bg-background/60 p-3">
                        <div className="text-sm font-medium">Enabled local shells</div>
                        <div className="text-xs text-muted-foreground mt-1 mb-3">
                          Select which local shells appear in the terminal "+" dropdown.
                        </div>
                        {terminalShellsLoading ? (
                          <div className="text-xs text-muted-foreground">Loading local shells...</div>
                        ) : terminalShellsError ? (
                          <div className="text-xs text-destructive">{terminalShellsError}</div>
                        ) : terminalShellEntries.length === 0 ? (
                          <div className="text-xs text-muted-foreground">No local shells found.</div>
                        ) : (
                          <details className="rounded-md border bg-background/70">
                            <summary className="cursor-pointer list-none select-none px-3 py-2 text-sm font-medium hover:bg-muted/40">
                              <span className="inline-flex items-center gap-2">
                                Shell selection
                                <span className="text-xs text-muted-foreground">
                                  (
                                  {
                                    terminalShellEntries.filter((shell) =>
                                      enabledTerminalShells.has(shell.name),
                                    ).length
                                  }
                                  /
                                  {terminalShellEntries.length}
                                  {" "}enabled)
                                </span>
                              </span>
                            </summary>
                            <div className="space-y-2 border-t px-3 py-3">
                              <select
                                multiple
                                className="w-full min-h-40 rounded-md border bg-background px-2 py-2 text-sm"
                                disabled={localTerminalDisabled}
                                value={terminalShellEntries
                                  .filter((shell) => enabledTerminalShells.has(shell.name))
                                  .map((shell) => shell.name)}
                                onChange={(event) => {
                                  const selected = Array.from(event.target.selectedOptions).map((option) => option.value);
                                  setTerminalShellEnabledValues(selected);
                                }}
                              >
                                {terminalShellEntries.map((shell) => (
                                  <option key={shell.path} value={shell.name}>
                                    {shell.displayName} ({shell.path})
                                  </option>
                                ))}
                              </select>
                              <div className="text-[11px] text-muted-foreground">
                                Use Cmd/Ctrl-click to select multiple shells.
                              </div>
                            </div>
                          </details>
                        )}
                      </div>
                    </div>
                  </section>

                  <section className="rounded-lg border bg-muted/10 p-4 space-y-4">
                    <div>
                      <div className="text-[11px] uppercase tracking-wide font-semibold text-muted-foreground">Remote</div>
                      <div className="text-sm font-medium mt-1">SSH endpoints</div>
                      <div className="text-xs text-muted-foreground mt-1">
                        Add and manage SSH hosts for remote shell connections.
                      </div>
                    </div>
                    <div className="rounded-md bg-background/60 p-3">
                      <div className="flex gap-2">
                        <input
                          className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                          placeholder="ssh://user@host"
                          value={remoteEndpointDraft}
                          onChange={(event) => setRemoteEndpointDraft(event.target.value)}
                        />
                        <button
                          type="button"
                          className="rounded-md border px-3 py-2 text-sm hover:bg-muted disabled:opacity-50"
                          onClick={addRemoteEndpoint}
                          disabled={remoteEndpointDraft.trim().length === 0}
                        >
                          Add
                        </button>
                      </div>
                    </div>
                    <div className="rounded-md bg-background/60 p-3">
                      {sortedRemoteEndpoints.length === 0 ? (
                        <div className="text-xs text-muted-foreground">
                          No remote endpoints yet. Add one above to create SSH shell connections.
                        </div>
                      ) : (
                        <div className="space-y-2">
                          {sortedRemoteEndpoints.map((endpoint) => (
                            <div
                              key={endpoint.id}
                              className="flex items-center justify-between gap-3 bg-muted/30 rounded-md px-2 py-1"
                            >
                              <div className="min-w-0">
                                <div className="text-xs text-foreground">{endpoint.name}</div>
                                <div className="text-[11px] text-muted-foreground truncate">
                                  {endpoint.host}
                                </div>
                              </div>
                              <div className="flex items-center gap-1">
                                <button
                                  type="button"
                                  className={[
                                    "rounded-md border px-2 py-1 text-xs",
                                    endpoint.enabled ? "bg-primary text-primary-foreground" : "bg-background text-foreground",
                                  ].join(" ")}
                                  onClick={() => toggleRemoteEndpointEnabled(endpoint.id)}
                                >
                                  {endpoint.enabled ? "Enabled" : "Disabled"}
                                </button>
                                <button
                                  type="button"
                                  className="rounded-md border px-2 py-1 text-xs hover:bg-muted"
                                  onClick={() => editRemoteEndpoint(endpoint.id)}
                                >
                                  Edit
                                </button>
                                <button
                                  type="button"
                                  className="rounded-md border px-2 py-1 text-xs hover:bg-muted"
                                  onClick={() => deleteRemoteEndpoint(endpoint.id)}
                                >
                                  Delete
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </section>

                </div>
              )}
              {group === "modelProviders" && (
                <div className="max-w-4xl space-y-5">
                  {localIntegrationCards.length > 0 ? (
                    <section className="rounded-lg border bg-muted/10 p-4 space-y-4">
                      <div>
                        <div className="text-[11px] uppercase tracking-wide font-semibold text-muted-foreground">Local Integrations</div>
                      </div>
                      <div className="rounded-md bg-background/60 p-3">
                        <div className="space-y-3">
                          {localIntegrationCards.map((integration) => (
                            <div key={integration.key} className="rounded-lg bg-muted/30 p-3">
                              <div className="flex items-start justify-between gap-4">
                                <div className="min-w-0">
                                  <div className="text-sm font-medium text-foreground">{integration.title}</div>
                                  <div className="mt-2 text-xs text-muted-foreground">
                                    Cached models: {integration.models.length}
                                  </div>
                                </div>
                                <div className="shrink-0 flex items-center gap-2">
                                  <button
                                    type="button"
                                    className={[
                                      "rounded-md border px-2 py-1 text-xs",
                                      integration.enabled ? "bg-primary text-primary-foreground" : "bg-background text-foreground",
                                    ].join(" ")}
                                    onClick={() =>
                                      integration.key === "dockerLocal"
                                        ? toggleIntegration("dockerLocalEnabled")
                                        : toggleIntegration("ollamaLocalEnabled")
                                    }
                                  >
                                    {integration.enabled ? "Enabled" : "Disabled"}
                                  </button>
                                  <button
                                    type="button"
                                    className="rounded-md border px-2 py-1 text-xs hover:bg-muted"
                                    onClick={() => openLocalEditor(integration.key)}
                                  >
                                    Edit
                                  </button>
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    </section>
                  ) : null}

                  <div className="rounded-lg border bg-muted/10 p-4 space-y-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-[11px] uppercase tracking-wide font-semibold text-muted-foreground">API model providers</div>
                      </div>
                      <button
                        type="button"
                        className={[
                          "rounded-md border px-2 py-1 text-xs",
                          aiApiModelProvidersEnabled ? "bg-primary text-primary-foreground" : "bg-background text-foreground",
                        ].join(" ")}
                        onClick={() => toggleIntegration("aiApiModelProvidersEnabled")}
                      >
                        {aiApiModelProvidersEnabled ? "Enabled" : "Disabled"}
                      </button>
                    </div>
                    <div
                      aria-disabled={aiApiModelProvidersDisabled}
                      className={[
                        "transition-opacity",
                        aiApiModelProvidersDisabled ? "pointer-events-none select-none opacity-45 grayscale-[35%]" : "",
                      ].join(" ")}
                    >
                      <div className="mb-4 flex justify-end">
                        <button
                          type="button"
                          className="w-28 rounded-md border px-3 py-2 text-sm hover:bg-muted disabled:opacity-50"
                          disabled={aiApiModelProvidersDisabled}
                          onClick={() => openCreateProvider(newProviderType)}
                        >
                          New
                        </button>
                      </div>

                      {providers.length === 0 ? (
                        <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                          No external providers configured yet.
                        </div>
                      ) : (
                        <ul className="space-y-3">
                          {sortedProviders.map((provider) => (
                            <li
                              key={provider.id}
                              className="rounded-lg p-1 bg-muted/30"
                            >
                              <div className="flex items-start justify-between gap-4">
                                <div className="min-w-0">
                                  <div className="text-sm font-medium text-foreground">
                                    {provider.name}
                                  </div>
                                  <div className="text-xs text-muted-foreground truncate">
                                    {getModelProviderDescriptor(provider.providerType).displayName}
                                  </div>
                                  <div className="text-xs text-muted-foreground truncate">
                                    {provider.config.baseUrl ?? "Managed endpoint"}
                                  </div>
                                  <div className="mt-2 text-xs text-muted-foreground">
                                    Cached models: {provider.models.length}
                                  </div>
                                </div>
                                <div className="shrink-0 flex items-center gap-2">
                                  <button
                                    type="button"
                                    className={[
                                      "rounded-md border px-2 py-1 text-xs",
                                      provider.enabled ? "bg-primary text-primary-foreground" : "bg-background text-foreground",
                                    ].join(" ")}
                                    disabled={aiApiModelProvidersDisabled}
                                    onClick={() => toggleProviderEnabled(provider.id)}
                                  >
                                    {provider.enabled ? "Enabled" : "Disabled"}
                                  </button>
                                  <button
                                    type="button"
                                    className="rounded-md border px-2 py-1 text-xs hover:bg-muted"
                                    disabled={aiApiModelProvidersDisabled}
                                    onClick={() => openEditProvider(provider)}
                                  >
                                    Edit
                                  </button>
                                  <button
                                    type="button"
                                    className="rounded-md border px-2 py-1 text-xs text-destructive hover:bg-muted"
                                    disabled={aiApiModelProvidersDisabled}
                                    onClick={() => void deleteProvider(provider.id)}
                                  >
                                    Delete
                                  </button>
                                </div>
                              </div>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>
                </div>
              )}
              {group === "reset" && (
                <div className="max-w-2xl space-y-4">
                  <div>
                    <div className="text-xs text-muted-foreground">
                      Use with care. These actions are destructive.
                    </div>
                  </div>
                  {resetError ? (
                    <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                      {resetError}
                    </div>
                  ) : null}
                  <div className="rounded-lg border p-4">
                    <div className="text-sm font-medium mb-2">Import / export configuration</div>
                    <div className="text-sm text-muted-foreground mb-3">
                      Export selected configuration sections to a JSON backup, or import a previous
                      export to restore those settings.
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        className="rounded-md border px-3 py-2 text-sm hover:bg-muted disabled:opacity-50"
                        disabled={resetBusy !== null}
                        onClick={() => setExportSettingsModalOpen(true)}
                      >
                        {resetBusy === "settingsExport" ? "Exporting..." : "Export"}
                      </button>
                      <button
                        type="button"
                        className="rounded-md border px-3 py-2 text-sm hover:bg-muted disabled:opacity-50"
                        disabled={resetBusy !== null}
                        onClick={() => void beginImportSettings()}
                      >
                        {resetBusy === "settingsImport" ? "Importing..." : "Import"}
                      </button>
                    </div>
                    <input
                      ref={settingsImportInputRef}
                      type="file"
                      className="hidden"
                      accept="application/json,.json"
                      onChange={onSettingsImportInputChange}
                    />
                  </div>
                  <div className="rounded-lg border p-4">
                    <div className="text-sm font-medium mb-2">Reset app user data</div>
                    <div className="text-sm text-muted-foreground mb-3">
                      Delete specific app user data stored on this machine. Choose which
                      categories to reset. The app will restart after deletion.
                    </div>
                    <button
                      type="button"
                      className="rounded-md border px-3 py-2 text-sm hover:bg-muted disabled:opacity-50"
                      disabled={resetBusy !== null}
                      onClick={() => setDeleteAppDataModalOpen(true)}
                    >
                      {resetBusy === "appData" ? "Deleting..." : "Delete app user data"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {deleteAppDataModalOpen && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center lightbox-container p-4"
            role="dialog"
            aria-modal="true"
            aria-label="Delete app user data"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) setDeleteAppDataModalOpen(false);
            }}
          >
            <div className="w-full max-w-lg rounded-xl border bg-background shadow-lg">
              <div className="flex items-center justify-between border-b px-4 py-3">
                <div className="font-semibold">Delete app user data</div>
                <IconButton
                  label="Close"
                  onClick={() => setDeleteAppDataModalOpen(false)}
                >
                  <X className="h-4 w-4" />
                </IconButton>
              </div>
              <div className="space-y-3 p-4">
                <div className="text-sm text-muted-foreground">
                  Select which categories to delete. The app will restart after deletion.
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    className="text-xs underline hover:no-underline"
                    onClick={selectAllDeleteCategories}
                  >
                    Select all
                  </button>
                  <button
                    type="button"
                    className="text-xs underline hover:no-underline"
                    onClick={deselectAllDeleteCategories}
                  >
                    Deselect all
                  </button>
                </div>
                <div className="space-y-2">
                  {STORAGE_CATEGORIES.map((cat) => {
                    const disabled =
                      cat.requiresBackend && !isElectrobun();
                    const checked = deleteCategoriesSelected.has(cat.id);
                    return (
                      <label
                        key={cat.id}
                        className={`flex items-center gap-3 rounded-md border px-3 py-2 text-sm cursor-pointer ${disabled ? "opacity-50 cursor-not-allowed" : "hover:bg-muted/50"
                          }`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={disabled}
                          onChange={() => !disabled && toggleDeleteCategory(cat.id)}
                          className="rounded border"
                        />
                        <span className="flex-1">{cat.label}</span>
                        {disabled && (
                          <span className="text-xs text-muted-foreground">
                            (desktop app only)
                          </span>
                        )}
                      </label>
                    );
                  })}
                </div>
              </div>
              <div className="flex justify-end gap-2 border-t px-4 py-3">
                <button
                  type="button"
                  className="rounded-md border px-3 py-2 text-sm hover:bg-muted"
                  onClick={() => setDeleteAppDataModalOpen(false)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="rounded-md border border-destructive bg-destructive/10 px-3 py-2 text-sm text-destructive hover:bg-destructive/20 disabled:opacity-50"
                  disabled={deleteCategoriesSelected.size === 0}
                  onClick={() => void confirmDeleteAppUserData()}
                >
                  Delete selected
                </button>
              </div>
            </div>
          </div>
        )}
        {exportSettingsModalOpen && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center lightbox-container p-4"
            role="dialog"
            aria-modal="true"
            aria-label="Export settings"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) setExportSettingsModalOpen(false);
            }}
          >
            <div className="w-full max-w-lg rounded-xl border bg-background shadow-lg">
              <div className="flex items-center justify-between border-b px-4 py-3">
                <div className="font-semibold">Export settings</div>
                <IconButton label="Close" onClick={() => setExportSettingsModalOpen(false)}>
                  <X className="h-4 w-4" />
                </IconButton>
              </div>
              <div className="space-y-3 p-4">
                <div className="text-sm text-muted-foreground">
                  Select which configuration sections to export.
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    className="text-xs underline hover:no-underline"
                    onClick={selectAllExportCategories}
                  >
                    Select all
                  </button>
                  <button
                    type="button"
                    className="text-xs underline hover:no-underline"
                    onClick={deselectAllExportCategories}
                  >
                    Deselect all
                  </button>
                </div>
                <div className="space-y-2">
                  {EXPORTABLE_STORAGE_CATEGORIES.map((cat) => {
                    const checked = exportCategoriesSelected.has(cat.id);
                    return (
                      <label
                        key={cat.id}
                        className="flex items-center gap-3 rounded-md border px-3 py-2 text-sm cursor-pointer hover:bg-muted/50"
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleExportCategory(cat.id)}
                          className="rounded border"
                        />
                        <span className="flex-1">{cat.label}</span>
                      </label>
                    );
                  })}
                </div>
              </div>
              <div className="flex justify-end gap-2 border-t px-4 py-3">
                <button
                  type="button"
                  className="rounded-md border px-3 py-2 text-sm hover:bg-muted"
                  onClick={() => setExportSettingsModalOpen(false)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="rounded-md border px-3 py-2 text-sm hover:bg-muted disabled:opacity-50"
                  disabled={exportCategoriesSelected.size === 0 || resetBusy !== null}
                  onClick={() => void confirmExportSettings()}
                >
                  Export selected
                </button>
              </div>
            </div>
          </div>
        )}

        {remoteEndpointEditorOpen && remoteEndpointEditorDraft && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center lightbox-container p-4"
            role="dialog"
            aria-modal="true"
            aria-label="Edit remote endpoint"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) closeRemoteEndpointEditor();
            }}
          >
            <div className="w-full max-w-lg rounded-xl border bg-background shadow-lg">
              <div className="flex items-center justify-between border-b px-4 py-3">
                <div className="font-semibold">Edit Remote Endpoint</div>
                <IconButton label="Close remote endpoint editor" onClick={closeRemoteEndpointEditor}>
                  <X className="h-4 w-4" />
                </IconButton>
              </div>
              <div className="space-y-3 p-4">
                <Field
                  label="Endpoint name"
                  value={remoteEndpointEditorDraft.name}
                  onChange={(value) =>
                    setRemoteEndpointEditorDraft((prev) =>
                      prev ? { ...prev, name: value } : prev,
                    )
                  }
                  placeholder="My SSH host"
                />
                <Field
                  label="SSH URL"
                  value={remoteEndpointEditorDraft.host}
                  onChange={(value) =>
                    setRemoteEndpointEditorDraft((prev) =>
                      prev ? { ...prev, host: value } : prev,
                    )
                  }
                  placeholder="ssh://user@host"
                />
                {remoteEndpointEditorError ? (
                  <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                    {remoteEndpointEditorError}
                  </div>
                ) : null}
              </div>
              <div className="flex items-center justify-end gap-2 border-t px-4 py-3">
                <button
                  type="button"
                  className="rounded-md border px-3 py-2 text-sm hover:bg-muted"
                  onClick={closeRemoteEndpointEditor}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="rounded-md border px-3 py-2 text-sm hover:bg-muted"
                  onClick={saveRemoteEndpointEditor}
                >
                  Save endpoint
                </button>
              </div>
            </div>
          </div>
        )}

        {localEditorOpen && localDraft && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center lightbox-container p-4"
            role="dialog"
            aria-modal="true"
            aria-label={`Edit ${localDraft.name}`}
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) closeLocalEditor();
            }}
          >
            <div className="w-full max-w-4xl rounded-xl border bg-background shadow-lg">
              <div className="flex items-center justify-between border-b px-4 py-3">
                <div className="font-semibold">{localDraft.name}</div>
                <IconButton label="Close local integration form" onClick={closeLocalEditor}>
                  <X className="h-4 w-4" />
                </IconButton>
              </div>

              <div className="p-4 space-y-4">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className="rounded-md border px-3 py-2 text-sm hover:bg-muted disabled:opacity-50"
                    disabled={localRefreshBusy}
                    onClick={() => void refreshLocalModels()}
                  >
                    {localRefreshBusy ? "Refreshing..." : "Refresh models"}
                  </button>
                  <span className="text-xs text-muted-foreground">
                    {localDraft.key === "dockerLocal"
                      ? "Pulls local Docker AI models"
                      : "Pulls from local Ollama host"}
                  </span>
                </div>

                {localEditorError ? (
                  <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                    {localEditorError}
                  </div>
                ) : null}

                <div className="rounded-lg border">
                  <div className="border-b px-3 py-2 text-xs font-medium text-muted-foreground">
                    Cached models ({localDraft.models.length})
                  </div>
                  {localDraft.models.length === 0 ? (
                    <div className="p-3 text-xs text-muted-foreground">
                      Refresh models to load local model IDs.
                    </div>
                  ) : (
                    <ul className="max-h-72 overflow-auto divide-y">
                      {sortedLocalDraftModels.map((model) => (
                        <li key={model.id} className="p-3 text-xs">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="font-medium text-foreground truncate">{model.id}</div>
                            </div>
                            <div className="flex flex-wrap justify-end gap-1">
                              {MODEL_TYPE_LABELS.map((type) => (
                                <button
                                  key={type}
                                  type="button"
                                  className={[
                                    "rounded border px-2 py-1 text-[11px] tracking-wide",
                                    model.enabledTypes[type]
                                      ? "bg-primary border-primary text-primary-foreground"
                                      : "bg-secondary/20 border-border text-secondary-foreground",
                                  ].join(" ")}
                                  onClick={() => toggleLocalDraftModelType(model.id, type)}
                                >
                                  {MODEL_TYPE_DISPLAY[type]}
                                </button>
                              ))}
                            </div>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>

              <div className="flex items-center justify-end gap-2 border-t px-4 py-3">
                <button
                  type="button"
                  className="rounded-md border px-3 py-2 text-sm hover:bg-muted"
                  onClick={closeLocalEditor}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="rounded-md border px-3 py-2 text-sm hover:bg-muted"
                  onClick={saveLocalIntegration}
                >
                  Save provider
                </button>
              </div>
            </div>
          </div>
        )}

        {editorOpen && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center lightbox-container p-4"
            role="dialog"
            aria-modal="true"
            aria-label={draft.id ? "Edit model provider" : "New model provider"}
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) closeProviderEditor();
            }}
          >
            <div className="w-full max-w-4xl rounded-xl border bg-background shadow-lg">
              <div className="flex items-center justify-between border-b px-4 py-3">
                <div className="font-semibold">
                  {draft.id ? "Edit Model Provider" : "New Model Provider"}
                </div>
                <IconButton label="Close provider form" onClick={closeProviderEditor}>
                  <X className="h-4 w-4" />
                </IconButton>
              </div>

              <div className="p-4 space-y-4">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field
                    label="Name"
                    value={draft.name}
                    onChange={(value) => setDraft((prev) => ({ ...prev, name: value }))}
                  />
                  <Field
                    label="Provider"
                    value={draft.providerType}
                    onChange={(value) =>
                      setDraft((prev) => {
                        const nextType = value as ModelProviderType;
                        const nextDescriptor = getModelProviderDescriptor(nextType);
                        return {
                          ...prev,
                          providerType: nextType,
                          config: {
                            ...nextDescriptor.defaultConfig,
                            ...prev.config,
                          },
                        };
                      })
                    }
                    isSelect
                    selectOptions={MODEL_PROVIDER_DESCRIPTORS.map((provider) => ({
                      value: provider.type,
                      label: provider.displayName,
                    }))}
                  />
                  {descriptor.configFields.map((field) => (
                    <Field
                      key={field.key}
                      label={field.label}
                      value={draft.config[field.key] ?? ""}
                      placeholder={field.placeholder}
                      onChange={(value) =>
                        setDraft((prev) => ({
                          ...prev,
                          config: { ...prev.config, [field.key]: value },
                        }))
                      }
                    />
                  ))}
                  {descriptor.secretFields.map((field) => (
                    <Field
                      key={field.key}
                      label={field.label}
                      value={draft.secretValues[field.key] ?? ""}
                      placeholder={field.placeholder}
                      onChange={(value) =>
                        setDraft((prev) => ({
                          ...prev,
                          secretValues: { ...prev.secretValues, [field.key]: value },
                        }))
                      }
                      isPassword
                    />
                  ))}
                </div>
                {descriptor.secretFields.some((field) => draft.secretRefs[field.key]) ? (
                  <div className="text-xs text-muted-foreground">
                    Existing secrets are already saved in Bun secrets. Leave fields blank to keep
                    existing values.
                  </div>
                ) : null}

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className="rounded-md border px-3 py-2 text-sm hover:bg-muted disabled:opacity-50"
                    disabled={!canRefreshModels || refreshBusy}
                    onClick={refreshModels}
                  >
                    {refreshBusy ? "Refreshing..." : "Refresh models"}
                  </button>
                  <span className="text-xs text-muted-foreground">
                    {draft.providerType === "openaiCompatible"
                      ? `Pulls from ${(draft.config.baseUrl ?? "").trim() || "<host>"}/models`
                      : `Pulls from ${descriptor.displayName}`}
                  </span>
                </div>

                {editorError ? (
                  <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                    {editorError}
                  </div>
                ) : null}

                <div className="rounded-lg border">
                  <div className="border-b px-3 py-2 text-xs font-medium text-muted-foreground">
                    Cached models ({draft.models.length})
                  </div>
                  {draft.models.length === 0 ? (
                    <div className="p-3 text-xs text-muted-foreground">
                      Refresh models to load provider model IDs.
                    </div>
                  ) : (
                    <ul className="max-h-72 overflow-auto divide-y">
                      {sortedDraftModels.map((model) => (
                        <li key={model.id} className="p-3 text-xs">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="font-medium text-foreground truncate">
                                {model.id}
                              </div>
                            </div>
                            <div className="flex flex-wrap justify-end gap-1">
                              {MODEL_TYPE_LABELS.map((type) => (
                                <button
                                  key={type}
                                  type="button"
                                  className={[
                                    "rounded border px-2 py-1 text-[11px] tracking-wide",
                                    model.enabledTypes[type]
                                      ? "bg-primary text-primary-foreground"
                                      : "bg-background text-foreground",
                                  ].join(" ")}
                                  onClick={() => toggleDraftModelType(model.id, type)}
                                >
                                  {MODEL_TYPE_DISPLAY[type]}
                                </button>
                              ))}
                            </div>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>

              <div className="flex items-center justify-end gap-2 border-t px-4 py-3">
                <button
                  type="button"
                  className="rounded-md border px-3 py-2 text-sm hover:bg-muted"
                  onClick={closeProviderEditor}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="rounded-md border px-3 py-2 text-sm hover:bg-muted disabled:opacity-50"
                  disabled={editorBusy}
                  onClick={saveProvider}
                >
                  {editorBusy ? "Saving..." : "Save provider"}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }, [
    canRefreshModels,
    beginImportSettings,
    closeLocalEditor,
    closeRemoteEndpointEditor,
    confirmExportSettings,
    customOverrides,
    deselectAllExportCategories,
    descriptor,
    deleteRemoteEndpoint,
    deleteProvider,
    draft,
    editRemoteEndpoint,
    editorBusy,
    editorError,
    editorOpen,
    group,
    handleDeletePreset,
    handleNewPreset,
    handlePresetSelect,
    handleSavePreset,
    integrations,
    isTestPreviewOn,
    isUserPreset,
    localDraft,
    presetHasChanges,
    presetSelectOptions,
    selectedPresetId,
    localEditorError,
    localEditorOpen,
    localIntegrationCards,
    localRefreshBusy,
    localIntegrationAvailability,
    newProviderType,
    onClose,
    onSettingsImportInputChange,
    open,
    openCreateProvider,
    openLocalEditor,
    providers,
    refreshBusy,
    refreshLocalModels,
    remoteEndpointDraft,
    remoteEndpointEditorDraft,
    remoteEndpointEditorError,
    remoteEndpointEditorOpen,
    resetBusy,
    resetError,
    saveRemoteEndpointEditor,
    saveLocalIntegration,
    saveProvider,
    selectAllExportCategories,
    sortedRemoteEndpoints,
    theme,
    themeBrightness,
    themeColors,
    themeContrast,
    themeSaturation,
    terminalShellEntries,
    terminalShellsError,
    terminalShellsLoading,
    toggleIntegration,
    toggleDockerSectionVisibility,
    toggleExportCategory,
    toggleLocalDraftModelType,
    toggleRemoteEndpointEnabled,
    setTerminalShellEnabledValues,
    toggleProviderEnabled,
    updateBusy,
    updateInfo,
    addRemoteEndpoint,
    enabledTerminalShells,
    exportCategoriesSelected,
    exportSettingsModalOpen,
  ]);

  if (!open) return null;
  return createPortal(body, document.body);
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  isPassword = false,
  isSelect = false,
  selectOptions = [],
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  isPassword?: boolean;
  isSelect?: boolean;
  selectOptions?: { value: string; label: string }[];
}) {
  return (
    <label className="flex flex-col gap-1 text-xs">
      <span className="text-muted-foreground">{label}</span>
      {isSelect ? (
        <CustomSelect
          value={value}
          onChange={onChange}
          options={selectOptions}
          className="rounded-md px-2 py-2 text-sm"
        />
      ) : (
        <input
          type={isPassword ? "password" : "text"}
          value={value}
          placeholder={placeholder}
          className="rounded-md border bg-background px-2 py-2 text-sm text-foreground"
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </label>
  );
}
