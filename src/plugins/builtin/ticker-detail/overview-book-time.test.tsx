import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { act } from "react";
import { createOpenTuiTestHarness, settleFrame } from "../../../renderers/opentui/test-utils";
import { AppContext, createInitialState } from "../../../state/app/context";
import { createStaticAppStore } from "../../../test-support/app-store";
import { createTestFinancials, createTestQuote } from "../../../test-support/data-provider";
import { createTestTicker } from "../../../test-support/ticker";
import { createDefaultConfig } from "../../../types/config";
import { quoteBookTimeLines } from "./overview/components";
import { OverviewTab } from "./overview-tab";

const config = createDefaultConfig("/tmp/gloom-overview-book-time-unused");
const tui = createOpenTuiTestHarness();
afterEach(() => mock.restore());
// Thu 26 Nov 2026, 03:30 UTC: New York shut, the book left after hours at 00:59 UTC.
const now = Date.parse("2026-11-26T03:30:00Z");
const quote = createTestQuote({
  symbol: "NVDA", name: "NVIDIA Corporation", currency: "USD", exchangeName: "NASDAQ", listingExchangeName: "NASDAQ", marketState: "CLOSED",
  price: 149.3, change: -6.08, changePercent: -3.91, previousClose: 155.38, low: 141.17, high: 150.37, low52w: 124.5, high52w: 243.37,
  bid: 151.22, ask: 151.25, bidSize: 600, askSize: 500, bidAskTime: Date.parse("2026-11-26T00:59:00Z"), dataSource: "delayed",
});

async function frame(width: number, height = 40) {
  spyOn(Date, "now").mockReturnValue(now);
  await act(async () => {
    await tui.render(
      <AppContext value={createStaticAppStore(createInitialState(config))}>
        <OverviewTab
          ticker={createTestTicker("NVDA", "NVIDIA Corporation", { exchange: "NASDAQ", assetCategory: "STOCK" })}
          financials={createTestFinancials({ quote, fundamentals: { marketCap: 3.6e12, trailingPE: 16 } })}
          width={width}
          height={height}
        />
      </AppContext>,
      { width, height },
    );
  });
  await settleFrame(tui.setup(), 10);
  return tui.frame();
}

test("the book's time keeps a blank after its label and its session and feed on one line", async () => {
  // A book 24 cells wide read "TimeThu 26 Nov 00:59 UTC", then "after-hours" and "delayed" on a line each.
  const parts = ["Thu 26 Nov 00:59 UTC", "after-hours", "delayed"];
  const short = ["26 Nov 00:59 UTC", "after-hours", "delayed"];
  expect(quoteBookTimeLines(parts, short, 24)).toEqual({ clockLines: ["26 Nov 00:59 UTC"], contextLines: ["after-hours · delayed"] });
  // With a cell to spare the weekday stays.
  expect(quoteBookTimeLines(parts, short, 25)).toEqual({ clockLines: ["Thu 26 Nov 00:59 UTC"], contextLines: ["after-hours · delayed"] });
  // Today's regular session is a clock and its feed: one line.
  expect(quoteBookTimeLines(["18:56 UTC", "delayed"], ["18:56 UTC", "delayed"], 24)).toEqual({ clockLines: ["18:56 UTC · delayed"], contextLines: [] });
  // Narrower than its session and feed together: a line each, none past the book's edge.
  const narrow = quoteBookTimeLines(parts, short, 18);
  expect(narrow.contextLines).toEqual(["after-hours", "delayed"]);
  for (const line of [...narrow.clockLines, ...narrow.contextLines]) expect(line.length).toBeLessThanOrEqual(18);
  expect(quoteBookTimeLines([], [], 24)).toEqual({ clockLines: [], contextLines: [] });

  // In the pane: the label, a gap, the clock; the session and feed right-aligned under it.
  const lines = (await frame(84)).split("\n");
  const time = lines.findIndex((line) => /\bTime\s+26 Nov 00:59 UTC\s*$/.test(line));
  expect(time).toBeGreaterThanOrEqual(0);
  expect(lines[time + 1]).toMatch(/after-hours · delayed\s*$/);
  // Both end on the book's right edge, where Bid, Ask and Spr end.
  const edge = (line: string) => line.trimEnd().length;
  expect(edge(lines[time + 1]!)).toBe(edge(lines[time]!));
  expect(edge(lines.find((line) => /\bSpr\b/.test(line))!)).toBe(edge(lines[time]!));
});
