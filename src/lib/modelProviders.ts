import { isElectrobun } from "../electrobun/env";
import { getRpcAsync, sendDevWsRequest } from "../electrobun/renderer";

export type ProviderModelType =
  | "ask"
  | "agent"
  | "autocomplete"
  | "vision"
  | "image"
  | "video"
  | "tts";

export type ProviderModel = {
  id: string;
  size: string;
  details: string;
  enabledTypes: Record<ProviderModelType, boolean>;
};

export type ModelProviderType =
  | "openai"
  | "anthropic"
  | "google"
  | "xai"
  | "mistral"
  | "groq"
  | "ollama"
  | "openaiCompatible";

export type ModelProviderConfigFieldKey =
  | "baseUrl"
  | "organization"
  | "project"
  | "location";

export type ModelProviderSecretFieldKey = "apiKey";

export type ModelProviderConfigValues = Partial<Record<ModelProviderConfigFieldKey, string>>;
export type ModelProviderSecretRefs = Partial<Record<ModelProviderSecretFieldKey, string>>;
export type ModelProviderSecretValues = Partial<Record<ModelProviderSecretFieldKey, string>>;

export type ModelProviderConfig = {
  id: string;
  name: string;
  providerType: ModelProviderType;
  config: ModelProviderConfigValues;
  secretRefs: ModelProviderSecretRefs;
  enabled: boolean;
  models: ProviderModel[];
  updatedAt: number;
  // Legacy plaintext token retained only for migration and one-save transfer to Bun secrets.
  legacyApiToken?: string;
};

export type ModelProviderConfigField = {
  key: ModelProviderConfigFieldKey;
  label: string;
  placeholder?: string;
  description?: string;
  required: boolean;
};

export type ModelProviderSecretField = {
  key: ModelProviderSecretFieldKey;
  label: string;
  placeholder?: string;
  description?: string;
  required: boolean;
};

export type ModelProviderDescriptor = {
  type: ModelProviderType;
  displayName: string;
  description: string;
  configFields: ModelProviderConfigField[];
  secretFields: ModelProviderSecretField[];
  defaultConfig: ModelProviderConfigValues;
};

export const MODEL_PROVIDER_DESCRIPTORS: ModelProviderDescriptor[] = [
  {
    type: "openai",
    displayName: "OpenAI",
    description: "OpenAI hosted models",
    configFields: [
      {
        key: "organization",
        label: "Organization (optional)",
        placeholder: "org_...",
        required: false,
      },
      {
        key: "project",
        label: "Project (optional)",
        placeholder: "proj_...",
        required: false,
      },
    ],
    secretFields: [{ key: "apiKey", label: "API Key", placeholder: "sk-...", required: true }],
    defaultConfig: {},
  },
  {
    type: "anthropic",
    displayName: "Anthropic",
    description: "Claude via Anthropic API",
    configFields: [],
    secretFields: [{ key: "apiKey", label: "API Key", placeholder: "sk-ant-...", required: true }],
    defaultConfig: {},
  },
  {
    type: "google",
    displayName: "Google Generative AI",
    description: "Gemini via Google AI Studio API",
    configFields: [],
    secretFields: [{ key: "apiKey", label: "API Key", placeholder: "AIza...", required: true }],
    defaultConfig: {},
  },
  {
    type: "xai",
    displayName: "xAI",
    description: "Grok models via xAI API",
    configFields: [
      {
        key: "baseUrl",
        label: "Base URL",
        placeholder: "https://api.x.ai/v1",
        required: true,
      },
    ],
    secretFields: [{ key: "apiKey", label: "API Key", placeholder: "xai-...", required: true }],
    defaultConfig: { baseUrl: "https://api.x.ai/v1" },
  },
  {
    type: "mistral",
    displayName: "Mistral",
    description: "Mistral API",
    configFields: [
      {
        key: "baseUrl",
        label: "Base URL",
        placeholder: "https://api.mistral.ai/v1",
        required: true,
      },
    ],
    secretFields: [{ key: "apiKey", label: "API Key", placeholder: "mistral-...", required: true }],
    defaultConfig: { baseUrl: "https://api.mistral.ai/v1" },
  },
  {
    type: "groq",
    displayName: "Groq",
    description: "Groq OpenAI-compatible API",
    configFields: [
      {
        key: "baseUrl",
        label: "Base URL",
        placeholder: "https://api.groq.com/openai/v1",
        required: true,
      },
    ],
    secretFields: [{ key: "apiKey", label: "API Key", placeholder: "gsk_...", required: true }],
    defaultConfig: { baseUrl: "https://api.groq.com/openai/v1" },
  },
  {
    type: "ollama",
    displayName: "Ollama",
    description: "Local/self-hosted Ollama server",
    configFields: [
      {
        key: "baseUrl",
        label: "Host",
        placeholder: "http://localhost:11434",
        required: true,
      },
    ],
    secretFields: [],
    defaultConfig: { baseUrl: "http://localhost:11434" },
  },
  {
    type: "openaiCompatible",
    displayName: "OpenAI-compatible",
    description: "Custom OpenAI-compatible endpoint",
    configFields: [
      {
        key: "baseUrl",
        label: "Host",
        placeholder: "https://host.example.com",
        required: true,
      },
    ],
    secretFields: [{ key: "apiKey", label: "API Key (optional)", placeholder: "sk-...", required: false }],
    defaultConfig: {},
  },
];

export const MODEL_TYPE_LABELS: ProviderModelType[] = [
  "ask",
  "agent",
  "autocomplete",
  "vision",
  "image",
  "video",
  "tts",
];

export const MODEL_TYPE_DISPLAY: Record<ProviderModelType, string> = {
  ask: "Ask",
  agent: "Agent",
  autocomplete: "Auto-Complete",
  vision: "Vision",
  image: "Image",
  video: "Video",
  tts: "TTS",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function getModelProviderDescriptor(type: ModelProviderType): ModelProviderDescriptor {
  const descriptor = MODEL_PROVIDER_DESCRIPTORS.find((candidate) => candidate.type === type);
  return descriptor ?? MODEL_PROVIDER_DESCRIPTORS[0]!;
}

function defaultEnabledTypes(): Record<ProviderModelType, boolean> {
  return {
    ask: false,
    agent: false,
    autocomplete: false,
    vision: false,
    image: false,
    video: false,
    tts: false,
  };
}

function buildModel(raw: unknown): ProviderModel | null {
  if (!isRecord(raw)) return null;
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!id) return null;

  const size =
    typeof raw.size === "string"
      ? raw.size
      : typeof raw.model_size === "string"
        ? raw.model_size
        : typeof raw.bytes === "number"
          ? `${raw.bytes} bytes`
          : "Unknown";

  const details =
    typeof raw.description === "string"
      ? raw.description
      : typeof raw.details === "string"
        ? raw.details
        : "No provider details";

  return {
    id,
    size,
    details,
    enabledTypes: defaultEnabledTypes(),
  };
}

function sanitizeBaseUrl(value: string) {
  return value.trim().replace(/\/+$/, "");
}

type HttpMethod = "GET" | "POST";

type ProxyHttpRequest = {
  url: string;
  method: HttpMethod;
  headers?: Record<string, string>;
  body?: string;
};

type ProxyHttpResponse = {
  ok: boolean;
  status: number;
  json: unknown | null;
  text: string;
};

function requireOk(ok: boolean, status: number) {
  if (!ok) {
    throw new Error(`Request failed (${status})`);
  }
}

function shouldUseProxy(url: string) {
  if (isElectrobun()) return true;
  if (typeof window === "undefined") return true;
  let requestUrl: URL;
  try {
    requestUrl = new URL(url, window.location.origin);
  } catch {
    return true;
  }
  return requestUrl.origin !== window.location.origin;
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("Request aborted", "AbortError");
  }
}

async function proxyHttpRequest(input: ProxyHttpRequest): Promise<ProxyHttpResponse> {
  if (isElectrobun()) {
    const rpc = await getRpcAsync();
    if (!rpc) throw new Error("Not running inside Electrobun");
    return await rpc.request.modelProvider_httpRequest(input);
  }
  try {
    return await sendDevWsRequest<ProxyHttpResponse>("modelProviderHttpRequest", input, 30_000);
  } catch {
    const res = await fetch("/api/docker/modelProviderHttpRequest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    const json = (await res.json()) as ProxyHttpResponse;
    if (!res.ok) {
      throw new Error(`Request failed (${res.status})`);
    }
    return json;
  }
}

async function fetchJsonViaBestTransport(input: {
  url: string;
  method: HttpMethod;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}): Promise<{ ok: boolean; status: number; json: unknown }> {
  throwIfAborted(input.signal);
  if (!shouldUseProxy(input.url)) {
    const response = await fetch(input.url, {
      method: input.method,
      headers: input.headers,
      body: input.body,
      signal: input.signal,
    });
    const json = (await response.json()) as unknown;
    return { ok: response.ok, status: response.status, json };
  }
  const proxied = await proxyHttpRequest({
    url: input.url,
    method: input.method,
    headers: input.headers,
    body: input.body,
  });
  throwIfAborted(input.signal);
  return {
    ok: proxied.ok,
    status: proxied.status,
    json: proxied.json,
  };
}

type FetchProviderModelsInput = {
  providerType: ModelProviderType;
  config: ModelProviderConfigValues;
  secrets: ModelProviderSecretValues;
  signal?: AbortSignal;
};

function buildOpenAIHeaders(
  apiKey: string | undefined,
  extras?: Record<string, string | undefined>,
): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey?.trim()) {
    headers.Authorization = `Bearer ${apiKey.trim()}`;
  }
  if (extras) {
    for (const [key, value] of Object.entries(extras)) {
      if (!value?.trim()) continue;
      headers[key] = value.trim();
    }
  }
  return headers;
}

function extractOpenAIModels(json: unknown): ProviderModel[] {
  const value = isRecord(json) ? json : {};
  const rawModels = Array.isArray(value.data) ? value.data : [];
  return rawModels.map(buildModel).filter((model): model is ProviderModel => model !== null);
}

async function fetchOpenAIFamilyModels(input: {
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string | undefined>;
  signal?: AbortSignal;
}) {
  const url = `${sanitizeBaseUrl(input.baseUrl)}/models`;
  const response = await fetchJsonViaBestTransport({
    url,
    method: "GET",
    headers: buildOpenAIHeaders(input.apiKey, input.headers),
    signal: input.signal,
  });
  requireOk(response.ok, response.status);
  return extractOpenAIModels(response.json);
}

function normalizeGoogleModelName(name: string) {
  return name.startsWith("models/") ? name.slice("models/".length) : name;
}

async function fetchGoogleModels(apiKey: string, signal?: AbortSignal) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`;
  const response = await fetchJsonViaBestTransport({ url, method: "GET", signal });
  requireOk(response.ok, response.status);
  const json = response.json;
  const value = isRecord(json) ? json : {};
  const rawModels = Array.isArray(value.models) ? value.models : [];
  const models: ProviderModel[] = [];
  for (const raw of rawModels) {
    if (!isRecord(raw)) continue;
    const name = typeof raw.name === "string" ? normalizeGoogleModelName(raw.name) : "";
    if (!name) continue;
    models.push({
      id: name,
      size: "Unknown",
      details: typeof raw.description === "string" ? raw.description : "Google model",
      enabledTypes: defaultEnabledTypes(),
    });
  }
  return models;
}

async function fetchAnthropicModels(apiKey: string, signal?: AbortSignal) {
  const response = await fetchJsonViaBestTransport({
    url: "https://api.anthropic.com/v1/models",
    method: "GET",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    signal,
  });
  requireOk(response.ok, response.status);
  const json = response.json;
  const value = isRecord(json) ? json : {};
  const rawModels = Array.isArray(value.data) ? value.data : [];
  const models: ProviderModel[] = [];
  for (const raw of rawModels) {
    const model = buildModel(raw);
    if (model) models.push(model);
  }
  return models;
}

async function fetchOllamaModels(baseUrl: string, signal?: AbortSignal) {
  const response = await fetchJsonViaBestTransport({
    url: `${sanitizeBaseUrl(baseUrl)}/api/tags`,
    method: "GET",
    signal,
  });
  requireOk(response.ok, response.status);
  const json = response.json;
  const value = isRecord(json) ? json : {};
  const rawModels = Array.isArray(value.models) ? value.models : [];
  const models: ProviderModel[] = [];
  for (const raw of rawModels) {
    if (!isRecord(raw)) continue;
    const id = typeof raw.name === "string" ? raw.name : "";
    if (!id) continue;
    const size = typeof raw.size === "number" ? `${raw.size} bytes` : "Unknown";
    const details = typeof raw.details === "string" ? raw.details : "Ollama model";
    models.push({
      id,
      size,
      details,
      enabledTypes: defaultEnabledTypes(),
    });
  }
  return models;
}

function requiredSecret(
  providerType: ModelProviderType,
  secrets: ModelProviderSecretValues,
  key: ModelProviderSecretFieldKey,
): string {
  const descriptor = getModelProviderDescriptor(providerType);
  const field = descriptor.secretFields.find((candidate) => candidate.key === key);
  const value = secrets[key]?.trim();
  if (value) return value;
  if (field?.required) {
    throw new Error(`${field.label} is required for ${descriptor.displayName}.`);
  }
  return "";
}

export async function fetchProviderModels(input: FetchProviderModelsInput): Promise<ProviderModel[]> {
  const baseUrl = sanitizeBaseUrl(input.config.baseUrl ?? "");
  switch (input.providerType) {
    case "openai":
      return await fetchOpenAIFamilyModels({
        baseUrl: "https://api.openai.com/v1",
        apiKey: requiredSecret(input.providerType, input.secrets, "apiKey"),
        headers: {
          "OpenAI-Organization": input.config.organization,
          "OpenAI-Project": input.config.project,
        },
        signal: input.signal,
      });
    case "xai":
    case "mistral":
    case "groq":
    case "openaiCompatible": {
      if (!baseUrl) {
        throw new Error("Host is required.");
      }
      return await fetchOpenAIFamilyModels({
        baseUrl,
        apiKey: requiredSecret(input.providerType, input.secrets, "apiKey"),
        signal: input.signal,
      });
    }
    case "anthropic":
      return await fetchAnthropicModels(requiredSecret(input.providerType, input.secrets, "apiKey"), input.signal);
    case "google":
      return await fetchGoogleModels(requiredSecret(input.providerType, input.secrets, "apiKey"), input.signal);
    case "ollama":
      return await fetchOllamaModels(baseUrl || "http://localhost:11434", input.signal);
  }
}

function readStringRecord(raw: unknown): Record<string, string> {
  if (!isRecord(raw)) return {};
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    next[key] = trimmed;
  }
  return next;
}

function parseStoredModel(raw: unknown): ProviderModel | null {
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

function isProviderType(value: string): value is ModelProviderType {
  return MODEL_PROVIDER_DESCRIPTORS.some((provider) => provider.type === value);
}

export function parseStoredModelProvider(raw: unknown): ModelProviderConfig | null {
  if (!isRecord(raw)) return null;
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!id || !name) return null;

  const maybeType = typeof raw.providerType === "string" ? raw.providerType : "";
  if (isProviderType(maybeType)) {
    const providerType = maybeType;
    const modelsRaw = Array.isArray(raw.models) ? raw.models : [];
    const models = modelsRaw
      .map((model) => parseStoredModel(model))
      .filter((model): model is ProviderModel => model !== null);
    return {
      id,
      name,
      providerType,
      config: readStringRecord(raw.config),
      secretRefs: readStringRecord(raw.secretRefs),
      enabled: Boolean(raw.enabled),
      models,
      updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : Date.now(),
      legacyApiToken: typeof raw.legacyApiToken === "string" ? raw.legacyApiToken : undefined,
    };
  }

  const host = typeof raw.host === "string" ? raw.host.trim() : "";
  if (!host) return null;
  const legacyApiToken = typeof raw.apiToken === "string" ? raw.apiToken : "";
  const modelsRaw = Array.isArray(raw.models) ? raw.models : [];
  const models = modelsRaw
    .map((model) => parseStoredModel(model))
    .filter((model): model is ProviderModel => model !== null);
  return {
    id,
    name,
    providerType: "openaiCompatible",
    config: { baseUrl: host },
    secretRefs: {},
    enabled: Boolean(raw.enabled),
    models,
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : Date.now(),
    legacyApiToken: legacyApiToken.trim() ? legacyApiToken : undefined,
  };
}

export function migrateStoredModelProviders(raw: unknown): ModelProviderConfig[] | null {
  if (!Array.isArray(raw)) return null;
  const providers = raw
    .map((entry) => parseStoredModelProvider(entry))
    .filter((provider): provider is ModelProviderConfig => provider !== null);
  return providers;
}
