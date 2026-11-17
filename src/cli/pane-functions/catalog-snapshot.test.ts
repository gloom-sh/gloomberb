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
