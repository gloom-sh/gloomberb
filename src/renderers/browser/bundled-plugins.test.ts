import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { loadWebBundledPlugins } from "./bundled-plugins";

/**
 * The web app has no way for a visitor to repair a plugin and no marketplace
 * install to retry, so one bad module must not be able to take the terminal
 * down with it: the others still load, the app starts on its built-ins, and the
 * failure is carried as an error the marketplace shows against that plugin.
 */
const dir = mkdtempSync(join(tmpdir(), "gloom-web-plugins-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function pluginModule(name: string, source: string): string {
  const path = join(dir, `${name}.js`);
  writeFileSync(path, source);
  return path;
}

test("loads each plugin module and contains a failure to the plugin that caused it", async () => {
  const loaded = await loadWebBundledPlugins([
    {
      id: "polls",
      name: "Polls",
      version: "1.0.0",
      url: pluginModule("polls", 'export default { id: "polls", name: "Polls", version: "1.2.0" };'),
    },
    { id: "broken", name: "Broken", version: "1.0.0", url: pluginModule("broken", "throw new Error('boom');") },
    { id: "empty", name: "Empty", version: "1.0.0", url: pluginModule("empty", "export const unrelated = 1;") },
  ]);

  expect(loaded.map((entry) => entry.plugin.id)).toEqual(["polls", "broken", "empty"]);
  // The declaration inside the module wins over the descriptor built alongside it.
  expect(loaded[0]).toMatchObject({ plugin: { version: "1.2.0" } });
  expect(loaded[0]?.error).toBeUndefined();
  expect(loaded[1]?.error).toContain("boom");
  expect(loaded[2]?.error).toContain("did not export a valid GloomPlugin");
});
