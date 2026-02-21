export type ContainerShell = {
  name: string;
  command: string;
};

function trimString(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

export function inferContainerShellName(command: string): string {
  const trimmed = trimString(command);
  if (!trimmed) return "shell";
  const firstToken = trimmed.split(/\s+/)[0] ?? "";
  const normalized = firstToken.replace(/\\/g, "/");
  const basename = normalized.split("/").pop()?.trim() ?? "";
  return basename || trimmed;
}

export function normalizeContainerShells(shells: Array<Partial<ContainerShell> | null | undefined> | null | undefined): ContainerShell[] {
  const seen = new Set<string>();
  const normalized: ContainerShell[] = [];
  for (const shell of shells ?? []) {
    const command = trimString(shell?.command);
    if (!command) continue;
    const name = trimString(shell?.name) || inferContainerShellName(command);
    const key = `${name}\n${command}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({ name, command });
  }
  return normalized;
}

export function createEmptyContainerShell(): ContainerShell {
  return { name: "", command: "" };
}

export function createDefaultContainerShell(command: string): ContainerShell {
  const trimmed = trimString(command);
  return {
    name: inferContainerShellName(trimmed),
    command: trimmed,
  };
}

export function parseContainerShellsLabel(value: string | null | undefined): ContainerShell[] {
  const trimmed = trimString(value);
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? normalizeContainerShells(parsed) : [];
  } catch {
    return [];
  }
}

export function serializeContainerShellsLabel(shells: Array<Partial<ContainerShell> | null | undefined> | null | undefined): string | null {
  const normalized = normalizeContainerShells(shells);
  return normalized.length > 0 ? JSON.stringify(normalized) : null;
}

export function getConfiguredContainerShells(source: {
  containerShells?: Array<Partial<ContainerShell> | null | undefined> | null;
  execCommandShell?: string | null;
}): ContainerShell[] {
  const normalized = normalizeContainerShells(source.containerShells);
  if (normalized.length > 0) return normalized;
  const legacyCommand = trimString(source.execCommandShell);
  return legacyCommand ? [createDefaultContainerShell(legacyCommand)] : [];
}

export function getPrimaryContainerShell(source: {
  containerShells?: Array<Partial<ContainerShell> | null | undefined> | null;
  execCommandShell?: string | null;
}): ContainerShell | null {
  return getConfiguredContainerShells(source)[0] ?? null;
}
