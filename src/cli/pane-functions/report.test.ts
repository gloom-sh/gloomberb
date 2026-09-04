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

test("selects headless before legacy reports and rendered DOM fallback", () => {
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
  })).toBe("report");
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
    kind: "chart-composer",
    complete: true,
    empty: false,
    unavailableSymbols: [],
    rowCount: 1,
  });
  expect(report.text).toContain("Prediction");
});
