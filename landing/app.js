function getDefaultRepoFromLocation() {
  const host = window.location.host || "";
  const path = window.location.pathname || "/";

  // GitHub Pages default: https://<owner>.github.io/<repo>/
  const hostParts = host.split(".");
  const owner = hostParts.length >= 3 && hostParts[1] === "github" && hostParts[2] === "io" ? hostParts[0] : "";
  const repo = path.split("/").filter(Boolean)[0] || "";

  if (owner && repo) return { owner, repo };
  return { owner: "", repo: "" };
}

function getRepo() {
  const root = document.body;
  const ownerFromAttr = root?.getAttribute("data-owner") || "";
  const repoFromAttr = root?.getAttribute("data-repo") || "";
  if (ownerFromAttr && repoFromAttr) return { owner: ownerFromAttr, repo: repoFromAttr };
  return getDefaultRepoFromLocation();
}

function setLinks({ owner, repo }) {
  const repoUrl = owner && repo ? `https://github.com/${owner}/${repo}` : "https://github.com";
  const releasesUrl = owner && repo ? `${repoUrl}/releases` : "https://github.com";

  for (const el of document.querySelectorAll("[data-repo-link]")) el.setAttribute("href", repoUrl);
  for (const el of document.querySelectorAll("[data-releases-link]")) el.setAttribute("href", releasesUrl);
}

function setButtonState(platform, { title, sub, href }) {
  const btn = document.querySelector(`[data-dl="${platform}"]`);
  const subEl = document.querySelector(`[data-dl-sub="${platform}"]`);
  if (!btn || !subEl) return;
  if (href) btn.setAttribute("href", href);
  if (title) btn.querySelector(".btn-title")?.replaceChildren(document.createTextNode(title));
  if (sub) subEl.replaceChildren(document.createTextNode(sub));
}

function pickAsset(assets, { platformIncludes, extPreferences }) {
  const filtered = assets
    .filter((a) => a && typeof a.name === "string" && typeof a.browser_download_url === "string")
    .filter((a) => platformIncludes.every((s) => a.name.toLowerCase().includes(s)));

  for (const ext of extPreferences) {
    const found = filtered.find((a) => a.name.toLowerCase().endsWith(ext));
    if (found) return found;
  }
  return filtered[0] || null;
}

async function wireDownloads() {
  const { owner, repo } = getRepo();
  setLinks({ owner, repo });

  const releasesUrl = owner && repo ? `https://github.com/${owner}/${repo}/releases` : "https://github.com";
  const latestApi = owner && repo ? `https://api.github.com/repos/${owner}/${repo}/releases/latest` : "";

  // Fallbacks if we can't infer repo (custom domain etc.)
  if (!latestApi) {
    setButtonState("mac", { sub: "Open Releases" });
    setButtonState("windows", { sub: "Open Releases" });
    setButtonState("linux", { sub: "Open Releases" });
    return;
  }

  try {
    const res = await fetch(latestApi, { headers: { Accept: "application/vnd.github+json" } });
    if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
    const data = await res.json();
    const tag = typeof data.tag_name === "string" ? data.tag_name : "latest";
    const assets = Array.isArray(data.assets) ? data.assets : [];

    // Asset naming in this repo is typically:
    //   stable-macos-arm64.ContextAssistant.dmg
    //   stable-<os>-<arch>.<filename>
    //
    // We keep matching flexible, so it still works if you later upload .zip/.msi/.AppImage/etc.
    const mac =
      pickAsset(assets, {
        platformIncludes: ["stable-macos", "arm64"],
        extPreferences: [".dmg", ".zip", ".app.tar.zst", ".tar.zst"],
      }) ||
      pickAsset(assets, {
        platformIncludes: ["stable-macos"],
        extPreferences: [".dmg", ".zip", ".app.tar.zst", ".tar.zst"],
      });

    const windows =
      pickAsset(assets, {
        platformIncludes: ["stable-windows"],
        extPreferences: [".exe", ".msi", ".zip", ".tar.zst"],
      }) || pickAsset(assets, { platformIncludes: ["windows"], extPreferences: [".exe", ".msi", ".zip"] });

    const linux =
      pickAsset(assets, {
        platformIncludes: ["stable-linux"],
        extPreferences: [".appimage", ".deb", ".rpm", ".tar.zst", ".tar.gz", ".zip"],
      }) || pickAsset(assets, { platformIncludes: ["linux"], extPreferences: [".appimage", ".deb", ".rpm", ".tar.gz"] });

    if (mac) {
      setButtonState("mac", { sub: `${tag} • ${mac.name}`.slice(0, 80), href: mac.browser_download_url });
    } else {
      setButtonState("mac", { sub: `${tag} • Open Releases`, href: releasesUrl });
    }

    if (windows) {
      setButtonState("windows", { sub: `${tag} • ${windows.name}`.slice(0, 80), href: windows.browser_download_url });
    } else {
      setButtonState("windows", { sub: `${tag} • Open Releases`, href: releasesUrl });
    }

    if (linux) {
      setButtonState("linux", { sub: `${tag} • ${linux.name}`.slice(0, 80), href: linux.browser_download_url });
    } else {
      setButtonState("linux", { sub: `${tag} • Open Releases`, href: releasesUrl });
    }
  } catch (err) {
    setButtonState("mac", { sub: "Open Releases", href: releasesUrl });
    setButtonState("windows", { sub: "Open Releases", href: releasesUrl });
    setButtonState("linux", { sub: "Open Releases", href: releasesUrl });
  }
}

wireDownloads();

