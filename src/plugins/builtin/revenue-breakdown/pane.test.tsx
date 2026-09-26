import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { setCloudApiFetchTransport } from "../../../api-client";
import type { RevenueBreakdownPayload } from "../../../api-client/revenue-breakdown";
import { PaneFooterBar, PaneFooterProvider } from "../../../components/layout/pane/footer";
import { testRender } from "../../../renderers/opentui/test-utils";
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

let setup: Awaited<ReturnType<typeof testRender>> | undefined;
afterEach(async () => {
  if (setup) await act(async () => setup!.renderer.destroy());
  setup = undefined;
  setCloudApiFetchTransport(null);
  revenueBreakdownCache.reset();
});

async function mount(width = 110, height = 12) {
  revenueBreakdownCache.attach(new MemoryPluginPersistence());
  const paneId = "revenue-breakdown:test";
  const state = createInitialState(createTestPaneConfig("/tmp/revenue-breakdown-test", {
    paneId: "revenue-breakdown", instanceId: paneId, binding: { kind: "fixed", symbol: "AAPL" },
  }));
  state.tickers.set("AAPL", createTestTicker("AAPL", "Apple Inc.", { exchange: "NASDAQ" }));
  setup = await testRender(
    <TestPaneProvider state={state} paneId={paneId} pluginId="ticker-research" runtime={createTestPluginRuntime()}>
      <PaneFooterProvider>{(footer) => (
        <Box width={width} height={height} flexDirection="column">
          <Box height={height - 1}><RevenueBreakdownPane focused width={width} height={height - 1} /></Box>
          <PaneFooterBar footer={footer} focused width={width} />
        </Box>
      )}</PaneFooterProvider>
    </TestPaneProvider>,
    { width, height },
  );
  for (let i = 0; i < 4; i++) await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await setup!.renderOnce();
  });
  return setup.captureCharFrame();
}

test("a preview shows the two largest rows, locked rows and the upgrade key", async () => {
  setCloudApiFetchTransport(async () => Response.json(preview));
  const frame = await mount();
  expect(frame).toContain("iPhone");
  expect(frame).toContain("54.3B");
  expect(frame).toContain("+21.7%");
  expect(frame).toContain("Upgrade to see every product");
  expect(frame.match(/░{5}/g)?.length).toBeGreaterThan(4);
  expect(frame).toContain("[$]upgrade");
  expect(frame).toContain("filed 2026-07-31");
});

test("a company without a breakdown is empty, not failed", async () => {
  setCloudApiFetchTransport(async () => Response.json({ message: "no breakdown" }, { status: 404 }));
  const frame = await mount();
  expect(frame).toContain("No revenue breakdown.");
  expect(frame).not.toContain("[$]upgrade");
});
