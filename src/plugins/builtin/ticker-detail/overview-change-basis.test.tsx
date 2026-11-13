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
// 3042.HK's Tue 20 Oct move ran from Fri 16 Oct's close: HKEX was shut Mon 19 Oct. An HKEX
// fund under 10 prints its tick's three decimals.
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
    expect(wide[1]).toStartWith("HK$9.880  -0.060 (-0.60%) vs Fri 16 Oct close");
    expect(wide[2]).toStartWith("HKEX closed Mon 19 Oct, holiday");
    // Narrower than the whole line: the price and its move keep their row, the words take the next.
    const narrow = await headline(44);
    expect(narrow[1]).toStartWith("HK$9.880  -0.060 (-0.60%)");
    expect(narrow[1]).not.toContain("vs");
    expect(narrow[2]).toStartWith("vs Fri 16 Oct close");
    expect(narrow[3]).toStartWith("HKEX closed Mon 19 Oct, holiday");
  } finally {
    setSystemTime();
  }
});

test("a compact Treasury overview keeps its chart's 32nds visible beside the quote", async () => {
  const quote = createTestQuote({ symbol: "ZN=F", name: "Treasury", instrumentType: "FUTURE", exchangeName: "CBT",
    price: 104.484375, priceBasis: "thirty-seconds", change: -0.375, changePercent: -0.3576 });
  const priceHistory = [103.3, 104.2, 105, 104.4].map((close, index) => ({
    date: new Date(`2026-10-${20 + index}T00:00:00Z`), close, open: close, high: close, low: close, volume: 100,
  }));
  await tui.render(
    <AppContext value={createStaticAppStore(createInitialState(config))}>
      <OverviewTab ticker={createTestTicker("ZN=F", "Treasury", { exchange: "CBT", assetCategory: "FUTURE" })}
        financials={createTestFinancials({ quote, priceHistory })} width={74} height={30} />
    </AppContext>,
    { width: 74, height: 30 },
  );
  const frame = await tui.waitForFrameToContain("104-15½");
  // The axis ticks on half 32nds whatever the padded bounds, and the gutter still fits a cursor's decimal 32nds.
  const lines = frame.split("\n");
  expect(lines.filter((line) => /10[345]-\d{2}[¼½¾]?\s*$/.test(line)).length).toBeGreaterThanOrEqual(2);
  expect(lines.some((line) => /10[345]-\d{2}\.\d{2}\s*$/.test(line))).toBe(false);
  expect(frame).not.toContain("$104");
});

test("a coin's day range and volume say whose they are, so the switch from the composite to one exchange's day shows", async () => {
  const coin = (fields: Partial<Parameters<typeof createTestQuote>[0]>) => createTestQuote({
    symbol: "USDT-USD", name: "Tether USDt", currency: "USD", instrumentType: "CRYPTOCURRENCY", listingExchangeName: "CCC",
    exchangeName: "CCC", price: 0.99906, change: 0.0002, changePercent: 0.02, previousClose: 0.99886, marketState: "REGULAR",
    lastUpdated: Date.parse("2026-11-13T13:56:00Z"), ...fields,
  });
  const frame = async (quote: ReturnType<typeof createTestQuote>) => {
    await act(async () => {
      await tui.render(
        <AppContext value={createStaticAppStore(createInitialState(config))}>
          <OverviewTab ticker={createTestTicker("USDT-USD", "Tether USDt", { exchange: "CCC", currency: "USD", assetCategory: "CRYPTOCURRENCY" })}
            financials={createTestFinancials({ quote })} width={110} height={16} />
        </AppContext>,
        { width: 110, height: 16 },
      );
    });
    await settleFrame(tui.setup(), 10);
    return tui.frame();
  };
  // Served first: the composite's range and its volume.
  const composite = await frame(coin({ low: 0.99868, high: 0.99906, volume: 47_340_000_000, statsBasis: "composite" }));
  expect(composite).toMatch(/Day Range.*composite/);
  expect(composite).toMatch(/Volume\s+47\.34B\s+composite/);
  // Then one exchange's own day, from a real-time feed: the range and the volume say so.
  const exchange = await frame(coin({ low: 0.998162, high: 0.999736, volume: 763_300, statsBasis: "exchange" }));
  expect(exchange).toMatch(/Day Range.*1 exchange/);
  expect(exchange).toMatch(/Volume\s+763\.3k\s+1 exchange/);
  // Widened by the exchange's price, which fell outside the composite's range.
  const widened = await frame(coin({ low: 0.9901, high: 0.99906, volume: 47_340_000_000, statsBasis: "composite", rangeWidened: true,
    priceVenue: "Coinbase", price: 0.9901, dataSource: "live" }));
  expect(widened).toMatch(/Day Range.*composite \+ Coinbase/);
});

test("a coin's header names the exchange and time of its price, or the composite held back, where a listing names its venue", async () => {
  setSystemTime(new Date("2026-11-13T21:54:00Z"));
  const header = async (fields: Partial<Parameters<typeof createTestQuote>[0]>) => {
    const quote = createTestQuote({
      symbol: "USDT-USD", name: "Tether USDt", currency: "USD", instrumentType: "CRYPTOCURRENCY", listingExchangeName: "CCC",
      exchangeName: "CCC", price: 0.9988, change: 0.0001, changePercent: 0.01, previousClose: 0.9987, marketState: "REGULAR",
      lastUpdated: Date.parse("2026-11-13T21:53:40Z"), ...fields,
    });
    await act(async () => {
      await tui.render(
        <AppContext value={createStaticAppStore(createInitialState(config))}>
          <OverviewTab ticker={createTestTicker("USDT-USD", "Tether USDt", { exchange: "CCC", currency: "USD", assetCategory: "CRYPTOCURRENCY" })}
            financials={createTestFinancials({ quote })} width={110} height={8} />
        </AppContext>,
        { width: 110, height: 8 },
      );
    });
    await settleFrame(tui.setup(), 10);
    return tui.frame().split("\n")[0]!.trim();
  };
  try {
    const exchange = await header({ priceVenue: "Coinbase", dataSource: "live" });
    expect(exchange).toStartWith("Tether USDt (Coinbase · 21:53:40 UTC)");
    expect(exchange).not.toContain("CCC");
    // Held back, the composite says so once: no clock mark repeats the delay.
    const delayed = await header({ dataSource: "delayed", lastUpdated: Date.parse("2026-11-13T21:38:00Z") });
    expect(delayed).toStartWith("Tether USDt (composite · 15m delayed)");
    expect(delayed).not.toContain("◷");
    expect(delayed).not.toContain("CCC");
  } finally {
    setSystemTime();
  }
});

test("a stablecoin's header keeps six decimals when its previous close was written to eight", async () => {
  // USDT on 13 Nov 2026: the composite's 00:00 UTC close came as 0.99880666 and padded every figure to eight decimals.
  const quote = createTestQuote({
    symbol: "USDT-USD", name: "Tether USDt", currency: "USD", instrumentType: "CRYPTOCURRENCY", listingExchangeName: "CCC",
    exchangeName: "CCC", price: 0.998905, change: 0.00009834, changePercent: 0.0098, previousClose: 0.99880666, open: 0.99876,
    low: 0.99868, high: 0.9995, bid: 0.9989, ask: 0.99891, bidSize: 291_791, askSize: 21_301, marketState: "REGULAR",
    priceVenue: "Coinbase", dataSource: "live", lastUpdated: Date.parse("2026-11-13T23:15:38Z"),
  });
  await act(async () => {
    await tui.render(
      <AppContext value={createStaticAppStore(createInitialState(config))}>
        <OverviewTab ticker={createTestTicker("USDT-USD", "Tether USDt", { exchange: "CCC", currency: "USD", assetCategory: "CRYPTOCURRENCY" })}
          financials={createTestFinancials({ quote })} width={110} height={10} />
      </AppContext>,
      { width: 110, height: 10 },
    );
  });
  await settleFrame(tui.setup(), 10);
  const frame = tui.frame();
  expect(frame).toContain("$0.998905  +0.000098");
  expect(frame).toMatch(/Bid\s+291,791 x \$0\.998900/);
  expect(frame).toMatch(/Day Range \$0\.998680 .* \$0\.999500/);
  expect(frame).not.toMatch(/\$0\.\d{8}/);
});
