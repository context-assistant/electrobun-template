import { Electroview } from "electrobun/view";
import type { AppRPCSchema, UpdateInfo } from "./rpcSchema";

type RpcType = ReturnType<typeof Electroview.defineRPC<AppRPCSchema>>;

let rpc: RpcType | null = null;
let electroview: Electroview<RpcType> | null = null;
let lastUpdateInfo: UpdateInfo | null = null;

const updateInfoListeners = new Set<(info: UpdateInfo) => void>();

export function isElectrobun() {
  return (
    typeof window !== "undefined" &&
    typeof window.__electrobunWebviewId === "number"
  );
}

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
  if (!isElectrobun()) return null;
  if (rpc && electroview) return rpc;

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
}

export async function updaterGetUpdateInfo() {
  const r = getRpc();
  if (!r) return null;
  return await r.request.updater_getUpdateInfo({});
}

export async function updaterCheckForUpdate() {
  const r = getRpc();
  if (!r) throw new Error("Not running inside Electrobun");
  const info = await r.request.updater_checkForUpdate({});
  emitUpdateInfo(info);
  return info;
}

export async function updaterDownloadUpdate() {
  const r = getRpc();
  if (!r) throw new Error("Not running inside Electrobun");
  const info = await r.request.updater_downloadUpdate({});
  emitUpdateInfo(info);
  return info;
}

export async function updaterApplyUpdate() {
  const r = getRpc();
  if (!r) throw new Error("Not running inside Electrobun");
  return await r.request.updater_applyUpdate({});
}

export async function secretsGet(key: string) {
  const r = getRpc();
  if (!r) throw new Error("Not running inside Electrobun");
  const res = await r.request.secrets_get({ key });
  return res.value;
}

export async function secretsSet(key: string, value: string) {
  const r = getRpc();
  if (!r) throw new Error("Not running inside Electrobun");
  await r.request.secrets_set({ key, value });
}

export async function secretsDelete(key: string) {
  const r = getRpc();
  if (!r) throw new Error("Not running inside Electrobun");
  const res = await r.request.secrets_delete({ key });
  return res.ok;
}
