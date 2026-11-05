import { afterEach, expect, setSystemTime, test } from "bun:test";
import { createTestDataProvider, createTestQuote } from "../../../test-support/data-provider";
import { createTestHeadlessArgs, createTestHeadlessContext } from "../../../test-support/headless";
import { createDefaultConfig } from "../../../types/config";
import type { DataProvider } from "../../../types/data-provider";
import { kellyHeadless } from "./headless";

afterEach(() => setSystemTime());

/** Daily closes at 00:00 UTC whose calendar-month returns, from January 2026, are `returns` in order. */
function closes(returns: readonly number[]) {
  let close = 100;
  const points: Array<{ date: Date; close: number }> = [];
  for (let month = 0; month <= returns.length; month += 1) {
    if (month > 0) close *= 1 + returns[month - 1]!;
    const days = new Date(Date.UTC(2026, month + 1, 0)).getUTCDate();
    for (let day = 1; day <= days; day += 1) points.push({ date: new Date(Date.UTC(2026, month, day)), close });
  }
  return points;
}

async function load(returns: readonly number[], options: { bankroll?: number; baseCurrency?: string; marketData?: Partial<DataProvider> } = {}) {
  const history = closes(returns);
  // The day after the last month ends: every month is complete.
  setSystemTime(new Date(history.at(-1)!.date.getTime() + 86_400_000));
  return kellyHeadless.load(
    createTestHeadlessArgs({ symbols: ["BTC-USD"], options: { years: 1, ...(options.bankroll ? { bankroll: options.bankroll } : {}) } }),
    createTestHeadlessContext({
      config: { ...createDefaultConfig("/tmp/gloomberb-kelly-test"), baseCurrency: options.baseCurrency ?? "USD" },
      resolveInstrument: async () => ({ symbol: "BTC-USD", exchange: "" }),
      marketData: createTestDataProvider({ getPriceHistoryForResolution: async () => history, getPriceHistory: async () => history, ...options.marketData }),
    }),
  );
}

test("a Kelly fraction over the whole bankroll is said to be leverage, and one inside it says nothing of it", async () => {
  // Gains of 20% five months in nine against 15% losses: full Kelly sizes past the bankroll, half inside it.
  const levered = ((await load([0.2, -0.15, 0.2, -0.15, 0.2, -0.15, 0.2, -0.15, 0.2])).notes ?? []).find((note) => note.startsWith("Over 100%"));
  expect(levered).toMatch(/^Over 100% of bankroll means leverage, borrowing or margin beyond what you hold: Full Kelly 1\d\d\.\d\d% is 1\.\d\dx the bankroll\.$/);
  // Gains of 30% against losses of 25%, five months in nine: full Kelly stays inside the bankroll.
  expect(((await load([0.3, -0.25, 0.3, -0.25, 0.3, -0.25, 0.3, -0.25, 0.3])).notes ?? []).join(" ")).not.toContain("leverage");
});

test("in another base currency a coin's units are counted at the portfolio's rate, headed Units", async () => {
  const returns = [0.3, -0.25, 0.3, -0.25, 0.3, -0.25, 0.3, -0.25, 0.3];
  const marketData = {
    getQuote: async () => createTestQuote({ symbol: "BTC-USD", price: 2000, currency: "USD" }),
    // USD per unit: one SGD is 0.80 USD, so 2,000 USD is 2,500 SGD.
    getExchangeRate: async (currency: string) => (currency === "SGD" ? 0.8 : 1),
  };
  const result = await load(returns, { bankroll: 2_500_000, baseCurrency: "SGD", marketData });
  const sizing = result.sections!.find((section) => section.title === "Sizing on 2,500,000 SGD")!;
  expect(sizing.columns!.map((column) => column.header)).toEqual(["Kelly", "% of bankroll", "Position SGD", "Units"]);
  const full = sizing.rows!.find((row) => row.id === "full")!;
  // A coin is counted to a hundredth, never floored to whole coins.
  expect(full.shares).toBe(Math.floor(((full.position as number) / 2500) * 100) / 100);
  expect(result.metadata).toMatchObject({ priceInBase: { value: 2500, currency: "SGD" }, units: "units" });
  // The months are calendar months: nine returns from 31 Jan to 31 Oct.
  expect(result.sections![0]!.entries!.find((entry) => entry.key === "window")!.formatted).toBe("2026-01-31 to 2026-10-31, 9 monthly returns");

  // Without a rate to the base currency the column says why it is missing.
  const unpriced = await load(returns, { bankroll: 2_500_000, baseCurrency: "SGD", marketData: { ...marketData, getExchangeRate: async () => Promise.reject(new Error("no rate")) } });
  expect(unpriced.notes).toContain("No USD to SGD rate to count units in: each position is in SGD only.");
});
