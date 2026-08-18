import { describe, expect, test } from "bun:test";
import {
  analyzeSeriesSearchQuery,
  buildCapabilitySeriesSuggestions,
  buildSeriesCatalogSuggestions,
} from "./series-catalog";

const AAPL = { symbol: "AAPL", exchange: "NASDAQ", name: "Apple Inc." };

describe("chart composer series catalog", () => {
  test("maps provider catalog metadata without provider-specific core branches", () => {
    expect(buildCapabilitySeriesSuggestions([{
      capabilityId: "custom.series",
      capabilityName: "Custom Provider",
      seriesId: "series-1",
      label: "Custom history",
      parameters: { contract: "one" },
      style: "step",
    }])[0]).toMatchObject({
      label: "Custom history",
      detail: "Custom Provider",
      expression: {
        kind: "capability",
        capabilityId: "custom.series",
        seriesId: "series-1",
        parameters: { contract: "one" },
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
