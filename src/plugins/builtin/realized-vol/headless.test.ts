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

async function report(options: Record<string, unknown>, bars = closes) {
  const prices = async () => bars;
  const result = await realizedVolHeadless("cone").load(
    createTestHeadlessArgs({ symbols: ["UNG"], options: { estimator: "close-to-close", lookbackYears: 1, windows: "", showIv: true, ...options } }),
    createTestHeadlessContext({
      resolveInstrument: async () => ({ symbol: "UNG", exchange: "NYSEARCA" }),
      marketData: createTestDataProvider({ getPriceHistoryForResolution: prices, getPriceHistory: prices }),
    }),
  );
  const sections = result.sections as HeadlessBundleSection[];
  return { windows: sections[0]!.rows!.map((row) => row.window), titles: sections.map((section) => section.title), result };
}

test("HVT prints the windows asked for and no IV block when it is off, and every window by default", async () => {
  const asked = await report({ windows: "20,60", showIv: false });
  expect({ windows: asked.windows, titles: asked.titles }).toEqual({ windows: [20, 60], titles: ["Volatility cone", "History"] });
  expect((await report({ showIv: false })).windows).toEqual([10, 20, 30, 60, 90, 180, 260]);
});

test("HVT is complete for the windows asked for, whatever the windows left out lack", async () => {
  // 120 bars: enough for the 20- and 60-bar windows, short of the 180- and 260-bar ones.
  const short = closes.slice(-120);
  const asked = (await report({ windows: "20,60", showIv: false }, short)).result;
  expect(asked.complete).toBe(true);
  expect((asked.metadata!.model as { shortWindows: number[]; cone: unknown[] })).toMatchObject({ shortWindows: [], cone: [{ window: 20 }, { window: 60 }] });
  expect(asked.notes!.join(" ")).not.toContain("bar window");
  const every = (await report({ showIv: false }, short)).result;
  expect((every.metadata!.model as { shortWindows: number[] }).shortWindows).toEqual([180, 260]);
  expect(every.notes!.join(" ")).toContain("the 180- and 260-bar windows need more");
});

test("HVG's export has the daily series it draws, a column per window in percent, newest first", async () => {
  // The series was in JSON only, as fractions: a spreadsheet had the cone and nothing to chart.
  const { result } = await report({ windows: "20", showIv: false });
  const history = (result.sections as HeadlessBundleSection[]).find((section) => section.title === "History")!;
  expect(history.columns!.map((column) => column.header)).toEqual(["Date", "HV20"]);
  const model = result.metadata!.model as { series: Array<{ date: Date; values: Record<number, number | null> }> };
  expect(history.rows).toHaveLength(model.series.length);
  const newest = model.series.at(-1)!;
  expect(history.rows![0]).toEqual({ date: newest.date.toISOString().slice(0, 10), hv20: newest.values[20] });
  expect(history.columns![1]!.format!(newest.values[20], {})).toBe(`${(newest.values[20]! * 100).toFixed(2)}%`);
  // The text report prints the latest sessions.
  expect(history.textRows).toHaveLength(10);
});
