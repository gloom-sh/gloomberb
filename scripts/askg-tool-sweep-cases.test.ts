import { expect, spyOn, test } from "bun:test";
import { createPaneCatalog } from "../src/cli/pane-functions/discovery";
import type { MarketContext } from "../src/cli/types";
import { getLoadablePlugins } from "../src/plugins/catalog";
import { buildASKGClientManifest } from "../src/plugins/builtin/cloud/askg/manifest";
import { createDefaultConfig } from "../src/types/config";
import { SWEEP_CASES } from "./askg-tool-sweep-cases";

// The latency sweep (scripts/askg-tool-sweep.ts) only covers the tools it has
// cases for: a function Ask Gloom gains is swept from the day it ships.
test("every tool Ask Gloom calls in the app has a heavy case in the latency sweep, and every case names one", async () => {
  const fetch = spyOn(globalThis, "fetch").mockRejectedValue(new Error("The manifest is built offline"));
  try {
    const context = { config: createDefaultConfig("/synthetic/askg-sweep-test") } as MarketContext;
    const manifest = await buildASKGClientManifest(await createPaneCatalog(context, getLoadablePlugins()));
    const advertised = manifest.tools.filter((tool) => tool.source === "headless").map((tool) => tool.name);
    const swept = new Set(SWEEP_CASES.map((entry) => entry.tool));
    expect(advertised.length).toBeGreaterThan(100);
    expect(advertised.filter((name) => !swept.has(name))).toEqual([]);
    expect([...swept].filter((name) => !advertised.includes(name))).toEqual([]);
  } finally {
    fetch.mockRestore();
  }
});
