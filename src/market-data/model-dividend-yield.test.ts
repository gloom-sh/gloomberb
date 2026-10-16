import { expect, test } from "bun:test";
import type { CorporateActionsData, TickerFinancials } from "../types/financials";
import { loadModelDividendYield } from "./model-dividend-yield";

const now = Date.UTC(2026, 9, 16);
const quote = { symbol: "GLD", price: 382, currency: "USD", change: 0, changePercent: 0, lastUpdated: now };
const financials = (fundamentals?: TickerFinancials["fundamentals"]): TickerFinancials =>
  ({ quote, ...(fundamentals ? { fundamentals } : {}), annualStatements: [], quarterlyStatements: [], priceHistory: [] });
const history = (patch: Partial<CorporateActionsData> = {}): CorporateActionsData =>
  ({ symbol: "GLD", coverage: { dividends: "available" }, dividends: [], splits: [], earnings: [], ...patch });

test("a stated yield wins; without one a covered history with no dividend in 15 months is 0, anything else stays unknown", async () => {
  const read = (data: TickerFinancials | null, actions: CorporateActionsData | null) =>
    loadModelDividendYield(data, "GLD", async () => actions, now);
  let asked = 0;
  // A stated yield, a stated 0 included, is used as is and the history is never read.
  expect(await loadModelDividendYield(financials({ dividendYield: 0 }), "GLD", async () => { asked++; return history(); }, now))
    .toEqual({ value: 0, basis: "stated" });
  expect(asked).toBe(0);
  // GLD: no fundamentals, a history that covers dividends and has none.
  expect(await read(financials(), history())).toEqual({ value: 0, basis: "none-paid" });
  // A stale yield or another symbol's is not stated; the history decides.
  expect(await read(financials({ dividendYield: 0.02, stale: true }), history())).toEqual({ value: 0, basis: "none-paid" });
  expect(await read({ ...financials({ dividendYield: 0.02 }), quote: { ...quote, symbol: "IAU" } }, history())).toEqual({ value: 0, basis: "none-paid" });
  // A dividend 14 months ago, a declared one, uncovered dividends, another symbol's history or none at all: unknown, never 0.
  for (const actions of [history({ dividends: [{ exDate: "2025-08-20", amount: 1 }] }),
    history({ declaredDividends: [{ exDate: "2026-12-01", amount: 1 }] }), history({ coverage: { dividends: "unavailable" } }),
    history({ symbol: "SPY" }), null]) {
    expect(await read(financials(), actions)).toBeNull();
  }
  // A dividend that lapsed over 15 months ago no longer counts.
  expect(await read(financials(), history({ dividends: [{ exDate: "2025-07-01", amount: 1 }] }))).toEqual({ value: 0, basis: "none-paid" });
  // A history that fails to load leaves the yield unknown.
  expect(await loadModelDividendYield(financials(), "GLD", async () => { throw new Error("offline"); }, now)).toBeNull();
});
