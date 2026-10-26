import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { MarketDataCoordinator, setSharedMarketDataCoordinator } from "../../../market-data/coordinator";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { AppContext, createInitialState } from "../../../state/app/context";
import { createStaticAppStore } from "../../../test-support/app-store";
import { createTestDataProvider, createTestFinancials, createTestQuote } from "../../../test-support/data-provider";
import { createTestTicker } from "../../../test-support/ticker";
import { createDefaultConfig } from "../../../types/config";
import type { OptionContract } from "../../../types/financials";
import { OverviewTab } from "./overview-tab";

const config = createDefaultConfig("/tmp/gloom-option-contract-test-unused");
const tui = createOpenTuiTestHarness();
const EXPIRY = Date.UTC(2026, 9, 26) / 1000;

afterEach(() => { setSharedMarketDataCoordinator(null); });

test("an option's Overview states its contract and the chain's open interest and IV, joined however the broker spaces the symbol", async () => {
  const row = (contractSymbol: string, strike: number): OptionContract => ({
    contractSymbol, strike, currency: "USD", lastPrice: 54.07, change: 0, percentChange: 0, volume: 12, openInterest: 1830,
    bid: 52.05, ask: 55.6, impliedVolatility: 0.3412, inTheMoney: true, expiration: EXPIRY, lastTradeDate: 0,
  });
  const requests: Array<number | undefined> = [];
  setSharedMarketDataCoordinator(new MarketDataCoordinator(createTestDataProvider({
    getOptionsChain: async (symbol, _exchange, expiration) => {
      requests.push(expiration);
      return { underlyingSymbol: symbol, expirationDates: [EXPIRY], puts: [],
        calls: [row("AAPL  261026C00285000", 285), { ...row("AAPL  261026C00290000", 290), openInterest: 2450 }] };
    },
  })));
  const quote = createTestQuote({ symbol: "AAPL261026C00290000", price: 54.07, instrumentType: "OPTION" });
  await act(async () => {
    await tui.render(
      <AppContext value={createStaticAppStore(createInitialState(config))}>
        <OverviewTab ticker={createTestTicker("AAPL261026C00290000", "AAPL Oct 26 '26 $290 Call", { assetCategory: "OPT", exchange: "" })}
          financials={createTestFinancials({ quote })} width={100} height={40} />
      </AppContext>,
      { width: 100, height: 40 },
    );
  });
  const frame = await tui.waitForFrameToContain("Open Int");
  expect(requests).toEqual([EXPIRY]);
  for (const line of [/Underlying\s+AAPL/, /Type\s+Call/, /Strike\s+\$290\b/, /Expiry\s+2026-10-26/, /Open Int\s+2\.5k/, /Implied Vol\s+34\.1%/]) {
    expect(frame).toMatch(line);
  }
  // The contract section names the type; the profile does not repeat it.
  expect(frame).not.toMatch(/Type\s+(OPT|Option)/);
});
