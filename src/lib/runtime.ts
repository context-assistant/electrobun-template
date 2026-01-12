import { isElectrobun } from "../electrobun/env";

export type AppRuntime = "electrobun" | "web";

export function getRuntime(): AppRuntime {
  return isElectrobun() ? "electrobun" : "web";
}

export const runtime = {
  current: getRuntime(),
  isElectrobun: isElectrobun(),
  isWeb: !isElectrobun(),
} as const;

