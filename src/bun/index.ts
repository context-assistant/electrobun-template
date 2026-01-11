import {
  ApplicationMenu,
  BrowserView,
  BrowserWindow,
  Updater,
  Utils,
} from "electrobun";
import { secrets } from "bun";
import type { AppRPCSchema, UpdateInfo } from "../electrobun/rpcSchema";
import { mkdirSync } from "fs";
import { join } from "path";

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
      // @ts-expect-error - schema mixing makes this look borked to TS in some contexts
      view.rpc?.send.updater_updateInfoChanged(info);
    } catch {
      // ignore
    }
  }
}

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

async function loadWindowState(): Promise<WindowState> {
  try {
    const p = await getWindowStatePath();
    const f = Bun.file(p);
    if (!(await f.exists())) return DEFAULT_FRAME;
    const json = await f.json();
    return isValidWindowState(json) ? json : DEFAULT_FRAME;
  } catch {
    return DEFAULT_FRAME;
  }
}

let pendingSave: Timer | null = null;
let currentFrame: WindowState = DEFAULT_FRAME;

async function scheduleSaveWindowState() {
  if (pendingSave) clearTimeout(pendingSave);
  pendingSave = setTimeout(async () => {
    pendingSave = null;
    try {
      const p = await getWindowStatePath();
      await Bun.write(p, JSON.stringify(currentFrame, null, 2));
    } catch {
      // ignore
    }
  }, 250);
}

// Menubar: keep it minimal (single Quit item under the app menu).
// Note: Electrobun's accelerator parsing is non-standard; it appears to expect
// `key+modifier` (e.g. "q+cmd"). Using "cmd+q" can map to Cmd+C.
ApplicationMenu.setApplicationMenu([
  {
    label: "Context Assistant",
    submenu: [
      {
        label: "Quit Context Assistant",
        action: "app.quit",
        accelerator: process.platform === "darwin" ? "q+cmd" : "q+ctrl",
      },
    ],
  },
]);

ApplicationMenu.on("application-menu-clicked", (evt: any) => {
  const action = evt?.data?.action ?? evt?.action;
  if (action === "app.quit") Utils.quit();
});

// Main window
currentFrame = await loadWindowState();

const win = new BrowserWindow({
  title: "Context Assistant",
  frame: currentFrame,
  // Electrobun's closest equivalent to Electron's `titleBarStyle: "hidden"`.
  titleBarStyle: "hiddenInset",
    // hiddenInset looks better but does not snap to view
  // Load the packaged view.
  url: "views://main/index.html",
  rpc,
});

// Quit the whole app when the main window closes (red traffic light).
win.on("close", () => {
  Utils.quit();
});

win.on("move", (evt: any) => {
  const { x, y } = evt?.data ?? {};
  if (typeof x === "number") currentFrame.x = x;
  if (typeof y === "number") currentFrame.y = y;
  void scheduleSaveWindowState();
});

win.on("resize", (evt: any) => {
  const { x, y, width, height } = evt?.data ?? {};
  if (typeof x === "number") currentFrame.x = x;
  if (typeof y === "number") currentFrame.y = y;
  if (typeof width === "number") currentFrame.width = width;
  if (typeof height === "number") currentFrame.height = height;
  void scheduleSaveWindowState();
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
