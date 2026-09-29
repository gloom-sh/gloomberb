import { mkdir, readFile, rm, writeFile } from "fs/promises";
import { join, relative } from "path";
import { buildViewBundle } from "../src/renderers/electrobun/view/build-assets";
import type { WebBundledPluginDescriptor } from "../src/plugins/web-bundled";
import { isProxiedHost, PROXY_ALLOWED_HOSTS } from "../src/utils/plugin-proxy-hosts";
import { compileWebBundledPlugins } from "./web-plugins";

const root = process.cwd();
const outdir = join(root, "dist", "web");
await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
// Tabs get the plain mark, like gloom.sh; the app icon tile is too small to read at 16px.
await writeFile(join(outdir, "favicon.svg"), await readFile(join(root, "src/assets/gloomberb-mark.svg")));
await writeFile(join(outdir, "favicon.ico"), await readFile(join(root, "src/assets/gloomberb-mark.ico")));

async function buildPage(
  name: string,
  entrypoint: string,
  title: string,
  loadingText: string,
  htmlName: string,
  extraDefines: Record<string, string> = {},
) {
  const { script, stylesheet } = await buildViewBundle({
    entrypoint,
    outdir: join(outdir, "assets", name),
    sourcemap: "none",
    define: { __GLOOMBERB_API_URL__: "location.origin", ...extraDefines },
    failureMessage: `Failed to build the ${name} web page`,
    missingEntryMessage: `${name} build did not emit JavaScript`,
  });
  if (!stylesheet) throw new Error(`${name} build did not emit CSS`);
  const href = (path: string) => `/${relative(outdir, path).replaceAll("\\", "/")}`;
  await writeFile(join(outdir, htmlName), `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title}</title>
  <link rel="icon" href="/favicon.ico" sizes="any">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="${href(stylesheet)}">
</head>
<body>
  <div id="root"><div class="gloom-loading">${loadingText}</div></div>
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
  const compiled = await compileWebBundledPlugins(pluginsDir);

  const missing = compiled.flatMap(({ plugin }) => (plugin.hosts ?? [])
    .filter((host) => !isProxiedHost(host.trim().toLowerCase(), PROXY_ALLOWED_HOSTS))
    .map((host) => `${plugin.id} -> ${host}`));
  if (missing.length) {
    throw new Error(
      `These plugin hosts are missing from the web proxy allowlist:\n  ${missing.join("\n  ")}\n`
        + 'Run: bun run web:proxy-hosts',
    );
  }

  return compiled.map(({ plugin, file }) => ({
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
  "Gloomberb",
  "Loading Gloomberb...",
  "index.html",
  { __GLOOM_WEB_PLUGINS__: JSON.stringify(bundledPlugins) },
);
await buildPage("share", join(root, "src/renderers/share/main.tsx"), "Gloomberb Share", "Loading shared view...", "share.html");
