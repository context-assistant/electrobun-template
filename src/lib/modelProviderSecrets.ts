import { isElectrobun } from "../electrobun/env";
import { secretsDelete, secretsGet, secretsSet } from "../electrobun/renderer";
import type { ModelProviderSecretFieldKey, ModelProviderSecretValues } from "./modelProviders";

const SECRET_NAMESPACE = "modelProvider";

function sanitizeToken(value: string) {
  return value.replace(/[^a-zA-Z0-9._:-]/g, "_").slice(0, 64);
}

export function buildModelProviderSecretRef(
  providerId: string,
  key: ModelProviderSecretFieldKey,
): string {
  return `${SECRET_NAMESPACE}.${sanitizeToken(providerId)}.${key}`;
}

export async function resolveModelProviderSecret(secretRef: string): Promise<string | null> {
  if (!isElectrobun()) return null;
  return await secretsGet(secretRef);
}

export async function persistModelProviderSecretValues(
  providerId: string,
  secretValues: ModelProviderSecretValues,
): Promise<Record<string, string>> {
  if (!isElectrobun()) {
    throw new Error("Secret storage requires Electrobun runtime.");
  }
  const secretRefs: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(secretValues)) {
    if (typeof rawValue !== "string") continue;
    const value = rawValue.trim();
    if (!value) continue;
    const key = rawKey as ModelProviderSecretFieldKey;
    const secretRef = buildModelProviderSecretRef(providerId, key);
    await secretsSet(secretRef, value);
    secretRefs[key] = secretRef;
  }
  return secretRefs;
}

export async function deleteModelProviderSecrets(secretRefs: Record<string, string>) {
  if (!isElectrobun()) return;
  for (const secretRef of Object.values(secretRefs)) {
    if (!secretRef?.trim()) continue;
    try {
      await secretsDelete(secretRef);
    } catch {
      // ignore secret deletion failures
    }
  }
}
