import { expect, test } from "bun:test";
import { getLoadablePlugins } from "../plugins/catalog";
import { createDefaultConfig } from "../types/config";
import { knownGapMessage, topicPointer } from "./known-gaps";
import type { MarketContext } from "./types";
import { buildSearchReport, searchFunctionsForCli } from "./commands/search";
import { buildPaneCatalogEntries, renderPaneCatalogReport } from "./pane-functions/catalog";
import { createPaneCatalog } from "./pane-functions/discovery";
import { parsePaneCatalogArgs } from "./pane-functions/options";
import { lookupGlossary } from "./glossary";

test("data a name search cannot find is pointed to, with its proxies, by search and catalog, instead of each pointing at the other", () => {
  const gap = "EU carbon (EUA): the auction price is in EPWR, chart CAP:carbon:eua. Traded proxies: CO2:LSE, KRBN.";
  expect(["EUA", "carbon allowances", "EU-ETS", "Carbon"].map(knownGapMessage)).toEqual([gap, gap, gap, gap]);
  expect(knownGapMessage("carbon fiber")).toBeNull();

  const search = buildSearchReport({ query: "carbon allowances", candidates: [] });
  expect(search).toContain(gap);
  expect(search).not.toContain("catalog");
  const catalog = renderPaneCatalogReport([], parsePaneCatalogArgs(["EUA"]), lookupGlossary("EUA"), knownGapMessage("EUA"));
  expect(catalog).toContain(gap);
  expect(catalog).toContain("EU Allowance");
  expect(catalog).not.toContain("No functions match");
});

test("a topic no function covers is answered with the nearest functions, wherever its words sit in the query", async () => {
  const pointer = topicPointer("defense budget")!;
  expect(pointer.message).toStartWith("defense budget: not in the terminal yet; closest: AWARDS (");
  for (const query of ["Defense spending", "DoD", "us DoD-budget 2027", "military budget"]) expect(topicPointer(query)).toEqual(pointer);
  // One of its words is not the topic: "budget" alone is OSA's flag, "defense" the defense stocks.
  for (const query of ["budget", "defense", "defense stocks", "budget airline"]) expect(topicPointer(query)).toBeNull();
  expect(knownGapMessage("defense budget")).toBe(pointer.message);

  // Every function it names exists, so the pointer cannot rot when one is renamed.
  const context = { config: createDefaultConfig("/tmp/known-gaps-test") } as MarketContext;
  const registry = await createPaneCatalog(context, getLoadablePlugins());
  try {
    const tokens = (await buildPaneCatalogEntries(registry, context)).map((entry) => entry.token);
    for (const code of pointer.codes) expect(tokens, code).toContain(code);
  } finally {
    registry.destroy();
  }

  // The catalog leads with the note and lists no loose matches beneath it.
  const catalog = renderPaneCatalogReport([], parsePaneCatalogArgs(["defense budget"]), lookupGlossary("defense budget"), pointer.message);
  expect(catalog).toContain("defense budget: not in the terminal yet");
  expect(catalog).not.toContain("No functions match");
});

test("a search no ticker answers lists the functions that carry every word, so a task finds its function", async () => {
  const context = { config: createDefaultConfig("/tmp/known-gaps-test") } as MarketContext;
  const functions = await searchFunctionsForCli("target weights rebalance", getLoadablePlugins(), context);
  expect(functions.map((match) => match.token)).toEqual(["PF"]);
  // PF's own words say what it does with targets, so the list explains the match.
  expect(functions[0]!.description).toMatch(/target weights.*drift.*rebalance/);
  const report = buildSearchReport({ query: "target weights rebalance", candidates: [], functions }).replace(/\x1b\[[0-9;]*m/g, "");
  expect(report).toContain("PF  Collection Pane");
  expect(report).not.toContain("No matches found");
  // Some of the words only: no function carries them all, and the search says so as before.
  expect(await searchFunctionsForCli("rebalance xylophone", getLoadablePlugins(), context)).toEqual([]);
});
