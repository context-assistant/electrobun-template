/**
 * Ollama backend operations.
 * Uses the Ollama REST API (http://localhost:11434) for availability checks,
 * model listing, and model management. Terminal sessions (run/pull) are
 * handled in docker.ts using the shared PTY infrastructure.
 */

import type { OllamaModelInfo } from "../electrobun/rpcSchema";

const DEFAULT_OLLAMA_BASE = "http://localhost:11434";
let configuredOllamaHost: string | null = null;

type OllamaApiModel = {
  name: string;
  modified_at: string;
  size: number;
  digest: string;
};

type OllamaTagsResponse = {
  models: OllamaApiModel[];
};

type OllamaPsResponse = {
  models: Array<{ name: string; model: string }>;
};

type OllamaHttpResponse = {
  ok: boolean;
  status: number;
  json: unknown | null;
  text: string;
};

export function configureOllamaHost(ollamaHost: string | null): void {
  const value = typeof ollamaHost === "string" ? ollamaHost.trim() : "";
  configuredOllamaHost = value.length > 0 ? value : null;
  if (configuredOllamaHost) {
    process.env.OLLAMA_HOST = configuredOllamaHost;
  } else {
    delete process.env.OLLAMA_HOST;
  }
}

function resolveOllamaBase() {
  const candidate = (configuredOllamaHost ?? process.env.OLLAMA_HOST ?? "").trim();
  if (!candidate) return DEFAULT_OLLAMA_BASE;
  if (candidate.startsWith("ssh://")) return candidate;
  if (/^https?:\/\//i.test(candidate)) return candidate;
  return `http://${candidate}`;
}

function parseConfiguredSshOllamaTarget() {
  const base = resolveOllamaBase();
  if (!base.startsWith("ssh://")) return null;
  try {
    const parsed = new URL(base);
    if (parsed.protocol !== "ssh:") return null;
    if (!parsed.hostname) return null;
    const user = parsed.username ? decodeURIComponent(parsed.username) : "";
    return {
      target: user ? `${user}@${parsed.hostname}` : parsed.hostname,
      port: parsed.port || null,
    };
  } catch {
    return null;
  }
}

async function requestOllamaApiOverSsh(
  path: string,
  method: "GET" | "POST" | "DELETE",
  body?: unknown,
  timeoutMs = 5000,
): Promise<OllamaHttpResponse> {
  const sshTarget = parseConfiguredSshOllamaTarget();
  if (!sshTarget) throw new Error("SSH Ollama host is not configured.");
  const timeoutSeconds = Math.max(3, Math.ceil(timeoutMs / 1000));
  const pyScript = `
import json
import sys
import urllib.request
import urllib.error

payload = json.loads(sys.stdin.read() or "{}")
remote_url = payload.get("url", "")
method = payload.get("method", "GET")
headers = payload.get("headers") or {}
body_text = payload.get("body")
body = body_text.encode("utf-8") if isinstance(body_text, str) and len(body_text) > 0 else None

req = urllib.request.Request(remote_url, data=body, method=method, headers=headers)
status = 500
raw = b""
try:
    with urllib.request.urlopen(req, timeout=${timeoutSeconds}) as resp:
        status = int(getattr(resp, "status", 200))
        raw = resp.read()
except urllib.error.HTTPError as e:
    status = int(getattr(e, "code", 500))
    raw = e.read() if hasattr(e, "read") else b""

text = raw.decode("utf-8", "replace")
print(json.dumps({"status": status, "text": text}))
`.trim();
  const pyScriptB64 = Buffer.from(pyScript, "utf8").toString("base64");
  const shQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
  const remoteCommand = `python3 -c ${shQuote("import base64,sys;exec(base64.b64decode(sys.argv.pop()).decode(\"utf-8\"))")} ${shQuote(pyScriptB64)}`;

  const args = ["ssh"];
  if (sshTarget.port) args.push("-p", sshTarget.port);
  args.push(sshTarget.target, remoteCommand);
  const proc = Bun.spawn(args, { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const stdin = proc.stdin;
  if (!stdin || typeof stdin === "number") {
    throw new Error("SSH proxy stdin is not writable.");
  }
  stdin.write(
    JSON.stringify({
      url: `http://127.0.0.1:11434${path}`,
      method,
      headers: body != null ? { "Content-Type": "application/json" } : {},
      body: body != null ? JSON.stringify(body) : "",
    }),
  );
  stdin.flush();
  stdin.end();
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || "SSH Ollama request failed.");
  }

  let parsedOutput: { status?: unknown; text?: unknown } = {};
  try {
    parsedOutput = JSON.parse(stdout) as { status?: unknown; text?: unknown };
  } catch {
    throw new Error("SSH Ollama proxy returned invalid response.");
  }
  const status = typeof parsedOutput.status === "number" ? parsedOutput.status : 500;
  const text = typeof parsedOutput.text === "string" ? parsedOutput.text : "";
  let json: unknown | null = null;
  if (text.trim()) {
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      json = null;
    }
  }
  return { ok: status >= 200 && status < 300, status, json, text };
}

async function requestOllamaApi(
  path: string,
  method: "GET" | "POST" | "DELETE",
  body?: unknown,
  timeoutMs = 5000,
): Promise<OllamaHttpResponse> {
  const base = resolveOllamaBase();
  if (base.startsWith("ssh://")) {
    return await requestOllamaApiOverSsh(path, method, body, timeoutMs);
  }
  const url = `${base}${path}`;
  const response = await fetch(url, {
    method,
    headers: body != null ? { "Content-Type": "application/json" } : undefined,
    body: body != null ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let json: unknown | null = null;
  if (text.trim()) {
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      json = null;
    }
  }
  return { ok: response.ok, status: response.status, json, text };
}

function formatSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${(bytes / 1e3).toFixed(1)} KB`;
}

function shortDigest(digest: string): string {
  const hash = digest.startsWith("sha256:") ? digest.slice(7) : digest;
  return hash.slice(0, 12);
}

export async function ollamaAvailable(): Promise<boolean> {
  try {
    const response = await requestOllamaApi("/api/tags", "GET", undefined, 2000);
    return response.ok;
  } catch {
    return false;
  }
}

async function listRunningModelNames(): Promise<Set<string>> {
  try {
    const response = await requestOllamaApi("/api/ps", "GET", undefined, 3000);
    if (!response.ok || !response.json || typeof response.json !== "object") return new Set();
    const data = response.json as OllamaPsResponse;
    const names = new Set<string>();
    for (const m of data.models ?? []) {
      if (m.name) names.add(m.name);
      if (m.model) names.add(m.model);
    }
    return names;
  } catch {
    return new Set();
  }
}

export async function listOllamaModels(): Promise<OllamaModelInfo[]> {
  try {
    const [tagsResponse, runningNames] = await Promise.all([
      requestOllamaApi("/api/tags", "GET", undefined, 5000),
      listRunningModelNames(),
    ]);
    if (!tagsResponse.ok || !tagsResponse.json || typeof tagsResponse.json !== "object") return [];
    const data = tagsResponse.json as OllamaTagsResponse;
    return (data.models ?? []).map((m) => ({
      name: m.name,
      id: shortDigest(m.digest),
      size: formatSize(m.size),
      modifiedAt: new Date(m.modified_at).toLocaleDateString(),
      running: runningNames.has(m.name),
    }));
  } catch {
    return [];
  }
}

export async function removeOllamaModel(name: string): Promise<void> {
  const response = await requestOllamaApi("/api/delete", "DELETE", { name }, 10_000);
  if (!response.ok) {
    throw new Error(`Failed to remove model "${name}": ${response.text || response.status}`);
  }
}

export async function unloadOllamaModel(name: string): Promise<void> {
  // Unload by requesting generation with keep_alive=0, which evicts from VRAM.
  const response = await requestOllamaApi(
    "/api/generate",
    "POST",
    { model: name, keep_alive: 0 },
    10_000,
  );
  if (!response.ok) {
    throw new Error(`Failed to unload model "${name}": ${response.text || response.status}`);
  }
}
