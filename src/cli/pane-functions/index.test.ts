import { paneSchemas as chartSchemas } from "../../plugins/builtin/chart-composer/headless-schema";
import { paneSchemas as tickerSchemas } from "../../plugins/builtin/ticker-detail/headless-schema";
import { paneSchemas as correlationSchemas } from "../../plugins/builtin/correlation/headless-schema";
import { paneSchemas as researchSchemas } from "../../plugins/builtin/research/headless-schema";
import type { HeadlessPaneDefinition } from "../../types/headless";
import { describe, expect, test } from "bun:test";
import { paneFunctionTestInternals } from "./index";
import { parseCliGlobalArgs } from "../options";
import { thirteenFHeadless } from "../../plugins/builtin/thirteenf/headless";

const {
  parsePaneFunctionArgs,
  parsePaneCatalogArgs,
  normalizeLookupToken,
  parseArgumentsOption,
  optionPaneState,
  filterPaneCatalogEntries,
  renderPaneCatalogReport,
  getPaneFunctionCapability,
  isDataPaneForDomFallback,
  normalizeCapabilityOptions,
  capabilityPluginState,
} = paneFunctionTestInternals;

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

describe("pane function CLI args", () => {
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
  test("inline options do not consume the next positional instrument", () => {
    expect(parsePaneFunctionArgs(["GP", "--range=1M", "ES=F"])).toMatchObject({
      target: "GP", arg: "ES=F", options: { range: "1M" },
    });
  });
  test("parses target, argument, output, size, and pane options", () => {
    const parsed = parsePaneFunctionArgs([
      "FA",
      "$NVDA",
      "--period",
      "quarterly",
      "--statement=balance",
      "--output",
      "/tmp/fa-nvda.png",
      "--width",
      "900",
      "--height=700",
    ]);

    expect(parsed.target).toBe("FA");
    expect(parsed.arg).toBe("$NVDA");
    expect(parsed.outputPath).toBe("/tmp/fa-nvda.png");
    expect(parsed.width).toBe(900);
    expect(parsed.height).toBe(700);
    expect(parsed.requireBotSafe).toBe(false);
    expect(parsed.options).toEqual({
      period: "quarterly",
      statement: "balance",
    });
  });

  test("normalizes pane ids and shortcuts into one lookup form", () => {
    expect(normalizeLookupToken("comparison-chart-pane")).toBe("comparisonchartpane");
    expect(normalizeLookupToken("CMP")).toBe("cmp");
    expect(normalizeLookupToken("$FA")).toBe("fa");
  });

  test("expands --arguments key-value pairs", () => {
    expect(parseArgumentsOption("range-preset=1Y, axis_mode=percent")).toEqual({
      rangePreset: "1Y",
      axisMode: "percent",
    });
  });

  test("maps generic screenshot options into pane runtime state", () => {
    expect(optionPaneState({
      activeTab: "chart",
      state: "cursorSymbol=NVDA,customFlag=true",
    })).toEqual({
      activeTabId: "chart",
      cursorSymbol: "NVDA",
      customFlag: true,
    });
  });

  test("maps financial statement options into reusable pane state", () => {
    expect(optionPaneState({
      statement: "balance sheet",
      period: "quarterly",
    })).toEqual({
      financialSubTab: "balance",
      financialPeriod: "quarterly",
    });
  });

  test("parses catalog queries and limit options", () => {
    expect(parsePaneCatalogArgs(["chart", "price", "--limit", "3"])).toEqual({
      query: "chart price",
      limit: 3,
      botSafeOnly: false,
    });
    expect(parsePaneCatalogArgs(["cash", "flow", "--bot-safe"])).toEqual({
      query: "cash flow",
      limit: 25,
      botSafeOnly: true,
    });
  });

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
        argKind: "ticker-list",
        argPlaceholder: "tickers",
        keywords: ["compare", "price"],
        defaultSettings: {},
        capability: capabilityFor("comparison-chart-pane"),
      },
    ], "cash flow comparison");

    expect(matches.map(({ token }) => token)).toEqual(["GF", "CMP"]);
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

  test("rejects financial statement options on a price comparison", () => {
    const capability = capabilityFor("comparison-chart-pane");
    expect(() => normalizeCapabilityOptions(capability, {
      tab: "cashflow",
    })).toThrow("price-comparison does not support --tab");
  });
});
