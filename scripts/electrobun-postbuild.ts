#!/usr/bin/env bun
import plugin from "bun-plugin-tailwind";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "fs";
import { join } from "path";

function findResourcesAppFolder(root: string): string {
  const stack: string[] = [root];
  const seen = new Set<string>();

  while (stack.length) {
    const dir = stack.pop();
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);

    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }

    // Fast path: look for a Resources/app folder in this directory
    if (entries.includes("Resources")) {
      const candidate = join(dir, "Resources", "app");
      if (existsSync(candidate)) return candidate;
    }

    for (const name of entries) {
      const full = join(dir, name);
      try {
        if (statSync(full).isDirectory()) stack.push(full);
      } catch {
        // ignore
      }
    }
  }

  throw new Error(`Failed to locate a "Resources/app" folder under: ${root}`);
}

const buildDir = process.env.ELECTROBUN_BUILD_DIR;
if (!buildDir) {
  console.error(
    "Missing ELECTROBUN_BUILD_DIR; is this running under electrobun?",
  );
  process.exit(1);
}

const resourcesAppDir = findResourcesAppFolder(buildDir);
const viewOutDir = join(resourcesAppDir, "views", "main");

// Build into a temp folder then copy into the app bundle.
const tmpOutDir = join(process.cwd(), ".tmp-electrobun-renderer");
rmSync(tmpOutDir, { recursive: true, force: true });
mkdirSync(tmpOutDir, { recursive: true });

// Use the regular `src/index.html` as the bundler entrypoint so Bun can discover
// and bundle `./main.tsx` + CSS (then it will rewrite the HTML to point at the
// emitted `main.js` / `main.css`).
const entryHtml = join(process.cwd(), "src", "index.html");
const result = await Bun.build({
  entrypoints: [entryHtml],
  outdir: tmpOutDir,
  plugins: [plugin],
  target: "browser",
  minify: process.env.ELECTROBUN_BUILD_ENV !== "dev",
  sourcemap: process.env.ELECTROBUN_BUILD_ENV === "dev" ? "linked" : "none",
  define: {
    "process.env.NODE_ENV": JSON.stringify(
      process.env.ELECTROBUN_BUILD_ENV === "dev" ? "development" : "production",
    ),
  },
});

if (!result.success) {
  console.error("Electrobun postBuild: renderer build failed", result.logs);
  process.exit(1);
}

rmSync(viewOutDir, { recursive: true, force: true });
mkdirSync(viewOutDir, { recursive: true });

// Bun doesn't expose a single "copy dir" helper; `Bun.write` can copy files but
// we need a recursive copy. We'll just use `cp -R` via Bun.spawnSync for speed.
// (This script is only executed on the build host.)
const cp = Bun.spawnSync(["cp", "-R", tmpOutDir + "/", viewOutDir + "/"]);
if (cp.exitCode !== 0) {
  console.error("Failed to copy renderer output into app bundle.", cp.stderr);
  process.exit(cp.exitCode ?? 1);
}

console.log(`✅ Electrobun postBuild: wrote renderer to ${viewOutDir}`);

// macOS: ensure the app runs in HiDPI/Retina mode (prevents blurry UI/icons)
// Electrobun's generated Info.plist doesn't currently include this key.
if (process.env.ELECTROBUN_OS === "macos") {
  try {
    const contentsDir = join(resourcesAppDir, "..", ".."); // .../Contents
    const plistPath = join(contentsDir, "Info.plist");
    const plistFile = Bun.file(plistPath);
    if (await plistFile.exists()) {
      const plistText = await plistFile.text();
      if (!plistText.includes("NSHighResolutionCapable")) {
        const insertion =
          "    <key>NSHighResolutionCapable</key>\n    <true/>\n";
        const updated = plistText.replace("</dict>", `${insertion}</dict>`);
        await Bun.write(plistPath, updated);
        console.log("✅ Enabled NSHighResolutionCapable (Retina) in Info.plist");
      }
    }
  } catch (err) {
    console.warn("Failed to patch Info.plist for Retina mode:", err);
  }
}
