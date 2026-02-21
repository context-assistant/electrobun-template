/**
 * App storage for model providers and integrations.
 * Uses Electrobun app data folder when available (shared across instances).
 */
import { getItem, setItem, clearStorage } from "./appDataStorage";
import { migrateStoredModelProviders } from "./modelProviders";
import { MODEL_TYPE_LABELS, type ProviderModel, type ProviderModelType } from "./modelProviders";
import {
  isTerminalThemeSetting,
  MAIN_EDITOR_THEME_MATCH_APP,
  type TerminalThemeSetting,
} from "./editorThemes";

const MODEL_PROVIDERS_KEY = "context-assistant.model-providers.v1";
const MODEL_PROVIDERS_EVENT = "context-assistant:model-providers-state-changed";

export type ModelProviderIntegrationsState = {
  remoteEndpoints: RemoteSshEndpoint[];
  aiApiModelProvidersEnabled: boolean;
  dockerUiEnabled: boolean;
  dockerLocalEnabled: boolean;
  terminalEnabled: boolean;
  terminalEnabledShells: string[];
  terminalTheme: TerminalThemeSetting;
  ollamaLocalEnabled: boolean;
  dockerSectionVisibility: {
    image: boolean;
    app: boolean;
    container: boolean;
    files: boolean;
    volume: boolean;
    aiModel: boolean;
    network: boolean;
  };
  dockerLocalModels: ProviderModel[];
  ollamaLocalModels: ProviderModel[];
};

export type RemoteSshEndpoint = {
  id: string;
  name: string;
  host: string;
  enabled: boolean;
};

export const DEFAULT_MODEL_PROVIDER_INTEGRATIONS_STATE: ModelProviderIntegrationsState = {
  remoteEndpoints: [],
  aiApiModelProvidersEnabled: false,
  dockerUiEnabled: true,
  dockerLocalEnabled: false,
  terminalEnabled: false,
  terminalEnabledShells: ["bash", "zsh"],
  terminalTheme: MAIN_EDITOR_THEME_MATCH_APP,
  ollamaLocalEnabled: true,
  dockerSectionVisibility: {
    image: false,
    app: false,
    container: false,
    files: true,
    volume: false,
    aiModel: false,
    network: false,
  },
  dockerLocalModels: [],
  ollamaLocalModels: [],
};

type ModelProvidersStorageEnvelope<T> = {
  providers: T;
  integrations: ModelProviderIntegrationsState;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseIntegrations(raw: unknown): ModelProviderIntegrationsState {
  if (!isRecord(raw)) return DEFAULT_MODEL_PROVIDER_INTEGRATIONS_STATE;
  const legacyDockerEnabled =
    typeof raw.dockerEnabled === "boolean"
      ? raw.dockerEnabled
      : DEFAULT_MODEL_PROVIDER_INTEGRATIONS_STATE.dockerLocalEnabled;
  const legacyOllamaEnabled =
    typeof raw.ollamaEnabled === "boolean"
      ? raw.ollamaEnabled
      : DEFAULT_MODEL_PROVIDER_INTEGRATIONS_STATE.ollamaLocalEnabled;
  const dockerSectionVisibilityRaw = isRecord(raw.dockerSectionVisibility)
    ? raw.dockerSectionVisibility
    : {};
  const defaults = DEFAULT_MODEL_PROVIDER_INTEGRATIONS_STATE.dockerSectionVisibility;
  const hasDockerLocalModels = Array.isArray(raw.dockerLocalModels);
  const terminalEnabledShellsRaw = Array.isArray(raw.terminalEnabledShells)
    ? raw.terminalEnabledShells
    : [];
  const terminalEnabledShells = terminalEnabledShellsRaw
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => {
      const trimmed = entry.trim().toLowerCase();
      if (!trimmed) return "";
      return trimmed.includes("/") ? (trimmed.split("/").pop() ?? "") : trimmed;
    })
    .filter((entry) => entry.length > 0);
  const remoteEndpointsRaw = Array.isArray(raw.remoteEndpoints) ? raw.remoteEndpoints : [];
  const remoteEndpoints = remoteEndpointsRaw
    .map((entry, index) => {
      if (!isRecord(entry)) return null;
      const host = typeof entry.host === "string" ? entry.host.trim() : "";
      if (!host) return null;
      const id =
        typeof entry.id === "string" && entry.id.trim().length > 0
          ? entry.id.trim()
          : `remote-${index + 1}`;
      const nameRaw = typeof entry.name === "string" ? entry.name.trim() : "";
      const name = nameRaw.length > 0 ? nameRaw : host;
      return {
        id,
        name,
        host,
        enabled: typeof entry.enabled === "boolean" ? entry.enabled : true,
      } satisfies RemoteSshEndpoint;
    })
    .filter((entry): entry is RemoteSshEndpoint => entry !== null);
  return {
    remoteEndpoints,
    aiApiModelProvidersEnabled:
      typeof raw.aiApiModelProvidersEnabled === "boolean"
        ? raw.aiApiModelProvidersEnabled
        : DEFAULT_MODEL_PROVIDER_INTEGRATIONS_STATE.aiApiModelProvidersEnabled,
    // Local Docker host visibility is now always enabled.
    dockerUiEnabled: true,
    dockerLocalEnabled:
      typeof raw.dockerLocalEnabled === "boolean"
        ? raw.dockerLocalEnabled
        : legacyDockerEnabled,
    terminalEnabled:
      typeof raw.terminalEnabled === "boolean"
        ? raw.terminalEnabled
        : DEFAULT_MODEL_PROVIDER_INTEGRATIONS_STATE.terminalEnabled,
    terminalEnabledShells:
      terminalEnabledShells.length > 0
        ? Array.from(new Set(terminalEnabledShells))
        : [...DEFAULT_MODEL_PROVIDER_INTEGRATIONS_STATE.terminalEnabledShells],
    terminalTheme: (() => {
      const v = raw.terminalTheme;
      if (isTerminalThemeSetting(v)) return v;
      // Migrate legacy "system" to Match App Theme
      if (v === "system") return MAIN_EDITOR_THEME_MATCH_APP;
      return DEFAULT_MODEL_PROVIDER_INTEGRATIONS_STATE.terminalTheme;
    })(),
    ollamaLocalEnabled:
      typeof raw.ollamaLocalEnabled === "boolean"
        ? raw.ollamaLocalEnabled
        : legacyOllamaEnabled,
    dockerSectionVisibility: {
      image:
        typeof dockerSectionVisibilityRaw.image === "boolean"
          ? dockerSectionVisibilityRaw.image
          : defaults.image,
      app:
        typeof dockerSectionVisibilityRaw.app === "boolean"
          ? dockerSectionVisibilityRaw.app
          : defaults.app,
      container:
        typeof dockerSectionVisibilityRaw.container === "boolean"
          ? dockerSectionVisibilityRaw.container
          : defaults.container,
      files:
        typeof dockerSectionVisibilityRaw.files === "boolean"
          ? dockerSectionVisibilityRaw.files
          : defaults.files,
      volume:
        typeof dockerSectionVisibilityRaw.volume === "boolean"
          ? dockerSectionVisibilityRaw.volume
          : defaults.volume,
      aiModel:
        typeof dockerSectionVisibilityRaw.aiModel === "boolean"
          ? dockerSectionVisibilityRaw.aiModel
          : defaults.aiModel,
      network:
        typeof dockerSectionVisibilityRaw.network === "boolean"
          ? dockerSectionVisibilityRaw.network
          : defaults.network,
    },
    dockerLocalModels: hasDockerLocalModels
      ? parseProviderModels(raw.dockerLocalModels)
      : parseProviderModels(raw.dockerModels),
    ollamaLocalModels:
      typeof raw.ollamaLocalModels !== "undefined"
        ? parseProviderModels(raw.ollamaLocalModels)
        : parseProviderModels(raw.ollamaModels),
  };
}

function parseProviderModel(raw: unknown): ProviderModel | null {
  if (!isRecord(raw)) return null;
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!id) return null;
  const size = typeof raw.size === "string" ? raw.size : "Unknown";
  const details = typeof raw.details === "string" ? raw.details : "No provider details";
  const enabledTypesRaw = isRecord(raw.enabledTypes) ? raw.enabledTypes : {};
  const enabledTypes = MODEL_TYPE_LABELS.reduce(
    (acc, type) => {
      acc[type] = Boolean(enabledTypesRaw[type]);
      return acc;
    },
    {} as Record<ProviderModelType, boolean>,
  );
  return { id, size, details, enabledTypes };
}

function parseProviderModels(raw: unknown): ProviderModel[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => parseProviderModel(entry))
    .filter((entry): entry is ProviderModel => entry !== null);
}

function parseStoredEnvelope<T>(raw: unknown): ModelProvidersStorageEnvelope<T> | null {
  if (Array.isArray(raw)) {
    // Backward compatibility with legacy shape: providers[] only.
    const migratedProviders = migrateStoredModelProviders(raw);
    return {
      providers: (migratedProviders ?? raw) as T,
      integrations: { ...DEFAULT_MODEL_PROVIDER_INTEGRATIONS_STATE },
    };
  }
  if (!isRecord(raw) || !("providers" in raw)) return null;
  const migratedProviders = migrateStoredModelProviders(raw.providers);
  return {
    providers: (migratedProviders ?? raw.providers) as T,
    integrations: parseIntegrations(raw.integrations),
  };
}

async function readEnvelope<T>(): Promise<ModelProvidersStorageEnvelope<T> | null> {
  try {
    const raw = getItem(MODEL_PROVIDERS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    return parseStoredEnvelope<T>(parsed);
  } catch {
    return null;
  }
}

function emitModelProvidersStateChanged() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(MODEL_PROVIDERS_EVENT));
}

export async function readModelProvidersState<T>(): Promise<T | null> {
  const stored = await readEnvelope<T>();
  return stored?.providers ?? null;
}

export async function writeModelProvidersState<T>(state: T): Promise<void> {
  try {
    const stored = await readEnvelope<T>();
    const next: ModelProvidersStorageEnvelope<T> = {
      providers: state,
      integrations: stored?.integrations ?? { ...DEFAULT_MODEL_PROVIDER_INTEGRATIONS_STATE },
    };
    setItem(MODEL_PROVIDERS_KEY, JSON.stringify(next));
    emitModelProvidersStateChanged();
  } catch {
    // ignore
  }
}

export async function readModelProviderIntegrationsState(): Promise<ModelProviderIntegrationsState> {
  const stored = await readEnvelope<unknown>();
  return stored?.integrations ?? { ...DEFAULT_MODEL_PROVIDER_INTEGRATIONS_STATE };
}

export async function writeModelProviderIntegrationsState(
  state: ModelProviderIntegrationsState,
): Promise<void> {
  try {
    const providers = await readModelProvidersState<unknown>();
    const next: ModelProvidersStorageEnvelope<unknown> = {
      providers: providers ?? [],
      integrations: parseIntegrations(state),
    };
    setItem(MODEL_PROVIDERS_KEY, JSON.stringify(next));
    emitModelProvidersStateChanged();
  } catch {
    // ignore
  }
}

export function onModelProvidersStateChanged(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = () => listener();
  window.addEventListener(MODEL_PROVIDERS_EVENT, handler);
  return () => window.removeEventListener(MODEL_PROVIDERS_EVENT, handler);
}

export async function resetContextAssistantAppStorage(): Promise<void> {
  await clearStorage();
}
