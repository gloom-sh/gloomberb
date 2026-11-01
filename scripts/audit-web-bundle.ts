import { readdir, readFile, stat } from "fs/promises";
import { dirname, join, relative } from "path";
import { WEB_BUNDLED_PLUGIN_PACKAGES } from "../src/plugins/web-bundled";
import { WORLD_MAP_DATA_SPECIFIER } from "../src/renderers/dom/build-assets";
import { isProxiedHost } from "../src/utils/plugin-proxy-hosts";
import { IMMUTABLE_ASSET_PATH } from "../src/renderers/cloudflare/worker";

const root = join(process.cwd(), "dist", "web");

async function files(dir: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    result.push(...(entry.isDirectory() ? await files(path) : [path]));
  }
  return result;
}

const outputFiles = await files(root);
// Pane pictures rasterize terminal cells only in OpenTUI. A bundled atlas would
// add its entire compressed font coverage to every web download.
const terminalGlyphs = JSON.parse(await readFile(join(process.cwd(), "src/renderers/opentui/pane-image/glyphs.json"), "utf8")) as { coverage: string };
const terminalGlyphSignature = terminalGlyphs.coverage.slice(0, 128);
/** Desktop, fork, and native-host code that must never reach a browser bundle. */
const NATIVE_OR_FORK = /kohor\.st|__GLOOM_CLOUD_HOSTED|\/_gloomberb\/rpc|receiveMessageFromBun|__electrobun/;
/**
 * Browser shims for Node's zlib and crypto, about 660 KB between them. They get
 * bundled when Node-only code (self-update) reaches those modules through
 * import() or require(), even with the specifier held in a variable; it has to
 * use process.getBuiltinModule, which the bundler does not follow.
 */
const NODE_POLYFILL = /Z_BUF_ERROR|createDiffieHellman|pbkdf2Sync/;
/**
 * Providers the web build has no path to.
 *
 * A host that sends no CORS headers can still ship here: that is how every
 * bundled plugin reaches its data, by declaring the host and letting the worker
 * proxy it. So the list below is filtered by the committed allowlist rather
 * than checked as written: a host a bundled plugin declares is reachable by
 * definition, and leaving it here would fail the build the day that plugin
 * ships. What remains belongs to panes deliberately left out of the browser
 * catalog, where finding one means a pane got in that cannot fetch anything
 * once it renders.
 */
const UNSUPPORTED_PROVIDER_HOSTS = [
  "api.elections.kalshi.com",
  "forms13f.com",
].filter((host) => !isProxiedHost(host));
const UNSUPPORTED_PROVIDER = UNSUPPORTED_PROVIDER_HOSTS.length > 0
  ? new RegExp(UNSUPPORTED_PROVIDER_HOSTS.map((host) => host.replaceAll(".", "\\.")).join("|"))
  : null;

const failures: string[] = [];
for (const path of outputFiles) {
  const name = relative(root, path);
  if (name.endsWith(".map")) failures.push(`${name}: public source map`);
  if (!/\.(?:html|js|css|json)$/.test(name)) continue;
  const content = await readFile(path, "utf8");
  if (content.includes(terminalGlyphSignature)) failures.push(`${name}: terminal glyph atlas in the web bundle`);
  if (/sourceMappingURL=/.test(content)) failures.push(`${name}: source map reference`);
  if (NATIVE_OR_FORK.test(content)) failures.push(`${name}: forbidden native or fork code`);
  if (NODE_POLYFILL.test(content)) failures.push(`${name}: bundled Node zlib or crypto polyfill`);
  if (UNSUPPORTED_PROVIDER?.test(content)) failures.push(`${name}: unsupported provider code`);
  if (name.startsWith("assets/share/") && /\/telemetry\/(?:attention|errors|usage)/.test(content)) {
    failures.push(`${name}: authenticated telemetry client in a public share bundle`);
  }
  if (name.endsWith(".html")) {
    if (/<script(?![^>]*\bsrc=)[^>]*>/i.test(content)) failures.push(`${name}: inline script`);
    if (/<style\b/i.test(content)) failures.push(`${name}: inline style block`);
    if (/bearer\s|session[_-]?token/i.test(content)) failures.push(`${name}: embedded credential material`);
  }
}
/**
 * Every web-capable plugin is compiled into the build and loaded at startup, so
 * a visitor gets it without installing anything. The failure to catch is silent:
 * a build that emits no plugin modules, or an app bundle that was built without
 * the list, still starts and still passes every check above. It just quietly
 * drops the panes.
 */
// The Worker keeps a file for a year when its name says it is named after its
// contents: each such name has to be its file's hash, or a change under the
// same name would never reach a browser that has it.
for (const path of outputFiles) {
  const name = `/${relative(root, path).replaceAll("\\", "/")}`;
  if (!IMMUTABLE_ASSET_PATH.test(name)) continue;
  const hash = new Bun.CryptoHasher("sha256").update(await readFile(path)).digest("hex").slice(0, 16);
  if (!name.endsWith(`-${hash}${name.slice(name.lastIndexOf("."))}`)) failures.push(`${name.slice(1)}: kept as immutable, but its contents hash to ${hash}`);
}
// What a page loads before it paints is all kept that way.
for (const page of ["index.html", "share.html"]) {
  const html = await readFile(join(root, page), "utf8");
  for (const [, href] of html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)) {
    if (!IMMUTABLE_ASSET_PATH.test(href!)) failures.push(`${page}: ${href} is not named after its contents`);
  }
}

// Entry files are named after their contents (`main-<hash>.js`).
const named = (dir: string, stem: string, ext: string) => outputFiles
  .map((path) => relative(root, path).replaceAll("\\", "/"))
  .filter((name) => name.startsWith(`${dir}/${stem}-`) && name.endsWith(ext) && !name.slice(dir.length + 1).includes("/"));
const appBundleName = named("assets/app", "main", ".js")[0];
if (!appBundleName) throw new Error("Web bundle audit failed:\nassets/app/main-<hash>.js: missing app bundle");
const appBundle = await readFile(join(root, ...appBundleName.split("/")), "utf8");
for (const packageName of WEB_BUNDLED_PLUGIN_PACKAGES) {
  const module = named(`assets/plugins/${packageName}`, "index", ".js")[0];
  if (!module) {
    failures.push(`assets/plugins/${packageName}/index-<hash>.js: missing bundled plugin module`);
  } else if (!appBundle.includes(`/${module}`)) {
    failures.push(`${module}: built but not referenced by the app bundle`);
  }
}

/**
 * Lazy chunks (see src/renderers/dom/build-assets.ts) are fetched by path the
 * first time a pane asks, so a chunk missing from the build only shows up as
 * a pane drawn without its data. The world map's land is one: without its
 * index the map falls back to the coarse outline.
 */
for (const path of outputFiles.filter((file) => file.endsWith(".js"))) {
  const content = await readFile(path, "utf8");
  for (const [, specifier] of content.matchAll(/import\("(\.\/[^"]+\.chunk\.js)"\)/g)) {
    if (!outputFiles.includes(join(dirname(path), specifier!))) {
      failures.push(`${relative(root, path)}: lazy chunk ${specifier} is missing`);
    }
  }
}
if (!appBundle.includes(`import(${JSON.stringify(WORLD_MAP_DATA_SPECIFIER)})`)) {
  failures.push(`${appBundleName}: the world map's land data is not wired in`);
}

const shareScripts = outputFiles.filter((path) => /assets\/share\/.*\.js$/.test(path));
const shareBytes = (await Promise.all(shareScripts.map((path) => stat(path)))).reduce((sum, entry) => sum + entry.size, 0);
// The share page ships the shared API client, live quote socket included, so
// the budget leaves room for its protocol; it exists to catch a dependency or
// renderer pulled in by accident, not a few hundred bytes of protocol methods.
// Every cloud dataset adds its request methods to the shared client (GPU prices
// added 565 bytes, 305,392 total). The budget leaves room for the datasets that
// ship together, so one more function does not need its own limit change.
const SHARE_BUNDLE_LIMIT = 336_000;
if (shareBytes > SHARE_BUNDLE_LIMIT) failures.push(`share bundle is ${shareBytes} bytes (limit ${SHARE_BUNDLE_LIMIT})`);
if (failures.length) throw new Error(`Web bundle audit failed:\n${failures.join("\n")}`);
console.log(`Web bundle audit passed (${outputFiles.length} files, share JS ${shareBytes} bytes).`);
