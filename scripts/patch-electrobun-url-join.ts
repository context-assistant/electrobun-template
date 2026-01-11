#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

/**
 * Electrobun currently uses `path.join()` for URL construction in a few places.
 * That breaks `https://...` into `https:/...` and causes updater fetches to fail.
 *
 * This script patches the installed Electrobun files to use a URL-safe join.
 *
 * Safe to run multiple times.
 */

function patchFile(filePath: string, replacer: (src: string) => string): boolean {
  const src = readFileSync(filePath, "utf8");
  const next = replacer(src);
  if (next === src) return false;
  writeFileSync(filePath, next, "utf8");
  return true;
}

function ensureUrlJoinHelper(src: string): string {
  const helper = `

// ELECTROBUN_URL_JOIN_PATCH_START
// URL-safe join (avoid path.join() mangling https:// -> https:/)
//
  // Special case: GitHub Releases "download" endpoints treat the asset name as a *single* path segment.
  // This template uploads assets as a flat name:
  //   stable-macos-arm64.update.json
  //   stable-macos-arm64.<hash>.patch
  //   stable-macos-arm64.<app>.app.tar.zst
  // so the URL must be:
  //   .../download/stable-macos-arm64.update.json
function electrobunUrlJoin(base: string, ...parts: string[]) {
  const b = String(base).replace(/\\/+$/, "");
  const cleaned = parts
    .filter((p) => p !== undefined && p !== null)
    .map((p) => String(p).replace(/^\\/+/, ""));

  const isGitHubReleaseDownload =
    b.includes("github.com/") &&
    b.includes("/releases/") &&
    b.endsWith("/download");

  if (isGitHubReleaseDownload && cleaned.length >= 2) {
    const last = cleaned[cleaned.length - 1]!;
    const qIdx = last.indexOf("?");
    const filePart = qIdx >= 0 ? last.slice(0, qIdx) : last;
    const query = qIdx >= 0 ? last.slice(qIdx + 1) : "";

    const assetName = [...cleaned.slice(0, -1), filePart].join(".");
    // No encoding needed because we deliberately avoid "/" in asset names.
    return query ? \`\${b}/\${assetName}?\${query}\` : \`\${b}/\${assetName}\`;
  }

  const rest = cleaned.join("/");
  return rest ? \`\${b}/\${rest}\` : b;
}
// ELECTROBUN_URL_JOIN_PATCH_END
`;

  if (src.includes("// ELECTROBUN_URL_JOIN_PATCH_START")) {
    return src.replace(
      /\/\/ ELECTROBUN_URL_JOIN_PATCH_START[\s\S]*?\/\/ ELECTROBUN_URL_JOIN_PATCH_END\n/,
      helper,
    );
  }

  // Back-compat: replace the previously inserted helper (no markers).
  if (src.includes("// URL-safe join (avoid path.join() mangling https:// -> https:/)")) {
    return src.replace(
      /\/\/ URL-safe join \(avoid path\.join\(\) mangling https:\/\/ -> https:\/\)[\s\S]*?function electrobunUrlJoin\([\s\S]*?\n}\n/,
      helper,
    );
  }

  // Insert after imports (best-effort).
  const importEndIdx = src.lastIndexOf(";\n");
  if (importEndIdx !== -1 && importEndIdx < 4000) {
    return src.slice(0, importEndIdx + 2) + helper + src.slice(importEndIdx + 2);
  }
  return helper + src;
}

function patchUpdaterTs(src: string): string {
  let out = ensureUrlJoinHelper(src);

  // Replace URL joins but keep filesystem path.join usage intact.
  out = out.replaceAll(
    "const updateInfoUrl = join(localInfo.bucketUrl, platformFolder, `update.json?${cacheBuster}`);",
    "const updateInfoUrl = electrobunUrlJoin(localInfo.bucketUrl, platformFolder, `update.json?${cacheBuster}`);",
  );

  out = out.replaceAll(
    "join(localInfo.bucketUrl, platformFolder, `${currentHash}.patch`)",
    "electrobunUrlJoin(localInfo.bucketUrl, platformFolder, `${currentHash}.patch`)",
  );

  out = out.replaceAll(
    "const urlToLatestTarball = join(\n          localInfo.bucketUrl,\n          platformFolder,\n          tarballName\n        );",
    "const urlToLatestTarball = electrobunUrlJoin(localInfo.bucketUrl, platformFolder, tarballName);",
  );

  out = out.replaceAll(
    "return join(localInfo.bucketUrl, platformFolder);",
    "return electrobunUrlJoin(localInfo.bucketUrl, platformFolder);",
  );

  return out;
}

function patchCliIndexTs(src: string): string {
  let out = ensureUrlJoinHelper(src);

  // Patch the URL used to fetch previous update.json for diff generation.
  out = out.replaceAll(
    "const urlToPrevUpdateJson = join(\n        config.release.bucketUrl,\n        buildSubFolder,\n        'update.json'\n      );",
    "const urlToPrevUpdateJson = electrobunUrlJoin(config.release.bucketUrl, buildSubFolder, 'update.json');",
  );

  // Patch URL for downloading previous tarball in diff generation.
  out = out.replaceAll(
    "join(\n      config.release.bucketUrl,\n      buildSubFolder,\n      `${appFileName}.app.tar.zst`\n    );",
    "electrobunUrlJoin(config.release.bucketUrl, buildSubFolder, `${appFileName}.app.tar.zst`);",
  );

  out = out.replaceAll(
    "join(\n      config.release.bucketUrl,\n      buildSubFolder,\n      `${appFileName}.tar.zst`\n    );",
    "electrobunUrlJoin(config.release.bucketUrl, buildSubFolder, `${appFileName}.tar.zst`);",
  );

  return out;
}

const projectRoot = process.cwd();
const electrobunDir = join(projectRoot, "node_modules", "electrobun");

const targets = [
  join(electrobunDir, "dist", "api", "bun", "core", "Updater.ts"),
  ...new Bun.Glob("dist-*/api/bun/core/Updater.ts").scanSync(electrobunDir).map((p) => join(electrobunDir, p)),
  join(electrobunDir, "src", "cli", "index.ts"),
];

let changed = 0;
for (const filePath of targets) {
  const didPatch = filePath.endsWith("Updater.ts")
    ? patchFile(filePath, patchUpdaterTs)
    : patchFile(filePath, patchCliIndexTs);
  if (didPatch) {
    changed++;
    // eslint-disable-next-line no-console
    console.log(`Patched: ${filePath}`);
  }
}

// eslint-disable-next-line no-console
console.log(`Electrobun URL patch complete. Files changed: ${changed}`);

