import { expect, test } from "bun:test";

/**
 * Every runtime name a plugin can import, which also proves each subpath in
 * package.json resolves. Removing or renaming a name breaks every installed
 * plugin that imports it the moment it loads, while a type never does, so a
 * change here has to be deliberate: deprecate first, then list the removal
 * in REMOVED_HOST_EXPORTS (src/plugins/compat.ts), as PLUGINS.md describes.
 * Update with `bun test --update-snapshots src/public/public-api.test.ts`.
 */
test("the runtime exports of every public subpath are the reviewed ones", async () => {
  const pkg = JSON.parse(await Bun.file(new URL("../../package.json", import.meta.url)).text());
  const exported: Record<string, string[]> = {};
  for (const [subpath, target] of Object.entries(pkg.exports as Record<string, string>)) {
    if (subpath === "./package.json") continue;
    const mod = await import(new URL(`../../${target.replace(/^\.\//, "")}`, import.meta.url).href);
    exported[subpath] = Object.keys(mod).sort();
  }
  expect(exported).toMatchSnapshot();
});

test("a bundled external plugin uses the host's React and public hooks", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { useAssetData } = await import("./react");
  const { bundleExternalPlugin } = await import("../plugins/bundle");
  const { installPluginHostModules } = await import("../plugins/host-modules");
  const dir = await mkdtemp(join(tmpdir(), "gloom-public-plugin-"));
  try {
    await Bun.write(join(dir, "package.json"), JSON.stringify({ name: "smoke-plugin", main: "index.tsx" }));
    await Bun.write(join(dir, "index.tsx"), `
      import { createElement, useState } from "react";
      import { useAssetData } from "gloomberb/react";
      export default {
        id: "smoke-plugin", name: "Smoke", version: "1.0.0", useAssetData,
        component() { return createElement("div", null, useState("ready")[0]); },
      };
    `);
    await installPluginHostModules();
    const bundle = await bundleExternalPlugin(dir, join(dir, "out"));
    const plugin = (await import(bundle.outputPath)).default;
    expect(plugin.useAssetData).toBe(useAssetData);
    expect(renderToStaticMarkup(createElement(plugin.component))).toBe("<div>ready</div>");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
