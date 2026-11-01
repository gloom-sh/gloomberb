import type { ElectrobunConfig } from "electrobun/bun";
import pkg from "./package.json";
import { DESKTOP_APP_IDENTIFIER, DESKTOP_APP_NAME } from "./src/renderers/electrobun/shared/app-name";

const RELEASE_BASE_URL = "https://github.com/gloom-sh/gloomberb/releases/latest/download";
const GENERATE_RELEASE_PATCH = process.platform !== "win32";
const RELEASE_BUILD = process.argv.some((arg) => arg === "--env=stable" || arg === "--env=canary");
/**
 * Electrobun gives every Windows build Chromium's DevTools port. A release
 * has none: `-1` is no port, so Chromium starts no debugging server. Dev
 * builds keep it.
 */
const WINDOWS_RELEASE_CHROMIUM_FLAGS = {
  "remote-debugging-port": "-1",
  "remote-allow-origins": false,
};

/**
 * The Bun that Windows builds ship, in place of the 1.3 Electrobun brings.
 * Bun 1.3 runs every bun:ffi call and callback through code it writes into
 * heap memory and marks executable. Windows' heap later commits that memory
 * again as read-write, and the app crashes the next time native code calls one
 * of Electrobun's callbacks (often the window's first event, seconds after it
 * opens). Bun 1.4 keeps that code in its own executable memory. Windows builds
 * run on Windows.
 */
const WINDOWS_BUN_VERSION = "1.4.4";

const config: ElectrobunConfig = {
  app: {
    // The bundle, the macOS menu bar and Dock, the update archives. Releases
    // also carry the archives under the old name for installs from before
    // the rename (scripts/write-legacy-desktop-files.ts).
    name: DESKTOP_APP_NAME,
    identifier: DESKTOP_APP_IDENTIFIER,
    version: pkg.version,
    description: pkg.description,
    urlSchemes: ["gloomberb"],
  },
  build: {
    bun: {
      entrypoint: "src/renderers/electrobun/bun/index.ts",
      sourcemap: "external",
    },
    copy: {
      "dist/electrobun-view": "views/mainview",
    },
    ...(process.platform === "win32" ? { bunVersion: WINDOWS_BUN_VERSION } : {}),
    watch: [
      "src",
      "scripts/build-electrobun-view.ts",
      "electrobun.config.ts",
      "package.json",
    ],
    watchIgnore: [
      ".git",
      ".git/**",
      "dist/**",
      "build/**",
      "artifacts/**",
      "node_modules/**",
    ],
    mac: {
      codesign: true,
      createDmg: true,
      notarize: true,
      icons: "icon.iconset",
      defaultRenderer: "native",
    },
    win: {
      bundleCEF: true,
      defaultRenderer: "cef",
      icon: "src/assets/gloomberb-logo-windows.ico",
      ...(RELEASE_BUILD ? { chromiumFlags: WINDOWS_RELEASE_CHROMIUM_FLAGS } : {}),
    },
  },
  scripts: {
    preBuild: "scripts/build-electrobun-view.ts",
    postBuild: "scripts/install-electrobun-tui-shim.ts",
    postWrap: "",
    postPackage: "",
  },
  runtime: {
    exitOnLastWindowClosed: true,
  },
  release: {
    baseUrl: RELEASE_BASE_URL,
    generatePatch: GENERATE_RELEASE_PATCH,
  },
};

export default config;
