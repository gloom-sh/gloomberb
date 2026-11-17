import { expect, test } from "bun:test";
import { getLoadablePlugins } from "../../plugins/catalog";
import { createDefaultConfig } from "../../types/config";
import { findCatalogSeries, findSeriesFacts } from "../series-search";
import type { MarketContext } from "../types";
import { shellWord } from "../../utils/shell-word";
import { buildPaneCatalogEntries, exampleListName } from "./catalog";
import { type CatalogSnapshot, snapshotEntries } from "./catalog-snapshot";
import { buildCatalogSnapshot, renderCatalogSnapshot } from "./catalog-snapshot-build";
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

/**
 * The snapshot as `bun run catalog:snapshot` writes it and the command reads it back, built here from the plugins: the
 * file is not in git, so nothing below depends on one.
 */
let built: Promise<CatalogSnapshot> | undefined;
function writtenSnapshot(): Promise<CatalogSnapshot> {
  return built ??= buildCatalogSnapshot(plugins).then((snapshot) => JSON.parse(renderCatalogSnapshot(snapshot)) as CatalogSnapshot);
}

test("the snapshot lists every function as the plugins' own catalog does, for a profile with lists of its own", async () => {
  const context = richContext();
  // Built before a registry of the same plugins is set up: a setup leaves state that only its dispose undoes.
  const snapshot = await writtenSnapshot();
  const registry = await createPaneCatalog(context, plugins);
  try {
    const live = await buildPaneCatalogEntries(registry, context);
    const fromSnapshot = snapshotEntries(snapshot, await exampleListName(context));
    // The output is JSON or text of these: same fields, in the same order, with nothing left undefined.
    expect(fromSnapshot.map((entry) => JSON.stringify(entry))).toEqual(live.map((entry) => JSON.stringify(entry)));
    expect(live.some((entry) => entry.argExamples?.includes(shellWord("Tech Picks")))).toBe(true);
  } finally {
    registry.destroy();
  }
});

test("a profile with no list holding a symbol gets the examples a function gives of itself", async () => {
  const context = { config: createDefaultConfig("/catalog-snapshot-test"), store: { loadAllTickers: async () => [] } } as unknown as MarketContext;
  const snapshot = await writtenSnapshot();
  const registry = await createPaneCatalog(context, plugins);
  try {
    const live = await buildPaneCatalogEntries(registry, context);
    expect(snapshotEntries(snapshot, await exampleListName(context)).map((entry) => JSON.stringify(entry)))
      .toEqual(live.map((entry) => JSON.stringify(entry)));
  } finally {
    registry.destroy();
  }
});

test("the snapshot's series answer a search as the plugins' series do", async () => {
  const { series } = await writtenSnapshot();
  for (const query of ["operating margin", "fed funds", "defi", "DFEDTARU", "crack spread", "xyzzy"]) {
    expect(findSeriesFacts(series, query), query).toEqual(findCatalogSeries(plugins, query));
  }
});

/** What resolving a word reads of a registry: the function it opens, the code it is shown as, its options, how its arguments parse. */
function resolution(registry: Awaited<ReturnType<typeof createPaneCatalog>>, word: string) {
  const found = findPaneFunction(registry, word);
  return {
    template: found?.template?.id,
    pane: found?.pane?.id,
    code: found?.pane ? paneFunctionCode(found.template, found.pane, registry) : undefined,
    capability: found?.pane ? JSON.stringify(getPaneFunctionCapability(found.template, found.pane)) : undefined,
    parsed: JSON.stringify(parsePaneFunctionArgsFor(registry, [word, "AAPL", "--limit", "5"])),
  };
}

test("a function the snapshot gives to some plugins resolves there as it does among all of them", async () => {
  const context = { config: createDefaultConfig("/catalog-snapshot-test"), store: { loadAllTickers: async () => [] } } as unknown as MarketContext;
  const { functions } = await writtenSnapshot();
  expect(Object.keys(functions).length).toBeGreaterThan(20);
  for (const word of ["hds", "cn", "eqs"]) expect(functions[word], word).toBeDefined();
  // Their setups leave state other plugins read (the FRED series cache, 13F persistence), so these run among all.
  for (const word of ["g", "fa", "vix", "sec"]) expect(functions[word], word).toBeUndefined();
  // A keyword, which only names a function loosely, is not sent to a plugin.
  expect(functions["holdings"]).toBeUndefined();
  // Registries are set up and torn down one at a time: a setup leaves state that its dispose undoes.
  const all = await createPaneCatalog(context, plugins);
  const expected = Object.keys(functions).map((word) => [word, resolution(all, word)] as const);
  all.destroy();
  const groups = new Map<string, string[]>();
  for (const [word, holders] of Object.entries(functions)) groups.set(holders.join("+"), [...groups.get(holders.join("+")) ?? [], word]);
  for (const [key, words] of groups) {
    const alone = await createPaneCatalog(context, key.split("+").map((id) => loadBuiltinPlugin(id)!));
    try {
      for (const word of words) expect(resolution(alone, word), word).toEqual(expected.find(([other]) => other === word)![1]);
    } finally {
      alone.destroy();
    }
  }
}, 60_000);
