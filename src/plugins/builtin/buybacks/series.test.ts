import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { apiClient } from "../../../api-client";
import type { BuybackDay, BuybacksPayload } from "../../../api-client/buybacks";
import type { SeriesPoint } from "../../../series/types";
import { BUYBACK_SERIES } from "./series";

const sum = { shares: 0, sharesOnExchange: 0, paidOnExchange: 0, percentOfVolume: 0, days: 0, sessions: 5 };
// HSBC-like: one session bought in Hong Kong and in London.
const day: BuybackDay = {
  date: "2026-11-19", shares: 900_000, sharesOnExchange: 600_000, paidOnExchange: 77_000_000, currency: "HKD", average: 128.3,
  high: 129, low: 127.5, volume: 20_000_000, percentOfVolume: 3,
  venues: [{ venue: "HKEX", shares: 600_000, paid: 77_000_000, currency: "HKD", high: 129, low: 127.5 }, { venue: "LSE", shares: 300_000, paid: 3_900_000, currency: "GBP", high: 13.1, low: 12.9 }],
  destination: "cancel", mandateUsed: 1_000_000, inBlackout: null,
  filing: { url: "https://www1.hkexnews.hk/listedco/listconews/sehk/2026/1119/2026111900001.pdf", publishedAt: "2026-11-19T19:00:00+08:00", revised: false, multiDay: false },
};
const payload = (access: BuybacksPayload["access"]): BuybacksPayload => ({
  symbol: "0005:HKEX", name: "HSBC Holdings plc", status: "available", asOf: null, asOfSession: "2026-11-20", heldFrom: "2024-06-11",
  access, totalDays: 1, previewDays: access === "preview" ? 10 : null, lockedDays: 0, truncated: false, currency: "HKD",
  mandate: null, shares: null, summary: { last5: sum, last20: { ...sum, sessions: 20 }, ytd: sum, lastBuy: day.date, state: "buying" },
  blackout: { current: null, next: null, windows: [], daysToNext: null }, otherClasses: [],
  history: ["2026-11-18", "2026-11-19", "2026-11-20"].map((date) => ({ date, close: 128, volume: 20_000_000 })), days: [day],
});

const series = (id: string) => BUYBACK_SERIES.find((definition) => definition.id === id)!;
const load = (id: string, ticker: string) => {
  const definition = series(id);
  if (!("load" in definition) || !definition.load) throw new Error(`${id} loads nothing`);
  return Promise.resolve(definition.load({ ticker })) as Promise<readonly SeriesPoint[]>;
};
const values = (points: readonly SeriesPoint[]) => points.map((point) => [new Date(point.date).toISOString().slice(0, 10), point.value]);

const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

describe("buyback series", () => {
  test("each session's shares, on the Exchange and elsewhere, 0 on a session without a buy", async () => {
    const asked: string[] = [];
    spies.push(spyOn(apiClient, "getCloudBuybacks").mockImplementation(async (symbol) => {
      asked.push(symbol);
      return payload("full");
    }));
    expect(values(await load("buybacks:shares", "5.HK"))).toEqual([["2026-11-18", 0], ["2026-11-19", 600_000], ["2026-11-20", 0]]);
    expect(values(await load("buybacks:shares-elsewhere", "0005:HKEX"))).toEqual([["2026-11-18", 0], ["2026-11-19", 300_000], ["2026-11-20", 0]]);
    expect(asked).toEqual(["0005:HKEX", "0005:HKEX"]);
  });

  test("the free preview, a listing outside Hong Kong and one not held say so", async () => {
    spies.push(spyOn(apiClient, "getCloudBuybacks").mockImplementation(async () => payload("preview")));
    await expect(load("buybacks:shares", "0005.HK")).rejects.toThrow("requires Pro");
    await expect(load("buybacks:shares", "AAPL")).rejects.toThrow("Hong Kong listings");
    spies.push(spyOn(apiClient, "getCloudBuybacks").mockImplementation(async () => ({ ...payload("full"), status: "unavailable", days: [] })));
    await expect(load("buybacks:shares", "0005.HK")).rejects.toThrow("No buyback returns are held for 0005:HKEX");
  });
});
