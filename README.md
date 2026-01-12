## Context Assistant (Electrobun Template)

A cross‑platform **desktop app template** built with **[Electrobun](https://electrobun.dev/)** + **Bun** + **React** + **Tailwind CSS v4**.

- **Desktop shell**: Electrobun (`src/bun/index.ts`)
- **Renderer UI**: React 19 (`src/main.tsx`, `src/App.tsx`)
- **UI stack**: Tailwind v4 + Radix UI primitives + Redux Toolkit
- **Batteries included**:
  - Theme toggle (system/light/dark) in `SettingsModal`
  - Auto‑update plumbing via Electrobun `Updater` (GitHub Releases workflow included)
  - Secrets storage via `bun`’s `secrets` API (Keychain / Credential Manager / libsecret)
  - Window state persistence (size/position)

### Requirements

- **Bun** (the repo’s CI uses Bun **1.3.4**)
- **Linux only**: AppImage requires `libfuse2` (CI installs it automatically)

### Install

```bash
bun install
```

### Dev (desktop app)

Builds and opens the Electrobun app in **dev** mode:

```bash
bun dev
```

This runs `bunx electrobun build --env=dev` and then launches the output from:

- `build/dev-<os>-<arch>/`

### Dev (web-only / browser)

Runs the renderer in a browser with HMR (useful for fast UI iteration):

```bash
bun run dev:web
```

### Build (desktop app)

Builds the **stable** desktop artifacts:

```bash
bun run build:app
```

Electrobun writes:

- **Build outputs**: `build/stable-<os>-<arch>/...`
- **Updater artifacts**: `artifacts/stable-<os>-<arch>/...` (includes `update.json`, plus platform archives/patches when available)

### Build (static web bundle)

Builds `src/*.html` into `dist/`:

```bash
bun run build
```

Preview the `dist/` output:

```bash
bun run preview
```

### Landing page (GitHub Pages)

This repo also includes a simple **static landing page** (dark theme) in `landing/` that:

- Uses the project logo from `src/design/logo.svg`
- Links to the GitHub repo + Releases
- Auto-detects the latest release assets (Mac/Linux/Windows) via the public GitHub Releases API

Build it locally (generates `landing/index.html` and copies the logo into `landing/assets/`):

```bash
bun run build:landing
```

Preview it:

```bash
bun run preview:landing
```

Deployment is handled by GitHub Actions via `.github/workflows/pages.yml` (GitHub Pages source: **GitHub Actions**).

### Test

```bash
bun test
```

Watch mode:

```bash
bun run test:watch
```

### Project layout (high level)

- **`electrobun.config.ts`**: app metadata, build entrypoints, icons, updater `bucketUrl`
- **`src/bun/index.ts`**: main process (window creation, menu, updater + secrets RPC)
- **`src/electrobun/rpcSchema.ts`**: typed RPC schema shared by bun + renderer
- **`src/electrobun/renderer.ts`**: renderer-side RPC bridge + update-info subscription helpers
- **`scripts/electrobun-postbuild.ts`**: rebuilds the renderer with `bun-plugin-tailwind` (Tailwind v4) and copies it into the app bundle
- **`scripts/generate-app-icons.ts`**: generates macOS `icon.iconset`, Linux PNG, Windows `.ico` from `src/design/logo.svg`

### Icons

Edit `src/design/logo.svg`, then regenerate platform icon assets:

```bash
bun run generate:icons
```

### Auto-updates (GitHub Releases)

This template is wired for **Electrobun’s `Updater`**.

- **Updater URL shape**: `bucketUrl/<channel>-<os>-<arch>/update.json`
- **This repo’s default release backend**: GitHub Releases “latest download”
  - `bucketUrl`: `https://github.com/<owner>/<repo>/releases/latest/download`
  - Provided at build time via `ELECTROBUN_BUCKET_URL` (see `.github/workflows/release.yml`)

The release workflow uploads assets with names like:

- `stable-macos-arm64/update.json`
- `stable-macos-arm64/<hash>.patch` (when available)
- `stable-macos-arm64/<app>.app.tar.zst`

### Cutting a release

- Update version(s) as desired (see `electrobun.config.ts`)
- Push a tag like `v0.1.0`
- GitHub Actions builds macOS/Linux/Windows and publishes a GitHub Release containing the updater assets

#### GitHub Releases note (important)

GitHub’s `.../releases/*/download/...` endpoint treats the **asset name as a single path segment** (not a folder path).
So this template uploads updater assets using **flat names**:

- `stable-macos-arm64.update.json`
- `stable-macos-arm64.<hash>.patch`
- `stable-macos-arm64.<app>.app.tar.zst`

This template includes a `postinstall` patch (`scripts/patch-electrobun-url-join.ts`) so Electrobun’s Updater generates URLs in that format automatically.

### macOS: “App is damaged and can’t be opened”

If you download a macOS `.dmg`/`.app` from GitHub Releases and see:

- “**<App> is damaged and can’t be opened**”

that typically means the app **was not codesigned + notarized** (required for distribution) and/or it still has a **quarantine** attribute from the browser download.

- **Proper fix (recommended)**: enable codesign + notarization in CI.
  - This template supports it via Electrobun; configure the secrets listed in `.github/workflows/release.yml`.
- **Local dev workaround (not for end users)**: remove quarantine on the extracted app:

```bash
xattr -dr com.apple.quarantine "/Applications/ContextAssistant.app"
```
