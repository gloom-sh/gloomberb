import { expect, test } from "bun:test";

test("every exports subpath in package.json resolves", async () => {
  const pkg = JSON.parse(await Bun.file(new URL("../../package.json", import.meta.url)).text());
  const subpaths = Object.entries(pkg.exports as Record<string, string>);
  expect(subpaths.length).toBeGreaterThan(0);
  for (const [subpath, target] of subpaths) {
    if (subpath === "./package.json") continue;
    const file = Bun.file(new URL(`../../${target.replace(/^\.\//, "")}`, import.meta.url));
    expect(await file.exists(), `${subpath} -> ${target}`).toBe(true);
  }
});

test("a bundled external plugin uses the host's React and public hooks", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { useMarketData } = await import("./react");
  const { bundleExternalPlugin } = await import("../plugins/bundle");
  const { installPluginHostModules } = await import("../plugins/host-modules");
  const dir = await mkdtemp(join(tmpdir(), "gloom-public-plugin-"));
  try {
    await Bun.write(join(dir, "package.json"), JSON.stringify({ name: "smoke-plugin", main: "index.tsx" }));
    await Bun.write(join(dir, "index.tsx"), `
      import { createElement, useState } from "react";
      import { useMarketData } from "gloomberb/react";
      export default {
        id: "smoke-plugin", name: "Smoke", version: "1.0.0", useMarketData,
        component() { return createElement("div", null, useState("ready")[0]); },
      };
    `);
    await installPluginHostModules();
    const bundle = await bundleExternalPlugin(dir, join(dir, "out"));
    const plugin = (await import(bundle.outputPath)).default;
    expect(plugin.useMarketData).toBe(useMarketData);
    expect(renderToStaticMarkup(createElement(plugin.component))).toBe("<div>ready</div>");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
