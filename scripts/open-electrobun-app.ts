#!/usr/bin/env bun
import { join } from "path";

const envArg =
  process.argv.find((a) => a.startsWith("--env="))?.split("=", 2)[1] ?? "dev";

const platform = process.platform;
const arch = process.arch;

const osName =
  platform === "darwin" ? "macos" : platform === "win32" ? "win" : "linux";

const configModule = await import(join(process.cwd(), "electrobun.config.ts"));
const config = (configModule.default ?? configModule) as {
  app: { name: string };
};

const appFileName = (envArg === "stable" ? config.app.name : `${config.app.name}-${envArg}`)
  .replace(/\s/g, "")
  .replace(/\./g, "-");

const buildSubFolder = `${envArg}-${osName}-${arch}`;
const buildFolder = join(process.cwd(), "build", buildSubFolder);

if (osName === "macos") {
  const appPath = join(buildFolder, `${appFileName}.app`);
  const p = Bun.spawnSync(["open", "-n", appPath], {
    stdio: ["inherit", "inherit", "inherit"],
  });
  process.exit(p.exitCode ?? 0);
}

if (osName === "linux") {
  const appDir = join(buildFolder, appFileName);
  const launcherPath = join(appDir, "bin", "launcher");
  const p = Bun.spawn([launcherPath], {
    cwd: appDir,
    stdio: ["inherit", "inherit", "inherit"],
  });
  // Don't wait for the app to exit (same as macOS "open -n" behavior).
  p.unref();
  process.exit(0);
}

if (osName === "win") {
  const appDir = join(buildFolder, appFileName);
  const launcherPath = join(appDir, "bin", "Context Assistant.exe");
  const p = Bun.spawn([launcherPath], {
    cwd: appDir,
    stdio: ["inherit", "inherit", "inherit"],
  });
  p.unref();
  process.exit(0);
}

// Fallback: just tell the user where the build output is.
console.log(`Built app at: ${buildFolder}`);
console.log(
  `For ${osName}, launch using Electrobun's CLI (or run the platform artifact).`,
);

