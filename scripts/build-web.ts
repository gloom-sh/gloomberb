import { mkdir, readFile, rm, writeFile } from "fs/promises";
import { join, relative, resolve } from "path";
import { buildViewBundle, pageBootFrameScript, pageBuildId, type PageBootFrame } from "../src/renderers/dom/build-assets";
import { BROWSER_STORAGE_KEYS } from "../src/data/json-storage";
import type { WebBundledPluginDescriptor } from "../src/plugins/web-bundled";
import { isProxiedHost, PROXY_ALLOWED_HOSTS } from "../src/utils/plugin-proxy-hosts";
import { takeOption } from "./tui-benchmark-harness";
import { compileExtraWebPlugins, compileWebBundledPlugins } from "./web-plugins";

/**
 *   bun run web:build
 *   bun scripts/build-web.ts [--out <dir>] [--keep-names] [--plugin <dir>]...
 *
 * The flags are for the UI audit (`scripts/pane-chrome/ui-audit.ts`), which
 * builds its own copy: `--keep-names` keeps component names through
 * minification, and each `--plugin` compiles one more plugin checkout (the
 * registry's) into the page. The deployed build takes none of them.
 */
const args = process.argv.slice(2);
const root = process.cwd();
const outdir = resolve(takeOption(args, "--out") ?? join(root, "dist", "web"));
const keepNames = args.includes("--keep-names");
const extraPluginDirs = args.flatMap((arg, index) => (arg === "--plugin" && args[index + 1] ? [resolve(args[index + 1]!)] : []));
await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
// Tabs get the plain mark, like gloom.sh; the app icon tile is too small to read at 16px.
await writeFile(join(outdir, "favicon.svg"), await readFile(join(root, "src/assets/gloomberb-mark.svg")));
await writeFile(join(outdir, "favicon.ico"), await readFile(join(root, "src/assets/gloomberb-mark.ico")));
// A web app manifest makes the browser offer "Install Gloomberb": the terminal
// then gets its own window and a Dock or taskbar icon. People who start in the
// browser come back far less often than people with the app installed.
await writeFile(join(outdir, "app-icon-256.png"), await readFile(join(root, "icon.iconset/icon_256x256.png")));
await writeFile(join(outdir, "app-icon-512.png"), await readFile(join(root, "icon.iconset/icon_512x512.png")));
await writeFile(join(outdir, "manifest.webmanifest"), `${JSON.stringify({
  name: "Gloomberb",
  short_name: "Gloomberb",
  description: "An open-source financial terminal.",
  start_url: "/",
  scope: "/",
  display: "standalone",
  // The colour before the page draws; the window colours follow the chosen theme.
  background_color: "#272a34",
  icons: [
    { src: "/app-icon-256.png", sizes: "256x256", type: "image/png" },
    { src: "/app-icon-512.png", sizes: "512x512", type: "image/png" },
  ],
}, null, 2)}\n`);

interface PageText {
  title: string;
  /** Shown until the script draws, on a page with no launch frame. */
  loadingText?: string;
  /** Draw the launch frame (src/renderers/dom/boot-frame.ts) instead of loading text. */
  bootFrame?: PageBootFrame;
}

async function buildPage(
  name: string,
  entrypoint: string,
  { title, loadingText, bootFrame }: PageText,
  htmlName: string,
  extraDefines: Record<string, string> = {},
) {
  const { script, stylesheet } = await buildViewBundle({
    entrypoint,
    outdir: join(outdir, "assets", name),
    sourcemap: "none",
    keepNames,
    define: { __GLOOMBERB_API_URL__: "location.origin", ...extraDefines },
    failureMessage: `Failed to build the ${name} web page`,
    missingEntryMessage: `${name} build did not emit JavaScript`,
  });
  if (!stylesheet) throw new Error(`${name} build did not emit CSS`);
  const href = (path: string) => `/${relative(outdir, path).replaceAll("\\", "/")}`;
  const loading = loadingText ? `<div class="gloom-loading">${loadingText}</div>` : "";
  // A file of its own, not inline: the Worker's content security policy runs
  // no inline script. Classic and synchronous, so the frame is drawn before
  // the first paint; named for the build, so no cache serves another build's.
  let frameScript = "";
  if (bootFrame) {
    const build = await pageBuildId(script, stylesheet);
    const bootScript = join(outdir, "assets", name, `boot-frame-${build}.js`);
    await writeFile(bootScript, `${pageBootFrameScript({ ...bootFrame, build })}\n`);
    frameScript = `\n  <script src="${href(bootScript)}"></script>`;
  }
  await writeFile(join(outdir, htmlName), `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title}</title>
  <link rel="icon" href="/favicon.ico" sizes="any">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="manifest" href="/manifest.webmanifest">
  <link rel="apple-touch-icon" href="/app-icon-256.png">
  <link rel="stylesheet" href="${href(stylesheet)}">
</head>
<body>
  <div id="root">${loading}</div>${frameScript}
  <script type="module" src="${href(script)}"></script>
</body>
</html>\n`);
}

/**
 * Compiles the plugins that ship inside the web app, and hands the app the list
 * to load at startup.
 *
 * A plugin reaches hosts that send no CORS headers, which only work through the
 * worker's proxy, and the proxy refuses anything outside the committed
 * allowlist. So the build checks the two agree: a plugin update that adds a host
 * fails here with the command to run rather than shipping a pane that loads and
 * then cannot fetch.
 */
async function buildBundledPlugins(): Promise<WebBundledPluginDescriptor[]> {
  const pluginsDir = join(outdir, "assets", "plugins");
  const compiled = await compileWebBundledPlugins(pluginsDir, { minify: !keepNames });

  const missing = compiled.flatMap(({ plugin }) => (plugin.hosts ?? [])
    .filter((host) => !isProxiedHost(host.trim().toLowerCase(), PROXY_ALLOWED_HOSTS))
    .map((host) => `${plugin.id} -> ${host}`));
  if (missing.length) {
    throw new Error(
      `These plugin hosts are missing from the web proxy allowlist:\n  ${missing.join("\n  ")}\n`
        + 'Run: bun run web:proxy-hosts',
    );
  }

  // Plugins added for an audit are not served by the worker, so their hosts are not checked.
  const extra = extraPluginDirs.length ? await compileExtraWebPlugins(pluginsDir, extraPluginDirs, { minify: !keepNames }) : [];
  return [...compiled, ...extra].map(({ plugin, file }) => ({
    id: plugin.id,
    name: plugin.name,
    version: plugin.version,
    url: `/${relative(outdir, join(pluginsDir, file)).replaceAll("\\", "/")}`,
  }));
}

const bundledPlugins = await buildBundledPlugins();
console.log(`Bundled ${bundledPlugins.length} plugins: ${bundledPlugins.map((entry) => entry.id).join(", ")}`);

await buildPage(
  "app",
  join(root, "src/renderers/browser/main.tsx"),
  {
    title: "Gloomberb",
    // The app keeps its last frame in localStorage, which the page draws
    // while the script loads; a first visit gets the bare shell.
    bootFrame: { source: `JSON.parse(localStorage.getItem(${JSON.stringify(BROWSER_STORAGE_KEYS.bootFrame)}) || "null")` },
  },
  "index.html",
  { __GLOOM_WEB_PLUGINS__: JSON.stringify(bundledPlugins) },
);
await buildPage("share", join(root, "src/renderers/share/main.tsx"), { title: "Gloomberb Share", loadingText: "Loading shared view..." }, "share.html");
