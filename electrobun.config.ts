import type { ElectrobunConfig } from "electrobun/bun";
import pkg from "./package.json";
import { DESKTOP_APP_IDENTIFIER, DESKTOP_APP_NAME } from "./src/renderers/electrobun/shared/app-name";

const RELEASE_BASE_URL = "https://github.com/gloom-sh/gloomberb/releases/latest/download";
/** Patches from the previous release ship for macOS only: no release carries a Linux app, and Windows takes the whole archive. */
const GENERATE_RELEASE_PATCH = process.platform === "darwin";
/**
 * A macOS build for a check rather than for users, which has nothing to sign
 * with: neither signed nor notarized. A release signs, and its checks fail on
 * a disk image that is not.
 */
const MAC_UNSIGNED = process.env.GLOOM_DESKTOP_UNSIGNED === "1";
/**
 * Windows on x64 draws the app with the Chromium it ships. Windows on Arm
 * draws it with the system's WebView2 (window/create.ts), so an Arm build
 * ships no Chromium, and neither does a check of WebView2 on x64
 * (GLOOM_WINDOWS_RENDERER=native).
 */
const WINDOWS_NATIVE_RENDERER = process.env.GLOOM_WINDOWS_RENDERER === "native"
  || (process.platform === "win32" && process.arch === "arm64");
/**
 * Since Chromium 139, on Windows 11, Chromium's own top-level windows have
 * no redirection bitmap (RemoveRedirectionBitmap): DirectComposition alone
 * draws them, and Windows shows their backdrop until it does. In this app's
 * Chromium nothing ever reaches the window a `title` tooltip opens in, so a
 * tooltip was an empty light box. With the feature off those windows draw as
 * before and the page keeps DirectComposition. Electrobun passes
 * `--disable-features=VizDisplayCompositor` itself, as one switch, and a
 * second `--disable-features` would replace it: that one is taken out and
 * its feature listed here.
 */
const WINDOWS_CHROMIUM_FLAGS = {
  "disable-features=VizDisplayCompositor": false,
  "disable-features": "VizDisplayCompositor,RemoveRedirectionBitmap",
};

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
    mainProcess: "bun",
    bun: {
      entrypoint: "src/renderers/electrobun/bun/index.ts",
      sourcemap: "external",
    },
    copy: {
      "dist/electrobun-view": "views/mainview",
    },
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
      codesign: !MAC_UNSIGNED,
      createDmg: true,
      notarize: !MAC_UNSIGNED,
      icons: "icon.iconset",
      defaultRenderer: "native",
    },
    win: {
      bundleCEF: !WINDOWS_NATIVE_RENDERER,
      defaultRenderer: WINDOWS_NATIVE_RENDERER ? "native" : "cef",
      chromiumFlags: WINDOWS_CHROMIUM_FLAGS,
      icon: "src/assets/gloomberb-logo-windows.ico",
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
