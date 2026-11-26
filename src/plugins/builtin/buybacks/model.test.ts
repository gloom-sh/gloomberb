import { describe, expect, test } from "bun:test";
import type { BuybackDay, BuybacksPayload } from "../../../api-client/buybacks";
import { boughtKnownFrom, boughtPoints, cellText, lastBoughtFigure, mandateUsedPercent, ofAuthorised } from "./model";

const sum = { shares: 0, sharesOnExchange: 0, paidOnExchange: 0, percentOfVolume: 0, days: 0, sessions: 5 };
const day: BuybackDay = {
  date: "2026-10-15", shares: 240_000, sharesOnExchange: 240_000, paidOnExchange: 100_385_040, currency: "HKD", average: 418.271,
  high: 422.4, low: 414.2, volume: 20_676_017, percentOfVolume: 1.161, venues: [{ venue: "HKEX", shares: 240_000, paid: 100_385_040, currency: "HKD", high: 422.4, low: 414.2 }],
  destination: "cancel", mandateUsed: 50_465_700, inBlackout: null,
  filing: { url: "https://www1.hkexnews.hk/listedco/listconews/sehk/2026/1015/2026101500641.pdf", publishedAt: "2026-10-15T17:29:00+08:00", revised: false, multiDay: false },
};
const sessions = ["2026-10-15", "2026-10-16", "2026-10-19", "2026-10-20"];
const payload = (lastBuy: string | null): BuybacksPayload => ({
  symbol: "0700:HKEX", name: "Tencent Holdings Limited", status: "available", asOf: null, asOfSession: "2026-10-20", heldFrom: "2024-06-11",
  access: "full", totalDays: 1, previewDays: null, lockedDays: 0, truncated: false, currency: "HKD",
  mandate: { resolutionDate: "2026-05-13", authorised: 911_799_163, repurchased: 50_465_700, left: 861_333_463, usedPercent: 5.53, percentOfIssued: 0.55, asOf: "2026-10-15", filing: day.filing.url },
  shares: null, summary: { last5: sum, last20: { ...sum, sessions: 20 }, ytd: sum, lastBuy, state: lastBuy ? "paused" : "none" },
  blackout: { current: null, next: null, windows: [], daysToNext: null }, otherClasses: [],
  history: sessions.map((date) => ({ date, close: 400, volume: 1 })), days: lastBuy ? [day] : [],
});

describe("buybacks model", () => {
  test("with no buy in the span, one line says when the last was", () => {
    expect(lastBoughtFigure(payload("2026-10-15"))).toEqual({ value: "15 Oct 2026", detail: "3 sessions ago" });
    expect(lastBoughtFigure(payload(null))).toEqual({ value: "none", detail: "since 11 Jun 2024" });
  });

  test("the mandate used is a share of what it authorises, never of the shares in issue", () => {
    const data = payload("2026-10-15");
    expect(cellText(day, "mandateUsed")).toBe("50.47M");
    expect(ofAuthorised(mandateUsedPercent(day, data), data.mandate?.authorised)).toBe("5.5% of 911.80M authorised");
    expect(ofAuthorised(null, 1)).toBeNull();
  });

  describe("the chart's buying", () => {
    // Six sessions; bought on the 2nd (in Hong Kong and London), 4th and 6th.
    const dates = ["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-19"];
    const bought = (date: string, onExchange: number, elsewhere = 0): BuybackDay => ({
      ...day, date, shares: onExchange + elsewhere, sharesOnExchange: onExchange,
      venues: [{ ...day.venues[0]!, shares: onExchange }, ...(elsewhere ? [{ venue: "LSE", shares: elsewhere, paid: null, currency: "GBP", high: null, low: null }] : [])],
    });
    const all = [bought("2026-10-13", 100, 50), bought("2026-10-15", 200), bought("2026-10-19", 300)];
    const chart = (access: BuybacksPayload["access"], days: BuybackDay[], lockedDays: number): BuybacksPayload => ({
      ...payload("2026-10-19"), access, totalDays: days.length + lockedDays, previewDays: access === "preview" ? 2 : null, lockedDays, truncated: lockedDays > 0,
      history: dates.map((date) => ({ date, close: 400, volume: 1 })), days,
    });
    const values = (data: BuybacksPayload, where: "exchange" | "elsewhere") => boughtPoints(data, where).map((point) => point.value);

    test("the full history: every session, zero where nothing was bought, on the Exchange and elsewhere", () => {
      const data = chart("full", all, 0);
      expect(boughtKnownFrom(data)).toBeNull();
      expect(values(data, "exchange")).toEqual([0, 100, 0, 200, 0, 300]);
      expect(values(data, "elsewhere")).toEqual([0, 50, 0, 0, 0, 0]);
      expect(boughtPoints(data, "exchange").map((point) => point.date.toISOString().slice(0, 10))).toEqual(dates);
    });

    test("a preview withholding older sessions: blank before the oldest sent, zero only where a session is known to have none", () => {
      // The newest two sent, the 13 Oct buy withheld.
      const data = chart("preview", all.slice(1), 1);
      expect(boughtKnownFrom(data)).toBe("2026-10-15");
      expect(values(data, "exchange")).toEqual([null, null, null, 200, 0, 300]);
      expect(values(data, "elsewhere")).toEqual([null, null, null, 0, 0, 0]);
      // Each session keeps its place, so the close above stays aligned with it.
      expect(boughtPoints(data, "exchange")).toHaveLength(dates.length);
    });

    test("a preview that withholds nothing draws like the full history", () => {
      const data = chart("preview", all, 0);
      expect(boughtKnownFrom(data)).toBeNull();
      expect(values(data, "exchange")).toEqual([0, 100, 0, 200, 0, 300]);
    });

    test("every session withheld: no buying is known", () => {
      expect(values(chart("preview", [], 3), "exchange")).toEqual([null, null, null, null, null, null]);
    });
  });
});
