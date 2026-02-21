/**
 * File-based storage backend for app settings.
 * Uses a single JSON file in the app data folder for persistence.
 * Shared across all app instances (built app, dev server).
 *
 * - Electrobun main process: pass baseFolder from Updater.appDataFolder()
 * - Dev server: uses getAppDataFolderPath() (no Electrobun)
 */

import { mkdirSync } from "fs";
import { join } from "path";
import { getAppDataFolderPath } from "./appStoragePath";

const STORAGE_FILENAME = "app-storage.json";

async function getStorageFilePath(baseFolder?: string): Promise<string> {
  const folder = baseFolder ?? getAppDataFolderPath();
  mkdirSync(folder, { recursive: true });
  return join(folder, STORAGE_FILENAME);
}

async function readStorageFile(baseFolder?: string): Promise<Record<string, string>> {
  try {
    const path = await getStorageFilePath(baseFolder);
    const file = Bun.file(path);
    if (!(await file.exists())) return {};
    const json = await file.json();
    return typeof json === "object" && json !== null ? (json as Record<string, string>) : {};
  } catch {
    return {};
  }
}

async function writeStorageFile(data: Record<string, string>, baseFolder?: string): Promise<void> {
  const path = await getStorageFilePath(baseFolder);
  await Bun.write(path, JSON.stringify(data, null, 2));
}

export type StorageBackendOptions = { baseFolder?: string };

export async function storageGet(key: string, opts?: StorageBackendOptions): Promise<string | null> {
  const data = await readStorageFile(opts?.baseFolder);
  return data[key] ?? null;
}

export async function storageSet(key: string, value: string, opts?: StorageBackendOptions): Promise<void> {
  const data = await readStorageFile(opts?.baseFolder);
  data[key] = value;
  await writeStorageFile(data, opts?.baseFolder);
}

export async function storageRemove(key: string, opts?: StorageBackendOptions): Promise<void> {
  const data = await readStorageFile(opts?.baseFolder);
  delete data[key];
  await writeStorageFile(data, opts?.baseFolder);
}

export async function storageGetAll(opts?: StorageBackendOptions): Promise<Record<string, string>> {
  return readStorageFile(opts?.baseFolder);
}

export async function storageClear(opts?: StorageBackendOptions): Promise<void> {
  await writeStorageFile({}, opts?.baseFolder);
}
