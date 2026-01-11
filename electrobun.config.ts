import type { ElectrobunConfig } from "electrobun";
// Import the version from package.json
// @ts-ignore
import { version } from "./package.json";


const config: ElectrobunConfig = {
  app: {
    name: "Context Assistant",
    identifier: "com.contextassistant.app",
    version,
  },

  build: {
    mac: {
      // Required for distributing builds that open on other machines (Gatekeeper).
      // Electrobun reads these flags to decide whether to codesign/notarize.
      // We gate them behind env vars so local dev builds don’t require Apple creds.
      codesign: ["1", "true", "yes"].includes(
        (process.env.ELECTROBUN_CODESIGN ?? "").toLowerCase(),
      ),
      notarize: ["1", "true", "yes"].includes(
        (process.env.ELECTROBUN_NOTARIZE ?? "").toLowerCase(),
      ),
      // Used to generate `AppIcon.icns` via `iconutil` at build time.
      // Generate with: `bun run generate:icons`
      icons: "icon.iconset",
    },
    // NOTE: Electrobun's CLI currently reads `build.linux.appImageIcon` even
    // though it's not in the published config type yet.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    linux: {
      // Used when creating AppImage artifacts
      appImageIcon: "assets/icons/icon-512.png",
    } as any,

    bun: {
      entrypoint: "src/bun/index.ts",
      external: [],
    },

    // NOTE:
    // - Electrobun's CLI will bundle this entrypoint with `bun build` (no plugins),
    //   then we overwrite the view output in `scripts/electrobun-postbuild.ts` using
    //   `bun-plugin-tailwind` so Tailwind v4 directives get compiled correctly.
    views: {
      main: {
        entrypoint: "src/main.tsx",
        external: [],
      },
    },

    // Minimal fallback view shell (postBuild will overwrite this with a fully bundled output).
    copy: {
      "src/electrobun/index.html": "views/main/index.html",
    },
  },

  scripts: {
    postBuild: "scripts/electrobun-postbuild.ts",
  },

  // Configure to enable auto-updates (used by Electrobun's Updater).
  // Example: "https://my-bucket.s3.amazonaws.com/my-app"
  release: {
    // For GitHub Releases-backed updates, set this at build time to:
    //   https://github.com/<owner>/<repo>/releases/latest/download
    bucketUrl: process.env.ELECTROBUN_BUCKET_URL ?? "",
  },
};

export default config;
