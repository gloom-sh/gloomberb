import { expect, test } from "bun:test";
import { act, useState } from "react";
import { createOpenTuiTestHarness, settleFrame, takeSavedTextFile } from "../../../../renderers/opentui/test-utils";
import { createInitialState } from "../../../../state/app/context";
import { exportPaneTable } from "../../../../state/pane-table-export-registry";
import { createTestDataProvider } from "../../../../test-support/data-provider";
import { createTestHeadlessContext } from "../../../../test-support/headless";
import { createTestPaneConfig, createTestTicker, TestPaneProvider } from "../../../../test-support/pane";
import { createTestPluginRuntime } from "../../../../test-support/plugin-runtime";
import { renderHeadlessPaneText } from "../../../../cli/pane-functions/headless";
import { historicalPricesHeadless } from "../headless";
import { HistoricalPricesPane } from "./historical-prices";
import type { PricePoint } from "../../../../types/financials";

const tui = createOpenTuiTestHarness();

test("history exports retain listing ownership and active caveats through failed refresh and a pending listing switch", async () => {
  const paneId = "history:export-ownership";
  let selectListing!: (symbol: string) => void;
  let finishUs!: (points: PricePoint[]) => void;
  const us = new Promise<PricePoint[]>((resolve) => { finishUs = resolve; });
  const provider = createTestDataProvider({ getPriceHistory: async (symbol, _exchange, _range, context) => {
    if (symbol === "VOD:XNAS") return us;
    if (context?.cacheMode === "refresh") throw new Error("=provider, unavailable");
    return [{ date: new Date("2026-09-15"), open: 2, high: 1, low: 1.2, close: 1.31 }];
  } });
  const runtime = createTestPluginRuntime({ getMarketData: () => provider });
  function Harness() {
    const [symbol, setSymbol] = useState("VOD:XLON");
    selectListing = setSymbol;
    const state = createInitialState(createTestPaneConfig("/tmp/gloom-history-export-unused", {
      instanceId: paneId, paneId: "historical-prices", binding: { kind: "fixed", symbol },
    }));
    state.tickers.set(symbol, createTestTicker(symbol));
    return <TestPaneProvider state={state} paneId={paneId} pluginId="ticker-research" runtime={runtime}>
      <HistoricalPricesPane paneId={paneId} paneType="historical-prices" focused width={120} height={14} />
    </TestPaneProvider>;
  }
  await act(async () => { await tui.render(<Harness />, { width: 120, height: 14 }); });
  await settleFrame(tui.setup(), 8);
  const exportCsv = async () => {
    await exportPaneTable(paneId, "history.csv");
    return takeSavedTextFile()!.text;
  };
  const initial = await exportCsv();
  expect(initial).toContain("Ticker,VOD:XLON");
  expect(initial).toContain("Warning,");
  expect(initial).toContain("2026-09-15");
  await act(async () => { tui.setup().mockInput.pressKey("r"); });
  await settleFrame(tui.setup(), 8);
  const retained = await exportCsv();
  expect(retained).toContain("2026-09-15");
  expect(retained).toContain("Retained after refresh failure");
  expect(retained).toContain('Error,"\'=provider, unavailable"');
  await act(async () => { selectListing("VOD:XNAS"); });
  await settleFrame(tui.setup(), 3);
  const pending = await exportCsv();
  expect(pending).toContain("Ticker,VOD:XNAS");
  expect(pending).toContain("Status,Loading");
  expect(pending).not.toContain("2026-09-15");
  expect(pending).not.toContain("Warning,");
  expect(pending).not.toContain("Error,");
  await act(async () => { finishUs([{ date: new Date("2026-09-16"), close: 17.56 }]); });
  await settleFrame(tui.setup(), 3);
  const current = await exportCsv();
  expect(current).toContain("17.56");
  expect(current).toContain("Ticker,VOD:XNAS");
  expect(current).not.toContain("VOD:XLON");
  expect(current).toContain("Status,Available");
});

for (const [symbol, prior, close, change] of [
  ["NG=F", 3.124, 3.125, null],
  ["RB=F", 2.1233, 2.1234, null],
  ["6J=F", .006282, .0062825, null],
  // Tiny crypto prices keep a negative change inside the numeric columns too.
  ["SHIB-USD:CCC", 0.00000532, 0.00000529, "-0.00000003"],
] as const) {
  test(`${symbol}: history without instrument metadata keeps OHLC precision in pane, CSV and report`, async () => {
    const high = Math.max(prior, close);
    const low = Math.min(prior, close);
    const points = [
      { date: new Date("2026-09-08"), close: prior },
      { date: new Date("2026-09-09"), open: prior, high, low, close, volume: 0 },
      { date: new Date("2026-09-10"), close: NaN },
      { date: new Date("2026-09-11"), close: 0 },
    ];
    const provider = createTestDataProvider({ getPriceHistory: async () => points });
    const paneId = "history:precision";
    const config = createTestPaneConfig("/tmp/gloom-history-precision-unused", {
      instanceId: paneId, paneId: "historical-prices", binding: { kind: "fixed", symbol },
    });
    const state = createInitialState(config);
    state.tickers.set(symbol, createTestTicker(symbol));
    const runtime = createTestPluginRuntime({ getMarketData: () => provider });
    await act(async () => {
      await tui.render(
        <TestPaneProvider state={state} paneId={paneId} pluginId="ticker-research" runtime={runtime}>
          <HistoricalPricesPane paneId={paneId} paneType="historical-prices" focused width={120} height={14} />
        </TestPaneProvider>, { width: 120, height: 14 },
      );
    });
    await settleFrame(tui.setup(), 8);
    expect(tui.frame()).toContain(String(close));
    expect(tui.frame()).toContain(String(prior));
    if (change) expect(tui.frame()).toContain(change);
    await exportPaneTable(paneId, "history.csv");
    const csv = takeSavedTextFile()!.text;
    expect(csv).toContain(String(close));
    expect(csv).toContain(String(prior));

    const args = { symbols: [symbol], argument: [symbol], rawArgument: symbol, options: { range: "ALL" } };
    const result = await historicalPricesHeadless.load(args, createTestHeadlessContext({ marketData: provider }));
    expect(result.rows[1]).toMatchObject({ open: prior, high, low, close, volume: 0 });
    expect(result.rows[2]!.close).toBeNull();
    expect(result.rows[3]!.close).toBe(0);
    const text = renderHeadlessPaneText(historicalPricesHeadless, result, args, "Historical Prices");
    expect(text).toContain(String(close));
    expect(text).toContain(String(prior));
    expect(Number.isNaN(points[2]!.close)).toBe(true);
  });
}
