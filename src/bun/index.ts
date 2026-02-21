import {
  ApplicationMenu,
  BrowserView,
  BrowserWindow,
  Updater,
  Utils,
} from "electrobun";
import { secrets } from "bun";
import type { AppRPCSchema, UpdateInfo } from "../electrobun/rpcSchema";
import { mkdirSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import * as docker from "./docker";
import * as ollama from "./ollama";
import * as modelProviders from "./modelProviders";
import { getTerminalDaemonClient } from "./terminalDaemonClient";
import * as appStorage from "./appStorageBackend";

const HOST_CONTAINER_NAME = "context-assistant-host";

// Best-effort cleanup: stop the internal host container on app shutdown signals.
// Guard in case this module is reloaded.
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
    void (async () => {
      await stopHostContainer();
      // eslint-disable-next-line no-process-exit
      process.exit(0);
    })();
    console.log(`[bun] Received ${signal}, stopping ${HOST_CONTAINER_NAME}...`);
  };

  process.on("SIGINT", () => handleSignal("SIGINT"));
  process.on("SIGTERM", () => handleSignal("SIGTERM"));
}

function sanitizeKey(key: string) {
  // Keep it conservative: prevents accidental path-like keys, etc.
  // You can loosen this later if needed.
  if (!/^[a-zA-Z0-9._:-]{1,128}$/.test(key)) {
    throw new Error(
      `Invalid secret key "${key}". Use 1-128 chars of [a-zA-Z0-9._:-].`,
    );
  }
  return key;
}

async function getSecretsServiceName() {
  // Namespaced by app identifier so different Electrobun apps don't collide.
  const info = await Updater.getLocallocalInfo();
  return info.identifier;
}

function broadcastUpdateInfo(info: UpdateInfo) {
  for (const view of BrowserView.getAll()) {
    try {
      view.rpc?.send.updater_updateInfoChanged(info);
    } catch {
      // ignore
    }
  }
}

function broadcastContainersChanged(containers: Awaited<ReturnType<typeof docker.listContainers>>) {
  for (const view of BrowserView.getAll()) {
    try {
      view.rpc?.send.docker_containersChanged({ containers });
    } catch {
      // ignore
    }
  }
}

function broadcastLogData(containerId: string, data: string) {
  for (const view of BrowserView.getAll()) {
    try {
      view.rpc?.send.docker_logData({ containerId, data });
    } catch {
      // ignore
    }
  }
}

let terminalDaemonClient = getTerminalDaemonClient();

function terminalClient() {
  return terminalDaemonClient;
}

let dockerEventsProc: ReturnType<typeof Bun.spawn> | null = null;
let containerDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let containerSubscribers = 0;
const logSubscriptions = new Map<string, number>();
const logStreams = new Map<string, ReturnType<typeof Bun.spawn>>();

async function broadcastContainerListIfSubscribed() {
  if (containerSubscribers <= 0) return;
  try {
    const containers = await docker.listContainers();
    broadcastContainersChanged(containers);
  } catch {
    // ignore transient docker failures
  }
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
          containerDebounceTimer = setTimeout(() => void broadcastContainerListIfSubscribed(), 500);
        }
      } catch {
        // stream closed
      }
      dockerEventsProc = null;
      setTimeout(startDockerEventsWatcher, 5000);
    })();
    void proc.exited.then(() => {
      dockerEventsProc = null;
    });
  } catch {
    dockerEventsProc = null;
    setTimeout(startDockerEventsWatcher, 5000);
  }
}

function startLogStream(containerId: string, tail: number) {
  stopLogStream(containerId);
  try {
    const proc = Bun.spawn(
      ["docker", "logs", "-f", "--tail", String(tail), containerId],
      { stdout: "pipe", stderr: "pipe", env: { ...process.env } },
    );
    logStreams.set(containerId, proc);

    const pipeStream = async (reader: ReadableStreamDefaultReader<Uint8Array>) => {
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          const data = decoder.decode(value, { stream: true });
          if (data) broadcastLogData(containerId, data);
        }
      } catch {
        // stream closed
      }
    };
    void pipeStream(proc.stdout.getReader());
    void pipeStream(proc.stderr.getReader());
  } catch {
    // ignore
  }
}

function stopLogStream(containerId: string) {
  const proc = logStreams.get(containerId);
  if (!proc) return;
  try {
    proc.kill();
  } catch {
    // ignore
  }
  logStreams.delete(containerId);
}

startDockerEventsWatcher();

const rpc = BrowserView.defineRPC<AppRPCSchema>({
  handlers: {
    requests: {
      updater_getUpdateInfo: async () => {
        // Workaround: Updater.updateInfo() returns an internal singleton object.
        // We snapshot it so the renderer gets a plain JSON-able value.
        const info = Updater.updateInfo?.();
        return info ? { ...info } : null;
      },

      updater_checkForUpdate: async () => {
        const info = (await Updater.checkForUpdate()) as UpdateInfo;
        broadcastUpdateInfo(info);
        return info;
      },

      updater_downloadUpdate: async () => {
        await Updater.downloadUpdate();
        const info = Updater.updateInfo?.() as UpdateInfo;
        broadcastUpdateInfo(info);
        return { ...info };
      },

      updater_applyUpdate: async () => {
        await Updater.applyUpdate();
        return { ok: true };
      },

      secrets_get: async ({ key }) => {
        const service = await getSecretsServiceName();
        const value = await secrets.get({
          service,
          name: sanitizeKey(key),
        });
        return { value };
      },

      secrets_set: async ({ key, value }) => {
        const service = await getSecretsServiceName();
        await secrets.set({
          service,
          name: sanitizeKey(key),
          value,
        });
        return { ok: true };
      },

      secrets_delete: async ({ key }) => {
        const service = await getSecretsServiceName();
        const ok = await secrets.delete({
          service,
          name: sanitizeKey(key),
        });
        return { ok };
      },

      // App data storage (Electrobun app data folder)
      storage_get: async ({ key }) => {
        const baseFolder = await Updater.appDataFolder();
        const value = await appStorage.storageGet(key, { baseFolder });
        return { value };
      },
      storage_set: async ({ key, value }) => {
        const baseFolder = await Updater.appDataFolder();
        await appStorage.storageSet(key, value, { baseFolder });
        return { ok: true };
      },
      storage_remove: async ({ key }) => {
        const baseFolder = await Updater.appDataFolder();
        await appStorage.storageRemove(key, { baseFolder });
        return { ok: true };
      },
      storage_getAll: async () => {
        const baseFolder = await Updater.appDataFolder();
        const data = await appStorage.storageGetAll({ baseFolder });
        return { data };
      },
      storage_clear: async () => {
        const baseFolder = await Updater.appDataFolder();
        await appStorage.storageClear({ baseFolder });
        return { ok: true };
      },
      storage_resetWindowState: async () => {
        const path = await getWindowStatePath();
        try {
          unlinkSync(path);
        } catch {
          // ignore if file doesn't exist
        }
        return { ok: true };
      },

      modelProvider_httpRequest: async (params) => {
        return await modelProviders.proxyModelProviderHttpRequest(params);
      },

      // ----- Docker: availability -----
      docker_available: async () => {
        const available = await docker.dockerAvailable();
        return { available };
      },
      docker_setHost: async ({ dockerHost }) => {
        const value = typeof dockerHost === "string" ? dockerHost : null;
        docker.configureDockerHost(value);
        return { ok: true };
      },

      // ----- Docker: container operations -----
      docker_listContainers: async () => {
        const containers = await docker.listContainers();
        return { containers };
      },
      docker_createContainer: async (params) => {
        const containerId = await docker.createContainer(params);
        void broadcastContainerListIfSubscribed();
        return { containerId };
      },
      docker_startContainer: async ({ containerId }) => {
        await docker.startContainer(containerId);
        void broadcastContainerListIfSubscribed();
        return { ok: true };
      },
      docker_stopContainer: async ({ containerId }) => {
        await docker.stopContainer(containerId);
        void broadcastContainerListIfSubscribed();
        return { ok: true };
      },
      docker_removeContainer: async ({ containerId, force }) => {
        await docker.removeContainer(containerId, force);
        void broadcastContainerListIfSubscribed();
        return { ok: true };
      },
      docker_inspectContainer: async ({ containerId }) => {
        return await docker.inspectContainer(containerId);
      },
      docker_containerStats: async ({ containerId }) => {
        return await docker.getContainerStats(containerId);
      },
      docker_containerLogs: async ({ containerId, tail }) => {
        const logs = await docker.getContainerLogs(containerId, tail ?? 200);
        return { logs };
      },
      docker_containerExec: async ({ containerId, command }) => {
        return await docker.containerExec(containerId, command);
      },
      docker_containerExecAs: async ({ containerId, user, command }) => {
        return await docker.containerExecAs(containerId, user, command);
      },

      // ----- Docker: volume operations -----
      docker_listVolumes: async () => {
        const volumes = await docker.listVolumes();
        return { volumes };
      },
      docker_createVolume: async ({ name }) => {
        return await docker.createVolume(name);
      },
      docker_removeVolume: async ({ name }) => {
        await docker.removeVolume(name);
        return { ok: true };
      },
      docker_inspectVolume: async ({ name }) => {
        return await docker.inspectVolume(name);
      },
      docker_installBashDevToolsVolume: async ({ volumeName, scope }) => {
        return await docker.installBashDevToolsOnVolume(volumeName, scope);
      },
      docker_listNetworks: async () => {
        const networks = await docker.listNetworks();
        return { networks };
      },
      docker_removeNetwork: async ({ name }) => {
        await docker.removeNetwork(name);
        return { ok: true };
      },
      docker_listAiModels: async () => {
        const models = await docker.listAiModels();
        return { models };
      },
      docker_removeAiModel: async ({ name }) => {
        await docker.removeAiModel(name);
        return { ok: true };
      },
      docker_unloadAiModel: async ({ name }) => {
        await docker.unloadAiModel(name);
        return { ok: true };
      },

      // ----- Docker: file operations -----
      docker_listFiles: async ({ containerId, path }) => {
        const entries = await docker.listFiles(containerId, path);
        return { entries };
      },
      docker_readFile: async ({ containerId, path }) => {
        const content = await docker.readFile(containerId, path);
        return { content };
      },
      docker_readFileBase64: async ({ containerId, path }) => {
        const contentBase64 = await docker.readFileBase64(containerId, path);
        return { contentBase64 };
      },
      docker_writeFile: async ({ containerId, path, content }) => {
        await docker.writeFile(containerId, path, content);
        return { ok: true };
      },
      docker_createDirectory: async ({ containerId, path }) => {
        await docker.createDirectory(containerId, path);
        return { ok: true };
      },
      docker_deleteFile: async ({ containerId, path }) => {
        await docker.deleteFile(containerId, path);
        return { ok: true };
      },
      docker_renameFile: async ({ containerId, oldPath, newPath }) => {
        await docker.renameFile(containerId, oldPath, newPath);
        return { ok: true };
      },
      docker_importFiles: async ({ containerId, targetDirectory, entries }) => {
        await docker.importFiles(containerId, targetDirectory, entries);
        return { ok: true };
      },

      // ----- Docker: image operations -----
      docker_listImages: async () => {
        const images = await docker.listImages();
        return { images };
      },
      docker_removeImage: async ({ image, force }) => {
        await docker.removeImage(image, force);
        return { ok: true };
      },
      docker_pruneDanglingImages: async () => {
        await docker.pruneDanglingImages();
        return { ok: true };
      },
      docker_imageUsers: async ({ image }) => {
        const users = await docker.listImageUsers(image);
        return { users };
      },
      docker_buildImage: async ({ dockerfile, tag }) => {
        const output = await docker.buildImage(dockerfile, tag);
        return { output };
      },
      docker_commitContainer: async ({ containerId, image }) => {
        const imageId = await docker.commitContainer(containerId, image);
        return { imageId };
      },
      docker_imageDeclaredVolumes: async ({ image }) => {
        const volumes = await docker.inspectImageDeclaredVolumes(image);
        return { volumes };
      },

      // ----- Docker: volume attachment -----
      docker_attachVolume: async ({ containerId, volumeName, mountPath }) => {
        const newContainerId = await docker.attachVolumeToContainer(containerId, volumeName, mountPath);
        return { newContainerId };
      },

      docker_recreateWritable: async ({ containerId }) => {
        const newContainerId = await docker.recreateContainerWritable(containerId);
        return { newContainerId };
      },

      // ----- Docker: terminal operations -----
      docker_listLocalShells: async () => {
        const shells = await terminalClient().listLocalShells().then((res) => res.shells);
        return { shells };
      },
      docker_terminalCreate: async ({ containerId, shell, cols, rows, cwd, dockerHost }) => {
        return await terminalClient().createSession(
          { kind: "docker-exec", containerId, shell, cwd, dockerHost: dockerHost ?? null },
          cols,
          rows,
        );
      },
      docker_terminalCreateLocal: async ({ shell, cols, rows }) => {
        return await terminalClient().createSession({ kind: "local", shell }, cols, rows);
      },
      docker_terminalCreateSsh: async ({ sshHost, cols, rows }) => {
        return await terminalClient().createSession({ kind: "ssh", sshHost }, cols, rows);
      },
      docker_terminalCreateModelRun: async ({ modelName, cols, rows, dockerHost }) => {
        return await terminalClient().createSession(
          { kind: "docker-model-run", modelName, dockerHost: dockerHost ?? null },
          cols,
          rows,
        );
      },
      docker_terminalCreateDockerRun: async ({ image, args, cols, rows, dockerHost }) => {
        return await terminalClient().createSession(
          { kind: "docker-run", image, args, dockerHost: dockerHost ?? null },
          cols,
          rows,
        );
      },
      docker_terminalCreateImagePull: async ({ imageName, cols, rows, dockerHost }) => {
        return await terminalClient().createSession(
          { kind: "docker-image-pull", imageName, dockerHost: dockerHost ?? null },
          cols,
          rows,
        );
      },
      docker_terminalCreateModelPull: async ({ modelName, cols, rows, dockerHost }) => {
        return await terminalClient().createSession(
          { kind: "docker-model-pull", modelName, dockerHost: dockerHost ?? null },
          cols,
          rows,
        );
      },
      docker_terminalAttach: async ({ sessionId, cols, rows }) => {
        return await terminalClient().attachSession(sessionId, cols, rows);
      },
      docker_terminalList: async () => {
        return await terminalClient().listSessions();
      },
      docker_terminalInput: async ({ sessionId, data }) => {
        await terminalClient().sessionInput(sessionId, data);
        return { ok: true };
      },
      docker_terminalResize: async ({ sessionId, cols, rows }) => {
        await terminalClient().sessionResize(sessionId, cols, rows);
        return { ok: true };
      },
      docker_terminalDestroy: async ({ sessionId }) => {
        await terminalClient().sessionDestroy(sessionId);
        return { ok: true };
      },
      docker_terminalDestroyMany: async ({ sessionIds }) => {
        await terminalClient().sessionDestroyMany(sessionIds ?? []);
        return { ok: true };
      },
      docker_subscribeContainers: async () => {
        containerSubscribers += 1;
        void broadcastContainerListIfSubscribed();
        return { ok: true };
      },
      docker_unsubscribeContainers: async () => {
        containerSubscribers = Math.max(0, containerSubscribers - 1);
        return { ok: true };
      },
      docker_subscribeLogs: async ({ containerId, tail }) => {
        const next = (logSubscriptions.get(containerId) ?? 0) + 1;
        logSubscriptions.set(containerId, next);
        if (next === 1) {
          startLogStream(containerId, tail ?? 200);
        }
        return { ok: true };
      },
      docker_unsubscribeLogs: async ({ containerId }) => {
        const next = (logSubscriptions.get(containerId) ?? 1) - 1;
        if (next <= 0) {
          logSubscriptions.delete(containerId);
          stopLogStream(containerId);
        } else {
          logSubscriptions.set(containerId, next);
        }
        return { ok: true };
      },

      // ----- Ollama -----
      ollama_available: async () => {
        const available = await ollama.ollamaAvailable();
        return { available };
      },
      ollama_setHost: async ({ ollamaHost }) => {
        const value = typeof ollamaHost === "string" ? ollamaHost : null;
        ollama.configureOllamaHost(value);
        return { ok: true };
      },
      ollama_listModels: async () => {
        const models = await ollama.listOllamaModels();
        return { models };
      },
      ollama_removeModel: async ({ name }) => {
        await ollama.removeOllamaModel(name);
        return { ok: true };
      },
      ollama_unloadModel: async ({ name }) => {
        await ollama.unloadOllamaModel(name);
        return { ok: true };
      },
      ollama_terminalCreateModelRun: async ({ modelName, cols, rows, ollamaHost }) => {
        return await terminalClient().createSession(
          { kind: "ollama-run", modelName, ollamaHost: ollamaHost ?? null },
          cols,
          rows,
        );
      },
      ollama_terminalCreatePull: async ({ modelName, cols, rows, ollamaHost }) => {
        return await terminalClient().createSession(
          { kind: "ollama-pull", modelName, ollamaHost: ollamaHost ?? null },
          cols,
          rows,
        );
      },
    },
    messages: {},
  },
});

type WindowState = { x: number; y: number; width: number; height: number };

const DEFAULT_FRAME: WindowState = { x: 120, y: 120, width: 1200, height: 800 };

async function getWindowStatePath() {
  const appDataFolder = await Updater.appDataFolder();
  mkdirSync(appDataFolder, { recursive: true });
  return join(appDataFolder, "window-state.json");
}

async function getTerminalDaemonStateDir() {
  const appDataFolder = await Updater.appDataFolder();
  mkdirSync(appDataFolder, { recursive: true });
  return join(appDataFolder, "terminal-daemon");
}

function isValidWindowState(v: any): v is WindowState {
  return (
    v &&
    typeof v.x === "number" &&
    typeof v.y === "number" &&
    typeof v.width === "number" &&
    typeof v.height === "number" &&
    Number.isFinite(v.x) &&
    Number.isFinite(v.y) &&
    Number.isFinite(v.width) &&
    Number.isFinite(v.height) &&
    v.width >= 300 &&
    v.height >= 200
  );
}

async function loadWindowState(windowStatePath: string): Promise<WindowState> {
  try {
    const f = Bun.file(windowStatePath);
    if (!(await f.exists())) return DEFAULT_FRAME;
    const json = await f.json();
    return isValidWindowState(json) ? json : DEFAULT_FRAME;
  } catch {
    return DEFAULT_FRAME;
  }
}

let pendingSave: Timer | null = null;
let currentFrame: WindowState = DEFAULT_FRAME;

async function scheduleSaveWindowState(windowStatePath: string) {
  if (pendingSave) clearTimeout(pendingSave);
  pendingSave = setTimeout(async () => {
    pendingSave = null;
    try {
      await Bun.write(windowStatePath, JSON.stringify(currentFrame, null, 2));
    } catch {
      // ignore
    }
  }, 250);
}

function saveWindowStateSync(windowStatePath: string) {
  try {
    writeFileSync(windowStatePath, JSON.stringify(currentFrame, null, 2));
  } catch {
    // ignore
  }
}

// Menubar: define native role-based items so standard OS shortcuts work.
ApplicationMenu.setApplicationMenu([
  {
    label: "Context Assistant",
    submenu: [
      {
        label: "Quit Context Assistant",
        role: "quit",
      },
    ],
  },
  {
    label: "Edit",
    submenu: [
      { role: "undo" },
      { role: "redo" },
      { type: "separator" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      { role: "selectAll" },
    ],
  },
]);

// Main window
const windowStatePath = await getWindowStatePath();
currentFrame = await loadWindowState(windowStatePath);
const terminalDaemonStateDir = await getTerminalDaemonStateDir();
terminalDaemonClient = getTerminalDaemonClient(terminalDaemonStateDir);

// In dev mode, point the webview at the local Bun dev server for HMR.
// In production, load the packaged view.
const isDev = process.env.ELECTROBUN_BUILD_ENV === "dev";
const DEV_SERVER_PORT = Number(process.env.DEV_SERVER_PORT) || 4888;

let viewUrl = "views://main/index.html";
if (isDev) {
  try {
    const probe = await fetch(`http://localhost:${DEV_SERVER_PORT}`, {
      signal: AbortSignal.timeout(1000),
    });
    if (probe.ok) {
      viewUrl = `http://localhost:${DEV_SERVER_PORT}`;
    }
  } catch {
    console.log(
      `[dev] Dev server not running at localhost:${DEV_SERVER_PORT}, using bundled view`,
    );
  }
}

const win = new BrowserWindow({
  title: "Context Assistant",
  frame: currentFrame,
  // Electrobun's closest equivalent to Electron's `titleBarStyle: "hidden"`.
  titleBarStyle: "hiddenInset",
  // hiddenInset looks better but does not snap to view
  url: viewUrl,
  rpc,
  styleMask: {
    // titled: true,
    borderless: true,
    // UnifiedTitleAndToolbar: true,
  }
});

function refreshCurrentFrameFromWindow() {
  try {
    const frame = (win as any).getFrame?.();
    if (isValidWindowState(frame)) {
      currentFrame = frame;
      return;
    }
  } catch {
    // ignore
  }
}

// Quit the whole app when the main window closes (red traffic light).
win.on("close", () => {
  refreshCurrentFrameFromWindow();
  if (pendingSave) {
    clearTimeout(pendingSave);
    pendingSave = null;
  }
  // Ensure we persist the latest known bounds before process exit.
  saveWindowStateSync(windowStatePath);
  Utils.quit();
});

win.on("move", (evt: any) => {
  refreshCurrentFrameFromWindow();
  const { x, y } = evt?.data ?? {};
  if (typeof x === "number") currentFrame.x = x;
  if (typeof y === "number") currentFrame.y = y;
  void scheduleSaveWindowState(windowStatePath);
});

win.on("resize", (evt: any) => {
  refreshCurrentFrameFromWindow();
  const { x, y, width, height } = evt?.data ?? {};
  if (typeof x === "number") currentFrame.x = x;
  if (typeof y === "number") currentFrame.y = y;
  if (typeof width === "number") currentFrame.width = width;
  if (typeof height === "number") currentFrame.height = height;
  void scheduleSaveWindowState(windowStatePath);
});

terminalDaemonClient.onOutput((sessionId, data) => {
  for (const view of BrowserView.getAll()) {
    try {
      view.rpc?.send.docker_terminalOutput({ sessionId, data });
    } catch {
      // ignore
    }
  }
});

terminalDaemonClient.onExit((sessionId, code) => {
  for (const view of BrowserView.getAll()) {
    try {
      view.rpc?.send.docker_terminalExit({ sessionId, code });
    } catch {
      // ignore
    }
  }
});

// Optional: kick off an update check shortly after startup (non-dev channels only).
setTimeout(async () => {
  try {
    const info = await Updater.checkForUpdate();
    broadcastUpdateInfo(info as UpdateInfo);
  } catch {
    // ignore (e.g., bucketUrl not configured)
  }
}, 1500);

export { win };
