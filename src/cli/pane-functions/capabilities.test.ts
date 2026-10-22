import { describe, expect, test } from "bun:test";
import { paneSchemas as chartSchemas } from "../../plugins/builtin/chart-composer/headless-schema";
import { buildFundamentalChartPreset, buildValuationChartPreset } from "../../plugins/builtin/chart-composer/presets";
import { paneSchemas as correlationSchemas } from "../../plugins/builtin/correlation/headless-schema";
import { paneSchemas as researchSchemas } from "../../plugins/builtin/research/headless-schema";
import { optionsPositioningHeadless } from "../../plugins/builtin/options-positioning/headless";
import { optionsScenarioHeadless } from "../../plugins/builtin/options-scenario/headless";
import { thirteenFHeadless } from "../../plugins/builtin/thirteenf/headless";
import { volSurfaceHeadless } from "../../plugins/builtin/vol-surface/headless";
import { paneSchemas as tickerSchemas } from "../../plugins/builtin/ticker-detail/headless-schema";
import type { HeadlessPaneDefinition } from "../../types/headless";
import { getLoadablePlugins } from "../../plugins/catalog";
import { createDefaultConfig } from "../../types/config";
import type { MarketContext } from "../types";
import { parseCliGlobalArgs } from "../options";
import { COMMODITIES_VIEW_STATE } from "../../plugins/builtin/commodities-energy/view-state";
import { cotHeadless } from "../../plugins/builtin/cot/headless";
import { FIXED_INCOME_VIEW_STATE } from "../../plugins/builtin/fixed-income/model";
import { futuresCurveHeadless } from "../../plugins/builtin/futures-curve/headless";
import { jodiHeadless } from "../../plugins/builtin/jodi/headless";
import { treasuryAuctionsHeadless } from "../../plugins/builtin/treasury-auctions/headless";
import { yieldCurveHeadless } from "../../plugins/builtin/yield-curve/headless";
import {
  capabilityPaneSettings,
  capabilityPluginState,
  getPaneFunctionCapability,
  isDataPaneForDomFallback,
  noArgumentMessage,
  normalizeCapabilityOptions,
} from "./capabilities";
import {
  buildPaneCatalogEntries,
  filterPaneCatalogEntries,
  renderPaneCatalogReport,
  selectPaneCatalogMatches,
  type PaneCatalogEntry,
} from "./catalog";
import { createPaneCatalog } from "./discovery";
import { findCatalogSeries } from "../series-search";
import { parsePaneFunctionArgs } from "./options";

const dummyPane = {
  id: "test-pane",
  name: "Test",
  component: () => null,
  defaultPosition: "right" as const,
};

function capabilityFor(templateId: string) {
  const schemas: Record<string, Pick<HeadlessPaneDefinition, "argument" | "options" | "discovery">> = {
    ...chartSchemas, ...tickerSchemas, ...correlationSchemas, ...researchSchemas,
  };
  const schema = schemas[templateId];
  return getPaneFunctionCapability({
    id: templateId,
    ...(schema ? { headless: { ...schema, shape: "rows" as const, load: () => ({ rows: [] }) } } : {}),
    paneId: dummyPane.id,
    label: "Test",
    description: "Test",
  }, dummyPane);
}

describe("pane function capabilities", () => {
  test("passes global limits through the pane schema instead of silently using its default", () => {
    const capability = getPaneFunctionCapability({
      id: "funds", paneId: dummyPane.id, label: "Funds", description: "Funds", headless: thirteenFHeadless,
    }, dummyPane);
    for (const flags of [["--limit", "15"], ["--limit=15"]]) {
      const global = parseCliGlobalArgs(["fn", "13F", "1067983", ...flags, "--json"]);
      const parsed = parsePaneFunctionArgs(global.args.slice(1), global.options);
      expect(normalizeCapabilityOptions(capability, parsed.options, { strict: true }).limit).toBe(15);
    }
    const parsed = parsePaneFunctionArgs(["13F", "1067983"], { limit: 201 });
    expect(() => normalizeCapabilityOptions(capability, parsed.options, { strict: true })).toThrow();
  });

  test("normalizes GF options without creating retired plugin state", () => {
    const capability = capabilityFor("fundamental-graph-pane");
    const options = normalizeCapabilityOptions(capability, {
      metric: "operating cash flow",
      period: "yearly",
    });

    expect(options).toEqual({
      metric: "operatingCashFlow",
      period: "annual",
    });
    expect(capabilityPluginState(capability, options)).toEqual({});
  });

  // A read applies its period over the template, so a default that differs changes what it shows.
  test("GF and GE read the period their app templates open on, with the other one option away", () => {
    for (const [id, build, period, other] of [
      ["fundamental-graph-pane", buildFundamentalChartPreset, "quarterly", "annual"],
      ["valuation-graph-pane", buildValuationChartPreset, "annual", "quarterly"],
    ] as const) {
      const capability = capabilityFor(id);
      for (const symbols of [["AAPL"], ["AAPL", "MSFT"]]) {
        expect(build(symbols).series.map((series) => series.source)).toEqual(symbols.map(() => expect.objectContaining({ period })));
      }
      expect(normalizeCapabilityOptions(capability, {}).period).toBe(period);
      expect(normalizeCapabilityOptions(capability, { period: other }).period).toBe(other);
    }
  });

  test("exposes custom G as a bot-safe mixed-series capability", () => {
    const capability = capabilityFor("chart-composer-pane");

    expect(capability).toMatchObject({
      id: "chart-composer",
      botSafe: true,
      tickerCardinality: "none",
      reportReadiness: "ready",
      screenshotReadiness: "ready",
    });
    expect(normalizeCapabilityOptions(capability, {
      range: "five years",
      resolution: "1d",
    })).toEqual({
      rangePreset: "5Y",
      chartResolution: "1d",
    });
  });

  test("maps data panes to rendered reports and keeps interactive panes unsupported", () => {
    expect(capabilityFor("new-api-pane")).toMatchObject({
      id: "new-api-pane",
      botSafe: false,
      outputKind: "rendered-view",
      reportReadiness: "live-dom",
      screenshotReadiness: "live-dom",
    });

    const helpPane = { ...dummyPane, id: "help" };
    expect(getPaneFunctionCapability(undefined, helpPane)).toMatchObject({
      id: "help",
      reportReadiness: "unsupported",
      screenshotReadiness: "live-dom",
    });
    expect(isDataPaneForDomFallback(dummyPane)).toBe(true);
    expect(isDataPaneForDomFallback(helpPane)).toBe(false);
  });

  test("every expiry option takes a date or Unix seconds and names both forms when it cannot read one", () => {
    const options: Array<[string, HeadlessPaneDefinition, string, string | number]> = [
      ["vol-surface", volSurfaceHeadless, "expiration", 1799971200],
      ["options-scenario", optionsScenarioHeadless, "expiration", 1799971200],
      ["options-positioning", optionsPositioningHeadless("strikes"), "expiry", "2027-01-15"],
    ];
    for (const [id, headless, key, read] of options) {
      const capability = getPaneFunctionCapability({ id, paneId: dummyPane.id, label: id, description: id, headless }, dummyPane);
      expect(normalizeCapabilityOptions(capability, { [key]: "2027-01-15" })[key]).toBe(read);
      expect(normalizeCapabilityOptions(capability, { [key]: "1799971200" })[key]).toBe(read);
      // A date reads as a date option reads it.
      for (const date of ["15.01.2027", "Jan 15 2027", "15 January 2027"]) expect(normalizeCapabilityOptions(capability, { [key]: date })[key]).toBe(read);
      for (const bad of ["2027-02-30", "15/01/2027", "1799971200000"]) {
        expect(() => normalizeCapabilityOptions(capability, { [key]: bad }))
          .toThrow(`Invalid --${key} "${bad}". Use YYYY-MM-DD (2028-01-21), DD.MM.YYYY, Jan 21 2028, 21 January 2028 or Unix seconds (1832025600).`);
      }
    }
  });

  test("COT, CTM, AUCT, JODI and GC options reach their view's own state, under the namespace its workspace wraps it with", () => {
    const cases: Array<[HeadlessPaneDefinition, Record<string, string>, Record<string, Record<string, unknown>>, Record<string, unknown>]> = [
      [cotHeadless, { traderClass: "commercial", scope: "all" }, { [COMMODITIES_VIEW_STATE.cot]: { class: "commercial", scope: "all" } }, {}],
      [futuresCurveHeadless, { tab: "table", date: "2026-10-09" }, { [COMMODITIES_VIEW_STATE.curve]: { tab: "contracts" } }, { asOfDate: "2026-10-09" }],
      [treasuryAuctionsHeadless, { filter: "bill" }, { [FIXED_INCOME_VIEW_STATE.treasuryAuctions]: { activeTab: "bill" } }, {}],
      [jodiHeadless, { commodity: "gas" }, { [COMMODITIES_VIEW_STATE.balances]: { commodity: "gas" } }, {}],
      [yieldCurveHeadless, { date: "2026-10-09" }, {}, { asOfDate: "2026-10-09" }],
    ];
    for (const [headless, raw, pluginState, settings] of cases) {
      const capability = getPaneFunctionCapability({ id: "view", paneId: dummyPane.id, label: "View", description: "View", headless }, dummyPane);
      const options = normalizeCapabilityOptions(capability, raw);
      expect(capabilityPluginState(capability, options)).toMatchObject(pluginState);
      expect(capabilityPaneSettings(capability, options)).toMatchObject(settings);
    }
  });

  test("rejects financial statement options on a price comparison", () => {
    const capability = capabilityFor("comparison-chart-pane");
    expect(() => normalizeCapabilityOptions(capability, {
      tab: "cashflow",
    })).toThrow("price-comparison does not support --tab");
  });

  test("an option a function does not take is refused by the code the user typed, not its pane or capability id", () => {
    const comparison = capabilityFor("comparison-chart-pane");
    expect(() => normalizeCapabilityOptions(comparison, { tab: "cashflow" }, { code: "COMP" }))
      .toThrow("COMP does not support --tab. Supported options: --rangePreset, --axisMode, --chartResolution.");
    // The intraday chart's capability id is not its template id, and neither is what anyone types.
    const intraday = capabilityFor("graph-intraday-price-pane");
    expect(intraday.id).toBe("intraday-price-chart");
    expect(() => normalizeCapabilityOptions(intraday, { interval: "5m" }, { code: "GIP" }))
      .toThrow("GIP does not support --interval.");
    // A function with no options says so.
    expect(() => normalizeCapabilityOptions({ ...intraday, options: [] }, { range: "1Y" }, { code: "CDX" }))
      .toThrow("CDX does not support --range. It has no options.");
  });

  test("a word after a function that takes none is answered with its options, and runs as the option whose value it is", () => {
    expect(noArgumentMessage(jodiHeadless.options, "JODI", "Gas"))
      .toBe("JODI does not accept an argument. Options: --commodity <oil|gas>. Run: gloomberb fn JODI --commodity gas");
    // Anything else gets an example: a choice that is not the default, in the command that was run.
    expect(noArgumentMessage(jodiHeadless.options, "JODI", "europe", "shot"))
      .toBe("JODI does not accept an argument. Options: --commodity <oil|gas>. Example: gloomberb shot JODI --commodity gas");
    expect(noArgumentMessage([], "CDX", "IG")).toBe("CDX does not accept an argument. Run: gloomberb fn CDX");
  });
});

describe("pane catalog search", () => {
  test("searches and renders pane catalog entries", () => {
    const matches = filterPaneCatalogEntries([
      {
        token: "GP",
        label: "Graph Price",
        description: "Open a ticker detail pane locked to a price chart.",
        paneId: "ticker-detail",
        paneName: "Detail",
        templateId: "graph-price-pane",
        shortcut: "GP",
        aliases: [],
        argKind: "ticker",
        argPlaceholder: "ticker",
        keywords: ["gp", "graph", "price", "chart"],
        defaultSettings: { lockedTabId: "chart", chartRangePreset: "5Y" },
        capability: capabilityFor("graph-price-pane"),
      },
      {
        token: "FA",
        label: "Financial Analysis",
        description: "Open a ticker detail pane locked to financial statements.",
        paneId: "ticker-detail",
        paneName: "Detail",
        templateId: "financial-analysis-pane",
        shortcut: "FA",
        aliases: [],
        argKind: "ticker",
        argPlaceholder: "ticker",
        keywords: ["fa", "financial", "analysis", "statements"],
        defaultSettings: { lockedTabId: "financials" },
        capability: capabilityFor("financial-analysis-pane"),
      },
    ], "price chart");

    expect(matches.map((entry) => entry.token)).toEqual(["GP"]);
    expect(renderPaneCatalogReport(matches, { query: "price chart", limit: 10, botSafeOnly: false })).toContain("gloomberb shot GP <ticker>");
  });

  test("finds the semantic financial comparison capability from natural wording", () => {
    const matches = filterPaneCatalogEntries([
      {
        token: "GF",
        label: "Fundamental Graph",
        description: "Graph statement metrics for one or more tickers.",
        paneId: "fundamental-graph",
        paneName: "Fundamental Graph",
        templateId: "fundamental-graph-pane",
        shortcut: "GF",
        aliases: [],
        argKind: "ticker-list",
        argPlaceholder: "tickers",
        keywords: ["fundamental", "graph", "financials", "statements"],
        defaultSettings: {},
        capability: capabilityFor("fundamental-graph-pane"),
      },
      {
        token: "CMP",
        label: "Comparison Chart",
        description: "Compare stock prices.",
        paneId: "comparison-chart",
        paneName: "Compare",
        templateId: "comparison-chart-pane",
        shortcut: "CMP",
        aliases: [],
        argKind: "ticker-list",
        argPlaceholder: "tickers",
        keywords: ["compare", "price"],
        defaultSettings: {},
        capability: capabilityFor("comparison-chart-pane"),
      },
    ], "cash flow comparison");

    expect(matches.map(({ token }) => token)).toEqual(["GF", "CMP"]);
  });

  test("a phrase carried whole by a name or keyword ranks first, then one in a description, then each word somewhere", () => {
    const entry = (token: string, description: string, keywords: string[], options: PaneCatalogEntry["capability"]["options"] = []) => ({
      token,
      label: token,
      description,
      paneId: token.toLowerCase(),
      paneName: token,
      shortcut: token,
      aliases: [],
      keywords,
      defaultSettings: {},
      capability: { ...capabilityFor(`${token.toLowerCase()}-pane`), aliases: keywords, options },
    });
    const word = (key: string, description: string) => ({ key, type: "string" as const, description });
    const matches = filterPaneCatalogEntries([
      // Alphabetical order puts the weakest matches first: only ranking can reorder them.
      entry("AAA", "Money market curves.", [], [word("rate", "Policy rate"), word("funding", "Funding source")]),
      entry("BBB", "Short rates against funding.", ["funding"]),
      entry("CCC", "Daily funding rate by venue.", ["venues"]),
      entry("PERP", "Perpetual funding.", ["perp", "funding rate", "open interest"]),
      entry("ZZZ", "Unrelated.", ["rate"]),
    ], "funding rate");

    const order = matches.map(({ token }) => token);
    expect(order.slice(0, 2)).toEqual(["PERP", "CCC"]);
    expect(order.slice(2, 4).sort()).toEqual(["AAA", "BBB"]);
    expect(order[4]).toBe("ZZZ");
  });

  test("hedging and put-selling searches put OSA first among the built-in functions", async () => {
    const context = { config: createDefaultConfig("/tmp/capabilities-test") } as MarketContext;
    const registry = await createPaneCatalog(context, getLoadablePlugins());
    try {
      const entries = await buildPaneCatalogEntries(registry, context);
      for (const query of ["collar", "hedge", "hedging", "protective put", "put spread"]) {
        expect(filterPaneCatalogEntries(entries, query)[0]?.token, query).toBe("OSA");
      }
      // Selling puts: OSA runs the trade, OMON picks the strike, VCA finds the rich premium.
      for (const query of ["cash secured put", "csp", "put selling", "sell put", "short put", "wheel"]) {
        const tokens = filterPaneCatalogEntries(entries, query).map(({ token }) => token);
        expect(tokens[0], query).toBe("OSA");
        expect(tokens.slice(0, 3).sort(), query).toEqual(["OMON", "OSA", "VCA"]);
      }
    } finally {
      registry.destroy();
    }
  });

  test("Buffett, overlap, copying a basket and active share searches list 13F first, one word or several", async () => {
    const context = { config: createDefaultConfig("/tmp/capabilities-test") } as MarketContext;
    const registry = await createPaneCatalog(context, getLoadablePlugins());
    try {
      const entries = await buildPaneCatalogEntries(registry, context);
      for (const query of ["buffett", "berkshire", "overlap", "copy", "active share", "portfolio import"]) {
        const ranked = filterPaneCatalogEntries(entries, query);
        expect(selectPaneCatalogMatches(ranked, query, 10).shown[0]?.token, query).toBe("13F");
      }
      // The Buffett indicator is still VAL's.
      expect(filterPaneCatalogEntries(entries, "buffett").map(({ token }) => token)).toContain("VAL");
    } finally {
      registry.destroy();
    }
  });

  test("a function's code page names the other functions that list the same word, and AIS finds the map in any case", async () => {
    const context = { config: createDefaultConfig("/tmp/capabilities-test") } as MarketContext;
    const registry = await createPaneCatalog(context, getLoadablePlugins());
    try {
      const entries = await buildPaneCatalogEntries(registry, context);
      // `catalog port` is PORT's page; MAP lists ports and vessels, so it is named under it.
      const page = renderPaneCatalogReport(filterPaneCatalogEntries(entries, "port"), { query: "port", limit: 10, botSafeOnly: false });
      expect(page).toContain("gloomberb fn PORT <portfolio-id>");
      expect(page).toMatch(/Also matches "port"[\s\S]*\nMAP\s/);
      for (const query of ["ais", "AIS", "shipping"]) expect(filterPaneCatalogEntries(entries, query).map(({ token }) => token), query).toContain("MAP");
    } finally {
      registry.destroy();
    }
  });

  test("a metals desk's plain words for the gold/silver ratio list GR first, and search lists it", async () => {
    const context = { config: createDefaultConfig("/tmp/capabilities-test") } as MarketContext;
    const registry = await createPaneCatalog(context, getLoadablePlugins());
    try {
      const entries = await buildPaneCatalogEntries(registry, context);
      for (const query of ["ratio", "gold silver", "gold silver ratio", "gold/silver ratio"]) {
        const ranked = filterPaneCatalogEntries(entries, query);
        const { shown, loose } = selectPaneCatalogMatches(ranked, query, 10);
        expect(shown[0]?.token, query).toBe("GR");
        // `search` lists functions only from a match that is not loose.
        expect(loose, query).toBe(false);
      }
    } finally {
      registry.destroy();
    }
  });

  test("crack spread and refining margin searches find G alone, with the per-barrel crack presets it charts", async () => {
    const context = { config: createDefaultConfig("/tmp/capabilities-test") } as MarketContext;
    const plugins = getLoadablePlugins();
    const registry = await createPaneCatalog(context, plugins);
    try {
      const entries = await buildPaneCatalogEntries(registry, context);
      for (const query of ["crack", "crack spread", "refining margin"]) {
        const ranked = filterPaneCatalogEntries(entries, query);
        expect(selectPaneCatalogMatches(ranked, query, 10).shown.map(({ token }) => token), query).toEqual(["G"]);
        expect(findCatalogSeries(plugins, query).map(({ unit, expression }) => `${unit} ${expression}`).sort(), query).toEqual([
          "USD/barrel (2*42*RB=F + 42*HO=F - 3*CL=F)/3",
          "USD/barrel 42*HO=F - BZ=F",
          "USD/barrel 42*HO=F - CL=F",
        ]);
      }
    } finally {
      registry.destroy();
    }
  });

  test("a word found only in a flag's description is no match; a flag's own name, or every word together, is", () => {
    const entry = (token: string, description: string, keys: Array<[string, string]>) => ({
      token,
      label: token,
      description,
      paneId: token.toLowerCase(),
      paneName: token,
      shortcut: token,
      aliases: [],
      keywords: [],
      defaultSettings: {},
      capability: {
        ...capabilityFor(`${token.toLowerCase()}-pane`),
        options: keys.map(([key, text]) => ({ key, type: "string" as const, description: text })),
      },
    });
    const osa = entry("OSA", "Build positions and compare scenario P&L.", [
      ["budgetBps", "Hedge budget in basis points of --nav."],
      ["expiration", "Chain expiry for --strategy."],
    ]);
    // "budget" is OSA's hedge budget flag, not a function about budgets.
    expect(filterPaneCatalogEntries([osa], "budget")).toEqual([]);
    expect(filterPaneCatalogEntries([osa], "expiration").map(({ token }) => token)).toEqual(["OSA"]);
    expect(filterPaneCatalogEntries([osa], "hedge budget").map(({ token }) => token)).toEqual(["OSA"]);
  });

  test("a query word starts a word, and joining words do not count", () => {
    const entry = (token: string, description: string) => ({
      token,
      label: token,
      description,
      paneId: token.toLowerCase(),
      paneName: token,
      shortcut: token,
      aliases: [],
      keywords: [],
      defaultSettings: {},
      capability: capabilityFor(`${token.toLowerCase()}-pane`),
    });
    // "date" is in "update" and "to" in "stock"; neither is a date or a word.
    const entries = [
      entry("AAA", "Year to date returns by sector."),
      entry("BBB", "Update a stock quote."),
      entry("CCC", "Dated filings of each year."),
    ];
    expect(filterPaneCatalogEntries(entries, "year to date").map(({ token }) => token)).toEqual(["AAA", "CCC"]);
    expect(filterPaneCatalogEntries(entries, "date").map(({ token }) => token)).toEqual(["AAA", "CCC"]);
  });

  test("two words typed as one find the functions that carry both, and a word that is neither finds nothing", () => {
    const entry = (token: string, description: string) => ({
      token,
      label: token,
      description,
      paneId: token.toLowerCase(),
      paneName: token,
      shortcut: token,
      aliases: [],
      keywords: [],
      defaultSettings: {},
      capability: capabilityFor(`${token.toLowerCase()}-pane`),
    });
    const entries = [
      entry("AAA", "Implied volatility surface and smiles."),
      entry("BBB", "Volatility index closes."),
      entry("CCC", "Surface temperature by ocean basin."),
      entry("DDD", "Balance sheet and income statement for a ticker."),
    ];
    // BBB has "vol" and CCC "surf", but only AAA has both; a query that matches on its own is not cut.
    expect(filterPaneCatalogEntries(entries, "volsurf").map(({ token }) => token)).toEqual(["AAA"]);
    // The two words are written in a row: "baltic" starts DDD's "balance" and "ticker" without being either word.
    expect(filterPaneCatalogEntries(entries, "baltic")).toEqual([]);
    expect(filterPaneCatalogEntries(entries, "balancesheet").map(({ token }) => token)).toEqual(["DDD"]);
    expect(filterPaneCatalogEntries(entries, "volatility").map(({ token }) => token)).toEqual(["AAA", "BBB"]);
    expect(filterPaneCatalogEntries(entries, "zzqxvb")).toEqual([]);
  });

  test("a multi-word query lists the functions that carry every word, or the few closest, with the rest counted", () => {
    const entry = (token: string, description: string) => ({
      token,
      label: token,
      description,
      paneId: token.toLowerCase(),
      paneName: token,
      shortcut: token,
      aliases: [],
      keywords: [],
      defaultSettings: {},
      capability: capabilityFor(`${token.toLowerCase()}-pane`),
    });
    const select = (entries: PaneCatalogEntry[], query: string, limit = 25) =>
      selectPaneCatalogMatches(filterPaneCatalogEntries(entries, query), query, limit);

    const some = ["AAA", "BBB", "CCC", "DDD", "EEE", "FFF", "GGG"].map((token) => entry(token, "Price history by year."));
    const complete = entry("ZZZ", "Price history by year to date.");
    const loose = select(some, "price date");
    // None has both words: the five closest, the rest left to a sharper query.
    expect(loose).toMatchObject({ loose: true, hidden: 2 });
    expect(loose.shown).toHaveLength(5);
    expect(select([...some, complete], "year to date").shown.map(({ token }) => token)).toEqual(["ZZZ"]);
    // --all lists every match.
    expect(select(some, "price date", Number.POSITIVE_INFINITY)).toMatchObject({ hidden: 0, loose: false });
    expect(select(some, "price date", Number.POSITIVE_INFINITY).shown).toHaveLength(7);
  });

  test("an alias opens its function even when other functions contain the same letters", () => {
    const entry = (token: string, aliases: string[], keywords: string[]) => ({
      token,
      label: token,
      description: `${token} function.`,
      paneId: token.toLowerCase(),
      paneName: token,
      shortcut: token,
      aliases,
      keywords,
      defaultSettings: {},
      capability: capabilityFor(`${token.toLowerCase()}-pane`),
    });
    const matches = filterPaneCatalogEntries([
      entry("COT", ["CFTC"], ["cftc", "positioning"]),
      entry("SEC", ["CF"], ["filings"]),
    ], "cf");

    expect(matches.map(({ token }) => token)).toEqual(["SEC", "COT"]);
    const report = renderPaneCatalogReport(matches, { query: "cf", limit: 10, botSafeOnly: false });
    expect(report).toContain("SEC function.");
    expect(report).not.toContain("COT function.");
  });
});
