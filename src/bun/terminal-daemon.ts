import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import * as docker from "./docker";
import {
  TERMINAL_DAEMON_PROTOCOL_VERSION,
  daemonPidPath,
  daemonSocketPath,
  daemonStateFilePath,
  type TerminalDaemonEventEnvelope,
  type TerminalDaemonMethod,
  type TerminalDaemonRequestEnvelope,
  type TerminalDaemonRequestMap,
  type TerminalDaemonResponseEnvelope,
} from "./terminalDaemonProtocol";
import type { TerminalLaunchSpec, TerminalSessionRecord } from "../lib/terminalSessionTypes";

type StartTerminalDaemonOptions = {
  installSignalHandlers?: boolean;
  exitOnFatal?: boolean;
};

function parseCliArgs() {
  const args = new Map<string, string>();
  for (let i = 2; i < process.argv.length; i += 1) {
    const key = process.argv[i];
    const value = process.argv[i + 1];
    if (!key?.startsWith("--")) continue;
    args.set(key.slice(2), typeof value === "string" ? value : "");
  }
  return args;
}

export function startTerminalDaemon(stateDirArg?: string, options?: StartTerminalDaemonOptions) {
  const stateDir = stateDirArg || join(homedir(), ".context-assistant", "terminal-daemon");
  const installSignalHandlers = options?.installSignalHandlers ?? false;
  const exitOnFatal = options?.exitOnFatal ?? false;

  mkdirSync(stateDir, { recursive: true });

  const socketPath = daemonSocketPath(stateDir);
  const stateFilePath = daemonStateFilePath(stateDir);
  const pidPath = daemonPidPath(stateDir);

  try {
    rmSync(socketPath, { force: true });
  } catch {
    // ignore
  }

  writeFileSync(pidPath, String(process.pid));

  const sessionRecords = new Map<string, TerminalSessionRecord>();
  const subscribers = new Set<Socket>();
  const sessionOutputTail = new Map<string, string>();
  const MAX_TAIL_BYTES = 128 * 1024;
  const MAX_TAIL_LINES = 300;

  function trimTail(value: string): string {
    let out = value;
    if (out.length > MAX_TAIL_BYTES) {
      out = out.slice(out.length - MAX_TAIL_BYTES);
    }
    const lines = out.split(/\r?\n/);
    if (lines.length > MAX_TAIL_LINES) {
      out = lines.slice(lines.length - MAX_TAIL_LINES).join("\n");
    }
    return out;
  }

  function appendOutputTail(sessionId: string, chunk: string) {
    if (!chunk) return;
    const previous = sessionOutputTail.get(sessionId) ?? "";
    sessionOutputTail.set(sessionId, trimTail(previous + chunk));
  }

  function persistState() {
    const payload = JSON.stringify(
      {
        version: 1,
        updatedAt: Date.now(),
        sessions: Array.from(sessionRecords.values()),
      },
      null,
      2,
    );
    const tmpPath = `${stateFilePath}.tmp`;
    try {
      writeFileSync(tmpPath, payload);
      rmSync(stateFilePath, { force: true });
      writeFileSync(stateFilePath, payload);
      rmSync(tmpPath, { force: true });
    } catch {
      // ignore best-effort persistence
    }
  }

  function emitEvent(evt: TerminalDaemonEventEnvelope) {
    const line = `${JSON.stringify(evt)}\n`;
    for (const socket of subscribers) {
      try {
        socket.write(line);
      } catch {
        subscribers.delete(socket);
        try {
          socket.destroy();
        } catch {
          // ignore
        }
      }
    }
  }

  docker.setTerminalCallbacks(
    (sessionId, data) => {
      appendOutputTail(sessionId, data);
      emitEvent({ type: "event", event: "output", payload: { sessionId, data } });
    },
    (sessionId, code) => {
      const previous = sessionRecords.get(sessionId);
      if (previous) {
        sessionRecords.delete(sessionId);
        persistState();
      }
      sessionOutputTail.delete(sessionId);
      emitEvent({ type: "event", event: "exit", payload: { sessionId, code } });
    },
  );

  function normalizeSize(cols?: number, rows?: number): { cols: number; rows: number } {
    const safeCols = typeof cols === "number" && Number.isFinite(cols) && cols > 0 ? Math.floor(cols) : 80;
    const safeRows = typeof rows === "number" && Number.isFinite(rows) && rows > 0 ? Math.floor(rows) : 24;
    return { cols: safeCols, rows: safeRows };
  }

  async function createSession(
    launchSpec: TerminalLaunchSpec,
    cols?: number,
    rows?: number,
  ): Promise<{ sessionId: string; shell: string; reused: boolean }> {
    const size = normalizeSize(cols, rows);
    let created: { sessionId: string; shell: string };
    switch (launchSpec.kind) {
      case "local":
        created = await docker.createLocalTerminalSession(launchSpec.shell, size.cols, size.rows);
        break;
      case "ssh":
        created = await docker.createSshTerminalSession(launchSpec.sshHost, size.cols, size.rows);
        break;
      case "docker-exec":
        docker.configureDockerHost(launchSpec.dockerHost ?? null);
        created = await docker.createTerminalSession(
          launchSpec.containerId,
          launchSpec.shell,
          size.cols,
          size.rows,
          launchSpec.cwd,
        );
        break;
      case "docker-run":
        docker.configureDockerHost(launchSpec.dockerHost ?? null);
        created = await docker.createDockerRunSession(launchSpec.image, launchSpec.args ?? [], size.cols, size.rows);
        break;
      case "ollama-run":
        created = await docker.createOllamaRunSession(
          launchSpec.modelName,
          size.cols,
          size.rows,
          launchSpec.ollamaHost ?? null,
        );
        break;
      case "docker-model-run":
        docker.configureDockerHost(launchSpec.dockerHost ?? null);
        created = await docker.createModelRunnerSession(
          launchSpec.modelName,
          size.cols,
          size.rows,
          launchSpec.dockerHost ?? null,
        );
        break;
      case "ollama-pull":
        created = await docker.createOllamaPullSession(
          launchSpec.modelName,
          size.cols,
          size.rows,
          launchSpec.ollamaHost ?? null,
        );
        break;
      case "docker-image-pull":
        docker.configureDockerHost(launchSpec.dockerHost ?? null);
        created = await docker.createDockerImagePullSession(launchSpec.imageName, size.cols, size.rows);
        break;
      case "docker-model-pull":
        docker.configureDockerHost(launchSpec.dockerHost ?? null);
        created = await docker.createDockerModelPullSession(
          launchSpec.modelName,
          size.cols,
          size.rows,
          launchSpec.dockerHost ?? null,
        );
        break;
      default:
        throw new Error(`Unsupported launch spec: ${(launchSpec as { kind?: string }).kind ?? "unknown"}`);
    }

    const now = Date.now();
    sessionRecords.set(created.sessionId, {
      sessionId: created.sessionId,
      launchSpec,
      shell: created.shell,
      status: "running",
      createdAt: now,
      updatedAt: now,
      cols: size.cols,
      rows: size.rows,
    });
    persistState();
    return { ...created, reused: false };
  }

  async function handleMethod<T extends TerminalDaemonMethod>(
    method: T,
    params: unknown,
  ): Promise<TerminalDaemonRequestMap[T]["result"]> {
    const p = (params ?? {}) as Record<string, unknown>;
    switch (method) {
      case "ping":
        return { ok: true, version: TERMINAL_DAEMON_PROTOCOL_VERSION } as TerminalDaemonRequestMap[T]["result"];
      case "sessionCreate": {
        const launchSpec = p.launchSpec as TerminalLaunchSpec;
        const result = await createSession(launchSpec, p.cols as number | undefined, p.rows as number | undefined);
        return result as TerminalDaemonRequestMap[T]["result"];
      }
      case "sessionAttach": {
        const sessionId = String(p.sessionId ?? "");
        const session = sessionRecords.get(sessionId);
        if (!session || !docker.isTerminalSessionAlive(sessionId)) {
          throw new Error("Session no longer running");
        }
        const size = normalizeSize(p.cols as number | undefined, p.rows as number | undefined);
        docker.terminalResize(sessionId, size.cols, size.rows);
        session.updatedAt = Date.now();
        session.cols = size.cols;
        session.rows = size.rows;
        persistState();
        return {
          ok: true,
          shell: session.shell,
          recentOutput: sessionOutputTail.get(sessionId) ?? "",
        } as TerminalDaemonRequestMap[T]["result"];
      }
      case "sessionDetach":
        return { ok: true } as TerminalDaemonRequestMap[T]["result"];
      case "sessionList":
        return {
          sessions: Array.from(sessionRecords.values()).filter((entry) =>
            docker.isTerminalSessionAlive(entry.sessionId)
          ),
        } as TerminalDaemonRequestMap[T]["result"];
      case "sessionInput":
        docker.terminalInput(String(p.sessionId ?? ""), String(p.data ?? ""));
        return { ok: true } as TerminalDaemonRequestMap[T]["result"];
      case "sessionResize":
        docker.terminalResize(
          String(p.sessionId ?? ""),
          Number(p.cols ?? 80),
          Number(p.rows ?? 24),
        );
        return { ok: true } as TerminalDaemonRequestMap[T]["result"];
      case "sessionDestroy":
        docker.destroyTerminalSession(String(p.sessionId ?? ""));
        sessionRecords.delete(String(p.sessionId ?? ""));
        sessionOutputTail.delete(String(p.sessionId ?? ""));
        persistState();
        return { ok: true } as TerminalDaemonRequestMap[T]["result"];
      case "sessionDestroyMany":
        for (const sessionId of (p.sessionIds as string[] | undefined) ?? []) {
          try {
            docker.destroyTerminalSession(sessionId);
          } catch {
            // ignore
          }
          sessionRecords.delete(sessionId);
          sessionOutputTail.delete(sessionId);
        }
        persistState();
        return { ok: true } as TerminalDaemonRequestMap[T]["result"];
      case "listLocalShells":
        return { shells: await docker.listLocalShells() } as TerminalDaemonRequestMap[T]["result"];
      default:
        throw new Error(`Unsupported method: ${String(method)}`);
    }
  }

  function parseLine(line: string): TerminalDaemonRequestEnvelope | { type: "subscribe" } | null {
    if (!line.trim()) return null;
    try {
      return JSON.parse(line) as TerminalDaemonRequestEnvelope | { type: "subscribe" };
    } catch {
      return null;
    }
  }

  const server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");

    socket.on("data", (chunk) => {
      buffer += chunk;
      while (true) {
        const idx = buffer.indexOf("\n");
        if (idx < 0) break;
        const rawLine = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        const parsed = parseLine(rawLine);
        if (!parsed) continue;

        if ("type" in parsed && parsed.type === "subscribe") {
          subscribers.add(socket);
          continue;
        }
        if (!("id" in parsed) || !("method" in parsed)) {
          continue;
        }
        const id = String(parsed.id);
        const method = parsed.method as TerminalDaemonMethod;
        const params = (parsed as { params?: unknown }).params ?? {};
        void (async () => {
          try {
            const result = await handleMethod(method, params as never);
            const msg: TerminalDaemonResponseEnvelope = { id, ok: true, result };
            socket.write(`${JSON.stringify(msg)}\n`);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const msg: TerminalDaemonResponseEnvelope = { id, ok: false, error: message };
            socket.write(`${JSON.stringify(msg)}\n`);
          }
        })();
      }
    });

    const cleanup = () => {
      subscribers.delete(socket);
    };
    socket.on("error", cleanup);
    socket.on("close", cleanup);
  });

  server.on("error", (error) => {
    console.error("[terminal-daemon] fatal error:", error);
    if (exitOnFatal) {
      process.exit(1);
    }
  });

  const stop = () => {
    try {
      server.close();
    } catch {
      // ignore
    }
  };

  if (installSignalHandlers) {
    process.on("SIGINT", () => {
      stop();
      process.exit(0);
    });
    process.on("SIGTERM", () => {
      stop();
      process.exit(0);
    });
  }

  server.listen(socketPath);
  return { stateDir, socketPath, stop };
}

if (import.meta.main) {
  const args = parseCliArgs();
  startTerminalDaemon(args.get("state-dir"), {
    installSignalHandlers: true,
    exitOnFatal: true,
  });
}
