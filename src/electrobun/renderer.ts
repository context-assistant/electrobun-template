import type { AppRPCSchema, ContainerInfo, UpdateInfo } from "./rpcSchema";
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

// ---------------------------------------------------------------------------
// Terminal output streaming
// ---------------------------------------------------------------------------

type TerminalOutputListener = (sessionId: string, data: string) => void;
type TerminalExitListener = (sessionId: string, code: number) => void;

const terminalOutputListeners = new Set<TerminalOutputListener>();
const terminalExitListeners = new Set<TerminalExitListener>();

export function onTerminalOutput(cb: TerminalOutputListener) {
  terminalOutputListeners.add(cb);
  ensureDevWs();
  return () => terminalOutputListeners.delete(cb);
}

export function onTerminalExit(cb: TerminalExitListener) {
  terminalExitListeners.add(cb);
  ensureDevWs();
  return () => terminalExitListeners.delete(cb);
}

function emitTerminalOutput(payload: { sessionId: string; data: string }) {
  for (const cb of terminalOutputListeners) cb(payload.sessionId, payload.data);
}

function emitTerminalExit(payload: { sessionId: string; code: number }) {
  for (const cb of terminalExitListeners) cb(payload.sessionId, payload.code);
}

// ---------------------------------------------------------------------------
// Container list change listeners (dev-mode push via WebSocket)
// ---------------------------------------------------------------------------

type ContainersChangedListener = (containers: ContainerInfo[]) => void;
const containersChangedListeners = new Set<ContainersChangedListener>();

export function onContainersChanged(cb: ContainersChangedListener) {
  containersChangedListeners.add(cb);
  if (containersChangedListeners.size === 1) {
    if (isElectrobun()) {
      void (async () => {
        const r = await getRpcAsync();
        await r?.request.docker_subscribeContainers({});
      })();
    } else {
      ensureDevWs();
      sendDevWsMessage({ type: "subscribe", channel: "containers" });
    }
  }
  return () => {
    containersChangedListeners.delete(cb);
    if (containersChangedListeners.size === 0) {
      if (isElectrobun()) {
        void (async () => {
          const r = await getRpcAsync();
          await r?.request.docker_unsubscribeContainers({});
        })();
      } else {
        sendDevWsMessage({ type: "unsubscribe", channel: "containers" });
      }
    }
  };
}

function emitContainersChanged(containers: ContainerInfo[]) {
  for (const cb of containersChangedListeners) cb(containers);
}

// ---------------------------------------------------------------------------
// Log stream listeners (dev-mode push via WebSocket)
// ---------------------------------------------------------------------------

type LogStreamListener = (containerId: string, data: string) => void;
const logStreamListeners = new Set<LogStreamListener>();

/** Active log subscriptions, tracked for reconnect resubscription. */
const activeLogSubscriptions = new Map<string, number>();

export function onLogStream(cb: LogStreamListener) {
  logStreamListeners.add(cb);
  if (!isElectrobun()) ensureDevWs();
  return () => {
    logStreamListeners.delete(cb);
  };
}

export function subscribeLogStream(containerId: string, tail: number) {
  activeLogSubscriptions.set(containerId, tail);
  if (isElectrobun()) {
    void (async () => {
      const r = await getRpcAsync();
      await r?.request.docker_subscribeLogs({ containerId, tail });
    })();
    return;
  }
  ensureDevWs();
  sendDevWsMessage({ type: "subscribe", channel: "logs", containerId, tail });
}

export function unsubscribeLogStream(containerId: string) {
  activeLogSubscriptions.delete(containerId);
  if (isElectrobun()) {
    void (async () => {
      const r = await getRpcAsync();
      await r?.request.docker_unsubscribeLogs({ containerId });
    })();
    return;
  }
  sendDevWsMessage({ type: "unsubscribe", channel: "logs", containerId });
}

function emitLogData(containerId: string, data: string) {
  for (const cb of logStreamListeners) cb(containerId, data);
}

// ---------------------------------------------------------------------------
// Dev-server WebSocket — general-purpose channel
// Handles: terminal I/O, container list push, log streaming
// ---------------------------------------------------------------------------

let devWs: WebSocket | null = null;
let devWsConnecting = false;
let nextDevWsRequestId = 1;
const devWsPendingRequests = new Map<
  string,
  { resolve: (value: unknown) => void; reject: (reason?: unknown) => void; timer: ReturnType<typeof setTimeout> }
>();

/**
 * Send a message over the dev WebSocket. Returns true if sent,
 * false if the socket isn't open (caller can fall back to HTTP).
 */
export function sendDevWsMessage(msg: object): boolean {
  if (isElectrobun()) return false;
  ensureDevWs();
  if (devWs?.readyState === WebSocket.OPEN) {
    devWs.send(JSON.stringify(msg));
    return true;
  }
  return false;
}

/**
 * Send a request/response message over the dev WebSocket.
 * Rejects if the socket is unavailable, times out, or returns an error.
 */
export async function sendDevWsRequest<T>(
  method: string,
  params: unknown = {},
  timeoutMs = 10_000,
): Promise<T> {
  if (isElectrobun()) throw new Error("Dev WebSocket request transport is unavailable in Electrobun");
  ensureDevWs();
  if (devWs?.readyState !== WebSocket.OPEN) {
    throw new Error("Dev WebSocket is not connected");
  }

  const id = `req_${nextDevWsRequestId++}`;
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      devWsPendingRequests.delete(id);
      reject(new Error(`Dev WebSocket request timed out for ${method}`));
    }, timeoutMs);
    devWsPendingRequests.set(id, {
      resolve: (value) => resolve(value as T),
      reject,
      timer,
    });
    devWs?.send(JSON.stringify({ type: "request", id, method, params }));
  });
}

function hasActiveListeners() {
  return (
    terminalOutputListeners.size > 0 ||
    terminalExitListeners.size > 0 ||
    containersChangedListeners.size > 0 ||
    logStreamListeners.size > 0
  );
}

function ensureDevWs() {
  if (isElectrobun()) return;
  if (devWs?.readyState === WebSocket.OPEN) return;
  if (devWsConnecting) return;
  devWsConnecting = true;

  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${window.location.host}/api/ws`);

  ws.onopen = () => {
    devWs = ws;
    devWsConnecting = false;
    // Resubscribe to active subscriptions after reconnect
    if (containersChangedListeners.size > 0) {
      sendDevWsMessage({ type: "subscribe", channel: "containers" });
    }
    for (const [containerId, tail] of activeLogSubscriptions) {
      sendDevWsMessage({ type: "subscribe", channel: "logs", containerId, tail });
    }
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data as string);
      switch (msg.type) {
        case "output":
          emitTerminalOutput({ sessionId: msg.sessionId, data: msg.data });
          break;
        case "exit":
          emitTerminalExit({ sessionId: msg.sessionId, code: msg.code });
          break;
        case "containersChanged":
          emitContainersChanged(msg.containers);
          break;
        case "logData":
          emitLogData(msg.containerId, msg.data);
          break;
        case "response": {
          const pending = devWsPendingRequests.get(String(msg.id ?? ""));
          if (!pending) break;
          devWsPendingRequests.delete(String(msg.id ?? ""));
          clearTimeout(pending.timer);
          if (msg.error) {
            pending.reject(new Error(String(msg.error)));
          } else {
            pending.resolve(msg.result);
          }
          break;
        }
      }
    } catch {
      // ignore malformed messages
    }
  };

  ws.onclose = () => {
    for (const [id, pending] of devWsPendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Dev WebSocket disconnected"));
      devWsPendingRequests.delete(id);
    }
    devWs = null;
    devWsConnecting = false;
    if (hasActiveListeners()) {
      setTimeout(ensureDevWs, 1000);
    }
  };

  ws.onerror = () => {
    devWsConnecting = false;
    // onclose will fire after onerror, which handles reconnection
  };
}

// ---------------------------------------------------------------------------

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
          docker_terminalOutput: (payload) => emitTerminalOutput(payload),
          docker_terminalExit: (payload) => emitTerminalExit(payload),
          docker_containersChanged: (payload) => emitContainersChanged(payload.containers),
          docker_logData: (payload) => emitLogData(payload.containerId, payload.data),
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
