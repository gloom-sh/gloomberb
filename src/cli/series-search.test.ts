import { expect, spyOn, test } from "bun:test";
import { apiClient } from "../api-client";
import { getLoadablePlugins } from "../plugins/catalog";
import type { SeriesDefinition } from "../series/types";
import { createDefaultConfig } from "../types/config";
import type { MarketContext } from "./types";
import { buildSearchReport } from "./commands/search";
import { parsePaneCatalogArgs } from "./pane-functions/options";
import { buildPaneCatalogEntries, filterPaneCatalogEntries, renderPaneCatalogReport } from "./pane-functions/catalog";
import { createPaneCatalog } from "./pane-functions/discovery";
import { findCatalogSeries } from "./series-search";

const load = () => [];
const plugins: Array<{ series: SeriesDefinition[] }> = [{
  series: [
    { id: "day-ahead:de", name: "Germany day-ahead power price", unit: "EUR/MWh", frequency: "daily", group: "Energy",
      tags: ["electricity", "day-ahead", "Europe"], publisher: "Ember", load },
    { id: "day-ahead:gb", name: "Great Britain day-ahead power price", unit: "EUR/MWh", frequency: "daily", group: "Energy",
      tags: ["electricity", "day-ahead", "UK"], publisher: "Ember", load },
    { id: "vol:apple", name: "Apple volatility index", unit: "index", frequency: "daily", group: "Volatility", expression: "^VXAPL:close" },
    { id: "short:ratio", name: "Short volume ratio", unit: "%", frequency: "daily", group: "Positioning", input: "ticker",
      expression: "{ticker}:short_ratio" },
  ],
}];
const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
const rates: Array<{ series: SeriesDefinition[] }> = [{
  series: [
    { id: "fred:DFEDTARU", name: "Fed funds target range, upper limit", unit: "%", frequency: "daily", group: "Rates",
      tags: ["fed funds"], publisher: "FRED", expression: "FRED:DFEDTARU" },
    { id: "policy-rate:ch", name: "Switzerland policy rate (SNB policy rate)", unit: "%", frequency: "daily", group: "Rates",
      tags: ["central bank", "Swiss National Bank", "SNB"], publisher: "Swiss National Bank", load },
  ],
}];

test("a query finds series by the words that start theirs, names first, and never a ticker's own field", () => {
  expect(findCatalogSeries(plugins, "german power").map((match) => match.expression)).toEqual(["CAP:day-ahead:de"]);
  // "eur" starts "Europe", never the middle of a word; two letters are too few to search by.
  expect(findCatalogSeries(plugins, "eur").map((match) => match.id)).toEqual(["day-ahead:de"]);
  expect(findCatalogSeries(plugins, "uk")).toEqual([]);
  expect(findCatalogSeries(plugins, "day-ahead").map((match) => [match.id, match.exact])).toEqual([
    ["day-ahead:de", true], ["day-ahead:gb", true],
  ]);
  // The publisher is searched by the catalog, not by a ticker search.
  expect(findCatalogSeries(plugins, "ember", "all")).toHaveLength(2);
  expect(findCatalogSeries(plugins, "ember", "names")).toEqual([]);
  expect(findCatalogSeries(plugins, "short ratio")).toEqual([]);
  expect(findCatalogSeries(plugins, "de")).toEqual([]);
});

test("catalog lists the series it finds with what fn G charts, after the functions or in their place", () => {
  const report = strip(renderPaneCatalogReport([], parsePaneCatalogArgs(["day-ahead"]), undefined, null,
    findCatalogSeries(plugins, "day-ahead")));
  expect(report).toContain('Series for "day-ahead" (2)');
  expect(report).toContain("Germany day-ahead power price");
  expect(report).toContain("CAP:day-ahead:gb");
  expect(report).toContain("Chart one with gloomberb fn G <chart>.");
  expect(report).not.toContain("No functions match");
  // A formula is quoted so the shell passes it to fn G whole; a plain expression is not.
  const crack = [{ series: [{ id: "fut:crack", name: "Heating oil crack", unit: "USD/barrel", frequency: "daily" as const,
    group: "Futures", expression: "42*HO=F - CL=F" }, ...plugins[0]!.series] }];
  const quoted = strip(renderPaneCatalogReport([], parsePaneCatalogArgs(["crack"]), undefined, null, findCatalogSeries(crack, "heating oil")));
  expect(quoted).toContain('"42*HO=F - CL=F"');
  expect(strip(renderPaneCatalogReport([], parsePaneCatalogArgs(["apple"]), undefined, null, findCatalogSeries(plugins, "apple"))))
    .toMatch(/ \^VXAPL:close\n/);
});

test("search lists a series the query names before the tickers, one it merely mentions after them", () => {
  const ticker = { kind: "search", category: "Primary Listing", label: "AAPL", symbol: "AAPL", detail: "Apple Inc.", right: "NASDAQ" };
  const named = strip(buildSearchReport({ query: "day-ahead", candidates: [ticker as never], series: findCatalogSeries(plugins, "day-ahead", "names") }));
  expect(named.indexOf("Series for")).toBeLessThan(named.indexOf("Primary Listing"));
  const mentioned = strip(buildSearchReport({ query: "apple", candidates: [ticker as never], series: findCatalogSeries(plugins, "apple", "names") }));
  expect(mentioned.indexOf("Primary Listing")).toBeLessThan(mentioned.indexOf("Apple volatility index"));
});

test("a series id, its chart expression or a FRED id finds the series, and a FRED id points to the fred command", () => {
  for (const query of ["DFEDTARU", "dfedtaru", "FRED:DFEDTARU", "fred:DFEDTARU"]) {
    expect(findCatalogSeries(rates, query, "names").map((match) => [match.id, match.exact])).toEqual([["fred:DFEDTARU", true]]);
  }
  expect(findCatalogSeries(rates, "CAP:policy-rate:ch", "names").map((match) => match.id)).toEqual(["policy-rate:ch"]);
  expect(findCatalogSeries(rates, "policy-rate:ch", "names").map((match) => match.id)).toEqual(["policy-rate:ch"]);
  // Part of an id is no id.
  expect(findCatalogSeries(rates, "DFEDTAR", "names")).toEqual([]);
  const report = strip(buildSearchReport({ query: "DFEDTARU", candidates: [], series: findCatalogSeries(rates, "DFEDTARU", "names") }));
  expect(report).toContain("Federal Reserve (United States): policy rate on the CBR board, gloomberb fn CBR.");
  expect(report).toContain("Print it with gloomberb fred DFEDTARU; chart it with gloomberb fn G FRED:DFEDTARU.");
  expect(report).not.toContain("No matches found");
});

test("a search naming a central bank says CBR has its rate, instead of finding nothing", () => {
  const report = strip(buildSearchReport({ query: "Swiss National Bank", candidates: [],
    series: findCatalogSeries(rates, "Swiss National Bank", "names") }));
  expect(report).toContain("Swiss National Bank (Switzerland): policy rate on the CBR board, gloomberb fn CBR.");
  expect(report).toContain("CAP:policy-rate:ch");
  expect(report).not.toContain("No matches found");
  // A bank named with the rate asked for is the same bank.
  for (const [query, line] of [
    ["bank of japan rate", "Bank of Japan (Japan): policy rate on the CBR board"],
    ["Federal Reserve rate", "Federal Reserve (United States): policy rate on the CBR board"],
  ] as const) {
    expect(strip(buildSearchReport({ query, candidates: [], series: findCatalogSeries(rates, query, "names") }))).toContain(line);
  }
});

test("mortgage, PMMS, NAHB, homebuilder and housing lead to ECST's housing rows and the housing series", async () => {
  // Catalog discovery starts chat and instantiates the map's chart templates.
  const restore = [spyOn(apiClient, "getChannels").mockResolvedValue([]), spyOn(apiClient, "geo").mockResolvedValue({ series: [] })];
  const loadable = getLoadablePlugins();
  const context = { config: createDefaultConfig("/tmp/series-search-test") } as MarketContext;
  const registry = await createPaneCatalog(context, loadable);
  try {
    const entries = await buildPaneCatalogEntries(registry, context);
    const charted = (query: string) => findCatalogSeries(loadable, query).map((match) => match.expression);
    for (const query of ["mortgage", "PMMS", "homebuilder", "housing"]) {
      expect(filterPaneCatalogEntries(entries, query).map((entry) => entry.token), query).toContain("ECST");
    }
    expect(charted("PMMS")).toEqual(["FRED:MORTGAGE30US", "FRED:MORTGAGE15US", "FRED:MORTGAGE30US10Y"]);
    expect(charted("NAHB")).toEqual(["FRED:NAHBHMI"]);
    expect(charted("mortgage")).toEqual(expect.arrayContaining(["FRED:MORTGAGE30US", "FRED:MORTGAGE15US", "FRED:MORTGAGE30US10Y"]));
    for (const query of ["homebuilder", "housing"]) {
      expect(charted(query), query).toEqual(expect.arrayContaining([
        "FRED:EXHOSLUSM495S", "FRED:MORTGAGE30US", "FRED:MORTGAGE15US", "FRED:MORTGAGE30US10Y", "FRED:NAHBHMI",
      ]));
    }
  } finally {
    registry.destroy();
    for (const spy of restore) spy.mockRestore();
  }
});
