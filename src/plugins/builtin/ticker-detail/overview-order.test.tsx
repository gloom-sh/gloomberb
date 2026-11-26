import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { act } from "react";
import { createOpenTuiTestHarness, settleFrame } from "../../../renderers/opentui/test-utils";
import { AppContext, createInitialState } from "../../../state/app/context";
import { createStaticAppStore } from "../../../test-support/app-store";
import { createTestFinancials, createTestQuote } from "../../../test-support/data-provider";
import { createTestTicker } from "../../../test-support/ticker";
import { createDefaultConfig } from "../../../types/config";
import { Text } from "../../../ui";
import { OverviewTab } from "./overview-tab";

const config = createDefaultConfig("/tmp/gloom-overview-order-unused");
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
          perpetuals={<Text>OWN CONTRACT ROW</Text>}
          perpetualMarkets={() => <Text>VENUE MARKETS</Text>}
        />
      </AppContext>,
      { width, height },
    );
  });
  await settleFrame(tui.setup(), 10);
  return tui.frame();
}

test("a security's range and figures come before the perpetual markets on it; a contract's own row stays under its price", async () => {
  const text = await frame(90);
  const at = (needle: string) => {
    const index = text.indexOf(needle);
    expect(index).toBeGreaterThanOrEqual(0);
    return index;
  };
  expect(at("OWN CONTRACT ROW")).toBeLessThan(at("Day Range"));
  expect(at("Day Range")).toBeLessThan(at("Fundamentals"));
  expect(at("Fundamentals")).toBeLessThan(at("VENUE MARKETS"));
});
