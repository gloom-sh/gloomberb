import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { setCloudApiFetchTransport } from "../../../api-client";
import type { RevenueBreakdownPayload } from "../../../api-client/revenue-breakdown";
import { PaneFooterBar, PaneFooterProvider } from "../../../components/layout/pane/footer";
import { renderedReportNotices } from "../../../cli/pane-functions/report-notices";
import { createRemoteUiRegistry, RemoteUiRegistryProvider } from "../../../remote/semantic-tree";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { createInitialState } from "../../../state/app/context";
import { createTestPaneConfig, createTestTicker, TestPaneProvider } from "../../../test-support/pane";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { Box } from "../../../ui";
import { revenueBreakdownCache } from "./client";
import { RevenueBreakdownPane } from "./pane";

const periods = [
  { end: "2025-06-30", fiscalYear: 2025, fiscalQuarter: 3 },
  { end: "2025-09-30", fiscalYear: 2025, fiscalQuarter: 4 },
  { end: "2025-12-31", fiscalYear: 2026, fiscalQuarter: 1 },
  { end: "2026-03-31", fiscalYear: 2026, fiscalQuarter: 2 },
  { end: "2026-06-30", fiscalYear: 2026, fiscalQuarter: 3 },
];
const preview: RevenueBreakdownPayload = {
  symbol: "AAPL",
  cik: "0000320193",
  currency: "USD",
  view: "product",
  views: ["product", "segment"],
  periods,
  total: [94.0e9, 102.5e9, 143.8e9, 111.2e9, 109.4e9],
  rows: [
    { key: "p:IPhone", label: "iPhone", values: [44.6e9, 49.0e9, 85.3e9, 57.0e9, 54.3e9], ttm: 245.5e9, yoy: 0.217, share: 0.496 },
    { key: "p:Service", label: "Services", values: [27.4e9, 28.8e9, 30.0e9, 31.0e9, 30.7e9], ttm: 120.5e9, yoy: 0.121, share: 0.281 },
  ],
  filed: "2026-07-31",
  access: "preview",
  lockedRows: 3,
};

const tui = createOpenTuiTestHarness();
afterEach(() => {
  setCloudApiFetchTransport(null);
  revenueBreakdownCache.reset();
});

async function mount(width = 110, height = 12, registry = createRemoteUiRegistry()) {
  revenueBreakdownCache.attach(new MemoryPluginPersistence());
  const paneId = "revenue-breakdown:test";
  const state = createInitialState(createTestPaneConfig("/tmp/revenue-breakdown-test", {
    paneId: "revenue-breakdown", instanceId: paneId, binding: { kind: "fixed", symbol: "AAPL" },
  }));
  state.tickers.set("AAPL", createTestTicker("AAPL", "Apple Inc.", { exchange: "NASDAQ" }));
  await tui.render(
    <RemoteUiRegistryProvider registry={registry}>
      <TestPaneProvider state={state} paneId={paneId} pluginId="ticker-research" runtime={createTestPluginRuntime()}>
        <PaneFooterProvider>{(footer) => (
          <Box width={width} height={height} flexDirection="column">
            <Box height={height - 1}><RevenueBreakdownPane paneId={paneId} paneType="revenue-breakdown" focused width={width} height={height - 1} /></Box>
            <PaneFooterBar footer={footer} focused width={width} />
          </Box>
        )}</PaneFooterProvider>
      </TestPaneProvider>
    </RemoteUiRegistryProvider>,
    { width, height },
  );
  for (let i = 0; i < 4; i++) await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await tui.setup().renderOnce();
  });
  return tui.frame();
}

test("a preview shows the two largest rows, locked rows and the upgrade key", async () => {
  setCloudApiFetchTransport(async () => Response.json(preview));
  const registry = createRemoteUiRegistry();
  const frame = await mount(110, 12, registry);
  expect(frame).toContain("iPhone");
  expect(frame).toContain("54.3B");
  expect(frame).toContain("+21.7%");
  expect(frame).toContain("Upgrade to see every product");
  expect(frame.match(/░{5}/g)?.length).toBeGreaterThan(4);
  expect(frame).toContain("[$]upgrade");
  expect(frame).toContain("filed 2026-07-31");
  expect(renderedReportNotices(registry.snapshot())).toEqual({
    notices: ["Preview: 3 rows held back (Gloom Pro)."], facts: { lockedRows: 3 },
  });
});

test("a company without a breakdown is empty, not failed", async () => {
  setCloudApiFetchTransport(async () => Response.json({ message: "no breakdown" }, { status: 404 }));
  const frame = await mount();
  expect(frame).toContain("No revenue breakdown.");
  expect(frame).not.toContain("[$]upgrade");
});

test("the header and filing footer keep the fiscal year from a trimmed annual column", async () => {
  const filing = { filed: "2025-11-25", url: "https://www1.hkexnews.hk/listedco/listconews/sehk/2025/1125/2025112501051.pdf", page: 17 };
  const reported: RevenueBreakdownPayload = {
    ...preview,
    cik: undefined,
    currency: "CNY",
    periods: [
      { kind: "annual", end: "2025-03-31", label: "Year ended 31 March 2025", revenueLabel: "Revenue", filing },
      { kind: "interim", end: "2025-09-30", label: "Six months ended 30 September 2025", revenueLabel: "Revenue", filing },
    ],
    rows: [{ ...preview.rows[0]!, values: [null, 272.65e9] }],
    total: [null, 272.65e9],
    access: "full",
    lockedRows: 0,
  };
  setCloudApiFetchTransport(async () => Response.json(reported));
  const frame = await mount();
  expect(frame).toMatch(/PRODUCT +H1 2026[^\n]*% TOTAL/);
  expect(frame).toContain("H1 2026 filed 2025-11-25");
});

test("hovering a quarter reads out its value, and an unreported one says so", async () => {
  const gapped = {
    ...preview,
    rows: preview.rows.map((row, index) => (index === 0 ? { ...row, values: [44.6e9, null, 85.3e9, 57.0e9, 54.3e9] } : row)),
  };
  setCloudApiFetchTransport(async () => Response.json(gapped));
  const frame = await mount();
  const lines = frame.split("\n");
  const y = lines.findIndex((line) => line.includes("iPhone"));
  const x = lines[y]!.indexOf("·");
  expect(x).toBeGreaterThan(0);
  const hoverAt = async (column: number, readout: string) => {
    await act(async () => tui.setup().mockMouse.moveTo(column, y));
    return tui.waitForFrameToContain(readout);
  };
  expect(await hoverAt(x, "iPhone  Q4 2025  not reported")).toContain("iPhone  Q4 2025  not reported");
  expect(await hoverAt(x + 2, "iPhone  Q1 2026  85.3B")).toContain("iPhone  Q1 2026  85.3B");
});
