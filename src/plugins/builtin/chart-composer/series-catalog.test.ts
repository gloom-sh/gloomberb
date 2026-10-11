import { describe, expect, test } from "bun:test";
import {
  analyzeSeriesSearchQuery,
  buildCapabilitySeriesSuggestions,
  buildSeriesCatalogSuggestions,
} from "./series-catalog";
import { seriesCatalogEntry } from "../../../series/registry";
import { FUTURES_SERIES } from "../futures/series";
import { TREASURY_SERIES } from "../yield-curve/series";

const AAPL = { symbol: "AAPL", exchange: "NASDAQ", name: "Apple Inc." };

describe("chart composer series catalog", () => {
  test("maps provider catalog metadata without provider-specific core branches", () => {
    expect(buildCapabilitySeriesSuggestions([{
      capabilityId: "custom.series",
      capabilityName: "Custom Provider",
      seriesId: "series-1",
      label: "Custom history",
      style: "step",
    }])[0]).toMatchObject({
      label: "Custom history",
      detail: "Custom Provider",
      expression: {
        kind: "capability",
        capabilityId: "custom.series",
        seriesId: "series-1",
        style: "step",
      },
    });
  });

  test("maps a metric-only query onto the current security", () => {
    const suggestions = buildSeriesCatalogSuggestions("revenue", AAPL);

    expect(suggestions[0]).toMatchObject({
      label: "AAPL:XNAS · Revenue",
      expression: {
        kind: "security",
        symbol: "AAPL",
        exchange: "NASDAQ",
        fieldId: "fundamental.totalRevenue",
      },
    });
  });

  test("understands a ticker and human metric name without source syntax", () => {
    const suggestions = buildSeriesCatalogSuggestions("MSFT free cash flow", AAPL);

    expect(suggestions[0]).toMatchObject({
      label: "MSFT · Free Cash Flow",
      expression: {
        kind: "security",
        symbol: "MSFT",
        fieldId: "fundamental.freeCashFlow",
      },
    });
  });

  test("separates company text from the requested metric for provider autocomplete", () => {
    expect(analyzeSeriesSearchQuery("Apple gross margin")).toEqual({
      directInstrument: null,
      instrumentQuery: "apple",
      metricQuery: "Gross Margin",
    });

    const suggestions = buildSeriesCatalogSuggestions(
      "Apple gross margin",
      AAPL,
      [{ symbol: "AAPL", exchange: "NASDAQ", name: "Apple Inc." }],
    );
    expect(suggestions[0]?.expression).toMatchObject({
      symbol: "AAPL",
      fieldId: "fundamental.grossMargin",
    });
  });

  test("suggests registered catalog series by name, and fills a ticker series in for the chart's ticker", () => {
    const registered = [
      ...[...FUTURES_SERIES, ...TREASURY_SERIES].map((definition) => seriesCatalogEntry({ definition, pluginId: "builtin" })),
      seriesCatalogEntry({ pluginId: "invented", definition: {
        id: "invented:widget-orders", name: "Widget orders", unit: "count", frequency: "weekly", group: "Economy",
        load: () => [],
      } }),
      seriesCatalogEntry({ pluginId: "invented", definition: {
        id: "invented:lending", name: "Securities lending fee", unit: "%", frequency: "daily", group: "Positioning",
        input: "ticker", load: () => [],
      } }),
    ];
    const suggest = (query: string) => buildSeriesCatalogSuggestions(query, AAPL, [], 8, registered);
    expect(suggest("e-mini s&p")[0]).toMatchObject({
      label: "FUT:ES · E-Mini S&P 500",
      expression: {
        kind: "security",
        symbol: "ES=F",
        fieldId: "market.ohlcv",
      },
    });
    // The typed expression leads, and its catalog entry is not listed twice.
    const treasury = suggest("UST:10Y");
    expect(treasury[0]).toMatchObject({
      label: "10Y Treasury Yield",
      expression: {
        kind: "economic",
        provider: "fred",
        seriesId: "DGS10",
      },
    });
    expect(treasury.filter((entry) => entry.id === "fred:DGS10")).toHaveLength(1);
    expect(suggest("widget orders")[0]).toMatchObject({
      label: "Widget orders",
      expression: { kind: "capability", capabilityId: "invented", seriesId: "widget-orders" },
    });
    expect(suggest("MSFT lending fee")[0]).toMatchObject({
      label: "MSFT · Securities lending fee",
      expression: { kind: "capability", capabilityId: "invented", seriesId: "lending/MSFT" },
    });
  });

  test("keeps direct FRED IDs available for advanced sources", () => {
    expect(buildSeriesCatalogSuggestions("FRED:CPIAUCSL", AAPL)[0]).toMatchObject({
      label: "FRED · CPIAUCSL",
      expression: {
        kind: "economic",
        provider: "fred",
        seriesId: "CPIAUCSL",
      },
    });
  });
});
