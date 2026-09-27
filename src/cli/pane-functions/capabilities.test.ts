import { describe, expect, test } from "bun:test";
import { paneSchemas as chartSchemas } from "../../plugins/builtin/chart-composer/headless-schema";
import { paneSchemas as correlationSchemas } from "../../plugins/builtin/correlation/headless-schema";
import { paneSchemas as researchSchemas } from "../../plugins/builtin/research/headless-schema";
import { thirteenFHeadless } from "../../plugins/builtin/thirteenf/headless";
import { paneSchemas as tickerSchemas } from "../../plugins/builtin/ticker-detail/headless-schema";
import type { HeadlessPaneDefinition } from "../../types/headless";
import { parseCliGlobalArgs } from "../options";
import {
  capabilityPluginState,
  getPaneFunctionCapability,
  isDataPaneForDomFallback,
  normalizeCapabilityOptions,
} from "./capabilities";
import { filterPaneCatalogEntries, renderPaneCatalogReport } from "./catalog";
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
