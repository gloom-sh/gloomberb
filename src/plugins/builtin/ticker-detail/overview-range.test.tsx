import { expect, test } from "bun:test";
import { act } from "react";
import { createOpenTuiTestHarness, settleFrame } from "../../../renderers/opentui/test-utils";
import { AppContext, createInitialState } from "../../../state/app/context";
import { createStaticAppStore } from "../../../test-support/app-store";
import { createTestFinancials, createTestQuote } from "../../../test-support/data-provider";
import { createTestTicker } from "../../../test-support/ticker";
import { createDefaultConfig } from "../../../types/config";
import { OverviewTab } from "./overview-tab";

const config = createDefaultConfig("/tmp/gloom-overview-range-unused");
const tui = createOpenTuiTestHarness();
// Cocoa on Fri 6 Nov 2026: the session's and the year's ranges.
const cocoa = createTestQuote({
  symbol: "CC=F", name: "Cocoa Dec 26", currency: "USD", instrumentType: "FUTURE", exchangeName: "NYB",
  price: 5119, change: -62, changePercent: -1.2, previousClose: 5181, low: 5072, high: 5287, low52w: 3061, high52w: 6820.5,
});

async function rangeRows(width: number): Promise<string[]> {
  await act(async () => {
    await tui.render(
      <AppContext value={createStaticAppStore(createInitialState(config))}>
        <OverviewTab ticker={createTestTicker("CC=F", "Cocoa", { exchange: "NYB", assetCategory: "FUTURE" })}
          financials={createTestFinancials({ quote: cocoa })} width={width} height={14} />
      </AppContext>,
      { width, height: 14 },
    );
  });
  await settleFrame(tui.setup(), 10);
  return tui.frame().split("\n").map((line) => line.trim()).filter((line) => /^(Day|52W)\b/.test(line));
}

test("a pane too narrow for priced range ends writes both ends compact instead of cutting the high", async () => {
  // A 27-cell CC=F pane read "Day $5,072.00 ● $5,28" and "52W $3,061.00 ● $6,82".
  const narrow = await rangeRows(25);
  expect(narrow).toHaveLength(2);
  expect(narrow[0]).toMatch(/^Day\s+5,072 .*\b5,287$/);
  expect(narrow[1]).toMatch(/^52W\s+3,061 .*\b6,821$/);
  // Stacked rows keep one track: their highs end in the same column.
  expect(narrow[0]!.length).toBe(narrow[1]!.length);
  // With room for the prices, the rows print them as the quote does.
  const wide = await rangeRows(60);
  expect(wide.join("\n")).toContain("$5,287.00");
  expect(wide.join("\n")).toContain("$6,820.50");
});
