import { expect, test } from "bun:test";
import { getLoadablePlugins } from "../plugins/catalog";
import { createDefaultConfig } from "../types/config";
import { commandPointer, knownGapForTicker, knownGapMessage, topicPointer } from "./known-gaps";
import type { MarketContext } from "./types";
import { buildSearchReport, searchFunctionsForCli } from "./commands/search";
import { buildPaneCatalogEntries, filterPaneCatalogEntries, renderPaneCatalogReport } from "./pane-functions/catalog";
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

test("freight rates and the Baltic indices are said to be uncovered, naming what is; BDI alone is also a ticker", () => {
  const gap = knownGapMessage("freight")!;
  expect(gap).toStartWith("Baltic indices (BDI, Capesize, Panamax, Supramax) and freight forwards (FFA) are not covered.");
  for (const proxy of ["BDRY", "SBLK", "GNK", "DSX", "fn CHOKE", "news \"dry bulk\""]) expect(gap).toContain(proxy);
  for (const query of ["Baltic Dry", "dry-bulk", "Panamax", "freight rates", "FFA", "BDI", "charter rates"]) expect(knownGapMessage(query), query).toBe(gap);
  // Only the whole query: a company, a sector or a ticker that merely carries the word is not the gap.
  for (const query of ["baltic sea", "freight forwarder stocks", "BDIX", "BDRY", "ocean freight carriers"]) expect(knownGapMessage(query), query).toBeNull();
  expect(knownGapForTicker("BDI")).toBe(gap);
  for (const symbol of ["FFA", "freight", "BDRY", "EUA"]) expect(knownGapForTicker(symbol), symbol).toBeNull();

  const catalog = renderPaneCatalogReport([], parsePaneCatalogArgs(["capesize"]), lookupGlossary("capesize"), knownGapMessage("capesize"));
  expect(catalog).toContain("are not covered");
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
    const freightCodes = [...knownGapMessage("freight")!.matchAll(/\bfn ([A-Z]+)/g)].map((match) => match[1]!);
    expect(freightCodes).toEqual(["CHOKE"]);
    for (const code of [...pointer.codes, ...topicPointer("borrow fee")!.codes, ...freightCodes]) expect(tokens, code).toContain(code);
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

test("the basis trade is found by its own words: the futures curve first, then the perpetual that pays its other leg", async () => {
  const context = { config: createDefaultConfig("/tmp/known-gaps-test") } as MarketContext;
  expect((await searchFunctionsForCli("basis trade", getLoadablePlugins(), context)).map((match) => match.token)).toEqual(["CTM", "PERP"]);
  const registry = await createPaneCatalog(context, getLoadablePlugins());
  try {
    const entries = await buildPaneCatalogEntries(registry, context);
    for (const query of ["basis", "carry", "contango", "backwardation", "roll", "basis trade"]) {
      const report = renderPaneCatalogReport(filterPaneCatalogEntries(entries, query), parsePaneCatalogArgs([query]), lookupGlossary(query)).replace(/\x1b\[[0-9;]*m/g, "");
      expect(report, query).toMatch(/^CTM\s+Futures Curve/m);
    }
  } finally {
    registry.destroy();
  }
  // Carry has no glossary entry of its own; the basis it names is listed beside the functions.
  expect(renderPaneCatalogReport([], parsePaneCatalogArgs(["carry"]), lookupGlossary("carry"))).toContain("Glossary: Futures basis.");
});

test("securities-lending data is said to be unavailable, with short interest as the nearest data, instead of SI being listed as its source", () => {
  const pointer = topicPointer("borrow fee")!;
  expect(pointer.message).toStartWith("borrow fee, utilization and locate: not available");
  expect(pointer.codes).toEqual(["SI", "SIW", "SIV"]);
  for (const query of ["borrow", "Utilisation", "utilization", "locate", "stock borrow rates", "what is the cost to borrow GME"]) {
    expect(topicPointer(query), query).toEqual(pointer);
  }
  // Words that name another thing alone: a country's capacity utilization is FRED's, and a company can be located.
  for (const query of ["capacity utilization", "locate headquarters", "borrow money", "short interest"]) expect(topicPointer(query), query).toBeNull();
  const catalog = renderPaneCatalogReport([], parsePaneCatalogArgs(["borrow fee"]), lookupGlossary("borrow fee"), pointer.message);
  expect(catalog).toContain("not available");
  expect(catalog).not.toContain("No functions match");
});

test("an income or reinvestment query names portfolio show --drip; a statement or margin query does not", () => {
  const line = "Portfolio income, yield and DRIP projection: gloomberb portfolio show <name> --drip";
  for (const query of ["drip", "DRIP projection", "reinvest", "dividend reinvestment", "dividend income", "my portfolio income"]) {
    expect(commandPointer(query), query).toBe(line);
  }
  for (const query of ["income statement", "net income", "fixed income", "dark pool"]) expect(commandPointer(query), query).toBeNull();
  expect(commandPointer("light theme")).toBe("Themes: gloomberb config themes");
});
