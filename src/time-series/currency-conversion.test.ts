import { expect, test } from "bun:test";
import type { FxCloses } from "../market-data/fx-closes";
import { currencySeries } from "./currency-conversion";
import type { ResolvedSeries, TimeSeriesPoint } from "./types";

const closes = (currency: string, byDay: Record<string, number>): FxCloses => {
  const days = Object.keys(byDay).sort();
  return { currency, closes: new Map(Object.entries(byDay)), first: days[0]!, asOf: days.at(-1)! };
};
const bar = (day: string, close: number): TimeSeriesPoint => ({
  date: new Date(`${day}T00:00:00Z`), observedAt: new Date(`${day}T00:00:00Z`), value: close, close, open: close, volume: 1000,
});
const series = (unit: string, points: TimeSeriesPoint[]) => ({ id: "a", label: "THYAO:BIST Close", unit, unitGroup: `price:${unit.split("/")[0]}`, points }) as unknown as ResolvedSeries;
const dayOf = (point: TimeSeriesPoint) => point.date.toISOString().slice(0, 10);

test("a lira price converts at its day's close into dollars and euros, a weekend bar at Friday's, and a week with no close leaves it out", async () => {
  // USD per lira, and per euro.
  const lira = closes("TRY", { "2025-11-05": 1 / 42, "2025-11-07": 1 / 42.2, "2026-11-05": 1 / 50 });
  const euro = closes("EUR", { "2025-11-05": 1.15, "2025-11-07": 1.16, "2026-11-05": 1.08 });
  const loads: string[] = [];
  const loadCloses = async (currency: string, start: string) => {
    loads.push(`${currency} ${start}`);
    return currency === "TRY" ? lira : euro;
  };
  const thyao = series("TRY/share", [bar("2025-11-05", 294.5), bar("2025-11-08", 296), bar("2026-06-01", 310), bar("2026-11-06", 299.25)]);
  const dollars = await currencySeries(thyao, { target: "USD", priceCurrency: "TRY", loadCloses, dayOf });
  expect(loads).toEqual(["TRY 2025-11-05"]);
  expect(dollars.series).toMatchObject({ unit: "USD/share", unitGroup: "price:USD", convertedFrom: "TRY" });
  const values = dollars.series.points.map((point) => [dayOf(point), point.close, point.volume]);
  // Saturday reads Friday's close; today, not closed yet, the last completed one; June has none in the week before it.
  expect(values).toEqual([["2025-11-05", 294.5 / 42, 1000], ["2025-11-08", 296 / 42.2, 1000], ["2026-11-06", 299.25 / 50, 1000]]);
  expect(dollars.notice).toBe("1 bar with no TRY/USD close in the week before left out.");
  // Neither side in dollars: through both.
  const euros = await currencySeries(thyao, { target: "EUR", priceCurrency: "TRY", loadCloses, dayOf });
  expect(euros.series.points[0]!.close).toBeCloseTo((294.5 / 42) / 1.15, 12);
  // Already in the currency asked for: untouched, nothing read.
  loads.length = 0;
  expect((await currencySeries(thyao, { target: "TRY", priceCurrency: "TRY", loadCloses, dayOf })).series).toBe(thyao);
  expect(loads).toEqual([]);
});

test("pence are pounds over 100, and a pair with no closes leaves the leg in its own currency, saying so", async () => {
  const vod = series("GBp/share", [bar("2026-11-05", 75)]);
  const pounds = await currencySeries(vod, { target: "GBP", priceCurrency: "GBp", loadCloses: async () => { throw new Error("not read"); }, dayOf });
  expect(pounds.series.points[0]!.close).toBeCloseTo(0.75, 12);
  expect(pounds.series.unit).toBe("GBP/share");
  const failed = await currencySeries(vod, { target: "USD", priceCurrency: "GBp", loadCloses: async () => { throw new Error("503"); }, dayOf });
  expect(failed.series).toBe(vod);
  expect(failed.notice).toBe("GBP/USD daily closes unavailable; left in GBP.");
});
