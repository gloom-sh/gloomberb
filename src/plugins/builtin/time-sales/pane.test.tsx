import { expect, test } from "bun:test";
import { act } from "react";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { createInitialState } from "../../../state/app/context";
import { TestPaneFrame, createTestPaneConfig, createTestTicker } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { tapeFixture } from "./test-fixture";
import { createSnapshotTapeClient } from "./snapshot-client";
import { TimeSalesPane } from "./pane";
import { TapeClientContext } from "./use-tape";

const tui = createOpenTuiTestHarness();

async function render(tab: "trades" | "quotes", width = 100, { tradePrice = 343.4551, sessionLow = 340.46 } = {}): Promise<string> {
  const data = tapeFixture();
  // A mid-point print in the window sets the trades' decimals to four; the NBBO's bid and ask stay at cents.
  data.trades[0]!.price = tradePrice;
  data.quotes = [{ ...data.quotes[0]!, bid: 342.62, ask: 342.86 }];
  data.session = { date: "2026-09-22", high: 347.82, low: sessionLow, asOf: data.asOf };
  const state = createInitialState(createTestPaneConfig("/tmp/gloom-time-sales-test", { instanceId: "qr", paneId: "time-sales", settings: { tab } }));
  state.focusedPaneId = "qr";
  state.paneState.qr = { cursorSymbol: "AAPL" };
  state.tickers.set("AAPL", createTestTicker("AAPL", "Apple Inc.", { exchange: "NASDAQ" }));
  const client = createSnapshotTapeClient([["AAPL", "NASDAQ", data]], async () => { throw new Error("Captured tape must not refetch"); });
  await act(async () => { await tui.render(<TapeClientContext.Provider value={client}>
    <TestPaneFrame state={state} paneId="qr" pluginId="time-sales" runtime={createTestPluginRuntime()} width={width} height={20}>
      {(body) => <TimeSalesPane paneId="qr" paneType="time-sales" focused {...body} />}
    </TestPaneFrame></TapeClientContext.Provider>, { width, height: 20 }); });
  for (let i = 0; i < 8; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); await tui.setup().renderOnce(); });
  return tui.frame();
}

test("the session range reads at the decimals of the tab's own prices", async () => {
  const quotes = await render("quotes");
  expect(quotes).toContain("342.62");
  expect(quotes).toContain("340.46 to 347.82");
  expect(quotes).not.toContain("340.4600");

  const trades = await render("trades");
  expect(trades).toContain("343.4551");
  expect(trades).toContain("340.4600 to 347.8200");
});

test("a sub-penny session extreme does not turn a tape of cent prints into four decimals", async () => {
  const trades = await render("trades", 100, { tradePrice: 343.45, sessionLow: 340.4599 });
  expect(trades).toContain("343.45");
  expect(trades).not.toContain("343.4500");
  expect(trades).toContain("340.46 to 347.82");
  expect(trades).not.toContain("340.4599");
});

test("a narrow NBBO pane gives up both venues, then the lots, before the spread is cut", async () => {
  const wide = await render("quotes", 100);
  expect(wide.match(/VENUE/g)).toHaveLength(2);
  expect(wide).toContain("SPREAD BP");

  const narrow = await render("quotes", 84);
  expect(narrow).not.toContain("VENUE");
  expect(narrow.match(/LOTS/g)).toHaveLength(2);
  expect(narrow).toContain("SPREAD BP");

  const narrower = await render("quotes", 64);
  expect(narrower).not.toContain("LOTS");
  expect(narrower).toContain("SPREAD BP");
});
