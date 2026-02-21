/**
 * Docker CLI wrapper for the Bun native backend.
 * All docker operations shell out to the `docker` CLI and parse JSON output.
 */

import { $ } from "bun";
import { homedir } from "node:os";
import { join, posix as pathPosix } from "node:path";
import { statSync } from "node:fs";
import { CA_HOME_MOUNT_TOKEN } from "../lib/mountTokens";
import {
  createDefaultContainerShell,
  getPrimaryContainerShell,
  parseContainerShellsLabel,
  serializeContainerShellsLabel,
  type ContainerShell,
} from "../lib/containerShells";

let configuredDockerHost: string | null = null;

function normalizeDockerHost(dockerHost: string | null | undefined): string | null {
  const trimmed = typeof dockerHost === "string" ? dockerHost.trim() : "";
  if (!trimmed) return null;
  // Treat bare host values as SSH hosts so legacy settings still route remote.
  if (!trimmed.includes("://")) return `ssh://${trimmed}`;
  return trimmed;
}

export function configureDockerHost(dockerHost: string | null): void {
  configuredDockerHost = normalizeDockerHost(dockerHost);
  if (configuredDockerHost) {
    process.env.DOCKER_HOST = configuredDockerHost;
  } else {
    delete process.env.DOCKER_HOST;
  }
}

function spawnWithDockerEnv(args: string[], options: any): any {
  const env = {
    ...process.env,
    ...(options?.env ?? {}),
  };
  const explicitDockerHost =
    typeof env.DOCKER_HOST === "string" ? env.DOCKER_HOST.trim() : "";
  if (configuredDockerHost) {
    env.DOCKER_HOST = configuredDockerHost;
  } else if (explicitDockerHost.length > 0) {
    env.DOCKER_HOST = explicitDockerHost;
  } else {
    delete env.DOCKER_HOST;
  }
  return Bun.spawn(args, {
    ...options,
    env,
  });
}

function spawnWithoutDockerHost(args: string[], options: any): any {
  const env = {
    ...process.env,
    ...(options?.env ?? {}),
  } as Record<string, string | undefined>;
  delete env.DOCKER_HOST;
  return Bun.spawn(args, {
    ...options,
    env,
  });
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ContainerInfo = {
  id: string;
  name: string;
  image: string;
  state: string; // "running" | "exited" | "created" | "paused" | ...
  status: string; // human-readable, e.g. "Up 2 hours"
  ports: string;
  createdAt: string;
  mounts: string;
  readOnly: boolean;
  rootUser: boolean;
  netHost: boolean;
  hasMappedPorts: boolean;
  dockerSock: boolean;
  sshAgent: boolean;
  containerShells?: ContainerShell[];
  execCommandShell?: string;
  execShellWorkdir?: string;
  composeProject: string;
  networks: string[];
};

export type ContainerStats = {
  containerId: string;
  cpuPercent: string;
  memUsage: string;
  memPercent: string;
  netIO: string;
  blockIO: string;
};

export type PortBinding = { hostIp: string; hostPort: string };

export type ContainerInspect = {
  id: string;
  name: string;
  image: string;
  state: {
    status: string;
    running: boolean;
    startedAt: string;
    finishedAt: string;
  };
  config: {
    env: string[];
    cmd: string[];
    entrypoint: string[] | null;
    /** Effective user for container PID1 (from `docker create --user` or image USER). */
    user: string;
    image: string;
    /** Docker Config.WorkingDir */
    workingDir: string;
    /** Paths declared via Dockerfile `VOLUME` (derived from Config.Volumes). */
    volumes: string[];
    labels: Record<string, string>;
  };
  hostConfig: {
    readOnly: boolean;
    networkMode: string;
    portBindings: Record<string, PortBinding[] | null>;
    gpusAll: boolean;
  };
  mounts: Array<{
    type: string;
    name: string;
    source: string;
    destination: string;
    rw: boolean;
  }>;
  networkSettings: {
    ports: Record<string, PortBinding[] | null>;
  };
};

export type VolumeInfo = {
  name: string;
  driver: string;
  mountpoint: string;
  createdAt: string;
  labels: Record<string, string>;
};

export type ImageInfo = {
  id: string;
  repository: string;
  tag: string;
  size: string;
  createdAt: string;
};

export type NetworkInfo = {
  id: string;
  name: string;
  driver: string;
  scope: string;
  createdAt: string;
};

export type AIModelInfo = {
  name: string;
  id: string;
  size: string;
  modifiedAt: string;
  status: string;
  running: boolean;
};

export type FileEntry = {
  name: string;
  isDirectory: boolean;
  size: number;
  modifiedAt: string;
  permissions: string;
};

export type DockerUploadEntry = {
  relativePath: string;
  kind: "file" | "directory";
  contentBase64?: string;
};

export type CreateContainerOptions = {
  image: string;
  name?: string;
  ports?: Array<{ host: number; container: number; protocol?: string }>;
  env?: Record<string, string>;
  volumes?: Array<{ volume: string; containerPath: string }>;
  command?: string[];
  containerShells?: ContainerShell[];
  /** Optional shell command used for terminal-tab `docker exec` sessions. */
  execCommandShell?: string;
  /** Optional working directory override for terminal-tab `docker exec` sessions. */
  execShellWorkdir?: string;
  /** Container working directory (`docker create -w`). */
  workdir?: string;
  readOnly?: boolean;
  /** If true, mounts tmpfs at /tmp (equivalent to `--tmpfs /tmp:rw`). */
  tmpfsTmp?: boolean;
  mountDockerSocket?: boolean;
  memoryLimit?: string;
  cpuLimit?: string;
  restartPolicy?: string;
  netHost?: boolean;
  gpusAll?: boolean;
  rootUser?: boolean;
  /** Preferred user for terminal sessions (`docker exec -u`). Stored as a container label. */
  execUser?: string;
  sshAgent?: boolean;
  gitConfig?: boolean;
  /** Advanced override for SSH agent socket bind source (resolved on daemon host). */
  sshAgentHostSocketPath?: string;
  /** Advanced override for gitconfig bind source (resolved on daemon host). */
  gitConfigHostPath?: string;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function runDockerAvailabilityProbe(
  args: string[],
  opts: { useDockerHostEnv: boolean; timeoutMs: number },
): Promise<boolean> {
  const proc = opts.useDockerHostEnv
    ? spawnWithDockerEnv(args, { stdout: "pipe", stderr: "pipe" })
    : spawnWithoutDockerHost(args, { stdout: "pipe", stderr: "pipe" });
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  try {
    const exitPromise = proc.exited
      .then((exitCode: number) => ({ timedOut: false as const, exitCode }))
      .catch(() => ({ timedOut: false as const, exitCode: -1 }));
    const timeoutPromise = new Promise<{ timedOut: true; exitCode: null }>((resolve) => {
      timeoutHandle = setTimeout(() => {
        try {
          proc.kill();
        } catch {
          // ignore
        }
        resolve({ timedOut: true, exitCode: null });
      }, opts.timeoutMs);
    });
    const result = await Promise.race([exitPromise, timeoutPromise]);
    if (timeoutHandle) clearTimeout(timeoutHandle);
    return !result.timedOut && result.exitCode === 0;
  } catch {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    try {
      proc.kill();
    } catch {
      // ignore
    }
    return false;
  }
}

export async function dockerAvailable(): Promise<boolean> {
  try {
    const defaultOk = await runDockerAvailabilityProbe(
      ["docker", "info", "--format", "{{.ID}}"],
      { useDockerHostEnv: true, timeoutMs: 6000 },
    );
    if (defaultOk) return true;

    // Some SSH-backed Docker setups fail `DOCKER_HOST=ssh://... docker info`
    // while direct SSH invocations still work (matching docker model behavior).
    const sshHost = parseConfiguredSshDockerHost();
    if (!sshHost) return false;
    const sshArgs = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=4"];
    if (sshHost.port) sshArgs.push("-p", sshHost.port);
    sshArgs.push(sshHost.target, "docker", "info", "--format", "{{.ID}}");
    return await runDockerAvailabilityProbe(sshArgs, { useDockerHostEnv: false, timeoutMs: 6000 });
  } catch {
    return false;
  }
}

function parseJsonLines<T>(output: string): T[] {
  return output
    .trim()
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as T);
}

function parseConfiguredSshDockerHost(dockerHostOverride?: string | null): { target: string; port: string | null } | null {
  const effectiveDockerHost =
    normalizeDockerHost(dockerHostOverride ?? null)
    ?? configuredDockerHost;
  if (!effectiveDockerHost || !effectiveDockerHost.startsWith("ssh://")) return null;
  try {
    const parsed = new URL(effectiveDockerHost);
    if (parsed.protocol !== "ssh:") return null;
    const host = parsed.hostname;
    if (!host) return null;
    const user = parsed.username ? decodeURIComponent(parsed.username) : "";
    return {
      target: user ? `${user}@${host}` : host,
      port: parsed.port || null,
    };
  } catch {
    return null;
  }
}

function rewriteDockerModelCommandForSsh(
  args: string[],
  opts?: { forceTty?: boolean },
  dockerHostOverride?: string | null,
): string[] {
  const sshHost = parseConfiguredSshDockerHost(dockerHostOverride);
  if (!sshHost) return args;
  if (args.length < 3 || args[0] !== "docker" || args[1] !== "model") return args;
  const sshArgs = ["ssh"];
  if (opts?.forceTty) sshArgs.push("-tt");
  if (sshHost.port) sshArgs.push("-p", sshHost.port);
  sshArgs.push(sshHost.target, "docker", "model", ...args.slice(2));
  return sshArgs;
}

function parseConfiguredSshOllamaHost(ollamaHost?: string | null): { target: string; port: string | null } | null {
  const configuredOllamaHost = (typeof ollamaHost === "string" ? ollamaHost : process.env.OLLAMA_HOST ?? "").trim();
  if (!configuredOllamaHost.startsWith("ssh://")) return null;
  try {
    const parsed = new URL(configuredOllamaHost);
    if (parsed.protocol !== "ssh:") return null;
    const host = parsed.hostname;
    if (!host) return null;
    const user = parsed.username ? decodeURIComponent(parsed.username) : "";
    return {
      target: user ? `${user}@${host}` : host,
      port: parsed.port || null,
    };
  } catch {
    return null;
  }
}

function parseSshTarget(sshHost: string): { target: string; port: string | null } | null {
  const trimmed = sshHost.trim();
  if (!trimmed) return null;
  if (!trimmed.startsWith("ssh://")) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "ssh:") return null;
    const host = parsed.hostname;
    if (!host) return null;
    const user = parsed.username ? decodeURIComponent(parsed.username) : "";
    return {
      target: user ? `${user}@${host}` : host,
      port: parsed.port || null,
    };
  } catch {
    return null;
  }
}

function rewriteOllamaCommandForSsh(
  args: string[],
  opts?: { forceTty?: boolean },
  ollamaHost?: string | null,
): string[] {
  const sshHost = parseConfiguredSshOllamaHost(ollamaHost);
  if (!sshHost) return args;
  if (args.length < 2 || args[0] !== "ollama") return args;
  const sshArgs = ["ssh"];
  if (opts?.forceTty) sshArgs.push("-tt");
  if (sshHost.port) sshArgs.push("-p", sshHost.port);
  sshArgs.push(sshHost.target, "ollama", ...args.slice(1));
  return sshArgs;
}

async function runDockerCommand(
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const rewritten = rewriteDockerModelCommandForSsh(args);
  const useDockerHostEnv = rewritten === args;
  const proc = useDockerHostEnv
    ? spawnWithDockerEnv(rewritten, { stdout: "pipe", stderr: "pipe" })
    : spawnWithoutDockerHost(rewritten, { stdout: "pipe", stderr: "pipe" });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { exitCode, stdout, stderr };
}

function parseAiModelRows(output: string): Record<string, unknown>[] {
  const trimmed = output.trim();
  if (!trimmed) return [];

  let rows: Record<string, unknown>[] = [];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) {
      rows = parsed.filter((v): v is Record<string, unknown> => Boolean(v && typeof v === "object"));
    } else if (parsed && typeof parsed === "object") {
      const nested = (parsed as { models?: unknown }).models;
      if (Array.isArray(nested)) {
        rows = nested.filter((v): v is Record<string, unknown> => Boolean(v && typeof v === "object"));
      } else {
        rows = [parsed as Record<string, unknown>];
      }
    }
  } catch {
    // Some Docker versions emit JSON lines instead of a single JSON document.
    rows = parseJsonLines<Record<string, unknown>>(trimmed);
  }

  return rows;
}

function mapAiModelRows(rows: Record<string, unknown>[]): AIModelInfo[] {
  return rows.map((m) => {
    const tags = Array.isArray(m.tags)
      ? m.tags.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
      : [];
    const config = (m.config && typeof m.config === "object") ? (m.config as Record<string, unknown>) : undefined;
    const created = m.created ?? m.createdAt ?? m.CreatedAt;
    const createdIso =
      typeof created === "number"
        ? new Date(created * 1000).toISOString()
        : (typeof created === "string" && created.trim().length > 0 ? created : "");

    const status = String(m.status ?? m.Status ?? "");
    const running = /\brunning\b/i.test(status);

    return {
      // Docker model JSON commonly exposes tags instead of a top-level name.
      name: String(m.name ?? m.Name ?? m.model ?? m.Model ?? tags[0] ?? m.id ?? m.ID ?? ""),
      id: String(m.id ?? m.ID ?? ""),
      size: String(m.size ?? m.Size ?? config?.size ?? config?.Size ?? ""),
      modifiedAt: String(m.modifiedAt ?? m.ModifiedAt ?? createdIso),
      status,
      running,
    };
  });
}

function normalizeAiModelName(name: string): string {
  return (name ?? "").trim().toLowerCase();
}

function aiModelNameAliases(name: string): Set<string> {
  const out = new Set<string>();
  const normalized = normalizeAiModelName(name);
  if (!normalized) return out;
  out.add(normalized);

  // Full ref -> leaf (`docker.io/ai/smollm2:latest` -> `smollm2:latest`)
  const leaf = normalized.includes("/") ? normalized.slice(normalized.lastIndexOf("/") + 1) : normalized;
  if (leaf) out.add(leaf);

  // Tagless variants (`smollm2:latest` -> `smollm2`)
  const stripTag = (value: string) => {
    const idx = value.lastIndexOf(":");
    // Keep digest-style refs (`@sha256:...`) intact; strip only simple tags.
    if (idx > -1 && !value.includes("@")) return value.slice(0, idx);
    return value;
  };
  const normalizedTagless = stripTag(normalized);
  const leafTagless = stripTag(leaf);
  if (normalizedTagless) out.add(normalizedTagless);
  if (leafTagless) out.add(leafTagless);

  return out;
}

async function listRunningAiModelNames(): Promise<Set<string>> {
  const running = new Set<string>();
  const result = await runDockerCommand(["docker", "model", "ps"]);
  if (result.exitCode !== 0) return running;
  const lines = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  // Expected format:
  // MODEL NAME  BACKEND    MODE        LAST USED
  // smollm2     llama.cpp  completion  45 seconds ago
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (!line || /^no running models/i.test(line)) continue;
    const modelName = line.split(/\s+/)[0] ?? "";
    for (const alias of aiModelNameAliases(modelName)) {
      running.add(alias);
    }
  }
  return running;
}

function markRunningAiModels(models: AIModelInfo[], runningNames: Set<string>): AIModelInfo[] {
  if (runningNames.size === 0) return models;
  return models.map((model) => {
    const aliases = aiModelNameAliases(model.name);
    const isRunning = Array.from(aliases).some((alias) => runningNames.has(alias));
    if (!isRunning) return model;
    return { ...model, running: true };
  });
}

async function listAiModelsFromRunnerMetadata(): Promise<AIModelInfo[] | null> {
  const runnerResult = await runDockerCommand([
    "docker",
    "ps",
    "--filter",
    "name=docker-model-runner",
    "--format",
    "{{.ID}}",
  ]);
  if (runnerResult.exitCode !== 0) return null;

  const runnerId = runnerResult.stdout.trim().split("\n").find((line) => line.trim().length > 0)?.trim();
  if (!runnerId) return null;

  const metadataResult = await runDockerCommand([
    "docker",
    "exec",
    runnerId,
    "cat",
    "/models/models.json",
  ]);
  if (metadataResult.exitCode !== 0) return null;

  const rows = parseAiModelRows(metadataResult.stdout.toString());
  const normalized: Record<string, unknown>[] = [];
  for (const row of rows) {
    const tags = Array.isArray(row.tags)
      ? row.tags.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
      : [];
    if (tags.length === 0) {
      normalized.push(row);
      continue;
    }
    for (const tag of tags) {
      normalized.push({ ...row, tags: [tag], name: tag, status: "downloaded" });
    }
  }
  return mapAiModelRows(normalized);
}

function isSocketPath(path: string): boolean {
  try {
    return statSync(path).isSocket();
  } catch {
    return false;
  }
}

function resolveHostDockerSocket(): string {
  const dockerHost = process.env.DOCKER_HOST;
  if (dockerHost && dockerHost.startsWith("ssh://")) {
    // For remote SSH Docker hosts, bind sources are resolved on the remote daemon host.
    // Prefer the canonical remote socket path used by dockerd.
    return "/var/run/docker.sock";
  }
  if (dockerHost && dockerHost.startsWith("unix://")) {
    const candidate = dockerHost.slice("unix://".length);
    if (candidate && isSocketPath(candidate)) return candidate;
  }

  const candidates =
    process.platform === "darwin"
      ? ["/var/run/docker.sock", join(homedir(), ".docker/run/docker.sock")]
      : ["/var/run/docker.sock"];

  for (const c of candidates) {
    if (isSocketPath(c)) return c;
  }

  throw new Error(
    `Docker socket not found. Tried ${candidates.join(", ")}. ` +
      `Start Docker Desktop (or dockerd) or set DOCKER_HOST=unix:///path/to/docker.sock.`,
  );
}

/**
 * Detect the configured user for a Docker image (the USER directive).
 * Returns empty string if the image isn't available locally or has no user set.
 */
async function detectImageUser(image: string): Promise<string> {
  try {
    const result =
      await $`docker image inspect ${image} --format ${"{{.Config.User}}"}`.quiet().nothrow();
    if (result.exitCode === 0) {
      return result.stdout.toString().trim();
    }
  } catch {
    // image not available locally
  }
  return "";
}

/**
 * Scan a Docker image's /etc/passwd for the first regular user (UID >= 1000).
 * Uses `docker run --rm` to inspect the image filesystem.
 * Returns { user, homeDir } or null if no regular user is found.
 */
async function detectImageNonRootUser(
  image: string,
): Promise<{ user: string; homeDir: string } | null> {
  try {
    const proc = spawnWithDockerEnv(
      [
        "docker", "run", "--rm", "--entrypoint", "", image,
        "awk", "-F:", "{if($3>=1000 && $3<65534){print $1\":\"$6; exit}}", "/etc/passwd",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    if (exitCode === 0 && stdout.trim()) {
      const [user, homeDir] = stdout.trim().split(":");
      if (user && homeDir && homeDir.startsWith("/")) {
        return { user, homeDir };
      }
    }
  } catch {
    // image not available or awk not present
  }
  return null;
}

/**
 * Scan a running container's /etc/passwd for the first regular user (UID >= 1000).
 * Returns { user, homeDir } or null if no regular user is found.
 */
async function detectContainerNonRootUser(
  containerId: string,
): Promise<{ user: string; homeDir: string } | null> {
  try {
    const result = await containerExec(containerId, [
      "awk", "-F:", "{if($3>=1000 && $3<65534){print $1\":\"$6; exit}}", "/etc/passwd",
    ]);
    if (result.exitCode === 0 && result.stdout.trim()) {
      const [user, homeDir] = result.stdout.trim().split(":");
      if (user && homeDir && homeDir.startsWith("/")) {
        return { user, homeDir };
      }
    }
  } catch {
    // detection failed
  }
  return null;
}

type PasswdUser = { name: string; uid: number; homeDir: string; shell: string };

function parsePasswdUsers(passwd: string): PasswdUser[] {
  const out: PasswdUser[] = [];
  for (const line of passwd.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    // /etc/passwd format: name:pw:uid:gid:gecos:home:shell
    const parts = trimmed.split(":");
    if (parts.length < 7) continue;
    const name = parts[0] ?? "";
    const uid = Number(parts[2] ?? "");
    const homeDir = parts[5] ?? "";
    const shell = parts[6] ?? "";
    if (!name) continue;
    out.push({
      name,
      uid: Number.isFinite(uid) ? uid : -1,
      homeDir,
      shell,
    });
  }
  return out;
}

/**
 * Determine the home directory path for a given user.
 */
function getHomeDir(user: string): string {
  if (!user || user === "root" || user === "0") return "/root";
  // Numeric UID — can't easily determine home, default to /root
  if (/^\d+$/.test(user)) return "/root";
  return `/home/${user}`;
}

async function readImagePasswd(image: string): Promise<string> {
  const trimmed = image.trim();
  if (!trimmed) return "";
  // Run `cat /etc/passwd` with an empty entrypoint so we don't start the image's default process.
  const proc = spawnWithDockerEnv(
    ["docker", "run", "--rm", "--entrypoint", "", trimmed, "cat", "/etc/passwd"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  if (exitCode !== 0) {
    throw new Error(`Failed to read /etc/passwd from image: ${stderr.trim() || "docker run failed"}`);
  }
  return stdout;
}

async function detectImageUserHomeDir(image: string, user: string): Promise<string | null> {
  const u = (user ?? "").trim();
  if (!u || u === "root" || u === "0" || /^\d+$/.test(u)) return null;
  try {
    const passwd = await readImagePasswd(image);
    const users = parsePasswdUsers(passwd);
    const match = users.find((x) => x.name === u);
    if (match?.homeDir && match.homeDir.startsWith("/")) return match.homeDir;
  } catch {
    // ignore
  }
  return null;
}

/**
 * Determine the home directory for the appropriate user of a Docker image,
 * based on the rootUser preference. Checks the image USER directive first,
 * then scans /etc/passwd inside the image for regular users (UID >= 1000).
 */
async function getImageHomeDir(image: string, rootUser: boolean, execUser?: string): Promise<string> {
  if (rootUser) return "/root";

  // If an explicit exec user is provided, prefer its home directory.
  const explicit = (execUser ?? "").trim();
  if (explicit && explicit !== "root" && explicit !== "0") {
    const home = await detectImageUserHomeDir(image, explicit);
    if (home) return home;
    return getHomeDir(explicit);
  }

  // 1. Check image USER directive
  const user = await detectImageUser(image);
  if (user && user !== "root" && user !== "0") return getHomeDir(user);

  // 2. Scan the image's /etc/passwd for regular users
  const nonRoot = await detectImageNonRootUser(image);
  if (nonRoot) return nonRoot.homeDir;

  return "/root";
}

/**
 * Determine which user to exec as inside a container, based on the
 * `context-assistant.root-user` label. When the label is "false", we
 * detect the image's configured user. If the image has no USER directive,
 * we scan /etc/passwd for regular users (UID >= 1000), falling back to root.
 */
async function getContainerExecUser(containerId: string): Promise<string> {
  try {
    const info = await inspectContainer(containerId);
    const rootUserLabel = info.config.labels?.["context-assistant.root-user"];
    const execUserLabel = info.config.labels?.["context-assistant.exec-user"];

    // Explicit override: if set, always honor it.
    if (execUserLabel && execUserLabel.trim()) {
      const v = execUserLabel.trim();
      return v;
    }

    // If the container itself is configured with a user, honor it.
    const configured = (info.config.user ?? "").trim();
    if (configured) {
      return configured === "0" ? "root" : configured;
    }

    // If label is missing or "true", use root
    if (!rootUserLabel || rootUserLabel === "true") return "root";

    // rootUser=false: detect image's configured user
    const imageUser = await detectImageUser(info.config.image || info.image);
    if (imageUser && imageUser !== "root" && imageUser !== "0") return imageUser;

    // Image USER is root/empty — scan /etc/passwd for regular users
    const nonRoot = await detectContainerNonRootUser(containerId);
    if (nonRoot) return nonRoot.user;

    return "root"; // fallback
  } catch {
    return "root";
  }
}

async function getContainerExecShellCommand(containerId: string): Promise<string | null> {
  try {
    const info = await inspectContainer(containerId);
    const configuredShell = getPrimaryContainerShell({
      containerShells: parseContainerShellsLabel(info.config.labels?.["context-assistant.exec-shells"]),
      execCommandShell: String(info.config.labels?.["context-assistant.exec-shell"] ?? "").trim(),
    });
    return configuredShell?.command ?? null;
  } catch {
    return null;
  }
}

async function getContainerExecShellWorkdir(containerId: string): Promise<string | null> {
  try {
    const info = await inspectContainer(containerId);
    const workdir = String(info.config.labels?.["context-assistant.exec-workdir"] ?? "").trim();
    return workdir || null;
  } catch {
    return null;
  }
}

function isEntrypointCleared(entrypoint: string[] | null): boolean {
  return (
    entrypoint == null ||
    (Array.isArray(entrypoint) && entrypoint.length === 0) ||
    (Array.isArray(entrypoint) && entrypoint.length === 1 && entrypoint[0] === "")
  );
}

// ---------------------------------------------------------------------------
// Container operations
// ---------------------------------------------------------------------------

export async function listContainers(): Promise<ContainerInfo[]> {
  const result =
    await $`docker ps -a --format '{"id":"{{.ID}}","name":"{{.Names}}","image":"{{.Image}}","state":"{{.State}}","status":"{{.Status}}","ports":"{{.Ports}}","createdAt":"{{.CreatedAt}}","mounts":"{{.Mounts}}"}'`.quiet().nothrow();
  if (result.exitCode !== 0) {
    throw new Error(`docker ps failed: ${result.stderr.toString()}`);
  }
  const output = result.stdout.toString();
  if (!output.trim()) return [];
  const containers = parseJsonLines<Omit<
    ContainerInfo,
    "readOnly" | "rootUser" | "netHost" | "hasMappedPorts" | "dockerSock" | "sshAgent" | "composeProject" | "networks"
  >>(output);
  if (containers.length === 0) return [];

  // Batch-inspect to get flags in a single call
  const ids = containers.map((c) => c.id);
  const inspectResult = await $`docker inspect ${ids}`.quiet().nothrow();

  const flagsById = new Map<
    string,
    Pick<ContainerInfo, "readOnly" | "rootUser" | "netHost" | "hasMappedPorts" | "dockerSock" | "sshAgent" | "containerShells" | "execCommandShell" | "execShellWorkdir" | "composeProject" | "networks">
  >();

  if (inspectResult.exitCode === 0) {
    try {
      const parsed = JSON.parse(inspectResult.stdout.toString()) as any[];
      for (const info of parsed ?? []) {
        const fullId = String(info?.Id ?? info?.ID ?? "");
        if (!fullId) continue;
        const id = fullId.slice(0, 12);

        const labels: Record<string, string> = (info?.Config?.Labels ?? {}) as any;
        const rootUserLabel = labels["context-assistant.root-user"];
        const execUserLabel = labels["context-assistant.exec-user"];
        const containerShells = parseContainerShellsLabel(labels["context-assistant.exec-shells"]);
        const execShellLabel = String(labels["context-assistant.exec-shell"] ?? "").trim();
        const execShellWorkdirLabel = String(labels["context-assistant.exec-workdir"] ?? "").trim();
        const dockerSockLabel = labels["context-assistant.docker-sock"];
        const sshAgentLabel = labels["context-assistant.ssh-agent"];
        const composeProject = String(labels["com.docker.compose.project"] ?? "").trim();
        const configuredUser = String(info?.Config?.User ?? "").trim();

        const mounts = (info?.Mounts ?? []) as Array<{ Destination?: string; Source?: string }>;
        const dockerSockMounted =
          dockerSockLabel === "true" ||
          mounts.some((m) => {
            const dest = typeof m?.Destination === "string" ? m.Destination : "";
            const src = typeof m?.Source === "string" ? m.Source : "";
            return dest === "/var/run/docker.sock" || src.includes("docker.sock");
          });

        const networkMode = String(info?.HostConfig?.NetworkMode ?? "");
        const netHost = networkMode === "host";

        const portsRaw = (info?.NetworkSettings?.Ports ?? info?.HostConfig?.PortBindings ?? null) as
          | Record<string, unknown>
          | null;
        const networksRaw = (info?.NetworkSettings?.Networks ?? null) as Record<string, unknown> | null;
        const networks = networksRaw && typeof networksRaw === "object"
          ? Object.keys(networksRaw)
          : [];
        let hasMappedPorts = false;
        if (portsRaw && typeof portsRaw === "object") {
          for (const v of Object.values(portsRaw)) {
            if (Array.isArray(v) && v.length > 0) {
              hasMappedPorts = true;
              break;
            }
          }
        }

        const isRootConfigured =
          configuredUser === "root" ||
          configuredUser === "0" ||
          configuredUser === "0:0" ||
          configuredUser === "root:root" ||
          configuredUser.startsWith("0:");

        flagsById.set(id, {
          readOnly: Boolean(info?.HostConfig?.ReadonlyRootfs),
          rootUser: execUserLabel
            ? execUserLabel.trim() === "root" || execUserLabel.trim() === "0"
            : configuredUser
              ? isRootConfigured
              : rootUserLabel !== "false",
          netHost,
          hasMappedPorts,
          dockerSock: dockerSockMounted,
          sshAgent: sshAgentLabel === "true",
          containerShells: containerShells.length > 0
            ? containerShells
            : (execShellLabel ? [createDefaultContainerShell(execShellLabel)] : undefined),
          execCommandShell: getPrimaryContainerShell({
            containerShells,
            execCommandShell: execShellLabel,
          })?.command,
          execShellWorkdir: execShellWorkdirLabel || undefined,
          composeProject,
          networks,
        });
      }
    } catch {
      // ignore parse failures; fall back to defaults below
    }
  }

  return containers.map((c) => {
    const flags = flagsById.get(c.id);
    const portsStr = typeof c.ports === "string" ? c.ports.trim() : "";
    return {
      ...c,
      readOnly: flags?.readOnly ?? false,
      rootUser: flags?.rootUser ?? true,
      netHost: flags?.netHost ?? false,
      hasMappedPorts: flags?.hasMappedPorts ?? Boolean(portsStr),
      dockerSock: flags?.dockerSock ?? false,
      sshAgent: flags?.sshAgent ?? false,
      containerShells: flags?.containerShells,
      execCommandShell: flags?.execCommandShell,
      execShellWorkdir: flags?.execShellWorkdir,
      composeProject: flags?.composeProject ?? "",
      networks: flags?.networks ?? [],
    };
  });
}

export async function createContainer(options: CreateContainerOptions): Promise<string> {
  const args: string[] = ["docker", "create"];

  if (options.name) {
    args.push("--name", options.name);
  }

  if (options.workdir) {
    args.push("-w", options.workdir);
  }

  if (options.readOnly) {
    args.push("--read-only");
  }

  if (options.tmpfsTmp) {
    args.push("--tmpfs", "/tmp:rw");
  }

  if (options.mountDockerSocket) {
    const hostSocket = resolveHostDockerSocket();
    const containerSocket = "/var/run/docker.sock";
    args.push("-v", `${hostSocket}:${containerSocket}`);
    args.push("-e", `DOCKER_HOST=unix://${containerSocket}`);
    args.push("--label", "context-assistant.docker-sock=true");
  }

  if (options.netHost) {
    args.push("--net=host");
  }

  if (options.gpusAll) {
    args.push("--gpus=all");
  }

  // Store rootUser preference as a container label
  const rootUser = options.rootUser !== false;
  args.push("--label", `context-assistant.root-user=${rootUser}`);

  const execUser = typeof options.execUser === "string" ? options.execUser.trim() : "";
  if (execUser) {
    args.push("--label", `context-assistant.exec-user=${execUser}`);
  }
  const containerShellsLabel = serializeContainerShellsLabel(options.containerShells);
  if (containerShellsLabel) {
    args.push("--label", `context-assistant.exec-shells=${containerShellsLabel}`);
  }
  const execCommandShell =
    getPrimaryContainerShell({
      containerShells: options.containerShells,
      execCommandShell: options.execCommandShell,
    })?.command ?? "";
  if (execCommandShell) {
    args.push("--label", `context-assistant.exec-shell=${execCommandShell}`);
  }
  const execShellWorkdir =
    typeof options.execShellWorkdir === "string" ? options.execShellWorkdir.trim() : "";
  if (execShellWorkdir) {
    args.push("--label", `context-assistant.exec-workdir=${execShellWorkdir}`);
  }

  // Configure the container's primary user as well (PID 1).
  // We keep root as the implicit default if no user is set.
  if (execUser && execUser !== "root" && execUser !== "0") {
    args.push("--user", execUser);
  }

  // Port mappings are ignored by Docker when host networking is active
  if (options.ports && !options.netHost) {
    for (const port of options.ports) {
      const proto = port.protocol ?? "tcp";
      args.push("-p", `${port.host}:${port.container}/${proto}`);
    }
  }

  if (options.env) {
    for (const [key, value] of Object.entries(options.env)) {
      args.push("-e", `${key}=${value}`);
    }
  }

  const normalizeContainerPath = (p: string): string => {
    const trimmed = (p ?? "").trim();
    if (!trimmed.startsWith("/")) return trimmed;
    if (trimmed === "/") return "/";
    // Docker treats `/foo` and `/foo/` as the same mount target.
    return trimmed.replace(/\/+$/, "");
  };

  // Compute the effective home directory for this image/user combo.
  // Used for:
  // - resolving CA_HOME_MOUNT_TOKEN → actual home dir
  // - binding host ~/.gitconfig
  const homeDir = await getImageHomeDir(options.image, rootUser, execUser);
  const normalizedHomeDir = normalizeContainerPath(homeDir);

  // Bind host ~/.gitconfig into the container (read-only)
  if (options.gitConfig) {
    const hostGitConfig =
      (typeof options.gitConfigHostPath === "string" && options.gitConfigHostPath.trim().length > 0)
        ? options.gitConfigHostPath.trim()
        : join(homedir(), ".gitconfig");
    const exists = await Bun.file(hostGitConfig).exists();
    const configuredRemoteHost = (process.env.DOCKER_HOST ?? "").trim();
    const isRemoteDockerHost = configuredRemoteHost.startsWith("ssh://") || configuredRemoteHost.startsWith("tcp://");
    if (!exists && !isRemoteDockerHost) {
      throw new Error(
        `Host ~/.gitconfig not found at ${hostGitConfig}. Disable "Bind host .gitconfig" or create the file.`,
      );
    }
    args.push("-v", `${hostGitConfig}:${homeDir}/.gitconfig:ro`);
    args.push("--label", "context-assistant.gitconfig=true");
    if (typeof options.gitConfigHostPath === "string" && options.gitConfigHostPath.trim().length > 0) {
      args.push("--label", `context-assistant.gitconfig-source=${options.gitConfigHostPath.trim()}`);
    }
  }

  // SSH agent forwarding — mount the host's SSH agent socket into the container
  if (options.sshAgent) {
    const containerSocket = "/run/host-services/ssh-auth.sock";
    const configuredRemoteHost = (process.env.DOCKER_HOST ?? "").trim();
    const isRemoteDockerHost = configuredRemoteHost.startsWith("ssh://") || configuredRemoteHost.startsWith("tcp://");
    // Local Docker Desktop on macOS expects /run/host-services/ssh-auth.sock as bind
    // source on the daemon host (Linux VM), not the launchd SSH_AUTH_SOCK path.
    // For remote daemons (ssh://, tcp://) and non-macOS hosts, prefer SSH_AUTH_SOCK.
    const envSocket = (process.env.SSH_AUTH_SOCK ?? "").trim();
    const hostSocket =
      (typeof options.sshAgentHostSocketPath === "string" && options.sshAgentHostSocketPath.trim().length > 0)
        ? options.sshAgentHostSocketPath.trim()
        : (
          (process.platform === "darwin" && !isRemoteDockerHost)
            ? "/run/host-services/ssh-auth.sock"
            : (envSocket || undefined)
        );

    if (hostSocket) {
      args.push("-v", `${hostSocket}:${containerSocket}`);
      args.push("-e", `SSH_AUTH_SOCK=${containerSocket}`);
      if (typeof options.sshAgentHostSocketPath === "string" && options.sshAgentHostSocketPath.trim().length > 0) {
        args.push("--label", `context-assistant.ssh-agent-source=${options.sshAgentHostSocketPath.trim()}`);
      }
    }
    args.push("--label", "context-assistant.ssh-agent=true");
  }

  // User-defined mounts
  if (options.volumes) {
    for (const vol of options.volumes) {
      const rawTarget = (vol.containerPath ?? "").trim();
      const resolvedTarget =
        rawTarget === CA_HOME_MOUNT_TOKEN ? normalizedHomeDir : normalizeContainerPath(rawTarget);
      if (!vol.volume?.trim() || !resolvedTarget) continue;
      args.push("-v", `${vol.volume.trim()}:${resolvedTarget}`);
    }
  }

  if (options.memoryLimit) {
    args.push("--memory", options.memoryLimit);
  }

  if (options.cpuLimit) {
    args.push("--cpus", options.cpuLimit);
  }

  if (options.restartPolicy) {
    args.push("--restart", options.restartPolicy);
  }

  // If the user provides a command override (e.g. "sleep infinity"), we must clear
  // the image ENTRYPOINT so the override keeps the container running.
  if (options.command && options.command.length > 0) {
    args.push("--entrypoint", "");
  }

  args.push(options.image);

  if (options.command && options.command.length > 0) {
    args.push(...options.command);
  }

  const proc = spawnWithDockerEnv(args, { stdout: "pipe", stderr: "pipe" });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();

  if (exitCode !== 0) {
    throw new Error(`docker create failed: ${stderr.trim()}`);
  }

  return stdout.trim().slice(0, 12); // short ID to match listContainers
}

export async function startContainer(containerId: string): Promise<void> {
  const result = await $`docker start ${containerId}`.quiet().nothrow();
  if (result.exitCode !== 0) {
    throw new Error(`docker start failed: ${result.stderr.toString()}`);
  }
}

export async function stopContainer(containerId: string): Promise<void> {
  // Use -t 3 to reduce the grace period (default is 10s which can cause RPC timeouts)
  const result = await $`docker stop -t 3 ${containerId}`.quiet().nothrow();
  if (result.exitCode !== 0) {
    throw new Error(`docker stop failed: ${result.stderr.toString()}`);
  }
}

export async function removeContainer(containerId: string, force = false): Promise<void> {
  const args = force ? ["-f"] : [];
  const result = await $`docker rm ${args} ${containerId}`.quiet().nothrow();
  if (result.exitCode !== 0) {
    throw new Error(`docker rm failed: ${result.stderr.toString()}`);
  }
}

export async function inspectContainer(containerId: string): Promise<ContainerInspect> {
  const result = await $`docker inspect ${containerId}`.quiet().nothrow();
  if (result.exitCode !== 0) {
    throw new Error(`docker inspect failed: ${result.stderr.toString()}`);
  }
  const parsed = JSON.parse(result.stdout.toString()) as any[];
  const info = parsed[0];
  if (!info) throw new Error("Container not found");

  const hasGpuDeviceRequest = Array.isArray(info.HostConfig?.DeviceRequests)
    ? info.HostConfig.DeviceRequests.some((request: any) => {
        const caps = Array.isArray(request?.Capabilities) ? request.Capabilities : [];
        return caps.some(
          (group: any) => Array.isArray(group) && group.some((cap: any) => String(cap).toLowerCase() === "gpu"),
        );
      })
    : false;
  const gpusAll = hasGpuDeviceRequest || String(info.HostConfig?.Runtime ?? "").toLowerCase() === "nvidia";

  const mapPortBindings = (
    raw: Record<string, any[] | null> | undefined,
  ): Record<string, PortBinding[] | null> => {
    if (!raw) return {};
    const mapped: Record<string, PortBinding[] | null> = {};
    for (const [key, bindings] of Object.entries(raw)) {
      if (!bindings) {
        mapped[key] = null;
        continue;
      }
      mapped[key] = bindings.map((b: any) => ({
        hostIp: b.HostIp ?? b.hostIp ?? "",
        hostPort: b.HostPort ?? b.hostPort ?? "",
      }));
    }
    return mapped;
  };

  return {
    id: info.Id ?? "",
    name: (info.Name ?? "").replace(/^\//, ""),
    image: info.Config?.Image ?? "",
    state: {
      status: info.State?.Status ?? "",
      running: Boolean(info.State?.Running),
      startedAt: info.State?.StartedAt ?? "",
      finishedAt: info.State?.FinishedAt ?? "",
    },
    config: {
      env: info.Config?.Env ?? [],
      cmd: info.Config?.Cmd ?? [],
      entrypoint: info.Config?.Entrypoint ?? null,
      user: info.Config?.User ?? "",
      image: info.Config?.Image ?? "",
      workingDir: info.Config?.WorkingDir ?? "",
      volumes: Object.keys(info.Config?.Volumes ?? {}),
      labels: info.Config?.Labels ?? {},
    },
    hostConfig: {
      readOnly: Boolean(info.HostConfig?.ReadonlyRootfs),
      networkMode: info.HostConfig?.NetworkMode ?? "",
      portBindings: mapPortBindings(info.HostConfig?.PortBindings),
      gpusAll,
    },
    mounts: (info.Mounts ?? []).map((m: any) => ({
      type: m.Type ?? "",
      name: m.Name ?? "",
      source: m.Source ?? "",
      destination: m.Destination ?? "",
      rw: m.RW ?? false,
    })),
    networkSettings: {
      ports: mapPortBindings(info.NetworkSettings?.Ports),
    },
  };
}

export async function getContainerStats(containerId: string): Promise<ContainerStats> {
  const result =
    await $`docker stats ${containerId} --no-stream --format '{"containerId":"{{.Container}}","cpuPercent":"{{.CPUPerc}}","memUsage":"{{.MemUsage}}","memPercent":"{{.MemPerc}}","netIO":"{{.NetIO}}","blockIO":"{{.BlockIO}}"}'`.quiet().nothrow();
  if (result.exitCode !== 0) {
    throw new Error(`docker stats failed: ${result.stderr.toString()}`);
  }
  const output = result.stdout.toString().trim();
  if (!output) throw new Error("No stats output");
  return JSON.parse(output) as ContainerStats;
}

export async function getContainerLogs(
  containerId: string,
  tail = 200,
): Promise<string> {
  const result = await $`docker logs --tail ${tail} ${containerId}`.quiet().nothrow();
  if (result.exitCode !== 0) {
    throw new Error(`docker logs failed: ${result.stderr.toString()}`);
  }
  // Combine stdout and stderr (docker logs sends both)
  return result.stdout.toString() + result.stderr.toString();
}

// ---------------------------------------------------------------------------
// Volume operations
// ---------------------------------------------------------------------------

export async function listVolumes(): Promise<VolumeInfo[]> {
  const result =
    await $`docker volume ls --format '{"name":"{{.Name}}","driver":"{{.Driver}}","mountpoint":"{{.Mountpoint}}","labels":"{{.Labels}}"}'`.quiet().nothrow();
  if (result.exitCode !== 0) {
    throw new Error(`docker volume ls failed: ${result.stderr.toString()}`);
  }
  const output = result.stdout.toString();
  if (!output.trim()) return [];
  return parseJsonLines<any>(output).map((v) => ({
    name: v.name,
    driver: v.driver,
    mountpoint: v.mountpoint,
    createdAt: "",
    labels: {},
  }));
}

export async function createVolume(name: string): Promise<VolumeInfo> {
  const result = await $`docker volume create ${name}`.quiet().nothrow();
  if (result.exitCode !== 0) {
    throw new Error(`docker volume create failed: ${result.stderr.toString()}`);
  }
  return inspectVolume(name);
}

export async function removeVolume(name: string): Promise<void> {
  const result = await $`docker volume rm ${name}`.quiet().nothrow();
  if (result.exitCode !== 0) {
    throw new Error(`docker volume rm failed: ${result.stderr.toString()}`);
  }
}

export async function inspectVolume(name: string): Promise<VolumeInfo> {
  const result = await $`docker volume inspect ${name}`.quiet().nothrow();
  if (result.exitCode !== 0) {
    throw new Error(`docker volume inspect failed: ${result.stderr.toString()}`);
  }
  const parsed = JSON.parse(result.stdout.toString()) as any[];
  const info = parsed[0];
  if (!info) throw new Error("Volume not found");
  return {
    name: info.Name ?? "",
    driver: info.Driver ?? "",
    mountpoint: info.Mountpoint ?? "",
    createdAt: info.CreatedAt ?? "",
    labels: info.Labels ?? {},
  };
}

export async function installBashDevToolsOnVolume(
  volumeName: string,
  scope: "root" | "home",
): Promise<{ homesInstalled: number }> {
  const normalizedVolume = (volumeName ?? "").trim();
  if (!normalizedVolume) throw new Error("Volume name is required");

  const normalizedScope = scope === "home" ? "home" : "root";
  const installScript = `
set -eu

ROOT="/ca-volume"
COUNT=0

ensure_home() {
  HOME_DIR="$1"
  [ -n "$HOME_DIR" ] || return 0
  mkdir -p "$HOME_DIR/.context-assistant"
  mkdir -p "$HOME_DIR/.bin"

  cat > "$HOME_DIR/.bin/open" <<'OPENSCRIPT'
#!/bin/sh
set -eu

if [ "$#" -lt 1 ]; then
  echo "usage: open <path>" >&2
  exit 2
fi

target="$1"

if [ -d "$target" ]; then
  kind="directory"
  abs="$(cd "$target" 2>/dev/null && pwd -P)" || {
    echo "open: cannot resolve directory: $target" >&2
    exit 1
  }
elif [ -f "$target" ]; then
  kind="file"
  abs="$(cd "$(dirname "$target")" 2>/dev/null && echo "$(pwd -P)/$(basename "$target")")"
  if [ -z "$abs" ]; then
    echo "open: cannot resolve file parent: $target" >&2
    exit 1
  fi
else
  echo "open: path does not exist: $target" >&2
  exit 1
fi

payload="$(printf '%s\t%s' "$kind" "$abs" | base64 | tr -d '\n\r')"
printf '\033]1337;CA_OPEN_B64=%s\007' "$payload"
OPENSCRIPT
  chmod +x "$HOME_DIR/.bin/open"

  if [ ! -d "$HOME_DIR/.oh-my-bash" ]; then
    git clone --depth 1 https://github.com/ohmybash/oh-my-bash.git "$HOME_DIR/.oh-my-bash" >/dev/null 2>&1 || true
  fi

  cat > "$HOME_DIR/.context-assistant/bash-dev-tools.sh" <<'EOF'
if [ -d "$HOME/.bin" ]; then
  export PATH="$HOME/.bin:$PATH"
fi
if [ -d "$HOME/.local/.bin" ]; then
  export PATH="$HOME/.local/.bin:$PATH"
fi
export OSH="$HOME/.oh-my-bash"
OSH_THEME="robbyrussell"
plugins=(git npm pyenv progress)
if [ -f "$OSH/oh-my-bash.sh" ]; then
  source "$OSH/oh-my-bash.sh"
fi
if [ -f "$HOME/.context-assistant/bash-aliases.sh" ]; then
  source "$HOME/.context-assistant/bash-aliases.sh"
fi
EOF

  cat > "$HOME_DIR/.context-assistant/bash-aliases.sh" <<'EOF'
alias c='clear'
alias x='exit'
alias gl='git log --oneline --decorate --graph'
alias gs='git status'
alias o='open'
alias d='docker'
alias de='docker exec -it'
alias di='docker images'
alias drmi='docker rmi'
alias dm='docker model'
alias dml='docker model list'
alias dmp='docker model pull'
alias dmr='docker model run'
alias dms='docker model serve'
alias dn='docker network'
alias dns='docker network ls'
alias dsp='docker system prune -f'
alias dspv='docker system prune -f --volumes'
alias ds='docker ps --format "table {{.ID}}\\t{{.Status}}\\t{{.Ports}}\\t{{.Names}}"'
alias dsa='docker ps -a --format "table {{.ID}}\\t{{.Status}}\\t{{.Ports}}\\t{{.Names}}"'
alias dv='docker volume'
alias dvs='docker volume ls'
alias dvp='docker volume prune --filter "label!=freshstacks"'
alias dc='docker compose'
alias dcb='docker compose build'
alias dcd='docker compose down'
alias dcdv='docker compose down --volumes'
alias dce='docker compose exec'
alias dcl='docker compose logs'
alias dcu='docker compose up -d'
alias dcw='docker compose watch'
EOF

  cat > "$HOME_DIR/.vimrc" <<'EOF'
" --- General ---
set nocompatible          " Use Vim defaults, not Vi
syntax on                 " Enable syntax highlighting
filetype plugin indent on " Enable filetype detection
set encoding=utf-8
set t_Co=256              " Force 256 colors
set autoread              " Update files when they are modified externally
set splitright            " By default split vertical split to the right side
set shell=/bin/bash
set nowrap                " nowrap by default

" --- UI ---
set number                " Show line numbers
set cursorline            " Highlight current line
set showmatch             " Show matching brackets
set noswapfile            " Disable swap files (optional)

" --- Indentation ---
set tabstop=4             " 4 spaces per tab
set shiftwidth=4          " 4 spaces for autoindent
set expandtab             " Use spaces instead of tabs
set smarttab
set autoindent

" --- Search ---
set hlsearch              " Highlight searches
set incsearch             " Search as you type
set ignorecase            " Ignore case in search
set smartcase             " Overrides ignorecase if capital exists

" --- Color Scheme ---
set background=dark         " Or light
" colorscheme habamax       " custom built-in theme
" colorscheme catppuccin    " custom built-in theme
" colorscheme quiet         " custom built-in theme
" colorscheme default       " Default built-in theme
EOF

  touch "$HOME_DIR/.bashrc"
  if ! grep -q "context-assistant bash dev tools" "$HOME_DIR/.bashrc" 2>/dev/null; then
    cat >> "$HOME_DIR/.bashrc" <<'EOF'

# >>> context-assistant bash dev tools >>>
if [ -f "$HOME/.context-assistant/bash-dev-tools.sh" ]; then
  source "$HOME/.context-assistant/bash-dev-tools.sh"
fi
# <<< context-assistant bash dev tools <<<
EOF
  fi
}

if [ "${normalizedScope}" = "root" ]; then
  ensure_home "$ROOT"
  COUNT=1
else
  for d in "$ROOT"/*; do
    [ -d "$d" ] || continue
    ensure_home "$d"
    COUNT=$((COUNT + 1))
  done
fi

echo "$COUNT"
`.trim();

  const proc = spawnWithDockerEnv(
    [
      "docker",
      "run",
      "--rm",
      "-v",
      `${normalizedVolume}:/ca-volume`,
      "alpine:3.20",
      "sh",
      "-lc",
      `apk add --no-cache git bash >/dev/null && ${installScript}`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  if (exitCode !== 0) {
    throw new Error(`Failed to install bash dev tools: ${stderr.trim() || "docker run failed"}`);
  }

  const homesInstalled = Number.parseInt(stdout.trim().split(/\s+/).at(-1) ?? "0", 10);
  return { homesInstalled: Number.isFinite(homesInstalled) ? homesInstalled : 0 };
}

// ---------------------------------------------------------------------------
// Network operations
// ---------------------------------------------------------------------------

export async function listNetworks(): Promise<NetworkInfo[]> {
  const result =
    await $`docker network ls --format '{"id":"{{.ID}}","name":"{{.Name}}","driver":"{{.Driver}}","scope":"{{.Scope}}","createdAt":""}'`.quiet().nothrow();
  if (result.exitCode !== 0) {
    throw new Error(`docker network ls failed: ${result.stderr.toString()}`);
  }
  const output = result.stdout.toString();
  if (!output.trim()) return [];
  return parseJsonLines<NetworkInfo>(output);
}

export async function removeNetwork(name: string): Promise<void> {
  const result = await $`docker network rm ${name}`.quiet().nothrow();
  if (result.exitCode !== 0) {
    throw new Error(`docker network rm failed: ${result.stderr.toString()}`);
  }
}

export async function listAiModels(): Promise<AIModelInfo[]> {
  const runningNames = await listRunningAiModelNames();
  const result = await runDockerCommand(["docker", "model", "list", "--json"]);
  if (result.exitCode !== 0) {
    const stderr = result.stderr.trim();
    if (/cannot connect to the docker daemon/i.test(stderr)) {
      throw new Error(stderr);
    }
    // Remote SSH hosts often fail model-runner metadata probes in ways that
    // should not silently degrade to local-ish "downloaded" placeholders.
    if (configuredDockerHost?.startsWith("ssh://")) {
      throw new Error(`docker model list failed: ${stderr}`);
    }
    // Docker's model plugin can fail against some remote contexts even when
    // regular docker commands work; fall back to model-runner metadata.
    const fallbackModels = await listAiModelsFromRunnerMetadata();
    if (fallbackModels) return markRunningAiModels(fallbackModels, runningNames);
    throw new Error(`docker model list failed: ${stderr}`);
  }
  const models = mapAiModelRows(parseAiModelRows(result.stdout));
  return markRunningAiModels(models, runningNames);
}

export async function removeAiModel(name: string): Promise<void> {
  const result = await runDockerCommand(["docker", "model", "rm", name]);
  if (result.exitCode !== 0) {
    throw new Error(`docker model rm failed: ${result.stderr.trim()}`);
  }
}

export async function unloadAiModel(name: string): Promise<void> {
  const result = await runDockerCommand(["docker", "model", "unload", name]);
  if (result.exitCode !== 0) {
    throw new Error(`docker model unload failed: ${result.stderr.trim()}`);
  }
}

// ---------------------------------------------------------------------------
// File operations (via docker exec / docker cp)
// ---------------------------------------------------------------------------

export async function listFiles(
  containerId: string,
  path: string,
): Promise<FileEntry[]> {
  const safePath = path || "/";

  // Use ls -la (no --time-style, for BusyBox/Alpine compatibility)
  const result =
    await $`docker exec ${containerId} ls -la ${safePath}`.quiet().nothrow();
  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString();
    // If directory doesn't exist, return empty rather than throwing
    if (stderr.includes("No such file or directory")) {
      return [];
    }
    throw new Error(`Failed to list files: ${stderr}`);
  }
  const output = result.stdout.toString();
  const lines = output.split("\n").filter((line) => line.trim().length > 0);

  const entries: FileEntry[] = [];
  for (const line of lines) {
    if (line.startsWith("total ")) continue;

    // Parse standard ls -la output:
    //   permissions links owner group size month day time/year name
    // The name starts after the 8th column for GNU ls, but we need to handle
    // variable whitespace. We'll match the permissions and extract the name
    // from the end.
    const match = line.match(
      /^([drwxlsStT-]{10,})\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\S+\s+\S+\s+\S+)\s+(.+)$/,
    );
    if (!match) continue;

    const permissions = match[1] ?? "";
    const size = parseInt(match[2] ?? "0", 10);
    const datePart = match[3] ?? "";
    const name = match[4] ?? "";

    if (name === "." || name === "..") continue;
    // Skip symlink targets (e.g. "foo -> /bar")
    const displayName = name.includes(" -> ") ? name.split(" -> ")[0]! : name;

    entries.push({
      name: displayName,
      isDirectory: permissions.startsWith("d"),
      size: isNaN(size) ? 0 : size,
      modifiedAt: datePart,
      permissions,
    });
  }

  return entries;
}

export async function readFile(
  containerId: string,
  path: string,
): Promise<string> {
  const result = await $`docker exec ${containerId} cat ${path}`.quiet().nothrow();
  if (result.exitCode !== 0) {
    throw new Error(`Failed to read file: ${result.stderr.toString()}`);
  }
  return result.stdout.toString();
}

export async function readFileBase64(
  containerId: string,
  path: string,
): Promise<string> {
  const result = await containerExec(containerId, [
    "sh",
    "-lc",
    "if command -v base64 >/dev/null 2>&1; then base64 \"$1\" | tr -d '\\n\\r'; else echo 'base64 command is required for preview' >&2; exit 127; fi",
    "preview-read",
    path,
  ]);
  if (result.exitCode !== 0) {
    throw new Error(`Failed to read file as base64: ${result.stderr}`);
  }
  return result.stdout.trim();
}

export async function writeFile(
  containerId: string,
  path: string,
  content: string,
): Promise<void> {
  // Use docker exec with sh -c and heredoc-style input via stdin
  const proc = spawnWithDockerEnv(
    ["docker", "exec", "-i", containerId, "sh", "-c", `cat > '${path.replace(/'/g, "'\\''")}'`],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  const stdin = proc.stdin;
  if (!stdin || typeof stdin === "number") {
    throw new Error("Failed to open stdin pipe for docker exec");
  }
  stdin.write(content);
  stdin.flush();
  stdin.end();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`Failed to write file: ${stderr.trim()}`);
  }
}

async function writeFileBytes(
  containerId: string,
  path: string,
  content: Uint8Array,
): Promise<void> {
  const proc = spawnWithDockerEnv(
    ["docker", "exec", "-i", containerId, "sh", "-c", `cat > '${path.replace(/'/g, "'\\''")}'`],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  const stdin = proc.stdin;
  if (!stdin || typeof stdin === "number") {
    throw new Error("Failed to open stdin pipe for docker exec");
  }
  stdin.write(content);
  stdin.flush();
  stdin.end();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`Failed to write file: ${stderr.trim()}`);
  }
}

function normalizeContainerAbsolutePath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "");
  const next = normalized.length > 0 ? normalized : "/";
  if (!next.startsWith("/")) {
    throw new Error(`Path must be absolute: ${path}`);
  }
  return next;
}

function normalizeUploadRelativePath(path: string): string {
  const segments = path
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    throw new Error("Upload entry path cannot be empty");
  }
  for (const segment of segments) {
    if (segment === "." || segment === "..") {
      throw new Error(`Invalid upload path segment: ${path}`);
    }
  }
  return segments.join("/");
}

export async function createDirectory(
  containerId: string,
  path: string,
): Promise<void> {
  const result = await $`docker exec ${containerId} mkdir -p ${path}`.quiet().nothrow();
  if (result.exitCode !== 0) {
    throw new Error(`Failed to create directory: ${result.stderr.toString()}`);
  }
}

export async function deleteFile(
  containerId: string,
  path: string,
): Promise<void> {
  const result = await $`docker exec ${containerId} rm -rf ${path}`.quiet().nothrow();
  if (result.exitCode !== 0) {
    throw new Error(`Failed to delete: ${result.stderr.toString()}`);
  }
}

export async function renameFile(
  containerId: string,
  oldPath: string,
  newPath: string,
): Promise<void> {
  const result = await $`docker exec ${containerId} mv ${oldPath} ${newPath}`.quiet().nothrow();
  if (result.exitCode !== 0) {
    throw new Error(`Failed to rename: ${result.stderr.toString()}`);
  }
}

export async function importFiles(
  containerId: string,
  targetDirectory: string,
  entries: DockerUploadEntry[],
): Promise<void> {
  const destinationRoot = normalizeContainerAbsolutePath(targetDirectory);
  if (entries.length === 0) return;

  const normalizedEntries = entries.map((entry) => ({
    kind: entry.kind,
    relativePath: normalizeUploadRelativePath(entry.relativePath),
    contentBase64: entry.contentBase64,
  }));

  normalizedEntries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
    const aDepth = a.relativePath.split("/").length;
    const bDepth = b.relativePath.split("/").length;
    if (aDepth !== bDepth) return aDepth - bDepth;
    return a.relativePath.localeCompare(b.relativePath);
  });

  for (const entry of normalizedEntries) {
    const destinationPath = pathPosix.join(destinationRoot, entry.relativePath);
    if (entry.kind === "directory") {
      await createDirectory(containerId, destinationPath);
      continue;
    }
    if (typeof entry.contentBase64 !== "string") {
      throw new Error(`Missing file content for upload: ${entry.relativePath}`);
    }
    await createDirectory(containerId, pathPosix.dirname(destinationPath));
    await writeFileBytes(
      containerId,
      destinationPath,
      Buffer.from(entry.contentBase64, "base64"),
    );
  }
}

// ---------------------------------------------------------------------------
// Container exec (run a command inside a running container)
// ---------------------------------------------------------------------------

export async function containerExec(
  containerId: string,
  command: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const args = ["docker", "exec", containerId, ...command];
  const proc = spawnWithDockerEnv(args, { stdout: "pipe", stderr: "pipe" });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { exitCode, stdout, stderr };
}

export async function containerExecAs(
  containerId: string,
  user: string,
  command: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const u = (user ?? "").trim();
  const args = u
    ? ["docker", "exec", "-u", u, containerId, ...command]
    : ["docker", "exec", containerId, ...command];
  const proc = spawnWithDockerEnv(args, { stdout: "pipe", stderr: "pipe" });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { exitCode, stdout, stderr };
}

// ---------------------------------------------------------------------------
// Image operations
// ---------------------------------------------------------------------------

export async function listImages(): Promise<ImageInfo[]> {
  const result =
    await $`docker images --format '{"id":"{{.ID}}","repository":"{{.Repository}}","tag":"{{.Tag}}","size":"{{.Size}}","createdAt":"{{.CreatedAt}}"}'`.quiet().nothrow();
  if (result.exitCode !== 0) {
    throw new Error(`docker images failed: ${result.stderr.toString()}`);
  }
  const output = result.stdout.toString();
  if (!output.trim()) return [];
  return parseJsonLines<ImageInfo>(output);
}

export async function removeImage(imageRef: string, force = false): Promise<void> {
  const trimmed = imageRef.trim();
  if (!trimmed) throw new Error("Image reference is required");
  const args = force ? ["docker", "image", "rm", "-f", trimmed] : ["docker", "image", "rm", trimmed];
  const proc = spawnWithDockerEnv(args, { stdout: "pipe", stderr: "pipe" });
  const exitCode = await proc.exited;
  const stderr = await new Response(proc.stderr).text();
  if (exitCode !== 0) {
    throw new Error(`docker image rm failed: ${stderr.trim() || "unknown error"}`);
  }
}

export async function pruneDanglingImages(): Promise<void> {
  const result = await $`docker image prune -f --filter ${"dangling=true"}`.quiet().nothrow();
  if (result.exitCode !== 0) {
    throw new Error(`docker image prune failed: ${result.stderr.toString()}`);
  }
}

export async function listImageUsers(image: string): Promise<string[]> {
  const trimmed = image.trim();
  if (!trimmed) return [];

  // Run `cat /etc/passwd` with an empty entrypoint so we don't start the image's default process.
  const proc = spawnWithDockerEnv(
    ["docker", "run", "--rm", "--entrypoint", "", trimmed, "cat", "/etc/passwd"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  if (exitCode !== 0) {
    throw new Error(`Failed to read /etc/passwd from image: ${stderr.trim() || "docker run failed"}`);
  }

  const users = parsePasswdUsers(stdout);

  const isInteractiveShell = (shell: string) => {
    const s = (shell ?? "").trim();
    if (!s.startsWith("/")) return false;
    const lower = s.toLowerCase();
    if (lower.includes("nologin")) return false;
    if (lower.endsWith("/false")) return false;
    return true;
  };

  const filtered = users
    .filter((u) => u.name === "root" || (u.uid >= 1 && isInteractiveShell(u.shell)))
    .map((u) => u.name);

  // Ensure `root` is always present if it exists in /etc/passwd.
  const set = new Set<string>(filtered);
  if (users.some((u) => u.name === "root")) set.add("root");

  return Array.from(set).sort((a, b) => {
    if (a === "root") return -1;
    if (b === "root") return 1;
    return a.localeCompare(b);
  });
}

export async function inspectImageDeclaredVolumes(image: string): Promise<string[]> {
  const trimmed = image.trim();
  if (!trimmed) return [];
  const result =
    await $`docker image inspect ${trimmed} --format ${"{{json .Config.Volumes}}"}`.quiet().nothrow();
  if (result.exitCode !== 0) {
    throw new Error(`docker image inspect failed: ${result.stderr.toString()}`);
  }
  const raw = result.stdout.toString().trim();
  if (!raw || raw === "null") return [];
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  return Object.keys(parsed ?? {}).sort((a, b) => a.localeCompare(b));
}

export async function buildImage(
  dockerfile: string,
  tag: string,
): Promise<string> {
  // Write Dockerfile to a temp location and build
  const tmpDir = `/tmp/ca-docker-build-${Date.now()}`;
  const { mkdirSync, writeFileSync, rmSync } = await import("fs");
  mkdirSync(tmpDir, { recursive: true });
  writeFileSync(`${tmpDir}/Dockerfile`, dockerfile);
  try {
    const result = await $`docker build -t ${tag} ${tmpDir}`.quiet().nothrow();
    if (result.exitCode !== 0) {
      throw new Error(`docker build failed: ${result.stderr.toString()}`);
    }
    return result.stdout.toString();
  } finally {
    try {
      rmSync(tmpDir, { recursive: true });
    } catch {
      // ignore cleanup errors
    }
  }
}

export async function commitContainer(
  containerId: string,
  image: string,
): Promise<string> {
  const trimmed = image.trim();
  if (!trimmed) throw new Error("Image name is required");
  // `docker commit` prints the new image ID on stdout.
  const result = await $`docker commit ${containerId} ${trimmed}`.quiet().nothrow();
  if (result.exitCode !== 0) {
    throw new Error(`docker commit failed: ${result.stderr.toString()}`);
  }
  return result.stdout.toString().trim();
}

// ---------------------------------------------------------------------------
// Container recreation with volume attached
// ---------------------------------------------------------------------------

export async function attachVolumeToContainer(
  containerId: string,
  volumeName: string,
  mountPath = "/workspace",
): Promise<string> {
  // 1. Inspect the existing container to capture its full configuration
  const info = await inspectContainer(containerId);
  const containerName = info.name;

  // 2. Stop and remove the old container first so we can reuse the name
  //    and avoid a brief flash of two containers in the UI.
  if (info.state.running) {
    const stopResult = await $`docker stop -t 3 ${containerId}`.quiet().nothrow();
    if (stopResult.exitCode !== 0) {
      await $`docker kill ${containerId}`.quiet().nothrow();
    }
  }
  await $`docker rm -f ${containerId}`.quiet().nothrow();

  // 3. Build args for the new container with the same config + new volume
  const args: string[] = ["docker", "create"];

  if (containerName) {
    args.push("--name", containerName);
  }

  if (info.hostConfig.readOnly) {
    args.push("--read-only");
  }

  if (info.hostConfig.networkMode === "host") {
    args.push("--net=host");
  }

  const configuredUser = (info.config.user ?? "").trim();
  if (configuredUser) {
    args.push("--user", configuredUser);
  }

  const workingDir = (info.config.workingDir ?? "").trim() || mountPath;
  if (workingDir) args.push("-w", workingDir);

  for (const [key, value] of Object.entries(info.config.labels ?? {})) {
    args.push("--label", `${key}=${value}`);
  }

  // Preserve existing mounts (except any already at the mountPath)
  for (const m of info.mounts) {
    if (m.destination === mountPath) continue;
    if (m.type === "volume" && m.name) {
      args.push("-v", `${m.name}:${m.destination}${m.rw ? "" : ":ro"}`);
    } else if (m.type === "bind" && m.source) {
      args.push("-v", `${m.source}:${m.destination}${m.rw ? "" : ":ro"}`);
    } else if (m.type === "tmpfs" && m.destination) {
      args.push("--tmpfs", `${m.destination}:${m.rw ? "rw" : "ro"}`);
    }
  }

  // Add the new volume mount
  args.push("-v", `${volumeName}:${mountPath}`);

  for (const envVar of info.config.env) {
    args.push("-e", envVar);
  }

  if (info.hostConfig.networkMode !== "host") {
    const portSource = info.hostConfig.portBindings;
    if (portSource) {
      for (const [containerPort, bindings] of Object.entries(portSource)) {
        if (bindings) {
          for (const binding of bindings) {
            if (binding.hostPort) {
              args.push("-p", `${binding.hostPort}:${containerPort}`);
            }
          }
        }
      }
    }
  }

  // Preserve a cleared entrypoint (set via --entrypoint "") so command overrides
  // like "sleep infinity" continue working after recreation.
  if (isEntrypointCleared(info.config.entrypoint)) {
    args.push("--entrypoint", "");
  }

  args.push(info.config.image || info.image);

  if (info.config.cmd && info.config.cmd.length > 0) {
    args.push(...info.config.cmd);
  }

  // 4. Create the new container (old one is already removed)
  const proc = spawnWithDockerEnv(args, { stdout: "pipe", stderr: "pipe" });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();

  if (exitCode !== 0) {
    throw new Error(`Failed to recreate container: ${stderr.trim()}`);
  }

  const newContainerId = stdout.trim().slice(0, 12); // short ID to match listContainers

  // 5. Start the new container
  await startContainer(newContainerId);

  return newContainerId;
}

// ---------------------------------------------------------------------------
// Recreate container with writable root filesystem
// ---------------------------------------------------------------------------

export async function recreateContainerWritable(
  containerId: string,
): Promise<string> {
  const info = await inspectContainer(containerId);

  // Already writable — nothing to do
  if (!info.hostConfig.readOnly) {
    return containerId;
  }

  const args: string[] = ["docker", "create"];
  // Intentionally NOT adding --read-only

  if (info.hostConfig.networkMode === "host") {
    args.push("--net=host");
  }

  const configuredUser = (info.config.user ?? "").trim();
  if (configuredUser) {
    args.push("--user", configuredUser);
  }

  const workingDir = (info.config.workingDir ?? "").trim();
  if (workingDir) {
    args.push("-w", workingDir);
  }

  // Preserve labels
  for (const [key, value] of Object.entries(info.config.labels ?? {})) {
    args.push("--label", `${key}=${value}`);
  }

  for (const m of info.mounts) {
    if (m.type === "volume" && m.name) {
      args.push("-v", `${m.name}:${m.destination}${m.rw ? "" : ":ro"}`);
    } else if (m.type === "bind" && m.source) {
      args.push("-v", `${m.source}:${m.destination}${m.rw ? "" : ":ro"}`);
    } else if (m.type === "tmpfs" && m.destination) {
      args.push("--tmpfs", `${m.destination}:${m.rw ? "rw" : "ro"}`);
    }
  }

  for (const envVar of info.config.env) {
    args.push("-e", envVar);
  }

  if (info.hostConfig.networkMode !== "host") {
    const portSource = info.hostConfig.portBindings;
    if (portSource) {
      for (const [containerPort, bindings] of Object.entries(portSource)) {
        if (bindings) {
          for (const binding of bindings) {
            if (binding.hostPort) {
              args.push("-p", `${binding.hostPort}:${containerPort}`);
            }
          }
        }
      }
    }
  }

  // Preserve a cleared entrypoint (set via --entrypoint "") so command overrides
  // like "sleep infinity" continue working after recreation.
  if (isEntrypointCleared(info.config.entrypoint)) {
    args.push("--entrypoint", "");
  }

  args.push(info.config.image || info.image);

  if (info.config.cmd && info.config.cmd.length > 0) {
    args.push(...info.config.cmd);
  }

  const proc = spawnWithDockerEnv(args, { stdout: "pipe", stderr: "pipe" });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();

  if (exitCode !== 0) {
    throw new Error(`Failed to recreate container: ${stderr.trim()}`);
  }

  const newContainerId = stdout.trim().slice(0, 12); // short ID to match listContainers

  if (info.state.running) {
    const stopResult = await $`docker stop -t 3 ${containerId}`.quiet().nothrow();
    if (stopResult.exitCode !== 0) {
      await $`docker kill ${containerId}`.quiet().nothrow();
    }
  }
  await $`docker rm -f ${containerId}`.quiet().nothrow();

  if (info.name) {
    await $`docker rename ${newContainerId} ${info.name}`.quiet().nothrow();
  }

  await startContainer(newContainerId);

  return newContainerId;
}

// ---------------------------------------------------------------------------
// Terminal session management — PTY via Python helper
// ---------------------------------------------------------------------------
//
// We use a small Python script that:
//   1. Creates a real PTY via pty.fork()
//   2. Execs docker exec -it inside the PTY (so echo, vim, etc. work)
//   3. Runs a copy loop between piped stdin/stdout and the PTY master fd
//   4. Intercepts a special escape sequence in stdin for PTY resize
//      (calls ioctl TIOCSWINSZ — no text ever reaches the shell)
//
// Resize protocol:  \x1b]resize;ROWS;COLS\x07   (OSC-style, intercepted by wrapper)

const PTY_HELPER_SCRIPT = `
import pty, os, sys, select, struct, fcntl, termios, signal

RESIZE_START = b'\\x1b]resize;'
RESIZE_END   = b'\\x07'

def set_winsize(fd, rows, cols):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))

# Parse optional --size ROWS COLS
args = sys.argv[1:]
init_rows, init_cols = 24, 80
if len(args) >= 3 and args[0] == '--size':
    init_rows, init_cols = int(args[1]), int(args[2])
    args = args[3:]

child_pid, master_fd = pty.fork()
if child_pid == 0:
    os.execvp(args[0], args)

set_winsize(master_fd, init_rows, init_cols)

buf = b''
try:
    while True:
        rfds, _, _ = select.select([0, master_fd], [], [])
        if master_fd in rfds:
            try:
                data = os.read(master_fd, 4096)
            except OSError:
                break
            if not data:
                break
            os.write(1, data)
        if 0 in rfds:
            try:
                data = os.read(0, 4096)
            except OSError:
                break
            if not data:
                break
            buf += data
            while RESIZE_START in buf:
                pre, _, after = buf.partition(RESIZE_START)
                if RESIZE_END in after:
                    cmd, _, after = after.partition(RESIZE_END)
                    if pre:
                        os.write(master_fd, pre)
                    try:
                        r, c = cmd.decode().split(';')
                        set_winsize(master_fd, int(r), int(c))
                        os.kill(child_pid, signal.SIGWINCH)
                    except Exception:
                        pass
                    buf = after
                else:
                    break
            if buf and RESIZE_START not in buf:
                os.write(master_fd, buf)
                buf = b''
except Exception:
    pass
finally:
    os.close(master_fd)
    try:
        _, status = os.waitpid(child_pid, 0)
        code = os.WEXITSTATUS(status) if os.WIFEXITED(status) else 1
    except Exception:
        code = 1
    sys.exit(code)
`.trim();

let ptyHelperPath: string | null = null;

function ensurePtyHelper(): string {
  if (ptyHelperPath) return ptyHelperPath;
  const path = "/tmp/ca-pty-helper.py";
  try {
    Bun.write(path, PTY_HELPER_SCRIPT);
  } catch {
    // If /tmp write fails, try writing next to the running script
    const fallback = `${import.meta.dir}/ca-pty-helper.py`;
    Bun.write(fallback, PTY_HELPER_SCRIPT);
    ptyHelperPath = fallback;
    return fallback;
  }
  ptyHelperPath = path;
  return path;
}

type TerminalSession = {
  proc: ReturnType<typeof Bun.spawn>;
  alive: boolean;
  cleanupDone?: boolean;
  onEnd?: () => Promise<void> | void;
};

const terminalSessions = new Map<string, TerminalSession>();

let sessionCounter = 0;

async function runTerminalSessionCleanup(session: TerminalSession): Promise<void> {
  if (session.cleanupDone) return;
  session.cleanupDone = true;
  const cleanup = session.onEnd;
  session.onEnd = undefined;
  if (!cleanup) return;
  try {
    await cleanup();
  } catch {
    // ignore best-effort cleanup failures
  }
}

/**
 * Detect the login shell for a user inside a container by reading
 * /etc/passwd.  Falls back to /bin/sh if detection fails.
 */
async function detectLoginShell(containerId: string, user = "root"): Promise<string> {
  try {
    const result = await containerExec(containerId, [
      "sh",
      "-c",
      `getent passwd ${user} 2>/dev/null || grep '^${user}:' /etc/passwd`,
    ]);
    if (result.exitCode === 0 && result.stdout.trim()) {
      // /etc/passwd format:  root:x:0:0:root:/root:/bin/bash
      const fields = result.stdout.trim().split(":");
      const shell = fields[fields.length - 1];
      if (shell && shell.startsWith("/")) {
        return shell;
      }
    }
  } catch {
    // detection failed – fall back
  }
  return "/bin/sh";
}

/**
 * Prefer bash for terminal tabs when available in the container.
 * Fall back to the user's login shell from /etc/passwd.
 */
async function detectPreferredTerminalShell(containerId: string, user = "root"): Promise<string> {
  try {
    const result = await containerExecAs(containerId, user, [
      "sh",
      "-lc",
      "if command -v bash >/dev/null 2>&1; then command -v bash; elif [ -x /bin/bash ]; then echo /bin/bash; elif [ -x /usr/bin/bash ]; then echo /usr/bin/bash; fi",
    ]);
    if (result.exitCode === 0) {
      const bashPath = result.stdout.trim();
      if (bashPath.startsWith("/")) {
        return bashPath;
      }
    }
  } catch {
    // fallback handled below
  }
  return detectLoginShell(containerId, user);
}

async function detectContainerUserHomeDir(containerId: string, user = "root"): Promise<string | null> {
  const u = (user ?? "").trim() || "root";
  if (u === "root" || u === "0") return "/root";
  try {
    const result = await containerExec(containerId, [
      "sh",
      "-c",
      `getent passwd ${u} 2>/dev/null || grep '^${u}:' /etc/passwd`,
    ]);
    if (result.exitCode === 0 && result.stdout.trim()) {
      // /etc/passwd format:  root:x:0:0:root:/root:/bin/bash
      const fields = result.stdout.trim().split(":");
      const home = fields[5];
      if (home && home.startsWith("/")) return home;
    }
  } catch {
    // ignore
  }
  return null;
}

/** Callback set by the host (index.ts) to push output to the webview. */
let onTerminalOutput: ((sessionId: string, data: string) => void) | null = null;
let onTerminalExit: ((sessionId: string, code: number) => void) | null = null;

export function setTerminalCallbacks(
  outputCb: (sessionId: string, data: string) => void,
  exitCb: (sessionId: string, code: number) => void,
) {
  onTerminalOutput = outputCb;
  onTerminalExit = exitCb;
}

export async function createTerminalSession(
  containerId: string,
  shell?: string,
  cols = 80,
  rows = 24,
  cwd?: string,
): Promise<{ sessionId: string; shell: string }> {
  // Determine which user to exec as based on the container's rootUser label
  const execUser = await getContainerExecUser(containerId);
  const explicitShell = typeof shell === "string" ? shell.trim() : "";
  const configuredExecShell = explicitShell || (await getContainerExecShellCommand(containerId)) || "";
  const resolvedShell = configuredExecShell || (await detectPreferredTerminalShell(containerId, execUser));
  const sessionId = `term_${++sessionCounter}_${Date.now()}`;
  const pidFileCandidates = [
    `/tmp/ca-terminal-${sessionId}.pid`,
    `/dev/shm/ca-terminal-${sessionId}.pid`,
  ];

  const helperPath = ensurePtyHelper();

  const shQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

  // Only set an explicit workdir when the caller requested one, or the container
  // has an exec-workdir label, and that directory exists. Otherwise let
  // `docker exec` use the container/image default working directory.
  let workdir: string | null = null;
  const requestedCwd = typeof cwd === "string" ? cwd.trim() : "";
  const configuredExecWorkdir = requestedCwd || (await getContainerExecShellWorkdir(containerId)) || "";
  if (configuredExecWorkdir.startsWith("/")) {
    try {
      const normalized = configuredExecWorkdir.replace(/\/+/g, "/").replace(/\/+$/g, "") || "/";
      const result = await containerExec(containerId, [
        "sh",
        "-lc",
        `cd ${shQuote(normalized)} 2>/dev/null && pwd -P`,
      ]);
      if (result.exitCode === 0) {
        const resolved = result.stdout.trim();
        workdir = resolved || normalized;
      }
    } catch {
      // ignore and fall back to container default working directory
    }
  }

  // We wrap the login shell in `sh -lc` so we can record a stable PID inside the
  // container. Killing the local `docker exec` client doesn't reliably stop the
  // in-container process; this PID file lets us explicitly terminate it.
  const quotedPidFileCandidates = pidFileCandidates.map(shQuote).join(" ");
  const wrappedShellCommand =
    `pidfile=''; ` +
    `for p in ${quotedPidFileCandidates}; do ` +
    `  d=$(dirname "$p"); ` +
    `  if [ -d "$d" ] && [ -w "$d" ]; then pidfile="$p"; break; fi; ` +
    `done; ` +
    `if [ -n "$pidfile" ]; then (echo $$ > "$pidfile") 2>/dev/null || true; fi; ` +
    `exec ${configuredExecShell ? configuredExecShell : shQuote(resolvedShell)}`;

  const execArgs = [
    "docker",
    "exec",
    "-it",
    "-e", 
    "LC_ALL=C",
  ];

  // Exec as the appropriate user
  if (execUser && execUser !== "root") {
    execArgs.push("-u", execUser);
  }

  execArgs.push(
    "-e",
    "TERM=xterm-256color",
    "-e",
    "LANG=C.UTF-8",
    "-e",
    "LC_ALL=C.UTF-8",
    "-e",
    `COLUMNS=${cols}`,
    "-e",
    `LINES=${rows}`,
  );

  if (workdir) {
    execArgs.push("-w", workdir);
  }

  execArgs.push(
    containerId,
    "sh",
    "-lc",
    wrappedShellCommand,
  );

  const proc = spawnWithDockerEnv(
    [
      "python3",
      helperPath,
      "--size",
      String(rows),
      String(cols),
      ...execArgs,
    ],
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  const session: TerminalSession = { proc, alive: true };
  terminalSessions.set(sessionId, session);

  const bestEffortKillRemote = async () => {
    // Kill the in-container process group (best-effort).
    // Using a process group (-PID) helps ensure child processes (vim, etc.) die too.
    const cleanupTargets = pidFileCandidates.map(shQuote).join(" ");
    const script =
      `for pidfile in ${cleanupTargets}; do ` +
      `  if [ -f "$pidfile" ]; then ` +
      `    pid=$(cat "$pidfile" 2>/dev/null | tr -d '\\r\\n'); ` +
      `    rm -f "$pidfile" 2>/dev/null || true; ` +
      `    if [ -n "$pid" ]; then ` +
      `      kill -TERM -"$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true; ` +
      `      sleep 0.2; ` +
      `      kill -KILL -"$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true; ` +
      `      break; ` +
      `    fi; ` +
      `  fi; ` +
      `done`;
    try {
      const killer = spawnWithDockerEnv(
        ["docker", "exec", containerId, "sh", "-lc", script],
        { stdout: "pipe", stderr: "pipe" },
      );
      await killer.exited;
    } catch {
      // ignore
    }
  };

  session.onEnd = bestEffortKillRemote;

  // Stream stdout (PTY output)
  void (async () => {
    try {
      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && onTerminalOutput) {
          onTerminalOutput(sessionId, decoder.decode(value, { stream: true }));
        }
      }
    } catch {
      // stream ended
    }
  })();

  // Stream stderr (Python errors, docker errors)
  void (async () => {
    try {
      const reader = proc.stderr.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && onTerminalOutput) {
          onTerminalOutput(sessionId, decoder.decode(value, { stream: true }));
        }
      }
    } catch {
      // stream ended
    }
  })();

  // Wait for exit
  void (async () => {
    const code = await proc.exited;
    session.alive = false;
    terminalSessions.delete(sessionId);
    await runTerminalSessionCleanup(session);
    if (onTerminalExit) {
      onTerminalExit(sessionId, code);
    }
  })();

  return { sessionId, shell: resolvedShell };
}

export async function listLocalShells(): Promise<string[]> {
  const defaults = ["/bin/zsh", "/bin/bash", "/bin/sh"];
  try {
    const text = await Bun.file("/etc/shells").text();
    const parsed = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && line.startsWith("/"));
    const unique = Array.from(new Set(parsed));
    return unique.length > 0 ? unique : defaults;
  } catch {
    return defaults;
  }
}

export async function createLocalTerminalSession(
  shell?: string,
  cols = 80,
  rows = 24,
): Promise<{ sessionId: string; shell: string }> {
  const available = await listLocalShells();
  const preferred =
    typeof shell === "string" && shell.trim().length > 0
      ? shell.trim()
      : (process.env.SHELL ?? "").trim();
  const resolvedShell = available.includes(preferred)
    ? preferred
    : available[0] ?? "/bin/sh";

  const sessionId = `term_${++sessionCounter}_${Date.now()}`;
  const helperPath = ensurePtyHelper();
  const proc = spawnWithoutDockerHost(
    ["python3", helperPath, "--size", String(rows), String(cols), resolvedShell],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  const session: TerminalSession = { proc, alive: true };
  terminalSessions.set(sessionId, session);

  void (async () => {
    try {
      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && onTerminalOutput) onTerminalOutput(sessionId, decoder.decode(value, { stream: true }));
      }
    } catch {
      // stream ended
    }
  })();

  void (async () => {
    try {
      const reader = proc.stderr.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && onTerminalOutput) onTerminalOutput(sessionId, decoder.decode(value, { stream: true }));
      }
    } catch {
      // stream ended
    }
  })();

  void (async () => {
    const code = await proc.exited;
    session.alive = false;
    terminalSessions.delete(sessionId);
    if (onTerminalExit) onTerminalExit(sessionId, code);
  })();

  return { sessionId, shell: resolvedShell };
}

export async function createSshTerminalSession(
  sshHost: string,
  cols = 80,
  rows = 24,
): Promise<{ sessionId: string; shell: string }> {
  const parsedTarget = parseSshTarget(sshHost);
  if (!parsedTarget) {
    throw new Error("SSH host must be in ssh://user@host format.");
  }

  const sessionId = `term_${++sessionCounter}_${Date.now()}`;
  const helperPath = ensurePtyHelper();
  const sshArgs = ["ssh", "-tt"];
  if (parsedTarget.port) {
    sshArgs.push("-p", parsedTarget.port);
  }
  sshArgs.push(parsedTarget.target);
  const proc = spawnWithoutDockerHost(
    ["python3", helperPath, "--size", String(rows), String(cols), ...sshArgs],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  const session: TerminalSession = { proc, alive: true };
  terminalSessions.set(sessionId, session);

  void (async () => {
    try {
      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && onTerminalOutput) onTerminalOutput(sessionId, decoder.decode(value, { stream: true }));
      }
    } catch {
      // stream ended
    }
  })();

  void (async () => {
    try {
      const reader = proc.stderr.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && onTerminalOutput) onTerminalOutput(sessionId, decoder.decode(value, { stream: true }));
      }
    } catch {
      // stream ended
    }
  })();

  void (async () => {
    const code = await proc.exited;
    session.alive = false;
    terminalSessions.delete(sessionId);
    if (onTerminalExit) onTerminalExit(sessionId, code);
  })();

  return { sessionId, shell: "ssh" };
}

export async function createModelRunnerSession(
  modelName: string,
  cols = 80,
  rows = 24,
  dockerHost: string | null = null,
): Promise<{ sessionId: string; shell: string }> {
  const trimmed = (modelName ?? "").trim();
  if (!trimmed) {
    throw new Error("Model name is required.");
  }

  const sessionId = `term_${++sessionCounter}_${Date.now()}`;
  const helperPath = ensurePtyHelper();
  const effectiveDockerHost = normalizeDockerHost(dockerHost) ?? normalizeDockerHost(configuredDockerHost) ?? "";
  const modelRunArgs = rewriteDockerModelCommandForSsh(
    ["docker", "model", "run", trimmed],
    { forceTty: true },
    effectiveDockerHost || null,
  );
  const useDockerHostEnv = modelRunArgs[0] === "docker";
  const env = {
    ...process.env,
  } as Record<string, string | undefined>;
  if (useDockerHostEnv && effectiveDockerHost.length > 0) {
    env.DOCKER_HOST = effectiveDockerHost;
  } else if (!useDockerHostEnv) {
    delete env.DOCKER_HOST;
  }
  if (onTerminalOutput) {
    onTerminalOutput(
      sessionId,
      `\r\n\x1b[2m[ca] docker model run host=${effectiveDockerHost || "local-default"}\x1b[0m\r\n`,
    );
  }
  const spawn = useDockerHostEnv ? spawnWithDockerEnv : spawnWithoutDockerHost;
  const proc = spawn(
    [
      "python3",
      helperPath,
      "--size",
      String(rows),
      String(cols),
      ...modelRunArgs,
    ],
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env,
    },
  );

  const session: TerminalSession = { proc, alive: true };
  terminalSessions.set(sessionId, session);

  void (async () => {
    try {
      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && onTerminalOutput) {
          onTerminalOutput(sessionId, decoder.decode(value, { stream: true }));
        }
      }
    } catch {
      // stream ended
    }
  })();

  void (async () => {
    try {
      const reader = proc.stderr.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && onTerminalOutput) {
          onTerminalOutput(sessionId, decoder.decode(value, { stream: true }));
        }
      }
    } catch {
      // stream ended
    }
  })();

  void (async () => {
    const code = await proc.exited;
    session.alive = false;
    terminalSessions.delete(sessionId);
    if (onTerminalExit) {
      onTerminalExit(sessionId, code);
    }
  })();

  return { sessionId, shell: "model-run" };
}

export async function createDockerRunSession(
  image: string,
  args: string[] = [],
  cols = 80,
  rows = 24,
): Promise<{ sessionId: string; shell: string }> {
  const trimmed = (image ?? "").trim();
  if (!trimmed) {
    throw new Error("Image name is required.");
  }
  const runArgs = Array.isArray(args) ? args.map((entry) => String(entry)) : [];
  const sessionId = `term_${++sessionCounter}_${Date.now()}`;
  const helperPath = ensurePtyHelper();
  const proc = spawnWithDockerEnv(
    [
      "python3",
      helperPath,
      "--size",
      String(rows),
      String(cols),
      "docker",
      "run",
      "--rm",
      "-it",
      trimmed,
      ...runArgs,
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  const session: TerminalSession = { proc, alive: true };
  terminalSessions.set(sessionId, session);

  void (async () => {
    try {
      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && onTerminalOutput) onTerminalOutput(sessionId, decoder.decode(value, { stream: true }));
      }
    } catch {
      // stream ended
    }
  })();

  void (async () => {
    try {
      const reader = proc.stderr.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && onTerminalOutput) onTerminalOutput(sessionId, decoder.decode(value, { stream: true }));
      }
    } catch {
      // stream ended
    }
  })();

  void (async () => {
    const code = await proc.exited;
    session.alive = false;
    terminalSessions.delete(sessionId);
    if (onTerminalExit) onTerminalExit(sessionId, code);
  })();

  return { sessionId, shell: "docker-run" };
}

export async function createOllamaRunSession(
  modelName: string,
  cols = 80,
  rows = 24,
  ollamaHost: string | null = null,
): Promise<{ sessionId: string; shell: string }> {
  const trimmed = (modelName ?? "").trim();
  if (!trimmed) throw new Error("Model name is required.");

  const sessionId = `term_${++sessionCounter}_${Date.now()}`;
  const helperPath = ensurePtyHelper();
  const runArgs = rewriteOllamaCommandForSsh(
    ["ollama", "run", trimmed],
    { forceTty: true },
    ollamaHost,
  );
  const env = { ...process.env } as Record<string, string | undefined>;
  if (typeof ollamaHost === "string" && ollamaHost.trim().length > 0) {
    env.OLLAMA_HOST = ollamaHost.trim();
  }
  const proc = spawnWithoutDockerHost(
    ["python3", helperPath, "--size", String(rows), String(cols), ...runArgs],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe", env },
  );

  const session: TerminalSession = { proc, alive: true };
  terminalSessions.set(sessionId, session);

  void (async () => {
    try {
      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && onTerminalOutput) onTerminalOutput(sessionId, decoder.decode(value, { stream: true }));
      }
    } catch {
      // stream ended
    }
  })();

  void (async () => {
    try {
      const reader = proc.stderr.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && onTerminalOutput) onTerminalOutput(sessionId, decoder.decode(value, { stream: true }));
      }
    } catch {
      // stream ended
    }
  })();

  void (async () => {
    const code = await proc.exited;
    session.alive = false;
    terminalSessions.delete(sessionId);
    if (onTerminalExit) onTerminalExit(sessionId, code);
  })();

  return { sessionId, shell: "ollama-run" };
}

export async function createOllamaPullSession(
  modelName: string,
  cols = 80,
  rows = 24,
  ollamaHost: string | null = null,
): Promise<{ sessionId: string; shell: string }> {
  const trimmed = (modelName ?? "").trim();
  if (!trimmed) throw new Error("Model name is required.");

  const sessionId = `term_${++sessionCounter}_${Date.now()}`;
  const helperPath = ensurePtyHelper();
  const pullArgs = rewriteOllamaCommandForSsh(
    ["ollama", "pull", trimmed],
    { forceTty: true },
    ollamaHost,
  );
  const env = { ...process.env } as Record<string, string | undefined>;
  if (typeof ollamaHost === "string" && ollamaHost.trim().length > 0) {
    env.OLLAMA_HOST = ollamaHost.trim();
  }
  const proc = spawnWithoutDockerHost(
    ["python3", helperPath, "--size", String(rows), String(cols), ...pullArgs],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe", env },
  );

  const session: TerminalSession = { proc, alive: true };
  terminalSessions.set(sessionId, session);

  void (async () => {
    try {
      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && onTerminalOutput) onTerminalOutput(sessionId, decoder.decode(value, { stream: true }));
      }
    } catch {
      // stream ended
    }
  })();

  void (async () => {
    try {
      const reader = proc.stderr.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && onTerminalOutput) onTerminalOutput(sessionId, decoder.decode(value, { stream: true }));
      }
    } catch {
      // stream ended
    }
  })();

  void (async () => {
    const code = await proc.exited;
    session.alive = false;
    terminalSessions.delete(sessionId);
    if (onTerminalExit) onTerminalExit(sessionId, code);
  })();

  return { sessionId, shell: "ollama-pull" };
}

export async function createDockerImagePullSession(
  imageName: string,
  cols = 80,
  rows = 24,
): Promise<{ sessionId: string; shell: string }> {
  const trimmed = (imageName ?? "").trim();
  if (!trimmed) throw new Error("Image name is required.");

  const sessionId = `term_${++sessionCounter}_${Date.now()}`;
  const helperPath = ensurePtyHelper();
  const proc = spawnWithDockerEnv(
    ["python3", helperPath, "--size", String(rows), String(cols), "docker", "pull", trimmed],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );

  const session: TerminalSession = { proc, alive: true };
  terminalSessions.set(sessionId, session);

  void (async () => {
    try {
      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && onTerminalOutput) onTerminalOutput(sessionId, decoder.decode(value, { stream: true }));
      }
    } catch {
      // stream ended
    }
  })();

  void (async () => {
    try {
      const reader = proc.stderr.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && onTerminalOutput) onTerminalOutput(sessionId, decoder.decode(value, { stream: true }));
      }
    } catch {
      // stream ended
    }
  })();

  void (async () => {
    const code = await proc.exited;
    session.alive = false;
    terminalSessions.delete(sessionId);
    if (onTerminalExit) onTerminalExit(sessionId, code);
  })();

  return { sessionId, shell: "docker-image-pull" };
}

export async function createDockerModelPullSession(
  modelName: string,
  cols = 80,
  rows = 24,
  dockerHost: string | null = null,
): Promise<{ sessionId: string; shell: string }> {
  const trimmed = (modelName ?? "").trim();
  if (!trimmed) throw new Error("Model name is required.");

  const sessionId = `term_${++sessionCounter}_${Date.now()}`;
  const helperPath = ensurePtyHelper();
  const effectiveDockerHost = normalizeDockerHost(dockerHost) ?? normalizeDockerHost(configuredDockerHost) ?? "";
  const modelPullArgs = rewriteDockerModelCommandForSsh(
    ["docker", "model", "pull", trimmed],
    undefined,
    effectiveDockerHost || null,
  );
  const useDockerHostEnv = modelPullArgs[0] === "docker";
  const env = {
    ...process.env,
  } as Record<string, string | undefined>;
  if (useDockerHostEnv && effectiveDockerHost.length > 0) {
    env.DOCKER_HOST = effectiveDockerHost;
  } else if (!useDockerHostEnv) {
    delete env.DOCKER_HOST;
  }
  if (onTerminalOutput) {
    onTerminalOutput(
      sessionId,
      `\r\n\x1b[2m[ca] docker model pull host=${effectiveDockerHost || "local-default"}\x1b[0m\r\n`,
    );
  }
  const spawn = useDockerHostEnv ? spawnWithDockerEnv : spawnWithoutDockerHost;
  const proc = spawn(
    ["python3", helperPath, "--size", String(rows), String(cols), ...modelPullArgs],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe", env },
  );

  const session: TerminalSession = { proc, alive: true };
  terminalSessions.set(sessionId, session);

  void (async () => {
    try {
      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && onTerminalOutput) onTerminalOutput(sessionId, decoder.decode(value, { stream: true }));
      }
    } catch {
      // stream ended
    }
  })();

  void (async () => {
    try {
      const reader = proc.stderr.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && onTerminalOutput) onTerminalOutput(sessionId, decoder.decode(value, { stream: true }));
      }
    } catch {
      // stream ended
    }
  })();

  void (async () => {
    const code = await proc.exited;
    session.alive = false;
    terminalSessions.delete(sessionId);
    if (onTerminalExit) onTerminalExit(sessionId, code);
  })();

  return { sessionId, shell: "docker-model-pull" };
}

export function terminalInput(sessionId: string, data: string): void {
  const session = terminalSessions.get(sessionId);
  if (!session || !session.alive) {
    return;
  }
  const stdin = session.proc.stdin;
  if (!stdin || typeof stdin === "number") {
    return;
  }
  stdin.write(data);
  stdin.flush();
}

export function terminalResize(
  sessionId: string,
  cols: number,
  rows: number,
): void {
  // Send a special escape sequence that our Python PTY helper intercepts.
  // The helper calls ioctl(TIOCSWINSZ) + SIGWINCH — no text reaches the shell.
  const session = terminalSessions.get(sessionId);
  if (!session?.alive) return;
  const stdin = session.proc.stdin;
  if (!stdin || typeof stdin === "number") return;
  try {
    stdin.write(`\x1b]resize;${rows};${cols}\x07`);
    stdin.flush();
  } catch {
    // ignore
  }
}

export function destroyTerminalSession(sessionId: string): void {
  const session = terminalSessions.get(sessionId);
  if (!session) return;
  session.alive = false;
  try {
    session.proc.kill();
  } catch {
    // ignore
  }
  void runTerminalSessionCleanup(session);
  terminalSessions.delete(sessionId);
}

export function isTerminalSessionAlive(sessionId: string): boolean {
  const session = terminalSessions.get(sessionId);
  return Boolean(session?.alive);
}

// (exported above)
