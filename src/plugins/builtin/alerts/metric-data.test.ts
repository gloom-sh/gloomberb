import { expect, test } from "bun:test";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { historyRows } from "../../../cli/history-rows";
import { getPublishedUsEquitySession } from "../../../market-data/published-us-sessions";
import { withSessionBar } from "../../../time-series/session-bar";
import type { PricePoint } from "../../../types/financials";
import { firstDailyCheck, metricReadings } from "./metric-data";
import { formatCurrentPrice, formatQuoteChecked } from "./format";
import type { AlertRule } from "./types";

const rule: AlertRule = { id: "cache", symbol: "TSLA", exchange: "NASDAQ", metric: { kind: "close_ma", period: 2 }, condition: "below", targetPrice: 0, status: "active", createdAt: 1 };
const days = ["2026-10-22", "2026-10-23", "2026-10-26"];
const bars = days.map(date => ({ date: new Date(date), open: 100, high: 100, low: 90, close: 90, volume: 1 }));

test("daily reads share a settled window across polls, then refresh at the next settled close without financials", async () => {
  const ends: string[] = [];
  const provider = createTestDataProvider({
    getTickerFinancials: async () => { throw new Error("Daily rules must not load financials"); },
    getPriceHistory: async () => { throw new Error("Daily rules must not request a forming window"); },
    getDetailedPriceHistory: async (_symbol, _exchange, _start, end) => { ends.push(end.toISOString().slice(0, 10)); return bars; },
  });
  const read = (time: string, r = rule) => metricReadings(provider, Date.parse(time))(r);
  const first = await read("2026-10-23T20:30Z");
  expect(await read("2026-10-23T20:31Z")).toBe(first);
  expect(await read("2026-10-26T20:15Z")).toBe(first);
  expect((await read("2026-10-26T20:30Z")).day).toBe("2026-10-26");
  expect(ends).toEqual(["2026-10-23", "2026-10-26"]);
  await read("2026-10-26T20:31Z", { ...rule, armedAt: 2 });
  expect(ends).toHaveLength(3);
});

test("a daily rule judges the closes history shows as final, read in history's bar size", async () => {
  // XLK's sessions to Mon 26 Oct 2026, each bar dated by its day as the data service dates daily bars.
  const days: string[] = [];
  for (let time = Date.parse("2026-08-03"); time <= Date.parse("2026-10-26"); time += 86_400_000) {
    const day = new Date(time).toISOString().slice(0, 10);
    if (getPublishedUsEquitySession("ARCA", day)?.kind === "session") days.push(day);
  }
  const bars = (marks: Record<string, Partial<PricePoint>> = {}): PricePoint[] => days.map((day, index) => ({
    date: new Date(day), open: 180, high: 190, low: 170, close: 180 + (index % 7), volume: 1, ...marks[day],
  }));
  const rsi: AlertRule = { id: "xlk", symbol: "XLK", exchange: "ARCA", metric: { kind: "rsi", period: 14 }, condition: "above", targetPrice: 70, status: "active", createdAt: 1 };
  // What `history XLK` shows as final at `now`: its rows without `partial`, from the same bars and session rule.
  const historyFinal = (served: PricePoint[], now: number) =>
    historyRows(withSessionBar(served, null, { now, venue: "ARCA" }), null).filter((row) => !row.partial).at(-1)?.date;
  const read = async (served: PricePoint[], now: number) => {
    const sizes: string[] = [];
    // The data service answers the bar size `history` asks for, and no bars for a size it does not know.
    const provider = createTestDataProvider({
      getDetailedPriceHistory: async (_symbol, _exchange, _start, end, size) => {
        sizes.push(size);
        return size === "1d" ? served.filter((bar) => bar.date.getTime() <= end.getTime()) : [];
      },
    });
    const reading = await metricReadings(provider, now)(rsi).then((value) => value.day, (error: Error) => error.message);
    return { reading, sizes };
  };

  // Tue 06:35 UTC: history shows Monday's close as final, and the rule reads it.
  const tuesday = Date.parse("2026-10-27T06:35:00Z");
  expect(historyFinal(bars(), tuesday)).toBe("2026-10-26");
  expect(await read(bars(), tuesday)).toEqual({ reading: "2026-10-26", sizes: ["1d"] });
  // A close the source still marks partial is partial in history too, and the rule waits for it.
  const unsettled = bars({ "2026-10-26": { partial: true } });
  expect(historyFinal(unsettled, tuesday)).toBe("2026-10-23");
  expect((await read(unsettled, tuesday)).reading).toBe("Waiting for the 2026-10-26 daily close.");
  // Mon 18:00 UTC, the session trading: the day's snapshot is no close in history, nor for the rule, which reads Friday's.
  const monday = Date.parse("2026-10-26T18:00:00Z");
  expect(historyFinal(bars(), monday)).toBe("2026-10-23");
  expect((await read(bars(), monday)).reading).toBe("2026-10-23");
  // A rule set then is first judged on Monday's close, once it has settled; one set on Tuesday morning, on Tuesday's.
  expect(firstDailyCheck("ARCA", monday)).toEqual({ day: "2026-10-26", at: Date.parse("2026-10-26T20:30:00Z") });
  expect(firstDailyCheck("ARCA", tuesday)).toEqual({ day: "2026-10-27", at: Date.parse("2026-10-27T20:30:00Z") });
});

test("missing history retries after a backoff and gives the row a visible reason; unsupported venues read nothing", async () => {
  let calls = 0;
  const provider = createTestDataProvider({ getDetailedPriceHistory: async () => ++calls === 1 ? [] : bars });
  const at = Date.parse("2026-10-23T20:30Z");
  await expect(metricReadings(provider, at)(rule)).rejects.toThrow("Waiting");
  await expect(metricReadings(provider, at + 30_000)(rule)).rejects.toThrow("Waiting");
  expect(calls).toBe(1);
  expect((await metricReadings(provider, at + 5 * 60_000)(rule)).day).toBe("2026-10-23");
  const unsupported = { ...rule, exchange: "LSE" };
  await expect(metricReadings(provider, at)(unsupported)).rejects.toThrow("delivery is unavailable");
  expect(calls).toBe(2);
  expect(formatCurrentPrice({ ...rule, lastCheckError: "Daily history is missing 2026-10-22." })).toBe("Bar gap");
  expect(formatCurrentPrice({ ...unsupported, lastCheckError: "Daily technical alerts need a published US listing calendar." })).toBe("US only");
  expect(formatQuoteChecked({ ...rule, lastCheckError: "Daily history is missing 2026-10-22." })).toBe("on daily close");
});
