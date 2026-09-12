import { readdir, readFile, stat } from "fs/promises";
import { join, relative } from "path";
import { WEB_BUNDLED_PLUGIN_PACKAGES } from "../src/plugins/web-bundled";

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
/** Desktop, fork, and native-host code that must never reach a browser bundle. */
const NATIVE_OR_FORK = /kohor\.st|__GLOOM_CLOUD_HOSTED|\/_gloomberb\/rpc|receiveMessageFromBun|__electrobun/;
/**
 * Providers the web build has no path to.
 *
 * A host that sends no CORS headers can still ship here: that is how every
 * bundled plugin reaches its data, by declaring the host and letting the worker
 * proxy it (`src/utils/plugin-proxy-hosts.json`). The hosts below belong to
 * panes deliberately left out of the browser catalog, so finding one means a
 * pane got in that cannot fetch anything once it renders.
 */
const UNSUPPORTED_PROVIDER = /api\.thebuildout\.ai|api\.elections\.kalshi\.com|forms13f\.com/;

const failures: string[] = [];
for (const path of outputFiles) {
  const name = relative(root, path);
  if (name.endsWith(".map")) failures.push(`${name}: public source map`);
  if (!/\.(?:html|js|css)$/.test(name)) continue;
  const content = await readFile(path, "utf8");
  if (/sourceMappingURL=/.test(content)) failures.push(`${name}: source map reference`);
  if (NATIVE_OR_FORK.test(content)) failures.push(`${name}: forbidden native or fork code`);
  if (UNSUPPORTED_PROVIDER.test(content)) failures.push(`${name}: unsupported provider code`);
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
const appBundle = await readFile(join(root, "assets", "app", "main.js"), "utf8");
for (const packageName of WEB_BUNDLED_PLUGIN_PACKAGES) {
  const module = `assets/plugins/${packageName}/index.js`;
  if (!outputFiles.includes(join(root, ...module.split("/")))) {
    failures.push(`${module}: missing bundled plugin module`);
  } else if (!appBundle.includes(`/${module}`)) {
    failures.push(`${module}: built but not referenced by the app bundle`);
  }
}

const shareScripts = outputFiles.filter((path) => /assets\/share\/.*\.js$/.test(path));
const shareBytes = (await Promise.all(shareScripts.map((path) => stat(path)))).reduce((sum, entry) => sum + entry.size, 0);
if (shareBytes > 300_000) failures.push(`share bundle is ${shareBytes} bytes (limit 300000)`);
if (failures.length) throw new Error(`Web bundle audit failed:\n${failures.join("\n")}`);
console.log(`Web bundle audit passed (${outputFiles.length} files, share JS ${shareBytes} bytes).`);
