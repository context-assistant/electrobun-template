export type ModelProviderHttpRequestParams = {
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
};

export type ModelProviderHttpRequestResponse = {
  ok: boolean;
  status: number;
  json: unknown | null;
  text: string;
};

const REQUEST_TIMEOUT_MS = 120_000;

function normalizeMethod(method?: string): "GET" | "POST" {
  const upper = (method ?? "GET").toUpperCase();
  if (upper === "GET" || upper === "POST") return upper;
  throw new Error(`Unsupported HTTP method: ${method ?? "<empty>"}`);
}

function normalizeUrl(url: string): string {
  const trimmed = (url ?? "").trim();
  if (!trimmed) throw new Error("Request URL is required.");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Invalid request URL: ${trimmed}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Unsupported URL protocol: ${parsed.protocol}`);
  }
  return parsed.toString();
}

function parseConfiguredSshDockerTarget(): { target: string; port: string | null; host: string } | null {
  const dockerHost = (process.env.DOCKER_HOST ?? "").trim();
  if (!dockerHost.startsWith("ssh://")) return null;
  try {
    const parsed = new URL(dockerHost);
    if (parsed.protocol !== "ssh:") return null;
    if (!parsed.hostname) return null;
    const user = parsed.username ? decodeURIComponent(parsed.username) : "";
    return {
      target: user ? `${user}@${parsed.hostname}` : parsed.hostname,
      port: parsed.port || null,
      host: parsed.hostname,
    };
  } catch {
    return null;
  }
}

function shouldProxyViaSshForDockerModelEndpoint(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const sshTarget = parseConfiguredSshDockerTarget();
  if (!sshTarget) return false;
  const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
  return parsed.hostname === sshTarget.host && port === "12434";
}

async function proxyHttpOverSshDockerHost(
  input: Required<Pick<ModelProviderHttpRequestParams, "url" | "method">> &
    Pick<ModelProviderHttpRequestParams, "headers" | "body">,
): Promise<ModelProviderHttpRequestResponse> {
  const sshTarget = parseConfiguredSshDockerTarget();
  if (!sshTarget) throw new Error("SSH Docker host is not configured.");
  const parsed = new URL(input.url);
  const remoteUrl = `http://127.0.0.1:12434${parsed.pathname}${parsed.search}`;

  const timeoutSeconds = Math.max(5, Math.ceil(REQUEST_TIMEOUT_MS / 1000));
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

  const stdinPayload = JSON.stringify({
    url: remoteUrl,
    method: input.method,
    headers: input.headers ?? {},
    body: input.body ?? "",
  });

  const args = ["ssh"];
  if (sshTarget.port) args.push("-p", sshTarget.port);
  args.push(sshTarget.target, remoteCommand);
  const proc = Bun.spawn(args, { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const stdin = proc.stdin;
  if (!stdin || typeof stdin === "number") {
    throw new Error("SSH proxy stdin is not writable.");
  }
  stdin.write(stdinPayload);
  stdin.flush();
  stdin.end();
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || "SSH proxy request failed.");
  }
  let parsedOutput: { status?: unknown; text?: unknown } = {};
  try {
    parsedOutput = JSON.parse(stdout) as { status?: unknown; text?: unknown };
  } catch {
    throw new Error("SSH proxy returned invalid response.");
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

export async function proxyModelProviderHttpRequest(
  params: ModelProviderHttpRequestParams,
): Promise<ModelProviderHttpRequestResponse> {
  const url = normalizeUrl(params.url);
  const method = normalizeMethod(params.method);
  const headers = params.headers ?? {};
  const body = params.body;
  try {
    const response = await fetch(url, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    const text = await response.text();
    let json: unknown | null = null;
    if (text.trim().length > 0) {
      try {
        json = JSON.parse(text) as unknown;
      } catch {
        json = null;
      }
    }

    return {
      ok: response.ok,
      status: response.status,
      json,
      text,
    };
  } catch (error) {
    if (!shouldProxyViaSshForDockerModelEndpoint(url)) throw error;
    return await proxyHttpOverSshDockerHost({ url, method, headers, body });
  }
}
