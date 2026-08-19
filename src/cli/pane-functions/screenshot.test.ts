import { describe, expect, test } from "bun:test";
import type { RemoteUiNodeSnapshot } from "../../remote/types";
import {
  chartSeriesEvidenceWithinRange,
  chartEvidenceMismatchesFor,
  missingActiveTabSelections,
  shotDataEvidenceFor,
  shotExpectedText,
  shotPriceHistoryRange,
  shotSemanticRowCount,
  shotUnavailableSymbols,
  type PaneScreenshotExpectedChartEvidence,
  type PaneScreenshotExpectedSelection,
} from "./screenshot";
import { collectShotSymbols } from "./data";
import type { DesktopPaneShotPayload } from "../desktop-pane-shot";
import type { ResolvedPaneFunction } from "./resolver";
import { buildCustomChartPreset } from "../../plugins/builtin/chart-composer/presets";
import { CHART_COMPOSER_PANE_ID } from "../../types/config";

describe("pane screenshot active-state verification", () => {
  const expected: PaneScreenshotExpectedSelection[] = [
    { control: "statement", label: "Cash Flow" },
    { control: "period", value: "annual" },
  ];

  test("accepts selections confirmed by the rendered semantic tab state", () => {
    expect(missingActiveTabSelections(renderedTabs("1", "annual"), expected)).toEqual([]);
  });

  test("rejects labels that are visible but not active", () => {
    expect(missingActiveTabSelections(renderedTabs("0", "quarterly"), expected))
      .toEqual(expected);
  });
});

describe("pane screenshot chart-data verification", () => {
  const expected: PaneScreenshotExpectedChartEvidence = {
    kind: "price-comparison",
    symbols: ["AAPL", "NVDA"],
    rangePreset: "1Y",
    axisMode: "percent",
    resolution: "1d",
    sourceSeries: [
      {
        symbol: "AAPL",
        pointCount: 2,
        first: { date: "2025-07-17T00:00:00.000Z", close: 100 },
        last: { date: "2026-07-18T00:00:00.000Z", close: 150 },
        projectionBaseValue: 110,
        projectionLatestRawValue: 150,
        projectionLatestValue: 36.36363636363637,
      },
      {
        symbol: "NVDA",
        pointCount: 2,
        first: { date: "2025-07-17T00:00:00.000Z", close: 200 },
        last: { date: "2026-07-18T00:00:00.000Z", close: 220 },
        projectionBaseValue: 205,
        projectionLatestRawValue: 220,
        projectionLatestValue: 7.317073170731708,
      },
    ],
  };

  test("accepts exact rendered comparison inputs and projection values", () => {
    expect(chartEvidenceMismatchesFor(renderedComparisonChart(), expected)).toEqual([]);
  });

  test("fetches the requested comparison range instead of a coarser five-year series", () => {
    expect(shotPriceHistoryRange(resolved("price-comparison", { rangePreset: "1Y" })))
      .toBe("1Y");
  });

  test("matches the exact chart window when the latest point is later in the day", () => {
    expect(chartSeriesEvidenceWithinRange("MSFT", [
      { date: new Date("2021-07-22T13:30:00.000Z"), close: 286.14 },
      { date: new Date("2021-07-23T13:30:00.000Z"), close: 289.67 },
      { date: new Date("2026-07-22T18:39:00.000Z"), close: 505.12 },
    ], "5Y")).toEqual({
      symbol: "MSFT",
      pointCount: 2,
      first: { date: "2021-07-23T13:30:00.000Z", close: 289.67 },
      last: { date: "2026-07-22T18:39:00.000Z", close: 505.12 },
    });
  });

  test("rejects a wrong range or rendered value even when symbols are visible", () => {
    const nodes = renderedComparisonChart();
    nodes[0]!.metadata!.rangePreset = "3M";
    (nodes[0]!.metadata!.projectionSeries as Array<Record<string, unknown>>)[0]!.latestRawValue = 149;
    expect(chartEvidenceMismatchesFor(nodes, expected)).toEqual([
      "rendered chart range does not match",
      "AAPL comparison latest value does not match",
    ]);
  });

  test("accepts resolved mixed-source composer evidence", () => {
    const expectedComposer: PaneScreenshotExpectedChartEvidence = {
      kind: "chart-composer",
      symbols: ["AAPL", "MSFT"],
      rangePreset: "5Y",
      resolution: "auto",
      baseSeries: [
        {
          id: "aapl-price",
          sourceKind: "security",
          symbol: "AAPL",
          fieldId: "market.ohlcv",
          style: "candles",
          transform: "raw",
          panelId: "main",
          visible: true,
        },
        {
          id: "msft-revenue",
          sourceKind: "security",
          symbol: "MSFT",
          fieldId: "fundamental.totalRevenue",
          style: "step",
          transform: "raw",
          panelId: "main",
          visible: true,
        },
        {
          id: "cpi",
          sourceKind: "economic",
          economicSeriesId: "CPIAUCSL",
          style: "step",
          transform: "raw",
          panelId: "macro",
          visible: true,
        },
        {
          id: "prediction",
          sourceKind: "capability",
          capabilityId: "prediction-markets.series",
          providerSeriesId: "polymarket/event-1/market-1",
          first: { date: "2026-01-01T00:00:00.000Z", value: 0.4 },
          last: { date: "2026-01-02T00:00:00.000Z", value: 0.6 },
          style: "area",
          transform: "raw",
          panelId: "prediction",
          visible: true,
        },
      ],
    };
    const metadata = {
      ...expectedComposer,
      projectedPointCount: 42,
      baseSeries: expectedComposer.baseSeries?.map((series) => ({ ...series, pointCount: 12 })),
    };
    const semanticUi = [{
      id: "chart-composer-data",
      role: "chart-data" as const,
      actions: [],
      metadata,
    }];
    expect(chartEvidenceMismatchesFor(semanticUi, expectedComposer)).toEqual([]);

    const wrong = structuredClone(semanticUi);
    (wrong[0]!.metadata.baseSeries![3]!.last as { value: number }).value = 0.7;
    expect(chartEvidenceMismatchesFor(wrong, expectedComposer))
      .toContain("rendered chart series prediction does not match");
  });
});

describe("pane screenshot chart-composer inputs", () => {
  test("loads security symbols from the parsed chart spec instead of treating the expression as one ticker", () => {
    const rawArg = "AAPL:price, MSFT:revenue, 3HNX:LSE:revenue, FRED:CPIAUCSL";
    const chart = {
      pane: { id: CHART_COMPOSER_PANE_ID },
      instance: { settings: { chartSpec: buildCustomChartPreset(rawArg) } },
      createOptions: { arg: rawArg },
    } as unknown as ResolvedPaneFunction;

    expect(collectShotSymbols(chart, rawArg)).toEqual(["AAPL", "MSFT", "3HNX:XLON"]);
  });

  test("uses rendered composer series for FRED-only screenshot readiness", () => {
    const composer = resolved("chart-composer", {});
    const semanticUi: RemoteUiNodeSnapshot[] = [{
      id: "chart-composer-data",
      role: "chart-data",
      actions: [],
      metadata: {
        kind: "chart-composer",
        baseSeries: [{
          sourceKind: "economic",
          economicSeriesId: "CPIAUCSL",
          pointCount: 12,
        }],
      },
    }];

    expect(shotSemanticRowCount(composer, payload([]), semanticUi)).toBe(12);
    expect(shotUnavailableSymbols(composer, payload([]), semanticUi)).toEqual([]);
  });

  test("accepts capability-backed composer evidence and reports an empty provider series", () => {
    const composer = resolved("chart-composer", {});
    const populated: RemoteUiNodeSnapshot[] = [{
      id: "chart-composer-data",
      role: "chart-data",
      actions: [],
      metadata: {
        kind: "chart-composer",
        baseSeries: [{
          sourceKind: "capability",
          capabilityId: "prediction-markets.series",
          providerSeriesId: "polymarket:one",
          pointCount: 5,
        }],
      },
    }];
    expect(shotSemanticRowCount(composer, payload([]), populated)).toBe(5);
    expect(shotUnavailableSymbols(composer, payload([]), populated)).toEqual([]);

    const empty = structuredClone(populated);
    (empty[0]!.metadata as any).baseSeries[0].pointCount = 0;
    expect(shotUnavailableSymbols(composer, payload([]), empty))
      .toEqual(["CAP:prediction-markets.series:polymarket:one"]);
  });

  test("expects the composer legend short label, not the catalog metric label", () => {
    const valuation = {
      ...resolved("valuation-series", { metric: "priceSales", period: "annual" }),
      pane: { id: CHART_COMPOSER_PANE_ID },
    } as unknown as ResolvedPaneFunction;

    expect(shotExpectedText(valuation, ["AAPL"], payload([]))).toEqual(["AAPL", "P/S"]);
  });

  test("reports an empty FRED composer source as unavailable", () => {
    const semanticUi: RemoteUiNodeSnapshot[] = [{
      id: "chart-composer-data",
      role: "chart-data",
      actions: [],
      metadata: {
        kind: "chart-composer",
        baseSeries: [{
          sourceKind: "economic",
          economicSeriesId: "UNRATE",
          pointCount: 0,
        }],
      },
    }];

    expect(shotUnavailableSymbols(resolved("chart-composer", {}), payload([]), semanticUi))
      .toEqual(["FRED:UNRATE"]);
  });
});

describe("pane screenshot structured data evidence", () => {
  test("captures the exact single-price series rendered by a price chart", () => {
    const evidence = shotDataEvidenceFor(
      resolved("price-chart", { rangePreset: "3M" }),
      payload([["AAPL", {
        priceHistory: [
          { date: "2026-04-01", close: 100 },
          { date: "2026-07-01", close: 125 },
        ],
      }]]),
    );

    expect(evidence).toEqual({
      kind: "price-series",
      symbol: "AAPL",
      range: "3M",
      pointCount: 2,
      first: { date: "2026-04-01T00:00:00.000Z", close: 100 },
      last: { date: "2026-07-01T00:00:00.000Z", close: 125 },
    });
  });

  test("captures the exact comparison projection inputs and return", () => {
    const evidence = shotDataEvidenceFor(
      resolved("price-comparison", { rangePreset: "1Y", axisMode: "percent" }),
      payload([
        ["AAPL", {
          priceHistory: [
            { date: "2025-07-01", close: 100 },
            { date: "2026-07-01", close: 150 },
          ],
        }],
        ["NVDA", {
          priceHistory: [
            { date: "2025-07-01", close: 200 },
            { date: "2026-07-01", close: 220 },
          ],
        }],
      ]),
    );

    expect(evidence).toEqual({
      kind: "price-comparison",
      symbols: ["AAPL", "NVDA"],
      range: "1Y",
      series: [
        {
          symbol: "AAPL",
          base: { date: "2025-07-01T00:00:00.000Z", value: 100 },
          latest: { date: "2026-07-01T00:00:00.000Z", value: 150 },
          returnPercent: 50,
        },
        {
          symbol: "NVDA",
          base: { date: "2025-07-01T00:00:00.000Z", value: 200 },
          latest: { date: "2026-07-01T00:00:00.000Z", value: 220 },
          returnPercent: 10,
        },
      ],
    });
  });

  test("captures rendered fundamental rows and headline statement values", () => {
    const financials = {
      priceHistory: [],
      annualStatements: [
        {
          date: "2025-01-31",
          totalRevenue: 100,
          operatingCashFlow: 30,
          capitalExpenditure: -10,
          freeCashFlow: 20,
        },
        {
          date: "2026-01-31",
          totalRevenue: 120,
          operatingCashFlow: 42,
          capitalExpenditure: -12,
          freeCashFlow: 30,
        },
      ],
      quarterlyStatements: [],
    };
    const graphEvidence = shotDataEvidenceFor(
      resolved("fundamental-series", {
        metric: "operatingCashFlow",
        period: "annual",
        periods: 2,
      }),
      payload([["NVDA", financials]]),
    );
    expect(graphEvidence).toEqual({
      kind: "fundamental-series",
      metric: "operatingCashFlow",
      period: "annual",
      series: [{
        symbol: "NVDA",
        rows: [
          { date: "2025-01-31", value: 30 },
          { date: "2026-01-31", value: 42 },
        ],
      }],
    });

    const statementEvidence = shotDataEvidenceFor(
      resolved("financial-statements", { statement: "cashflow", period: "annual" }),
      payload([["NVDA", financials]]),
    );
    expect(statementEvidence).toMatchObject({
      kind: "financial-statement",
      symbol: "NVDA",
      statement: "cashflow",
      period: "annual",
      latest: {
        date: "2026-01-31",
        metrics: expect.arrayContaining([
          expect.objectContaining({ key: "operatingCashFlow", value: 42 }),
          expect.objectContaining({ key: "capitalExpenditure", value: -12 }),
          expect.objectContaining({ key: "freeCashFlow", value: 30 }),
        ]),
      },
    });
  });
});

function resolved(
  capabilityId: string,
  options: Record<string, string | number>,
): ResolvedPaneFunction {
  return {
    capability: { id: capabilityId },
    options,
  } as unknown as ResolvedPaneFunction;
}

function payload(
  financials: Array<[string, Record<string, unknown>]>,
): DesktopPaneShotPayload {
  return {
    financials: financials.map(([symbol, value]) => [
      symbol,
      {
        quote: null,
        fundamentals: null,
        profile: null,
        annualStatements: [],
        quarterlyStatements: [],
        priceHistory: [],
        ...value,
      },
    ]),
  } as unknown as DesktopPaneShotPayload;
}

function renderedTabs(statement: string, period: string): RemoteUiNodeSnapshot[] {
  return [
    {
      id: "statements",
      role: "tabs",
      actions: [],
      metadata: {
        activeValue: statement,
        tabs: [
          { label: "Income", value: "0" },
          { label: "Cash Flow", value: "1" },
          { label: "Balance Sheet", value: "2" },
        ],
      },
    },
    {
      id: "period",
      role: "tabs",
      actions: [],
      metadata: {
        activeValue: period,
        tabs: [
          { label: "Annual", value: "annual" },
          { label: "Quarterly", value: "quarterly" },
        ],
      },
    },
  ];
}

function renderedComparisonChart(): RemoteUiNodeSnapshot[] {
  return [{
    id: "comparison-chart-data",
    role: "chart-data",
    actions: [],
    metadata: {
      kind: "price-comparison",
      symbols: ["AAPL", "NVDA"],
      rangePreset: "1Y",
      selectedResolution: "1d",
      effectiveResolution: "1d",
      requestedAxisMode: "percent",
      effectiveAxisMode: "percent",
      sourceSeries: [
        {
          symbol: "AAPL",
          pointCount: 2,
          first: { date: "2025-07-17T00:00:00.000Z", close: 100 },
          last: { date: "2026-07-18T00:00:00.000Z", close: 150 },
        },
        {
          symbol: "NVDA",
          pointCount: 2,
          first: { date: "2025-07-17T00:00:00.000Z", close: 200 },
          last: { date: "2026-07-18T00:00:00.000Z", close: 220 },
        },
      ],
      projectedPointCount: 2,
      projectionSeries: [
        {
          symbol: "AAPL",
          baseValue: 110,
          latestRawValue: 150,
          latestValue: 36.36363636363637,
          pointCount: 2,
        },
        {
          symbol: "NVDA",
          baseValue: 205,
          latestRawValue: 220,
          latestValue: 7.317073170731708,
          pointCount: 2,
        },
      ],
    },
  }];
}
