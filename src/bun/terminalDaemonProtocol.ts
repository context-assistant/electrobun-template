import { join } from "node:path";
import { createHash } from "node:crypto";
import type { TerminalLaunchSpec, TerminalSessionCreateResult, TerminalSessionRecord } from "../lib/terminalSessionTypes";

export const TERMINAL_DAEMON_PROTOCOL_VERSION = 2;
export const TERMINAL_DAEMON_SOCKET_BASENAME = "terminal-daemon.sock";
export const TERMINAL_DAEMON_STATE_BASENAME = "terminal-sessions.v1.json";
export const TERMINAL_DAEMON_PID_BASENAME = "terminal-daemon.pid";
const MAX_UNIX_SOCKET_PATH = 100;

export type TerminalDaemonRequestMap = {
  ping: {
    params: {};
    result: { ok: true; version: number };
  };
  sessionCreate: {
    params: {
      launchSpec: TerminalLaunchSpec;
      cols?: number;
      rows?: number;
      preferredSessionId?: string;
    };
    result: TerminalSessionCreateResult;
  };
  sessionAttach: {
    params: {
      sessionId: string;
      cols?: number;
      rows?: number;
    };
    result: { ok: true; shell: string; recentOutput: string };
  };
  sessionDetach: {
    params: {
      sessionId: string;
    };
    result: { ok: true };
  };
  sessionList: {
    params: {};
    result: { sessions: TerminalSessionRecord[] };
  };
  sessionInput: {
    params: { sessionId: string; data: string };
    result: { ok: true };
  };
  sessionResize: {
    params: { sessionId: string; cols: number; rows: number };
    result: { ok: true };
  };
  sessionDestroy: {
    params: { sessionId: string };
    result: { ok: true };
  };
  sessionDestroyMany: {
    params: { sessionIds: string[] };
    result: { ok: true };
  };
  listLocalShells: {
    params: {};
    result: { shells: string[] };
  };
};

export type TerminalDaemonMethod = keyof TerminalDaemonRequestMap;

export type TerminalDaemonRequestEnvelope<T extends TerminalDaemonMethod = TerminalDaemonMethod> = {
  id: string;
  method: T;
  params: TerminalDaemonRequestMap[T]["params"];
};

export type TerminalDaemonResponseEnvelope =
  | {
    id: string;
    ok: true;
    result: unknown;
  }
  | {
    id: string;
    ok: false;
    error: string;
  };

export type TerminalDaemonEventEnvelope =
  | {
    type: "event";
    event: "output";
    payload: { sessionId: string; data: string };
  }
  | {
    type: "event";
    event: "exit";
    payload: { sessionId: string; code: number };
  };

export type TerminalDaemonSubscribeEnvelope = {
  type: "subscribe";
};

export function daemonSocketPath(stateDir: string): string {
  const preferred = join(stateDir, TERMINAL_DAEMON_SOCKET_BASENAME);
  // macOS/Linux AF_UNIX paths are short; long app-data dirs can break listen/connect.
  if (process.platform !== "win32" && preferred.length > MAX_UNIX_SOCKET_PATH) {
    const hash = createHash("sha1").update(stateDir).digest("hex").slice(0, 12);
    return join("/tmp", `ca-terminal-daemon-${hash}.sock`);
  }
  return preferred;
}

export function daemonStateFilePath(stateDir: string): string {
  return join(stateDir, TERMINAL_DAEMON_STATE_BASENAME);
}

export function daemonPidPath(stateDir: string): string {
  return join(stateDir, TERMINAL_DAEMON_PID_BASENAME);
}
