#!/usr/bin/env bun
import { mkdir, writeFile, readFile, copyFile } from "fs/promises";
import path from "path";

type Repo = { owner: string; repo: string };

function parseGitHubRepository(envVal: string | undefined): Repo | null {
  if (!envVal) return null;
  const v = envVal.trim();
  const parts = v.split("/");
  if (parts.length !== 2) return null;
  const owner = parts[0]?.trim() ?? "";
  const repo = parts[1]?.trim() ?? "";
  if (!owner || !repo) return null;
  return { owner, repo };
}

async function main() {
  const projectRoot = process.cwd();
  const landingDir = path.join(projectRoot, "landing");
  const assetsDir = path.join(landingDir, "assets");

  await mkdir(assetsDir, { recursive: true });

  // Sync logo (source of truth is src/design/logo.svg)
  const logoSrc = path.join(projectRoot, "src", "design", "logo.svg");
  const logoDst = path.join(assetsDir, "logo.svg");
  await copyFile(logoSrc, logoDst);

  // Ensure Pages serves files exactly as-is
  await writeFile(path.join(landingDir, ".nojekyll"), "");

  const tplPath = path.join(landingDir, "index.template.html");
  const outPath = path.join(landingDir, "index.html");
  const tpl = await readFile(tplPath, "utf8");

  const gh = parseGitHubRepository(process.env.GITHUB_REPOSITORY);
  const owner = gh?.owner ?? "";
  const repo = gh?.repo ?? "";

  const repoUrl = owner && repo ? `https://github.com/${owner}/${repo}` : "https://github.com";
  const releasesUrl = owner && repo ? `${repoUrl}/releases` : "https://github.com";

  const html = tpl
    .replaceAll("__GH_OWNER__", owner)
    .replaceAll("__GH_REPO__", repo)
    .replaceAll("__REPO_URL__", repoUrl)
    .replaceAll("__RELEASES_URL__", releasesUrl);

  await writeFile(outPath, html, "utf8");

  // eslint-disable-next-line no-console
  console.log(`✅ Landing page built: ${path.relative(projectRoot, outPath)}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

