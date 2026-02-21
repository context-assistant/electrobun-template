/**
 * App data folder path for persistent storage.
 * Matches Electrobun's Updater.appDataFolder() so dev and built app share the same location.
 *
 * - Built app: uses Updater.appDataFolder() (requires Electrobun runtime)
 * - Dev server: computes equivalent path (no Electrobun, e.g. bun run dev:server)
 */

import { join } from "path";
import { homedir } from "os";

const APP_IDENTIFIER = "com.contextassistant.app";
const APP_NAME = "Context Assistant";

function getAppDataDir(): string {
  const platform = process.platform;
  if (platform === "darwin") {
    return join(homedir(), "Library", "Application Support");
  }
  if (platform === "win32") {
    return process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
  }
  return process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
}

/**
 * Returns the app data folder path.
 * Use this when Electrobun's Updater.appDataFolder() is not available (e.g. dev server).
 */
export function getAppDataFolderPath(): string {
  return join(getAppDataDir(), APP_IDENTIFIER, APP_NAME);
}
