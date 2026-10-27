import { expect, test } from "bun:test";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { metricReadings } from "./metric-data";
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
    getDetailedPriceHistory: async (_symbol, _exchange, _start, end, barSize) => { ends.push(`${end.toISOString().slice(0, 10)} ${barSize}`); return bars; },
  });
  const read = (time: string, r = rule) => metricReadings(provider, Date.parse(time))(r);
  const first = await read("2026-10-23T20:30Z");
  expect(await read("2026-10-23T20:31Z")).toBe(first);
  expect(await read("2026-10-26T20:15Z")).toBe(first);
  expect((await read("2026-10-26T20:30Z")).day).toBe("2026-10-26");
  expect(ends).toEqual(["2026-10-23 1d", "2026-10-26 1d"]);
  await read("2026-10-26T20:31Z", { ...rule, armedAt: 2 });
  expect(ends).toHaveLength(3);
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
