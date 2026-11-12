import { expect, test } from "bun:test";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { createTestHeadlessArgs, createTestHeadlessContext } from "../../../test-support/headless";
import type { HeadlessBundleSection } from "../../../types/headless";
import type { PricePoint } from "../../../types/financials";
import { realizedVolHeadless } from "./headless";

// Three hundred weekday closes up to Wed 11 Nov 2026, wobbling so every window has a volatility.
const closes: PricePoint[] = Array.from({ length: 300 }, (_, index) => {
  const date = new Date(Date.UTC(2026, 10, 11));
  let weekdays = 299 - index;
  while (weekdays > 0) {
    date.setUTCDate(date.getUTCDate() - 1);
    if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6) weekdays--;
  }
  return { date, close: 20 * (1 + 0.02 * Math.sin(index * 1.7)) };
});

async function report(options: Record<string, unknown>) {
  const prices = async () => closes;
  const result = await realizedVolHeadless("cone").load(
    createTestHeadlessArgs({ symbols: ["UNG"], options: { estimator: "close-to-close", lookbackYears: 1, windows: "", showIv: true, ...options } }),
    createTestHeadlessContext({
      resolveInstrument: async () => ({ symbol: "UNG", exchange: "NYSEARCA" }),
      marketData: createTestDataProvider({ getPriceHistoryForResolution: prices, getPriceHistory: prices }),
    }),
  );
  const sections = result.sections as HeadlessBundleSection[];
  return { windows: sections[0]!.rows!.map((row) => row.window), titles: sections.map((section) => section.title) };
}

test("HVT prints the windows asked for and no IV block when it is off, and every window by default", async () => {
  expect(await report({ windows: "20,60", showIv: false })).toEqual({ windows: [20, 60], titles: ["Volatility cone"] });
  expect((await report({ showIv: false })).windows).toEqual([10, 20, 30, 60, 90, 180, 260]);
});
