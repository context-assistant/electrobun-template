/**
 * Client-side Docker service.
 * When running inside Electrobun, calls go through the RPC bridge.
 * When running in the dev-server browser context, calls go through
 * HTTP POST to /api/docker/* on the same origin.
 */

import { isElectrobun } from "../electrobun/env";
import { getRpcAsync, sendDevWsMessage, sendDevWsRequest } from "../electrobun/renderer";
import { getItem } from "./localStorage";
import type {
  AIModelInfo,
  ContainerInfo,
  ContainerInspect,
  ContainerStats,
  CreateContainerParams,
  DockerUploadEntry,
  FileEntry,
  ImageInfo,
  NetworkInfo,
  VolumeInfo,
} from "../electrobun/rpcSchema";
import type { TerminalSessionRecord } from "./terminalSessionTypes";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type DockerTransport = "rpc" | "ws" | "http";
type DockerMetric = {
  count: number;
  errorCount: number;
  totalMs: number;
  lastMs: number;
  maxMs: number;
  lastError: string | null;
};

const dockerMetrics = new Map<string, DockerMetric>();
const rpcProxyCache = new WeakMap<object, any>();
let configuredDockerHost: string | null = null;
let dockerHostTaskQueue: Promise<void> = Promise.resolve();
let inspectContainerDevMethod: "inspectContainer" | "docker_inspectContainer" = "inspectContainer";
const DOCKER_HOST_TASK_TIMEOUT_MS = 12_000;

function normalizeDockerHost(dockerHost: string | null | undefined): string | null {
  const trimmed = typeof dockerHost === "string" ? dockerHost.trim() : "";
  if (!trimmed) return null;
  // Treat bare host values as SSH hosts so legacy settings don't silently
  // fall back to the local Docker socket.
  if (!trimmed.includes("://")) return `ssh://${trimmed}`;
  return trimmed;
}

function recordDockerMetric(method: string, transport: DockerTransport, ms: number, error?: unknown) {
  const key = `${transport}:${method}`;
  const existing = dockerMetrics.get(key) ?? {
    count: 0,
    errorCount: 0,
    totalMs: 0,
    lastMs: 0,
    maxMs: 0,
    lastError: null,
  };
  existing.count += 1;
  existing.totalMs += ms;
  existing.lastMs = ms;
  existing.maxMs = Math.max(existing.maxMs, ms);
  if (error != null) {
    existing.errorCount += 1;
    existing.lastError = error instanceof Error ? error.message : String(error);
  }
  dockerMetrics.set(key, existing);
}

async function trackDockerCall<T>(
  method: string,
  transport: DockerTransport,
  fn: () => Promise<T>,
): Promise<T> {
  const start = performance.now();
  try {
    const result = await fn();
    recordDockerMetric(method, transport, performance.now() - start);
    return result;
  } catch (error) {
    recordDockerMetric(method, transport, performance.now() - start, error);
    throw error;
  }
}

function wsRequestTransportEnabled() {
  if (isElectrobun()) return false;
  try {
    const override = getItem("context-assistant.docker.wsRequests");
    if (override === "0" || override === "false") return false;
    if (override === "1" || override === "true") return true;
  } catch {
    // ignore
  }
  // Default on for gradual migration; toggle can disable instantly.
  return true;
}

export function getDockerRequestMetricsSnapshot() {
  const rows = [...dockerMetrics.entries()].map(([key, m]) => ({
    key,
    count: m.count,
    errorCount: m.errorCount,
    avgMs: m.count > 0 ? m.totalMs / m.count : 0,
    lastMs: m.lastMs,
    maxMs: m.maxMs,
    lastError: m.lastError,
  }));
  return rows.sort((a, b) => b.count - a.count);
}

export function resetDockerRequestMetrics() {
  dockerMetrics.clear();
}

if (typeof window !== "undefined") {
  (window as any).__dockerRequestMetrics = {
    snapshot: getDockerRequestMetricsSnapshot,
    reset: resetDockerRequestMetrics,
  };
}

async function rpc() {
  const r = await getRpcAsync();
  if (!r) throw new Error("Not running inside Electrobun");
  const cached = rpcProxyCache.get(r);
  if (cached) return cached;
  const tracked = {
    ...r,
    request: new Proxy(r.request as Record<string, (...args: any[]) => Promise<any>>, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== "function") return value;
        return async (params: unknown) =>
          await trackDockerCall(String(prop), "rpc", async () => await value.call(target, params));
      },
    }),
  };
  rpcProxyCache.set(r, tracked);
  return tracked;
}

/**
 * Call a Docker API endpoint on the dev-server via HTTP POST.
 * The method name maps to /api/docker/<method>.
 */
async function devApiFetch<T>(method: string, params: unknown = {}): Promise<T> {
  if (wsRequestTransportEnabled()) {
    try {
      return await trackDockerCall(method, "ws", async () => await sendDevWsRequest<T>(method, params, 10_000));
    } catch {
      // Fall through to HTTP for compatibility/fallback.
    }
  }
  return await trackDockerCall(method, "http", async () => {
    const res = await fetch(`/api/docker/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
    const raw = await res.text();
    let json: any = null;
    if (raw.trim().length > 0) {
      try {
        json = JSON.parse(raw);
      } catch {
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}: ${raw}`);
        }
        throw new Error(`Invalid JSON response from /api/docker/${method}`);
      }
    }
    if (!res.ok) {
      const message =
        (json && (json.error ?? json.message)) ||
        (raw.trim().length > 0 ? raw : `API error: ${res.status}`);
      throw new Error(`HTTP ${res.status}: ${message}`);
    }
    return (json ?? {}) as T;
  });
}

function shouldTryLegacyInspectMethod(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error ?? "").toLowerCase();
  if (message.includes("no such container") || message.includes("container not found")) return false;
  if (message.includes("unknown method")) return true;
  if (message.includes("http 404")) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Docker availability
// ---------------------------------------------------------------------------

export async function isDockerAvailable(): Promise<boolean> {
  try {
    if (isElectrobun()) {
      const r = await rpc();
      const res = await r.request.docker_available({});
      return res.available;
    }
    const res = await devApiFetch<{ available: boolean }>("available");
    return res.available;
  } catch {
    return false;
  }
}

export async function configureDockerHost(dockerHost: string | null): Promise<void> {
  const nextHost = normalizeDockerHost(dockerHost);
  if (configuredDockerHost === nextHost) return;
  if (isElectrobun()) {
    const r = await rpc();
    await r.request.docker_setHost({ dockerHost: nextHost });
  } else {
    await devApiFetch("setHost", { dockerHost: nextHost });
  }
  configuredDockerHost = nextHost;
}

export async function runWithDockerHost<T>(
  dockerHost: string | null | undefined,
  task: () => Promise<T>,
): Promise<T> {
  const nextHost = normalizeDockerHost(dockerHost ?? null);
  const withTimeout = async <V,>(promise: Promise<V>, timeoutMs: number): Promise<V> => {
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error("Docker request timed out while syncing host context"));
        }, timeoutMs);
      });
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  };
  const run = async () => {
    await withTimeout(configureDockerHost(nextHost), DOCKER_HOST_TASK_TIMEOUT_MS);
    return await withTimeout(task(), DOCKER_HOST_TASK_TIMEOUT_MS);
  };
  const next = dockerHostTaskQueue.then(run, run);
  dockerHostTaskQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

// ---------------------------------------------------------------------------
// Container operations
// ---------------------------------------------------------------------------

export async function listContainers(): Promise<ContainerInfo[]> {
  if (isElectrobun()) {
    const r = await rpc();
    const res = await r.request.docker_listContainers({});
    return res.containers;
  }
  const res = await devApiFetch<{ containers: ContainerInfo[] }>("listContainers");
  return res.containers;
}

export async function createContainer(params: CreateContainerParams): Promise<string> {
  if (isElectrobun()) {
    const r = await rpc();
    const res = await r.request.docker_createContainer(params);
    return res.containerId;
  }
  const res = await devApiFetch<{ containerId: string }>("createContainer", params);
  return res.containerId;
}

export async function startContainer(containerId: string): Promise<void> {
  if (isElectrobun()) {
    const r = await rpc();
    await r.request.docker_startContainer({ containerId });
    return;
  }
  try {
    await devApiFetch("startContainer", { containerId });
    return;
  } catch (error) {
    const message = error instanceof Error ? error.message.toLowerCase() : String(error ?? "").toLowerCase();
    const isUnknownMethod = message.includes("unknown method");
    const isNotFound = message.includes("404") || message.includes("not found");
    if (!isUnknownMethod && !isNotFound) throw error;
  }

  // Backward-compatible fallbacks for older dev servers.
  try {
    await devApiFetch("start", { containerId });
    return;
  } catch (error) {
    const message = error instanceof Error ? error.message.toLowerCase() : String(error ?? "").toLowerCase();
    const isUnknownMethod = message.includes("unknown method");
    const isNotFound = message.includes("404") || message.includes("not found");
    if (!isUnknownMethod && !isNotFound) throw error;
  }

  await devApiFetch("docker_startContainer", { containerId });
}

export async function stopContainer(containerId: string): Promise<void> {
  if (isElectrobun()) {
    const r = await rpc();
    await r.request.docker_stopContainer({ containerId });
    return;
  }
  await devApiFetch("stopContainer", { containerId });
}

export async function removeContainer(containerId: string, force = false): Promise<void> {
  if (isElectrobun()) {
    const r = await rpc();
    await r.request.docker_removeContainer({ containerId, force });
    return;
  }
  await devApiFetch("removeContainer", { containerId, force });
}

export async function inspectContainer(containerId: string): Promise<ContainerInspect> {
  if (isElectrobun()) {
    const r = await rpc();
    return await r.request.docker_inspectContainer({ containerId });
  }
  // Backward-compatible fallback for older dev servers with sticky method selection.
  try {
    return await devApiFetch<ContainerInspect>(inspectContainerDevMethod, { containerId });
  } catch (error) {
    if (!shouldTryLegacyInspectMethod(error)) throw error;
  }
  const fallbackMethod =
    inspectContainerDevMethod === "inspectContainer" ? "docker_inspectContainer" : "inspectContainer";
  const result = await devApiFetch<ContainerInspect>(fallbackMethod, { containerId });
  inspectContainerDevMethod = fallbackMethod;
  return result;
}

export async function getContainerStats(containerId: string): Promise<ContainerStats> {
  if (isElectrobun()) {
    const r = await rpc();
    return await r.request.docker_containerStats({ containerId });
  }
  return await devApiFetch<ContainerStats>("containerStats", { containerId });
}

export async function getContainerLogs(containerId: string, tail = 200): Promise<string> {
  if (isElectrobun()) {
    const r = await rpc();
    const res = await r.request.docker_containerLogs({ containerId, tail });
    return res.logs;
  }
  const res = await devApiFetch<{ logs: string }>("containerLogs", { containerId, tail });
  return res.logs;
}

export async function containerExec(
  containerId: string,
  command: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  if (isElectrobun()) {
    const r = await rpc();
    return await r.request.docker_containerExec({ containerId, command });
  }
  return await devApiFetch<{ exitCode: number; stdout: string; stderr: string }>(
    "containerExec",
    { containerId, command },
  );
}

export async function containerExecAs(
  containerId: string,
  user: string,
  command: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  if (isElectrobun()) {
    const r = await rpc();
    return await r.request.docker_containerExecAs({ containerId, user, command });
  }
  return await devApiFetch<{ exitCode: number; stdout: string; stderr: string }>(
    "containerExecAs",
    { containerId, user, command },
  );
}

// ---------------------------------------------------------------------------
// Volume operations
// ---------------------------------------------------------------------------

export async function listVolumes(): Promise<VolumeInfo[]> {
  if (isElectrobun()) {
    const r = await rpc();
    const res = await r.request.docker_listVolumes({});
    return res.volumes;
  }
  const res = await devApiFetch<{ volumes: VolumeInfo[] }>("listVolumes");
  return res.volumes;
}

export async function createVolume(name: string): Promise<VolumeInfo> {
  if (isElectrobun()) {
    const r = await rpc();
    return await r.request.docker_createVolume({ name });
  }
  return await devApiFetch<VolumeInfo>("createVolume", { name });
}

export async function removeVolume(name: string): Promise<void> {
  if (isElectrobun()) {
    const r = await rpc();
    await r.request.docker_removeVolume({ name });
    return;
  }
  await devApiFetch("removeVolume", { name });
}

export async function inspectVolume(name: string): Promise<VolumeInfo> {
  if (isElectrobun()) {
    const r = await rpc();
    return await r.request.docker_inspectVolume({ name });
  }
  return await devApiFetch<VolumeInfo>("inspectVolume", { name });
}

export async function installBashDevToolsVolume(
  volumeName: string,
  scope: "root" | "home",
): Promise<{ homesInstalled: number }> {
  if (isElectrobun()) {
    const r = await rpc();
    return await r.request.docker_installBashDevToolsVolume({ volumeName, scope });
  }
  return await devApiFetch<{ homesInstalled: number }>("installBashDevToolsVolume", { volumeName, scope });
}

export async function listNetworks(): Promise<NetworkInfo[]> {
  if (isElectrobun()) {
    const r = await rpc();
    const res = await r.request.docker_listNetworks({});
    return res.networks;
  }
  const res = await devApiFetch<{ networks: NetworkInfo[] }>("listNetworks");
  return res.networks;
}

export async function removeNetwork(name: string): Promise<void> {
  if (isElectrobun()) {
    const r = await rpc();
    await r.request.docker_removeNetwork({ name });
    return;
  }
  await devApiFetch("removeNetwork", { name });
}

export async function listAiModels(): Promise<AIModelInfo[]> {
  if (isElectrobun()) {
    const r = await rpc();
    const res = await r.request.docker_listAiModels({});
    return res.models;
  }
  const res = await devApiFetch<{ models: AIModelInfo[] }>("listAiModels");
  return res.models;
}

export async function removeAiModel(name: string): Promise<void> {
  if (isElectrobun()) {
    const r = await rpc();
    await r.request.docker_removeAiModel({ name });
    return;
  }
  await devApiFetch("removeAiModel", { name });
}

export async function unloadAiModel(name: string): Promise<void> {
  if (isElectrobun()) {
    const r = await rpc();
    await r.request.docker_unloadAiModel({ name });
    return;
  }
  await devApiFetch("unloadAiModel", { name });
}

// ---------------------------------------------------------------------------
// File operations (via docker exec)
// ---------------------------------------------------------------------------

export async function listFiles(containerId: string, path: string): Promise<FileEntry[]> {
  if (isElectrobun()) {
    const r = await rpc();
    const res = await r.request.docker_listFiles({ containerId, path });
    return res.entries;
  }
  const res = await devApiFetch<{ entries: FileEntry[] }>("listFiles", { containerId, path });
  return res.entries;
}

export async function readFile(containerId: string, path: string): Promise<string> {
  if (isElectrobun()) {
    const r = await rpc();
    const res = await r.request.docker_readFile({ containerId, path });
    return res.content;
  }
  const res = await devApiFetch<{ content: string }>("readFile", { containerId, path });
  return res.content;
}

export async function readFileBase64(containerId: string, path: string): Promise<string> {
  if (isElectrobun()) {
    const r = await rpc();
    const res = await r.request.docker_readFileBase64({ containerId, path });
    return res.contentBase64;
  }
  const res = await devApiFetch<{ contentBase64: string }>("readFileBase64", { containerId, path });
  return res.contentBase64;
}

export async function writeFile(containerId: string, path: string, content: string): Promise<void> {
  if (isElectrobun()) {
    const r = await rpc();
    await r.request.docker_writeFile({ containerId, path, content });
    return;
  }
  await devApiFetch("writeFile", { containerId, path, content });
}

export async function createDirectory(containerId: string, path: string): Promise<void> {
  if (isElectrobun()) {
    const r = await rpc();
    await r.request.docker_createDirectory({ containerId, path });
    return;
  }
  await devApiFetch("createDirectory", { containerId, path });
}

export async function deleteFile(containerId: string, path: string): Promise<void> {
  if (isElectrobun()) {
    const r = await rpc();
    await r.request.docker_deleteFile({ containerId, path });
    return;
  }
  await devApiFetch("deleteFile", { containerId, path });
}

export async function renameFile(
  containerId: string,
  oldPath: string,
  newPath: string,
): Promise<void> {
  if (isElectrobun()) {
    const r = await rpc();
    await r.request.docker_renameFile({ containerId, oldPath, newPath });
    return;
  }
  await devApiFetch("renameFile", { containerId, oldPath, newPath });
}

export async function importFiles(
  containerId: string,
  targetDirectory: string,
  entries: DockerUploadEntry[],
): Promise<void> {
  if (isElectrobun()) {
    const r = await rpc();
    await r.request.docker_importFiles({ containerId, targetDirectory, entries });
    return;
  }
  await devApiFetch("importFiles", { containerId, targetDirectory, entries });
}

// ---------------------------------------------------------------------------
// Image operations
// ---------------------------------------------------------------------------

export async function listImages(): Promise<ImageInfo[]> {
  if (isElectrobun()) {
    const r = await rpc();
    const res = await r.request.docker_listImages({});
    return res.images;
  }
  const res = await devApiFetch<{ images: ImageInfo[] }>("listImages");
  return res.images;
}

export async function removeImage(image: string, force = false): Promise<void> {
  if (isElectrobun()) {
    const r = await rpc();
    await r.request.docker_removeImage({ image, force });
    return;
  }
  await devApiFetch("removeImage", { image, force });
}

export async function pruneDanglingImages(): Promise<void> {
  if (isElectrobun()) {
    const r = await rpc();
    await r.request.docker_pruneDanglingImages({});
    return;
  }
  await devApiFetch("pruneDanglingImages");
}

export async function listImageUsers(image: string): Promise<string[]> {
  if (isElectrobun()) {
    const r = await rpc();
    const res = await r.request.docker_imageUsers({ image });
    return res.users;
  }
  const res = await devApiFetch<{ users: string[] }>("imageUsers", { image });
  return res.users;
}

export async function buildImage(dockerfile: string, tag: string): Promise<string> {
  if (isElectrobun()) {
    const r = await rpc();
    const res = await r.request.docker_buildImage({ dockerfile, tag });
    return res.output;
  }
  const res = await devApiFetch<{ output: string }>("buildImage", { dockerfile, tag });
  return res.output;
}

export async function commitContainer(containerId: string, image: string): Promise<string> {
  if (isElectrobun()) {
    const r = await rpc();
    const res = await r.request.docker_commitContainer({ containerId, image });
    return res.imageId;
  }
  const res = await devApiFetch<{ imageId: string }>("commitContainer", { containerId, image });
  return res.imageId;
}

export async function inspectImageDeclaredVolumes(image: string): Promise<string[]> {
  if (isElectrobun()) {
    const r = await rpc();
    const res = await r.request.docker_imageDeclaredVolumes({ image });
    return res.volumes;
  }
  const res = await devApiFetch<{ volumes: string[] }>("inspectImageDeclaredVolumes", { image });
  return res.volumes;
}

// ---------------------------------------------------------------------------
// Volume attachment (recreates container with volume at /workspace)
// ---------------------------------------------------------------------------

export async function recreateWritable(containerId: string): Promise<string> {
  if (isElectrobun()) {
    const r = await rpc();
    const res = await r.request.docker_recreateWritable({ containerId });
    return res.newContainerId;
  }
  const res = await devApiFetch<{ newContainerId: string }>("recreateWritable", { containerId });
  return res.newContainerId;
}

export async function attachVolume(
  containerId: string,
  volumeName: string,
  mountPath?: string,
): Promise<string> {
  if (isElectrobun()) {
    const r = await rpc();
    const res = await r.request.docker_attachVolume({ containerId, volumeName, mountPath });
    return res.newContainerId;
  }
  const res = await devApiFetch<{ newContainerId: string }>("attachVolume", {
    containerId,
    volumeName,
    mountPath,
  });
  return res.newContainerId;
}

// ---------------------------------------------------------------------------
// Terminal operations
// ---------------------------------------------------------------------------

export async function createTerminalSession(
  containerId: string,
  shell?: string,
  cols?: number,
  rows?: number,
  cwd?: string,
  dockerHost?: string | null,
): Promise<{ sessionId: string; shell: string }> {
  const normalizedDockerHost = normalizeDockerHost(dockerHost ?? null);
  if (isElectrobun()) {
    const r = await rpc();
    return await r.request.docker_terminalCreate({
      containerId,
      shell,
      cols,
      rows,
      cwd,
      dockerHost: normalizedDockerHost,
    });
  }
  return await devApiFetch<{ sessionId: string; shell: string }>("terminalCreate", {
    containerId,
    shell,
    cols,
    rows,
    cwd,
    dockerHost: normalizedDockerHost,
  });
}

export async function listLocalShells(): Promise<string[]> {
  if (isElectrobun()) {
    const r = await rpc();
    const res = await r.request.docker_listLocalShells({});
    return res.shells;
  }
  const res = await devApiFetch<{ shells: string[] }>("listLocalShells");
  return res.shells;
}

export async function createLocalTerminalSession(
  shell?: string,
  cols?: number,
  rows?: number,
): Promise<{ sessionId: string; shell: string }> {
  if (isElectrobun()) {
    const r = await rpc();
    return await r.request.docker_terminalCreateLocal({ shell, cols, rows });
  }
  return await devApiFetch<{ sessionId: string; shell: string }>("terminalCreateLocal", {
    shell,
    cols,
    rows,
  });
}

export async function createSshTerminalSession(
  sshHost: string,
  cols?: number,
  rows?: number,
): Promise<{ sessionId: string; shell: string }> {
  if (isElectrobun()) {
    const r = await rpc();
    return await r.request.docker_terminalCreateSsh({ sshHost, cols, rows });
  }
  return await devApiFetch<{ sessionId: string; shell: string }>("terminalCreateSsh", {
    sshHost,
    cols,
    rows,
  });
}

export async function createModelRunnerTerminalSession(
  modelName: string,
  cols?: number,
  rows?: number,
  dockerHost?: string | null,
): Promise<{ sessionId: string; shell: string }> {
  const normalizedDockerHost = normalizeDockerHost(dockerHost ?? null);
  if (isElectrobun()) {
    const r = await rpc();
    return await r.request.docker_terminalCreateModelRun({
      modelName,
      cols,
      rows,
      dockerHost: normalizedDockerHost,
    });
  }
  return await devApiFetch<{ sessionId: string; shell: string }>("terminalCreateModelRun", {
    modelName,
    cols,
    rows,
    dockerHost: normalizedDockerHost,
  });
}

export async function createDockerRunTerminalSession(
  image: string,
  args?: string[],
  cols?: number,
  rows?: number,
  dockerHost?: string | null,
): Promise<{ sessionId: string; shell: string }> {
  const normalizedDockerHost = normalizeDockerHost(dockerHost ?? null);
  if (isElectrobun()) {
    const r = await rpc();
    return await r.request.docker_terminalCreateDockerRun({
      image,
      args: args ?? [],
      cols,
      rows,
      dockerHost: normalizedDockerHost,
    });
  }
  return await devApiFetch<{ sessionId: string; shell: string }>("terminalCreateDockerRun", {
    image,
    args: args ?? [],
    cols,
    rows,
    dockerHost: normalizedDockerHost,
  });
}

export async function createDockerImagePullTerminalSession(
  imageName: string,
  cols?: number,
  rows?: number,
  dockerHost?: string | null,
): Promise<{ sessionId: string; shell: string }> {
  const normalizedDockerHost = normalizeDockerHost(dockerHost ?? null);
  if (isElectrobun()) {
    const r = await rpc();
    return await r.request.docker_terminalCreateImagePull({
      imageName,
      cols,
      rows,
      dockerHost: normalizedDockerHost,
    });
  }
  return await devApiFetch<{ sessionId: string; shell: string }>("terminalCreateImagePull", {
    imageName,
    cols,
    rows,
    dockerHost: normalizedDockerHost,
  });
}

export async function createDockerModelPullTerminalSession(
  modelName: string,
  cols?: number,
  rows?: number,
  dockerHost?: string | null,
): Promise<{ sessionId: string; shell: string }> {
  const normalizedDockerHost = normalizeDockerHost(dockerHost ?? null);
  if (isElectrobun()) {
    const r = await rpc();
    return await r.request.docker_terminalCreateModelPull({
      modelName,
      cols,
      rows,
      dockerHost: normalizedDockerHost,
    });
  }
  return await devApiFetch<{ sessionId: string; shell: string }>("terminalCreateModelPull", {
    modelName,
    cols,
    rows,
    dockerHost: normalizedDockerHost,
  });
}

export async function attachTerminalSession(
  sessionId: string,
  cols?: number,
  rows?: number,
): Promise<{ ok: true; shell: string; recentOutput: string }> {
  if (isElectrobun()) {
    const r = await rpc();
    return await r.request.docker_terminalAttach({ sessionId, cols, rows });
  }
  return await devApiFetch<{ ok: true; shell: string; recentOutput: string }>("terminalAttach", { sessionId, cols, rows });
}

export async function listTerminalSessions(): Promise<TerminalSessionRecord[]> {
  if (isElectrobun()) {
    const r = await rpc();
    const res = await r.request.docker_terminalList({});
    return res.sessions as TerminalSessionRecord[];
  }
  const res = await devApiFetch<{ sessions: TerminalSessionRecord[] }>("terminalList");
  return res.sessions;
}

export async function terminalInput(sessionId: string, data: string): Promise<void> {
  if (isElectrobun()) {
    const r = await rpc();
    await r.request.docker_terminalInput({ sessionId, data });
    return;
  }
  // Prefer WebSocket (fire-and-forget, no HTTP overhead per keystroke)
  if (!sendDevWsMessage({ type: "terminalInput", sessionId, data })) {
    await devApiFetch("terminalInput", { sessionId, data });
  }
}

export async function terminalResize(
  sessionId: string,
  cols: number,
  rows: number,
): Promise<void> {
  if (isElectrobun()) {
    const r = await rpc();
    await r.request.docker_terminalResize({ sessionId, cols, rows });
    return;
  }
  // Prefer WebSocket (fire-and-forget, avoids HTTP overhead on resize)
  if (!sendDevWsMessage({ type: "terminalResize", sessionId, cols, rows })) {
    await devApiFetch("terminalResize", { sessionId, cols, rows });
  }
}

export async function destroyTerminalSession(sessionId: string): Promise<void> {
  if (isElectrobun()) {
    const r = await rpc();
    await r.request.docker_terminalDestroy({ sessionId });
    return;
  }
  await devApiFetch("terminalDestroy", { sessionId });
}

export async function destroyTerminalSessions(sessionIds: string[]): Promise<void> {
  const ids = (sessionIds ?? []).filter(Boolean);
  if (ids.length === 0) return;
  if (isElectrobun()) {
    const r = await rpc();
    await r.request.docker_terminalDestroyMany({ sessionIds: ids });
    return;
  }
  await devApiFetch("terminalDestroyMany", { sessionIds: ids });
}
