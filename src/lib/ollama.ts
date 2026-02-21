/**
 * Client-side Ollama service.
 * When running inside Electrobun, calls go through the RPC bridge.
 * When running in the dev-server browser context, availability check
 * falls back to a direct HTTP probe against localhost:11434.
 */

import { isElectrobun } from "../electrobun/env";
import { getRpcAsync, sendDevWsRequest } from "../electrobun/renderer";
import type { OllamaModelInfo } from "../electrobun/rpcSchema";

let configuredOllamaHost: string | null = null;

async function rpc() {
  const r = await getRpcAsync();
  if (!r) throw new Error("Not running inside Electrobun");
  return r;
}

/**
 * Dev-mode fallback: mirrors the same WS → HTTP pattern used by lib/docker.ts.
 * Method names map to entries in the dev-server's dockerHandlers registry.
 */
async function devFetch<T>(method: string, params: unknown = {}): Promise<T> {
  try {
    return await sendDevWsRequest<T>(method, params, 10_000);
  } catch {
    // WS not available or failed – fall back to HTTP
    const res = await fetch(`/api/docker/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
    const json = await res.json();
    if (!res.ok) throw new Error((json as any)?.error ?? `API error: ${res.status}`);
    return json as T;
  }
}

export async function isOllamaAvailable(): Promise<boolean> {
  try {
    if (isElectrobun()) {
      const r = await getRpcAsync();
      if (!r) return false;
      const res = await r.request.ollama_available({});
      return res.available;
    }
    return (await devFetch<{ available: boolean }>("ollamaAvailable")).available;
  } catch {
    return false;
  }
}

export async function configureOllamaHost(ollamaHost: string | null): Promise<void> {
  const nextHost = typeof ollamaHost === "string" && ollamaHost.trim().length > 0
    ? ollamaHost.trim()
    : null;
  if (configuredOllamaHost === nextHost) return;
  if (isElectrobun()) {
    const r = await rpc();
    await r.request.ollama_setHost({ ollamaHost: nextHost });
  } else {
    await devFetch("ollamaSetHost", { ollamaHost: nextHost });
  }
  configuredOllamaHost = nextHost;
}

export async function listModels(): Promise<OllamaModelInfo[]> {
  try {
    if (isElectrobun()) {
      const r = await rpc();
      const res = await r.request.ollama_listModels({});
      return res.models;
    }
    return (await devFetch<{ models: OllamaModelInfo[] }>("ollamaListModels")).models;
  } catch {
    return [];
  }
}

export async function removeModel(name: string): Promise<void> {
  if (isElectrobun()) {
    const r = await rpc();
    await r.request.ollama_removeModel({ name });
    return;
  }
  await devFetch("ollamaRemoveModel", { name });
}

export async function unloadModel(name: string): Promise<void> {
  if (isElectrobun()) {
    const r = await rpc();
    await r.request.ollama_unloadModel({ name });
    return;
  }
  await devFetch("ollamaUnloadModel", { name });
}

export async function createRunTerminalSession(
  modelName: string,
  cols?: number,
  rows?: number,
  ollamaHost?: string | null,
): Promise<{ sessionId: string; shell: string }> {
  if (isElectrobun()) {
    const r = await rpc();
    return await r.request.ollama_terminalCreateModelRun({ modelName, cols, rows, ollamaHost });
  }
  return await devFetch<{ sessionId: string; shell: string }>("ollamaTerminalCreateRun", {
    modelName,
    cols,
    rows,
    ollamaHost,
  });
}

export async function createPullTerminalSession(
  modelName: string,
  cols?: number,
  rows?: number,
  ollamaHost?: string | null,
): Promise<{ sessionId: string; shell: string }> {
  if (isElectrobun()) {
    const r = await rpc();
    return await r.request.ollama_terminalCreatePull({ modelName, cols, rows, ollamaHost });
  }
  return await devFetch<{ sessionId: string; shell: string }>("ollamaTerminalCreatePull", {
    modelName,
    cols,
    rows,
    ollamaHost,
  });
}

