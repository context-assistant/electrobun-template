import type { AppRPCSchema, UpdateInfo } from "./rpcSchema";
import { isElectrobun } from "./env";

// NOTE: We intentionally avoid a top-level import of `electrobun/view` so the web
// build doesn't pull in desktop-only code. Types are kept loose on purpose.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RpcType = any;

let rpc: RpcType | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let electroview: any | null = null;
let lastUpdateInfo: UpdateInfo | null = null;
let rpcInitPromise: Promise<RpcType | null> | null = null;

const updateInfoListeners = new Set<(info: UpdateInfo) => void>();

export function onUpdateInfoChanged(cb: (info: UpdateInfo) => void) {
  updateInfoListeners.add(cb);
  if (lastUpdateInfo) cb(lastUpdateInfo);
  return () => updateInfoListeners.delete(cb);
}

function emitUpdateInfo(info: UpdateInfo) {
  lastUpdateInfo = info;
  for (const cb of updateInfoListeners) cb(info);
}

export function getRpc() {
  return rpc;
}

export async function getRpcAsync() {
  if (!isElectrobun()) return null;
  if (rpc && electroview) return rpc;
  if (rpcInitPromise) return await rpcInitPromise;

  rpcInitPromise = (async () => {
    const { Electroview } = await import("electrobun/view");

    rpc = Electroview.defineRPC<AppRPCSchema>({
      handlers: {
        requests: {},
        messages: {
          updater_updateInfoChanged: (info) => emitUpdateInfo(info),
        },
      },
    }) as RpcType;

    electroview = new Electroview({ rpc });
    return rpc;
  })();

  try {
    return await rpcInitPromise;
  } finally {
    rpcInitPromise = null;
  }
}

// Convenience initializer: safe to call and ignore in web builds.
export function initElectrobunRpc() {
  void getRpcAsync();
}

export async function updaterGetUpdateInfo() {
  const r = await getRpcAsync();
  if (!r) return null;
  return await r.request.updater_getUpdateInfo({});
}

export async function updaterCheckForUpdate() {
  const r = await getRpcAsync();
  if (!r) throw new Error("Not running inside Electrobun");
  const info = await r.request.updater_checkForUpdate({});
  emitUpdateInfo(info);
  return info;
}

export async function updaterDownloadUpdate() {
  const r = await getRpcAsync();
  if (!r) throw new Error("Not running inside Electrobun");
  const info = await r.request.updater_downloadUpdate({});
  emitUpdateInfo(info);
  return info;
}

export async function updaterApplyUpdate() {
  const r = await getRpcAsync();
  if (!r) throw new Error("Not running inside Electrobun");
  return await r.request.updater_applyUpdate({});
}

export async function secretsGet(key: string) {
  const r = await getRpcAsync();
  if (!r) throw new Error("Not running inside Electrobun");
  const res = await r.request.secrets_get({ key });
  return res.value;
}

export async function secretsSet(key: string, value: string) {
  const r = await getRpcAsync();
  if (!r) throw new Error("Not running inside Electrobun");
  await r.request.secrets_set({ key, value });
}

export async function secretsDelete(key: string) {
  const r = await getRpcAsync();
  if (!r) throw new Error("Not running inside Electrobun");
  const res = await r.request.secrets_delete({ key });
  return res.ok;
}
