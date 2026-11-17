import { expect, test } from "bun:test";
import { readFileSync } from "fs";
import { getLoadablePlugins } from "../../plugins/catalog";
import { createDefaultConfig } from "../../types/config";
import { findCatalogSeries, findSeriesFacts } from "../series-search";
import type { MarketContext } from "../types";
import { shellWord } from "../../utils/shell-word";
import { buildPaneCatalogEntries, exampleListName } from "./catalog";
import { readCatalogSnapshot, snapshotEntries } from "./catalog-snapshot";
import { buildCatalogSnapshot, CATALOG_SNAPSHOT_PATH, renderCatalogSnapshot } from "./catalog-snapshot-build";
import { createPaneCatalog } from "./discovery";
import { loadBuiltinPlugin } from "../../plugins/catalog-lazy";
import { getPaneFunctionCapability } from "./capabilities";
import { paneFunctionCode } from "./catalog";
import { findPaneFunction, parsePaneFunctionArgsFor } from "./resolver";

const plugins = getLoadablePlugins([]);

/** A profile whose lists, currency and portfolios differ from a fresh one's, so anything a template reads from them shows. */
function richContext(): MarketContext {
  const config = createDefaultConfig("/catalog-snapshot-test");
  config.baseCurrency = "EUR";
  config.watchlists = [{ id: "spare", name: "Spare" }, { id: "tech", name: "Tech Picks" }];
  config.portfolios = [{ id: "main", name: "Main Portfolio", currency: "EUR" }, { id: "roth", name: "Roth", currency: "USD" }];
  const held = [{ metadata: { watchlists: ["tech"], portfolios: ["roth"], positions: [{ portfolio: "roth", shares: 3 }] } }];
  return { config, store: { loadAllTickers: async () => held } } as unknown as MarketContext;
}

test("the catalog snapshot is what the built-in plugins declare; run `bun run catalog:snapshot` when it is not", async () => {
  const text = renderCatalogSnapshot(await buildCatalogSnapshot(plugins));
  expect(readFileSync(CATALOG_SNAPSHOT_PATH, "utf8") === text).toBe(true);
});

test("the snapshot lists every function as the plugins' own catalog does, for a profile with lists of its own", async () => {
  const context = richContext();
  const registry = await createPaneCatalog(context, plugins);
  try {
    const live = await buildPaneCatalogEntries(registry, context);
    const fromSnapshot = snapshotEntries(readCatalogSnapshot(), await exampleListName(context));
    // The output is JSON or text of these: same fields, in the same order, with nothing left undefined.
    expect(fromSnapshot.map((entry) => JSON.stringify(entry))).toEqual(live.map((entry) => JSON.stringify(entry)));
    expect(live.some((entry) => entry.argExamples?.includes(shellWord("Tech Picks")))).toBe(true);
  } finally {
    registry.destroy();
  }
});

test("a profile with no list holding a symbol gets the examples a function gives of itself", async () => {
  const context = { config: createDefaultConfig("/catalog-snapshot-test"), store: { loadAllTickers: async () => [] } } as unknown as MarketContext;
  const registry = await createPaneCatalog(context, plugins);
  try {
    const live = await buildPaneCatalogEntries(registry, context);
    expect(snapshotEntries(readCatalogSnapshot(), await exampleListName(context)).map((entry) => JSON.stringify(entry)))
      .toEqual(live.map((entry) => JSON.stringify(entry)));
  } finally {
    registry.destroy();
  }
});

test("the snapshot's series answer a search as the plugins' series do", () => {
  for (const query of ["operating margin", "fed funds", "defi", "DFEDTARU", "crack spread", "xyzzy"]) {
    expect(findSeriesFacts(readCatalogSnapshot().series, query), query).toEqual(findCatalogSeries(plugins, query));
  }
});

test("a function the snapshot gives to one plugin resolves there as it does among all of them", async () => {
  const context = { config: createDefaultConfig("/catalog-snapshot-test"), store: { loadAllTickers: async () => [] } } as unknown as MarketContext;
  const all = await createPaneCatalog(context, plugins);
  const own = new Map<string, Awaited<ReturnType<typeof createPaneCatalog>>>();
  try {
    const { functions } = readCatalogSnapshot();
    expect(Object.keys(functions).length).toBeGreaterThan(100);
    for (const [word, holders] of Object.entries(functions)) {
      const key = holders.join("+");
      if (!own.has(key)) own.set(key, await createPaneCatalog(context, holders.map((id) => loadBuiltinPlugin(id)!)));
      const alone = own.get(key)!;
      const found = findPaneFunction(all, word);
      const foundAlone = findPaneFunction(alone, word);
      expect(foundAlone?.template?.id, word).toBe(found?.template?.id);
      expect(foundAlone?.pane?.id, word).toBe(found?.pane?.id);
      expect(paneFunctionCode(foundAlone!.template, foundAlone!.pane!, alone), word).toBe(paneFunctionCode(found!.template, found!.pane!, all));
      expect(JSON.stringify(getPaneFunctionCapability(foundAlone!.template, foundAlone!.pane!)), word)
        .toBe(JSON.stringify(getPaneFunctionCapability(found!.template, found!.pane!)));
      expect(JSON.stringify(parsePaneFunctionArgsFor(alone, [word, "AAPL", "--limit", "5"])), word)
        .toBe(JSON.stringify(parsePaneFunctionArgsFor(all, [word, "AAPL", "--limit", "5"])));
    }
    // A keyword, which only names a function loosely, is not sent to a plugin.
    expect(functions["holdings"]).toBeUndefined();
  } finally {
    all.destroy();
    for (const registry of own.values()) registry.destroy();
  }
}, 60_000);
