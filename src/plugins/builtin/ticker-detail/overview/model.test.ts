import { describe, expect, test } from "bun:test";
import type { Quote } from "../../../../types/financials";
import type { TickerPosition, TickerRecord } from "../../../../types/ticker";
import { buildPositionRows } from "./model";

function row(position: Partial<TickerPosition>, options: {
  quotePrice?: number | null;
  quoteCurrency?: string;
  toBase?: (value: number, currency: string) => number;
} = {}) {
  const ticker: TickerRecord = { metadata: {
    ticker: "TEST", exchange: "NASDAQ", currency: "USD", name: "Controlled position",
    portfolios: ["test"], watchlists: [], custom: {}, tags: [], assetCategory: "STK",
    positions: [{ portfolio: "test", broker: "manual", shares: 10, avgCost: 100, ...position }],
  } };
  const quotePrice = options.quotePrice === undefined ? 120 : options.quotePrice;
  return buildPositionRows({ ticker, quote: quotePrice == null ? undefined : { price: quotePrice } as Quote,
    quoteCurrency: options.quoteCurrency ?? "USD", baseCurrency: "USD",
    toBase: options.toBase ?? ((value) => value),
  })[0]!;
}

describe("research position valuation", () => {
  test("equivalent short conventions retain gross exposure but reverse price P&L", () => {
    const positive = row({ side: "short" });
    const negative = row({ shares: -10 });
    expect(positive).toEqual(negative);
    expect(positive).toMatchObject({ account: "test SHORT", qty: "-10 sh", cost: "$1,000.00", value: "$1,200.00", pnl: "-$200.00", ret: "-20.00%", pnlValue: -200 });
    expect(row({ side: "short" }, { quotePrice: 80 })).toMatchObject({ pnlValue: 200, ret: "+20.00%" });
    expect(row({})).toMatchObject({ qty: "10 sh", pnlValue: 200 });
  });

  test("broker signed and magnitude market values agree, and reported P&L wins", () => {
    expect(row({ shares: -10, marketValue: -1200 })).toEqual(row({ shares: -10, marketValue: 1200 }));
    expect(row({ shares: -10, marketValue: -1200 })).toMatchObject({ value: "$1,200.00", pnlValue: -200 });
    expect(row({ shares: -10, marketValue: -1200, unrealizedPnl: -175 })).toMatchObject({ pnlValue: -175, ret: "-17.50%" });
    expect(row({ shares: -10, markPrice: 80 })).toMatchObject({ mark: "$80", value: "$800.00", pnlValue: 200 });
  });

  test("derivative marks use contract multipliers while broker costs may already be scaled", () => {
    expect(row({ shares: 2, side: "short", avgCost: 5, multiplier: 100 }, { quotePrice: 6 }))
      .toMatchObject({ qty: "-2 ct", cost: "$1,000.00", value: "$1,200.00", pnlValue: -200, ret: "-20.00%" });
    expect(row({ shares: -10, avgCost: 500, multiplier: 100, marketValue: -4000, unrealizedPnl: 1000 }))
      .toMatchObject({ cost: "$5,000.00", value: "$4,000.00", pnlValue: 1000, ret: "+20.00%" });
  });

  test("position cost and quote marks use their own currencies before signed P&L", () => {
    const toBase = (value: number, currency: string) => currency === "EUR" ? value * 1.2 : value;
    expect(row({ side: "short", currency: "EUR" }, { quotePrice: 130, toBase }))
      .toMatchObject({ cost: "$1,200.00", value: "$1,300.00", pnlValue: -100, ret: "-8.33%" });
    expect(row({ side: "short", currency: "EUR", markPrice: 110 }, { quotePrice: 130, toBase }))
      .toMatchObject({ cost: "$1,200.00", value: "$1,320.00", pnlValue: -120, ret: "-10.00%" });
  });

  test("missing FX or marks never produce a valid-looking P&L", () => {
    const toBase = (value: number, currency: string) => currency === "USD" ? value : Number.NaN;
    expect(row({ side: "short", currency: "EUR" }, { toBase }))
      .toMatchObject({ cost: "—", value: "$1,200.00", pnl: "—", ret: "—", pnlValue: null });
    expect(row({ side: "short", currency: "EUR", markPrice: 110 }, { toBase }))
      .toMatchObject({ cost: "—", value: "—", pnl: "—", ret: "—", pnlValue: null });
    expect(row({ side: "short" }, { quotePrice: null }))
      .toMatchObject({ cost: "$1,000.00", mark: "—", value: "—", pnlValue: null });
  });
});
