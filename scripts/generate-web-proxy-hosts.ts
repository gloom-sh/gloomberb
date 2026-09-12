import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { getBrowserBuiltinPlugins } from "../src/plugins/catalog-browser";
import type { GloomPlugin } from "../src/types/plugin";
import { compileWebBundledPlugins } from "./web-plugins";

/**
 * Writes `src/utils/plugin-proxy-hosts.json`: the hosts the web worker will
 * proxy for plugins, derived from what the plugins in the web build declare:
 * the browser catalog's built-ins, and the plugins compiled in from their own
 * repositories (`plugins/web-bundled.ts`).
 *
 * The worker cannot import the catalog (it would pull the whole app into the
 * worker bundle), so the list is generated and committed. Run with --check in
 * CI to fail when the committed file no longer matches, which is how a plugin
 * that adds a host without regenerating gets caught before it ships broken on
 * the web.
 */

const OUT = new URL("../src/utils/plugin-proxy-hosts.json", import.meta.url);

function normalizeHost(host: string, pluginId: string): string {
  const trimmed = host.trim().toLowerCase();
  // A bare domain, nothing else. A scheme, path, or port here would either be
  // silently ignored by the suffix match or widen it in a surprising way.
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(trimmed)) {
    throw new Error(`Plugin "${pluginId}" declares an invalid host: "${host}". Use a bare domain such as "api.example.com".`);
  }
  return trimmed;
}

/**
 * Compiled to a scratch directory, then thrown away: this only needs each
 * plugin's declaration, and the real artifacts belong to `web:build`.
 */
async function webBundledPlugins(): Promise<GloomPlugin[]> {
  const scratch = await mkdtemp(join(tmpdir(), "gloom-web-plugins-"));
  try {
    return (await compileWebBundledPlugins(scratch)).map((entry) => entry.plugin);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

const byHost = new Map<string, string[]>();
for (const plugin of [...getBrowserBuiltinPlugins(), ...await webBundledPlugins()]) {
  for (const host of plugin.hosts ?? []) {
    const normalized = normalizeHost(host, plugin.id);
    byHost.set(normalized, [...(byHost.get(normalized) ?? []), plugin.id]);
  }
}

const hosts = [...byHost.keys()].sort();
const next = `${JSON.stringify({ hosts }, null, 2)}\n`;

if (process.argv.includes("--check")) {
  const current = await Bun.file(OUT).text().catch(() => "");
  if (current !== next) {
    console.error(
      "src/utils/plugin-proxy-hosts.json is out of date with the plugins in the web build.\n" +
        "Run: bun run web:proxy-hosts",
    );
    process.exit(1);
  }
  console.log(`plugin-proxy-hosts.json is current (${hosts.length} hosts).`);
} else {
  await Bun.write(OUT, next);
  console.log(`Wrote plugin-proxy-hosts.json (${hosts.length} hosts).`);
  for (const host of hosts) console.log(`  ${host}  <- ${byHost.get(host)!.join(", ")}`);
}
