import { readdir, readFile, stat } from "fs/promises";
import { join, relative } from "path";

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
const failures: string[] = [];
for (const path of outputFiles) {
  const name = relative(root, path);
  if (name.endsWith(".map")) failures.push(`${name}: public source map`);
  if (!/\.(?:html|js|css)$/.test(name)) continue;
  const content = await readFile(path, "utf8");
  if (/sourceMappingURL=/.test(content)) failures.push(`${name}: source map reference`);
  if (/kohor\.st|__GLOOM_CLOUD_HOSTED|\/_gloomberb\/rpc|receiveMessageFromBun|__electrobun|api\.thebuildout\.ai|api\.votehub\.com|api\.elections\.kalshi\.com|nasdaqtrader\.com|stockanalysis\.com\/ipos|forms13f\.com/.test(content)) {
    failures.push(`${name}: forbidden native, fork, or unsupported provider code`);
  }
  if (name.endsWith(".html")) {
    if (/<script(?![^>]*\bsrc=)[^>]*>/i.test(content)) failures.push(`${name}: inline script`);
    if (/<style\b/i.test(content)) failures.push(`${name}: inline style block`);
    if (/bearer\s|session[_-]?token/i.test(content)) failures.push(`${name}: embedded credential material`);
  }
}
const shareScripts = outputFiles.filter((path) => /assets\/share\/.*\.js$/.test(path));
const shareBytes = (await Promise.all(shareScripts.map((path) => stat(path)))).reduce((sum, entry) => sum + entry.size, 0);
if (shareBytes > 300_000) failures.push(`share bundle is ${shareBytes} bytes (limit 300000)`);
if (failures.length) throw new Error(`Web bundle audit failed:\n${failures.join("\n")}`);
console.log(`Web bundle audit passed (${outputFiles.length} files, share JS ${shareBytes} bytes).`);
