import type { ElectrobunConfig } from "electrobun/bun";
import pkg from "./package.json";

const RELEASE_BASE_URL = "https://github.com/gloom-sh/gloomberb/releases/latest/download";
const GENERATE_RELEASE_PATCH = process.platform !== "win32";

const config: ElectrobunConfig = {
  app: {
    name: "Gloomberb",
    identifier: "com.vincelwt.gloomberb",
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
