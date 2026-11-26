import { RGBA } from "@opentui/core";
import { expect, test } from "bun:test";
import { act } from "react";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { createInitialState } from "../../../state/app/context";
import { useTabCursorLink, type TabCursorLink } from "../../../state/app/tab-cursor";
import { getThemeColors } from "../../../theme/colors";
import { DEFAULT_THEME } from "../../../theme/themes";
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
  const narrowHeader = narrow.split("\n").find((line) => line.includes("TIME ET"))!;
  expect(narrowHeader).not.toContain("VENUE");
  expect(narrowHeader.match(/LOTS/g)).toHaveLength(2);
  expect(narrowHeader).toContain("SPREAD BP");
  expect(narrow).toContain("2 hidden · VENUE ×2");

  const narrower = await render("quotes", 64);
  const narrowerHeader = narrower.split("\n").find((line) => line.includes("TIME ET"))!;
  expect(narrowerHeader).not.toMatch(/VENUE|LOTS/);
  expect(narrowerHeader).toContain("SPREAD BP");
  expect(narrower).toContain("4 hidden · LOTS ×2, VENUE ×2");
});

/**
 * The tape and the NBBO at the given stamps, newest first as the feed sends
 * them, beside a chart that pins the tab's crosshair. A trade's price and a
 * quote's bid name its row: 100 and 200 for the first stamp, one more for each
 * after it.
 */
async function renderPinned(tab: "trades" | "quotes", stamps: string[], pinAt: string) {
  const data = tapeFixture();
  data.observedFrom = "2026-09-22T15:59:58Z";
  data.trades = stamps.map((timestamp, index) => ({ id: `90071992547409${90 + index}`, timestamp, price: 100 + index, size: 10,
    exchange: "D", conditions: ["@"], tape: "C" }));
  data.quotes = stamps.map((timestamp, index) => ({ timestamp, bid: 200 + index, ask: 300 + index, bidSize: 1, askSize: 1,
    bidExchange: "Q", askExchange: "P", conditions: ["R"], tape: "C" }));
  const state = createInitialState(createTestPaneConfig("/tmp/gloom-time-sales-test", { instanceId: "qr", paneId: "time-sales", settings: { tab } }));
  state.focusedPaneId = "qr";
  state.paneState.qr = { cursorSymbol: "AAPL" };
  state.tickers.set("AAPL", createTestTicker("AAPL", "Apple Inc.", { exchange: "NASDAQ" }));
  const client = createSnapshotTapeClient([["AAPL", "NASDAQ", data]], async () => { throw new Error("Captured tape must not refetch"); });
  let link: TabCursorLink | undefined;
  function Chart() {
    link = useTabCursorLink("chart");
    return null;
  }
  const settle = async () => {
    for (let i = 0; i < 8; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); await tui.setup().renderOnce(); });
  };
  await act(async () => { await tui.render(<TapeClientContext.Provider value={client}>
    <TestPaneFrame state={state} paneId="qr" pluginId="time-sales" runtime={createTestPluginRuntime()} width={100} height={20}>
      {(body) => <><Chart /><TimeSalesPane paneId="qr" paneType="time-sales" focused {...body} /></>}
    </TestPaneFrame></TapeClientContext.Provider>, { width: 100, height: 20 }); });
  await settle();
  await act(async () => link!.pin!(Date.parse(pinAt)));
  await settle();
  const price = (row: number) => tab === "quotes" ? `${200 + row}.00` : `${100 + row}.00`;
  const muted = RGBA.fromHex(getThemeColors(DEFAULT_THEME).textMuted).toInts();
  return {
    /** Whether the row at `index` of `stamps` draws its price muted; read on a row that is not selected. */
    mutedRow: (index: number) => {
      const lines = tui.setup().captureSpans().lines;
      const header = lines.findIndex((line) => line.spans.some((entry) => entry.text.includes("TIME ET")));
      // A muted row draws its time and price in one colour, so they share a span.
      const span = lines.slice(header + 1).flatMap((line) => line.spans).find((entry) => entry.text.includes(` ${price(index)}`));
      if (!span) throw new Error(`no row priced ${price(index)}`);
      return span.fg.toInts().every((value, channel) => value === muted[channel]);
    },
    /** The stamp the selected row opens on, to the nanosecond. */
    async selectedStamp() {
      await tui.emitKeypress({ name: "return", sequence: "\r" }, { frames: 2, afterCommit: true });
      await settle();
      const stamp = /As of UTC\s+(\S+ \S+)/.exec(tui.frame())?.[1] ?? null;
      await tui.emitKeypress({ name: "escape", sequence: "\u001b" }, { frames: 2, afterCommit: true });
      await settle();
      return stamp;
    },
    up: () => tui.emitKeypress({ name: "k", sequence: "k" }, { frames: 2, afterCommit: true }),
    unpin: () => act(async () => link?.pin?.(null)),
  };
}

// A pin on the millisecond before two prints a nanosecond apart is before
// both: the earlier is the one nearest it, though the millisecond cannot tell
// them apart. Both trades and NBBO compare the nanoseconds.
for (const tab of ["trades", "quotes"] as const) {
  test(`a pin before two ${tab} a nanosecond apart selects the earlier and mutes both`, async () => {
    const pane = await renderPinned(tab, ["2026-09-22T15:59:59.000000002Z", "2026-09-22T15:59:59.000000001Z"], "2026-09-22T15:59:59.000Z");
    try {
      expect(await pane.selectedStamp()).toBe("2026-09-22 15:59:59.000000001");
      expect(pane.mutedRow(0)).toBe(true);
      await pane.up();
      expect(await pane.selectedStamp()).toBe("2026-09-22 15:59:59.000000002");
      expect(pane.mutedRow(1)).toBe(true);
    } finally {
      await pane.unpin();
    }
  });

  test(`a pin on a ${tab.slice(0, -1)} selects it and mutes only the later ones`, async () => {
    const pane = await renderPinned(tab, [
      "2026-09-22T15:59:59.001000001Z", "2026-09-22T15:59:59.001Z", "2026-09-22T15:59:59.000000002Z", "2026-09-22T15:59:59.000000001Z",
    ], "2026-09-22T15:59:59.001Z");
    try {
      expect(await pane.selectedStamp()).toBe("2026-09-22 15:59:59.001");
      expect([0, 2, 3].map(pane.mutedRow)).toEqual([true, false, false]);
    } finally {
      await pane.unpin();
    }
  });
}
