/**
 * Bun dev server for the React renderer.
 * During development, the Electrobun webview points at this server
 * so we get hot module reloading without rebuilding the entire app.
 *
 * The server bundles the app on startup using Bun.build() with the
 * Tailwind plugin, then serves the bundled output. Run with:
 *
 *   bun --hot src/dev-server.ts
 *
 * `--hot` makes Bun reload this module when any imported file changes,
 * triggering a re-bundle automatically.
 *
 * It also exposes /api/docker/* endpoints so that Docker operations
 * work in the browser without the Electrobun RPC bridge, and a
 * WebSocket at /api/ws for real-time communication (terminal I/O,
 * container state changes via docker events, log streaming).
 */

import plugin from "bun-plugin-tailwind";
import { join } from "path";
import { homedir } from "os";
import * as docker from "./bun/docker";
import * as ollama from "./bun/ollama";
import * as modelProviders from "./bun/modelProviders";
import { getTerminalDaemonClient } from "./bun/terminalDaemonClient";
import * as appStorage from "./bun/appStorageBackend";

const PORT = Number(process.env.DEV_SERVER_PORT) || 4888;
const OUT_DIR = join(import.meta.dir, "..", ".dev-server-out");
const HOST_CONTAINER_NAME = "context-assistant-host";
const terminalDaemonClient = getTerminalDaemonClient(
  join(homedir(), ".context-assistant", "terminal-daemon"),
);

// Stop the internal host container when the dev server exits (best-effort).
// Bun `--hot` can reload this module without exiting; guard to avoid duplicate handlers.
const globalKey = "__context_assistant_host_cleanup_registered__";
if (!(globalThis as any)[globalKey]) {
  (globalThis as any)[globalKey] = true;

  const stopHostContainer = async () => {
    try {
      const containers = await docker.listContainers();
      const host = containers.find((c) => c.name === HOST_CONTAINER_NAME);
      if (host && host.state === "running") {
        await docker.stopContainer(host.id);
      }
    } catch {
      // ignore
    }
  };

  const handleSignal = (signal: string) => {
    // Do not await synchronously; we still try to stop before exit.
    void (async () => {
      await stopHostContainer();
      // eslint-disable-next-line no-process-exit
      process.exit(0);
    })();
    console.log(`[dev-server] Received ${signal}, stopping ${HOST_CONTAINER_NAME}...`);
  };

  process.on("SIGINT", () => handleSignal("SIGINT"));
  process.on("SIGTERM", () => handleSignal("SIGTERM"));
}

// ---------------------------------------------------------------------------
// Bundle the renderer on startup (re-runs on every --hot reload)
// ---------------------------------------------------------------------------

const buildStart = performance.now();

const result = await Bun.build({
  entrypoints: [join(import.meta.dir, "index.html")],
  outdir: OUT_DIR,
  plugins: [plugin],
  target: "browser",
  minify: false,
  sourcemap: "inline",
  define: {
    "process.env.NODE_ENV": JSON.stringify("development"),
  },
});

if (!result.success) {
  console.error("[dev-server] Build failed:", result.logs);
} else {
  const elapsed = (performance.now() - buildStart).toFixed(0);
  console.log(`[dev-server] Bundled in ${elapsed}ms → ${OUT_DIR}`);
}

// ---------------------------------------------------------------------------
// Docker API handler (mirrors the RPC handlers from src/bun/index.ts)
// ---------------------------------------------------------------------------

type DockerHandler = (params: any) => Promise<any>;

const dockerHandlers: Record<string, DockerHandler> = {
  available: async () => ({
    available: await docker.dockerAvailable(),
  }),
  setHost: async ({ dockerHost }) => {
    const value = typeof dockerHost === "string" ? dockerHost : null;
    docker.configureDockerHost(value);
    return { ok: true };
  },
  listContainers: async () => ({
    containers: await docker.listContainers(),
  }),
  createContainer: async (params) => ({
    containerId: await docker.createContainer(params),
  }),
  startContainer: async ({ containerId }) => {
    await docker.startContainer(containerId);
    return { ok: true };
  },
  stopContainer: async ({ containerId }) => {
    await docker.stopContainer(containerId);
    return { ok: true };
  },
  removeContainer: async ({ containerId, force }) => {
    await docker.removeContainer(containerId, force);
    return { ok: true };
  },
  inspectContainer: async ({ containerId }) =>
    await docker.inspectContainer(containerId),
  containerStats: async ({ containerId }) =>
    await docker.getContainerStats(containerId),
  containerLogs: async ({ containerId, tail }) => ({
    logs: await docker.getContainerLogs(containerId, tail ?? 200),
  }),
  containerExec: async ({ containerId, command }) =>
    await docker.containerExec(containerId, command),
  containerExecAs: async ({ containerId, user, command }) =>
    await docker.containerExecAs(containerId, user, command),
  listVolumes: async () => ({
    volumes: await docker.listVolumes(),
  }),
  createVolume: async ({ name }) => await docker.createVolume(name),
  removeVolume: async ({ name }) => {
    await docker.removeVolume(name);
    return { ok: true };
  },
  inspectVolume: async ({ name }) => await docker.inspectVolume(name),
  installBashDevToolsVolume: async ({ volumeName, scope }) =>
    await docker.installBashDevToolsOnVolume(volumeName, scope),
  listNetworks: async () => ({
    networks: await docker.listNetworks(),
  }),
  removeNetwork: async ({ name }) => {
    await docker.removeNetwork(name);
    return { ok: true };
  },
  listAiModels: async () => ({
    models: await docker.listAiModels().catch((error) => {
      const message = error instanceof Error ? error.message : String(error ?? "");
      if (/cannot connect to the docker daemon/i.test(message)) {
        return [];
      }
      throw error;
    }),
  }),
  removeAiModel: async ({ name }) => {
    await docker.removeAiModel(name);
    return { ok: true };
  },
  unloadAiModel: async ({ name }) => {
    await docker.unloadAiModel(name);
    return { ok: true };
  },
  listFiles: async ({ containerId, path }) => ({
    entries: await docker.listFiles(containerId, path),
  }),
  readFile: async ({ containerId, path }) => ({
    content: await docker.readFile(containerId, path),
  }),
  readFileBase64: async ({ containerId, path }) => ({
    contentBase64: await docker.readFileBase64(containerId, path),
  }),
  writeFile: async ({ containerId, path, content }) => {
    await docker.writeFile(containerId, path, content);
    return { ok: true };
  },
  createDirectory: async ({ containerId, path }) => {
    await docker.createDirectory(containerId, path);
    return { ok: true };
  },
  deleteFile: async ({ containerId, path }) => {
    await docker.deleteFile(containerId, path);
    return { ok: true };
  },
  renameFile: async ({ containerId, oldPath, newPath }) => {
    await docker.renameFile(containerId, oldPath, newPath);
    return { ok: true };
  },
  importFiles: async ({ containerId, targetDirectory, entries }) => {
    await docker.importFiles(containerId, targetDirectory, entries);
    return { ok: true };
  },
  listImages: async () => ({
    images: await docker.listImages(),
  }),
  removeImage: async ({ image, force }) => {
    await docker.removeImage(image, force);
    return { ok: true };
  },
  pruneDanglingImages: async () => {
    await docker.pruneDanglingImages();
    return { ok: true };
  },
  imageUsers: async ({ image }) => ({
    users: await docker.listImageUsers(image),
  }),
  buildImage: async ({ dockerfile, tag }) => ({
    output: await docker.buildImage(dockerfile, tag),
  }),
  commitContainer: async ({ containerId, image }) => ({
    imageId: await docker.commitContainer(containerId, image),
  }),
  inspectImageDeclaredVolumes: async ({ image }) => ({
    volumes: await docker.inspectImageDeclaredVolumes(image),
  }),
  attachVolume: async ({ containerId, volumeName, mountPath }) => ({
    newContainerId: await docker.attachVolumeToContainer(containerId, volumeName, mountPath),
  }),
  recreateWritable: async ({ containerId }) => ({
    newContainerId: await docker.recreateContainerWritable(containerId),
  }),
  terminalCreate: async ({ containerId, shell, cols, rows, cwd, dockerHost }) =>
    await terminalDaemonClient.createSession(
      { kind: "docker-exec", containerId, shell, cwd, dockerHost: dockerHost ?? null },
      cols,
      rows,
    ),
  listLocalShells: async () => ({
    shells: await terminalDaemonClient.listLocalShells().then((res) => res.shells),
  }),
  terminalCreateLocal: async ({ shell, cols, rows }) =>
    await terminalDaemonClient.createSession({ kind: "local", shell }, cols, rows),
  terminalCreateSsh: async ({ sshHost, cols, rows }: { sshHost: string; cols?: number; rows?: number }) =>
    await terminalDaemonClient.createSession({ kind: "ssh", sshHost }, cols, rows),
  terminalCreateModelRun: async ({ modelName, cols, rows, dockerHost }) =>
    await terminalDaemonClient.createSession(
      { kind: "docker-model-run", modelName, dockerHost: dockerHost ?? null },
      cols,
      rows,
    ),
  terminalCreateDockerRun: async ({ image, args, cols, rows, dockerHost }: { image: string; args?: string[]; cols?: number; rows?: number; dockerHost?: string | null }) =>
    await terminalDaemonClient.createSession(
      { kind: "docker-run", image, args, dockerHost: dockerHost ?? null },
      cols,
      rows,
    ),
  terminalCreateImagePull: async ({ imageName, cols, rows, dockerHost }: { imageName: string; cols?: number; rows?: number; dockerHost?: string | null }) =>
    await terminalDaemonClient.createSession(
      { kind: "docker-image-pull", imageName, dockerHost: dockerHost ?? null },
      cols,
      rows,
    ),
  terminalCreateModelPull: async ({ modelName, cols, rows, dockerHost }: { modelName: string; cols?: number; rows?: number; dockerHost?: string | null }) =>
    await terminalDaemonClient.createSession(
      { kind: "docker-model-pull", modelName, dockerHost: dockerHost ?? null },
      cols,
      rows,
    ),
  terminalAttach: async ({ sessionId, cols, rows }: { sessionId: string; cols?: number; rows?: number }) =>
    await terminalDaemonClient.attachSession(sessionId, cols, rows),
  terminalList: async () =>
    await terminalDaemonClient.listSessions(),
  ollamaAvailable: async () => ({ available: await ollama.ollamaAvailable() }),
  ollamaSetHost: async ({ ollamaHost }: { ollamaHost: string | null }) => {
    const value = typeof ollamaHost === "string" ? ollamaHost : null;
    ollama.configureOllamaHost(value);
    return { ok: true };
  },
  ollamaListModels: async () => ({ models: await ollama.listOllamaModels() }),
  ollamaRemoveModel: async ({ name }: { name: string }) => {
    await ollama.removeOllamaModel(name);
    return { ok: true };
  },
  ollamaUnloadModel: async ({ name }: { name: string }) => {
    await ollama.unloadOllamaModel(name);
    return { ok: true };
  },
  ollamaTerminalCreateRun: async (
    { modelName, cols, rows, ollamaHost }: { modelName: string; cols?: number; rows?: number; ollamaHost?: string | null },
  ) =>
    await terminalDaemonClient.createSession(
      { kind: "ollama-run", modelName, ollamaHost: ollamaHost ?? null },
      cols,
      rows,
    ),
  ollamaTerminalCreatePull: async (
    { modelName, cols, rows, ollamaHost }: { modelName: string; cols?: number; rows?: number; ollamaHost?: string | null },
  ) =>
    await terminalDaemonClient.createSession(
      { kind: "ollama-pull", modelName, ollamaHost: ollamaHost ?? null },
      cols,
      rows,
    ),
  modelProviderHttpRequest: async (params: {
    url: string;
    method?: "GET" | "POST";
    headers?: Record<string, string>;
    body?: string;
  }) => await modelProviders.proxyModelProviderHttpRequest(params),
  terminalInput: async ({ sessionId, data }) => {
    await terminalDaemonClient.sessionInput(sessionId, data);
    return { ok: true };
  },
  terminalResize: async ({ sessionId, cols, rows }) => {
    await terminalDaemonClient.sessionResize(sessionId, cols, rows);
    return { ok: true };
  },
  terminalDestroy: async ({ sessionId }) => {
    await terminalDaemonClient.sessionDestroy(sessionId);
    return { ok: true };
  },
  terminalDestroyMany: async ({ sessionIds }) => {
    await terminalDaemonClient.sessionDestroyMany(sessionIds ?? []);
    return { ok: true };
  },
};

const storageHandlers: Record<string, DockerHandler> = {
  storage_get: async ({ key }) => {
    const value = await appStorage.storageGet(key);
    return { value };
  },
  storage_set: async ({ key, value }) => {
    await appStorage.storageSet(key, value);
    return { ok: true };
  },
  storage_remove: async ({ key }) => {
    await appStorage.storageRemove(key);
    return { ok: true };
  },
  storage_getAll: async () => {
    const data = await appStorage.storageGetAll();
    return { data };
  },
  storage_clear: async () => {
    await appStorage.storageClear();
    return { ok: true };
  },
};

async function handleStorageApi(
  method: string,
  request: Request,
): Promise<Response> {
  const handler = storageHandlers[method];
  if (!handler) {
    return Response.json({ error: `Unknown storage method: ${method}` }, { status: 404 });
  }
  try {
    const params =
      request.method === "POST" ? await request.json().catch(() => ({})) : {};
    const result = await handler(params);
    return Response.json(result);
  } catch (e: any) {
    const message = e instanceof Error ? e.message : String(e);
    return Response.json({ error: message }, { status: 500 });
  }
}

async function handleDockerApi(
  method: string,
  request: Request,
): Promise<Response> {
  const handler = dockerHandlers[method];
  if (!handler) {
    return Response.json({ error: `Unknown method: ${method}` }, { status: 404 });
  }
  try {
    const params =
      request.method === "POST" ? await request.json().catch(() => ({})) : {};
    const result = await handler(params);
    return Response.json(result);
  } catch (e: any) {
    const { message, status } = normalizeDockerError(e);
    return Response.json(
      { error: message },
      { status },
    );
  }
}

async function invokeDockerMethod(method: string, params: unknown) {
  const handler = dockerHandlers[method];
  if (!handler) {
    const err = new Error(`Unknown method: ${method}`) as Error & { status?: number };
    err.status = 404;
    throw err;
  }
  return await handler(params);
}

async function invokeMethod(method: string, params: unknown) {
  const storageHandler = storageHandlers[method];
  if (storageHandler) return await storageHandler(params);
  return await invokeDockerMethod(method, params);
}

function normalizeDockerError(e: unknown): { message: string; status: number } {
  const anyErr = e as { message?: string; status?: number };
  const message = anyErr?.message ?? String(e);
  if (typeof anyErr?.status === "number") {
    return { message, status: anyErr.status };
  }
  const lower = message.toLowerCase();
  const status =
    lower.includes("no such container") ||
    lower.includes("container not found") ||
    lower.includes("no such object") ||
    lower.includes("no such volume") ||
    lower.includes("volume not found") ||
    lower.includes("no such network") ||
    lower.includes("network not found") ||
    lower.includes("session no longer running") ||
    lower.includes("session not found")
      ? 404
      : lower.includes("cannot connect to the docker daemon") ||
          lower.includes("error during connect") ||
          lower.includes("is the docker daemon running") ||
          lower.includes("dial unix") ||
          lower.includes("connect: permission denied") ||
          lower.includes("docker socket not found")
        ? 503
        : 500;
  return { message, status };
}

// ---------------------------------------------------------------------------
// WebSocket — general-purpose channel for real-time communication
// Handles: terminal I/O, container list push, log streaming
// ---------------------------------------------------------------------------

type WsData = {
  subscribedContainers: boolean;
  logStreams: Map<string, ReturnType<typeof Bun.spawn>>;
};

const wsClients = new Set<import("bun").ServerWebSocket<WsData>>();

function broadcast(msg: string, filter?: (ws: import("bun").ServerWebSocket<WsData>) => boolean) {
  for (const ws of wsClients) {
    if (filter && !filter(ws)) continue;
    try { ws.send(msg); } catch { /* dead socket */ }
  }
}

// -- Terminal callbacks (push output/exit to all WS clients) ----------------
terminalDaemonClient.onOutput((sessionId, data) => {
  broadcast(JSON.stringify({ type: "output", sessionId, data }));
});
terminalDaemonClient.onExit((sessionId, code) => {
  broadcast(JSON.stringify({ type: "exit", sessionId, code }));
});

// -- Docker events watcher (push container list changes) --------------------

let dockerEventsProc: ReturnType<typeof Bun.spawn> | null = null;
let containerDebounceTimer: ReturnType<typeof setTimeout> | null = null;

async function broadcastContainerList() {
  try {
    const containers = await docker.listContainers();
    broadcast(
      JSON.stringify({ type: "containersChanged", containers }),
      (ws) => ws.data.subscribedContainers,
    );
  } catch { /* ignore — docker may not be available */ }
}

function startDockerEventsWatcher() {
  if (dockerEventsProc) return;
  try {
    const proc = Bun.spawn(
      [
        "docker",
        "events",
        "--format",
        "{{json .}}",
        "--filter",
        "type=container",
        // Only lifecycle/state events that affect container listing/state.
        // Exclude noisy events like exec_start/exec_die that can occur constantly.
        "--filter",
        "event=create",
        "--filter",
        "event=destroy",
        "--filter",
        "event=start",
        "--filter",
        "event=stop",
        "--filter",
        "event=die",
        "--filter",
        "event=kill",
        "--filter",
        "event=restart",
        "--filter",
        "event=rename",
        "--filter",
        "event=pause",
        "--filter",
        "event=unpause",
      ],
      { stdout: "pipe", stderr: "pipe", env: { ...process.env } },
    );
    dockerEventsProc = proc;

    void (async () => {
      const reader = proc.stdout.getReader();
      try {
        while (true) {
          const { done } = await reader.read();
          if (done) break;
          if (containerDebounceTimer) clearTimeout(containerDebounceTimer);
          containerDebounceTimer = setTimeout(() => void broadcastContainerList(), 500);
        }
      } catch { /* stream ended */ }
      dockerEventsProc = null;
      setTimeout(startDockerEventsWatcher, 5000);
    })();

    void proc.exited.then(() => { dockerEventsProc = null; });
  } catch {
    dockerEventsProc = null;
    setTimeout(startDockerEventsWatcher, 5000);
  }
}

startDockerEventsWatcher();

// -- Log streaming helpers --------------------------------------------------

function startLogStream(
  ws: import("bun").ServerWebSocket<WsData>,
  containerId: string,
  tail: number,
) {
  stopLogStream(ws, containerId);
  try {
    const proc = Bun.spawn(
      ["docker", "logs", "-f", "--tail", String(tail), containerId],
      { stdout: "pipe", stderr: "pipe", env: { ...process.env } },
    );
    ws.data.logStreams.set(containerId, proc);

    const pipeStream = async (reader: ReadableStreamDefaultReader<Uint8Array>) => {
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const data = decoder.decode(value, { stream: true });
          try {
            ws.send(JSON.stringify({ type: "logData", containerId, data }));
          } catch { break; }
        }
      } catch { /* stream ended */ }
    };

    void pipeStream(proc.stdout.getReader());
    void pipeStream(proc.stderr.getReader());
  } catch { /* ignore */ }
}

function stopLogStream(
  ws: import("bun").ServerWebSocket<WsData>,
  containerId: string,
) {
  const proc = ws.data.logStreams.get(containerId);
  if (proc) {
    try { proc.kill(); } catch { /* ignore */ }
    ws.data.logStreams.delete(containerId);
  }
}

function cleanupWsClient(ws: import("bun").ServerWebSocket<WsData>) {
  for (const [, proc] of ws.data.logStreams) {
    try { proc.kill(); } catch { /* ignore */ }
  }
  ws.data.logStreams.clear();
  wsClients.delete(ws);
}

// ---------------------------------------------------------------------------
// Serve the bundled output + Docker API
// ---------------------------------------------------------------------------

const server = Bun.serve<WsData>({
  port: PORT,
  async fetch(request, server) {
    const url = new URL(request.url);
    let pathname = url.pathname;

    // WebSocket upgrade (general-purpose channel)
    if (pathname === "/api/ws") {
      const upgraded = server.upgrade(request, {
        data: {
          subscribedContainers: false,
          logStreams: new Map(),
        },
      });
      if (!upgraded) {
        return new Response("WebSocket upgrade failed", { status: 400 });
      }
      return undefined as any;
    }

    // Storage API (app data folder, same location as built app)
    const storagePrefix = "/api/storage/";
    if (pathname.startsWith(storagePrefix)) {
      const method = pathname.slice(storagePrefix.length);
      return handleStorageApi(method, request);
    }

    // Docker API routes (kept for one-shot request/response operations)
    const apiPrefix = "/api/docker/";
    if (pathname.startsWith(apiPrefix)) {
      const method = pathname.slice(apiPrefix.length);
      return handleDockerApi(method, request);
    }

    if (pathname === "/") pathname = "/index.html";

    // Try serving from the build output
    const outFile = Bun.file(join(OUT_DIR, pathname));
    if (await outFile.exists()) {
      return new Response(outFile);
    }

    // Serve static assets from src/ (images, svgs, etc.)
    const srcFile = Bun.file(join(import.meta.dir, pathname.slice(1)));
    if (await srcFile.exists()) {
      return new Response(srcFile);
    }

    // Serve static assets from project root (design/, assets/, etc.)
    const rootFile = Bun.file(join(import.meta.dir, "..", pathname.slice(1)));
    if (await rootFile.exists()) {
      return new Response(rootFile);
    }

    // SPA fallback
    return new Response(Bun.file(join(OUT_DIR, "index.html")));
  },
  websocket: {
    open(ws) {
      wsClients.add(ws);
    },
    message(ws, message) {
      try {
        const msg = JSON.parse(String(message));
        switch (msg.type) {
          case "terminalInput":
            void terminalDaemonClient.sessionInput(msg.sessionId, msg.data);
            break;
          case "terminalResize":
            void terminalDaemonClient.sessionResize(msg.sessionId, msg.cols, msg.rows);
            break;
          case "subscribe":
            if (msg.channel === "containers") {
              ws.data.subscribedContainers = true;
              void (async () => {
                try {
                  const containers = await docker.listContainers();
                  ws.send(JSON.stringify({ type: "containersChanged", containers }));
                } catch { /* ignore */ }
              })();
            } else if (msg.channel === "logs" && msg.containerId) {
              startLogStream(ws, msg.containerId, msg.tail ?? 200);
            }
            break;
          case "unsubscribe":
            if (msg.channel === "containers") {
              ws.data.subscribedContainers = false;
            } else if (msg.channel === "logs" && msg.containerId) {
              stopLogStream(ws, msg.containerId);
            }
            break;
          case "request": {
            const id = String(msg.id ?? "");
            const method = String(msg.method ?? "");
            if (!id || !method) {
              ws.send(JSON.stringify({ type: "response", id, error: "Invalid request envelope" }));
              break;
            }
            void (async () => {
              try {
                const result = await invokeMethod(method, msg.params ?? {});
                ws.send(JSON.stringify({ type: "response", id, result }));
              } catch (error) {
                const { message } = normalizeDockerError(error);
                ws.send(JSON.stringify({ type: "response", id, error: message }));
              }
            })();
            break;
          }
        }
      } catch { /* ignore malformed messages */ }
    },
    close(ws) {
      cleanupWsClient(ws);
    },
  },
  development: true,
});

console.log(`[dev-server] listening on http://localhost:${server.port}`);
