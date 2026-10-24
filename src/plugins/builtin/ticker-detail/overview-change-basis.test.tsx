import { setSystemTime, test, expect } from "bun:test";
import { act } from "react";
import { createOpenTuiTestHarness, settleFrame } from "../../../renderers/opentui/test-utils";
import { AppContext, createInitialState } from "../../../state/app/context";
import { createStaticAppStore } from "../../../test-support/app-store";
import { createTestFinancials, createTestQuote } from "../../../test-support/data-provider";
import { createTestTicker } from "../../../test-support/ticker";
import { createDefaultConfig } from "../../../types/config";
import { OverviewTab } from "./overview-tab";

const config = createDefaultConfig("/tmp/gloom-overview-change-basis-unused");
const tui = createOpenTuiTestHarness();
// 3042.HK's Tue 20 Oct move ran from Fri 16 Oct's close: HKEX was shut Mon 19 Oct.
const hk = createTestQuote({
  symbol: "3042.HK", name: "ChinaAMC Bitcoin ETF", currency: "HKD", instrumentType: "ETF", listingExchangeName: "HKEX", exchangeName: "HKEX",
  price: 9.88, change: -0.06, changePercent: -0.6, previousClose: 9.94, changeSessionDate: "2026-10-20", marketState: "CLOSED",
  lastUpdated: Date.parse("2026-10-20T08:08:00Z"),
});

async function headline(width: number): Promise<string[]> {
  await act(async () => {
    await tui.render(
      <AppContext value={createStaticAppStore(createInitialState(config))}>
        <OverviewTab ticker={createTestTicker("3042.HK", "ChinaAMC Bitcoin ETF", { exchange: "HKEX", currency: "HKD", assetCategory: "ETF" })}
          financials={createTestFinancials({ quote: hk })} width={width} height={8} />
      </AppContext>,
      { width, height: 8 },
    );
  });
  await settleFrame(tui.setup(), 10);
  return tui.frame().split("\n").map((line) => line.trim());
}

test("the headline says what its move is from, beside it or on the line under it, never splitting the move", async () => {
  setSystemTime(new Date("2026-10-21T00:30:00Z"));
  try {
    const wide = await headline(100);
    expect(wide[1]).toStartWith("HK$9.88  -0.06 (-0.60%) vs Fri 16 Oct close");
    expect(wide[2]).toStartWith("HKEX closed Mon 19 Oct, holiday");
    // Narrower than the whole line: the price and its move keep their row, the words take the next.
    const narrow = await headline(44);
    expect(narrow[1]).toStartWith("HK$9.88  -0.06 (-0.60%)");
    expect(narrow[1]).not.toContain("vs");
    expect(narrow[2]).toStartWith("vs Fri 16 Oct close");
    expect(narrow[3]).toStartWith("HKEX closed Mon 19 Oct, holiday");
  } finally {
    setSystemTime();
  }
});
