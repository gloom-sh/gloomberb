import { chartHeadless } from "../../plugins/builtin/chart-composer/headless";
import { afterEach, expect, test } from "bun:test";
import { createDefaultConfig } from "../../types/config";
import { CHART_SPEC_VERSION, type ChartSpec } from "../../time-series/types";
import { createTestDataProvider } from "../../test-support/data-provider";
import { setSharedRegistryForTests } from "../../plugins/registry";
import {
  buildFunctionReport,
  resolvePaneFunctionReportSource,
} from "./report";
import type { ResolvedPaneFunction } from "./resolver";
import { emptySeriesExport } from "./index";
import type { MarketContext } from "../types";

const spec: ChartSpec = {
  version: CHART_SPEC_VERSION,
  viewport: { range: "1M", resolution: "auto" },
  panels: [{ id: "main" }],
  series: [{
    id: "prediction",
    source: { kind: "capability", capabilityId: "prediction.series", seriesId: "market-one" },
    style: "area",
    transform: "raw",
    axis: "auto",
    panelId: "main",
    interpolation: "none",
  }],
  studies: [],
};

afterEach(() => setSharedRegistryForTests(undefined));

test("selects declared headless models and rendered DOM fallback without special capability IDs", () => {
  const base = {
    pane: { id: "market-data", name: "Market Data" },
    template: undefined,
    instance: {},
    capability: { id: "market-data", reportReadiness: "live-dom" },
  } as unknown as ResolvedPaneFunction;

  expect(resolvePaneFunctionReportSource(base)).toBe("dom");
  expect(resolvePaneFunctionReportSource({
    ...base,
    capability: { ...base.capability, id: "quote-comparison" },
  })).toBe("dom");
  expect(resolvePaneFunctionReportSource({
    ...base,
    capability: { ...base.capability, id: "quote-comparison" },
    headless: {
      shape: "rows",
      argument: { kind: "none" },
      options: [],
      load: () => ({ rows: [] }),
    },
  })).toBe("headless");
});

test("chart composer reports accept capability-backed series", async () => {
  const date = new Date(Date.now() - 24 * 60 * 60 * 1_000);
  setSharedRegistryForTests({
    capabilityManifests: () => [{
      id: "prediction.series",
      kind: "chart-series",
      name: "Prediction",
      operations: [{ id: "resolve", kind: "query", rendererSafe: true }],
    }],
    invokeCapability: async () => ({
      id: "provider-id",
      label: "Prediction",
      color: "#fff",
      unit: "probability",
      unitGroup: "probability",
      nativeFrequency: "daily",
      dataShape: "scalar",
      style: "line",
      transform: "raw",
      axis: "left",
      panelId: "main",
      interpolation: "none",
      points: [{ date, observedAt: date, value: 0.62 }],
    }),
  } as any);
  const resolved = {
    token: "chart-composer",
    headless: chartHeadless("chart-composer-pane"),
    options: {},
    label: "Chart Composer",
    description: "",
    pane: { id: "chart-composer", name: "Chart Composer" },
    instance: { settings: { chartSpec: spec } },
    capability: { id: "chart-composer", reportReadiness: "ready" },
  } as unknown as ResolvedPaneFunction;
  const context = {
    config: createDefaultConfig("/tmp/gloomberb-chart-report"),
    dataProvider: createTestDataProvider(),
    store: { loadTicker: async () => null },
  } as unknown as MarketContext;

  const report = await buildFunctionReport(resolved, context, "");
  expect(report.data).toMatchObject({
    kind: "series",
    complete: true,
    empty: false,
    unavailableSymbols: [],
    rowCount: 1,
  });
  expect(report.text).toContain("Prediction");
});

test("HELP has no report and sends a newcomer to the command guide and the function catalog", async () => {
  const resolved = (id: string) => ({
    token: id, pane: { id, name: id }, template: undefined, instance: {}, capability: { id, reportReadiness: "none" },
  }) as unknown as ResolvedPaneFunction;
  const context = { config: createDefaultConfig("/tmp/gloomberb-help-report-test"), dataProvider: createTestDataProvider() } as unknown as MarketContext;
  const message = (id: string) => buildFunctionReport(resolved(id), context, "").catch((error: Error) => error.message);
  const help = await message("help");
  expect(help).toContain("`gloom help`");
  expect(help).toContain("`gloom catalog`");
  // Another interactive pane points to the screenshot that draws it, with its argument.
  const shot = (id: string) => buildFunctionReport({ ...resolved(id), capability: { id, screenshotReadiness: "live-dom" } } as unknown as ResolvedPaneFunction, context, "santander")
    .catch((error: Error) => error.message);
  expect(await shot("CAT")).toContain("`gloom shot CAT santander`");
  expect(await message("chat")).not.toContain("gloom shot");
});

test("a series export with no rows says what was asked, and a FRED id given as a ticker gets the fred: prefix", () => {
  const fred = new Set(["DEXSFUS"]);
  expect(emptySeriesExport("G", "DEXSFUS", { unavailableSymbols: ["DEXSFUS"], errors: ["dexsfus-market-ohlcv-1: Not a ticker: DEXSFUS."] }, fred)).toEqual({
    message: "fn G DEXSFUS has no data to export: DEXSFUS is a FRED series, not a ticker.",
    details: "Chart it with the fred: prefix: gloom fn G fred:DEXSFUS --csv (or gloom fred DEXSFUS --csv).",
  });
  // Anything else repeats why, without the series id the error was filed under.
  expect(emptySeriesExport("G", "ZZZZQX", { unavailableSymbols: ["ZZZZQX"], errors: ["zzzzqx-market-ohlcv-1: Not a ticker: ZZZZQX."] }, fred, "--ndjson")).toEqual({
    message: "fn G ZZZZQX has no data to export for ZZZZQX.",
    details: "Not a ticker: ZZZZQX.\nCheck the symbol with gloom search, or run gloom fn G ZZZZQX without --ndjson to see the report.",
  });
});
