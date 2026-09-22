import { publishedWeekClose } from "../analytics/sharpe-cadence";
import { expect, test } from "bun:test";
import {
  buildRotation,
  rotationCloses,
  rotationInstruments,
  rotationQuadrant,
  rotationTrailWeeks,
  type RotationHistory,
} from "./model";
import { fetchRotation, validateRotationHistory } from "./client";
const DAY = 86_400_000;
const benchmark = { symbol: "SPY", exchange: "NYSEARCA", label: "SPY" };
function history(symbol: string, ratios: number[]): RotationHistory {
  return {
    instrument: { ...benchmark, symbol, label: symbol },
    currency: "USD",
    asOf: null,
    stale: false,
    error: null,
    points: ratios.map((value, index) => ({
      date: publishedWeekClose(
        new Date(Date.parse("2025-01-03") + index * 7 * DAY)
          .toISOString()
          .slice(0, 10),
        "ARCA",
      )!,
      close: value * 100,
    })),
  };
}
test("relative normalization has scale invariance, stable neutral baseline and no use of incomplete weeks", () => {
  const reference = history("SPY", Array(90).fill(1)),
    asset = history("XLK", Array(90).fill(2));
  const data = buildRotation(
      reference,
      [asset],
      6,
      new Date("2026-09-22T12:00:00Z"),
    ),
    row = data.rows[0]!;
  expect(row.strength).toBe(100);
  expect(row.momentum).toBe(100);
  expect(row.quadrant).toBe("Neutral");
  expect(row.strengthRank.percentile).toBe(50);
  expect(row.trail).toHaveLength(6);
  reference.points.push({ date: "2026-09-21", close: 100 });
  asset.points.push({ date: "2026-09-21", close: 1000 });
  expect(
    buildRotation(reference, [asset], 6, new Date("2026-09-22T12:00:00Z"))
      .rows[0]!.strength,
  ).toBe(100);
  expect(rotationQuadrant(101, 99)).toBe("Weakening");
  expect(rotationQuadrant(99, 101)).toBe("Improving");
});
test("missing matched sessions and contradictory duplicates break continuity instead of crossing gaps", () => {
  const ratios = Array.from({ length: 90 }, (_, i) => 1 + i * 0.01),
    asset = history("XLK", ratios),
    reference = history("SPY", Array(90).fill(1));
  const before = buildRotation(reference, [asset], 6, new Date("2026-09-22"));
  expect(before.rows[0]!.strength).toBeGreaterThan(100);
  asset.points.splice(87, 1);
  const missing = buildRotation(reference, [asset], 6, new Date("2026-09-22"))
    .rows[0]!;
  expect(missing.strength).toBeNull();
  expect(missing.trail).toEqual([]);
  const date = reference.points.at(-1)!.date;
  expect(
    rotationCloses(
      [
        { date, close: 1 },
        { date, close: 2 },
      ],
      "2026-09-22",
    ).size,
  ).toBe(0);
  expect(rotationCloses([{ date, close: 0 }], "2026-09-22").size).toBe(0);
});
test("currency mismatch, short history and no-lookahead ranks stay explicit", () => {
  const reference = history("SPY", Array(90).fill(1)),
    asset = history(
      "XLK",
      Array.from({ length: 90 }, (_, i) => 1 + i * 0.01),
    );
  asset.currency = "EUR";
  expect(
    buildRotation(reference, [asset], 6, new Date("2026-09-22")).rows[0]!
      .strength,
  ).toBeNull();
  asset.currency = "USD";
  asset.points = asset.points.slice(-17);
  const row = buildRotation(reference, [asset], 6, new Date("2026-09-22"))
    .rows[0]!;
  expect(row.momentum).not.toBeNull();
  expect(row.momentumRank.percentile).toBeNull();
  expect(row.momentumRank.samples).toBe(1);
  const limited = buildRotation(reference, [asset], 6, new Date("2026-07-01"));
  expect(
    limited.rows[0]!.history.every((point) => point.date < "2026-07-01"),
  ).toBe(true);
});
test("Cloud boundary rejects intraday masquerading as daily data and invalid custom scope", () => {
  expect(() =>
    validateRotationHistory({
      status: "success",
      data: [{ date: "2026-09-21", close: 1 }],
      providerMeta: { servedResolution: "15min" },
    }),
  ).toThrow("daily bars");
  expect(() =>
    validateRotationHistory({
      status: "success",
      data: [{ date: "2026-09-21", close: NaN }],
    }),
  ).toThrow("Invalid daily");
  expect(rotationInstruments("AAPL:NASDAQ AAPL,AAPL:NASDAQ")).toHaveLength(2);
  expect(() =>
    rotationInstruments(
      Array.from({ length: 25 }, (_, i) => `S${i}`).join(","),
    ),
  ).toThrow("at most");
});

test("Cloud currency and listing provenance cannot be overridden by a valid quote", async () => {
  const reference = history("SPY", Array(90).fill(1)),
    asset = history("XLK", Array(90).fill(2));
  const data = await fetchRotation(
    reference.instrument,
    [asset.instrument],
    6,
    {
      getCloudQuotesBatch: async () => ({
        status: "success",
        data: {
          items: [reference, asset].map((row) => ({
            symbol: row.instrument.symbol,
            exchange: "NYSEARCA",
            status: "success",
            data: { currency: "USD" } as any,
          })),
        },
      }),
      getCloudHistory: async (symbol) => ({
        status: "success",
        currency: symbol === "XLK" ? "EUR" : "USD",
        data: symbol === "XLK" ? asset.points : reference.points,
      }),
    },
    new Date("2026-09-22"),
  );
  expect(data.rows[0]!.strength).toBeNull();
  expect(data.rows[0]!.gaps.join(" ")).toContain("currency does not match");
  expect(() =>
    validateRotationHistory(
      {
        status: "success",
        data: asset.points,
        providerMeta: { normalizedSymbol: "XLF" },
      },
      asset.instrument,
      "USD",
    ),
  ).toThrow("listing identity");
});

test("calendar gaps, canonical aliases and screenshot trail settings stay consistent", () => {
  expect(publishedWeekClose("2026-07-03", "NYSEARCA")).toBe("2026-07-02");
  expect(publishedWeekClose("2026-09-18", "NYSEARCA")).toBe("2026-09-18");
  expect(publishedWeekClose("2026-09-18", "LSE")).toBeNull();
  expect(rotationInstruments("SPY:NYSEARCA SPY:ARCA")).toHaveLength(1);
  expect(rotationTrailWeeks(3)).toBe(3);
  const reference = history("SPY", Array(90).fill(1)),
    asset = history("XLK", Array(90).fill(2));
  reference.points.at(-1)!.date = "2026-09-17";
  asset.points.at(-1)!.date = "2026-09-17";
  const data = buildRotation(reference, [asset], 3, new Date("2026-09-22"));
  expect(data.asOf).not.toBe("2026-09-17");
  expect(data.gaps.join(" ")).toContain(
    "missing its verified 2026-09-18 close",
  );
  asset.currency = "EUR";
  const mismatched = buildRotation(
    reference,
    [asset],
    3,
    new Date("2026-09-22"),
  ).rows[0]!;
  expect(
    mismatched.history.every(
      (point) => point.strength == null && point.momentum == null,
    ),
  ).toBe(true);
  expect(mismatched.strengthRank.samples).toBe(0);
});
