import { afterEach, expect, test } from "bun:test";
import { setCloudApiFetchTransport } from "../../../api-client";
import type { CdxBoardIndex, CdxBoardPayload } from "../../../api-client/credit-boards";
import type { SeriesLoadResult } from "../../../series/types";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import { cdxBoardCache } from "./client";
import { CREDIT_BOARD_SERIES } from "./series";

afterEach(() => {
  setCloudApiFetchTransport(null);
  cdxBoardCache.reset();
});

/** HY's daily price and spread equivalent from `from` for `days` days, on one contract. */
function hy(from: string, days: number): CdxBoardIndex {
  const points = Array.from({ length: days }, (_, day) => ({
    date: new Date(Date.parse(`${from}T00:00:00Z`) + day * 86_400_000).toISOString().slice(0, 10),
    level: 106 - day / 100, prints: 300, maturity: "2031-12-20", spreadBp: 340 + day / 10,
  }));
  const last = points.at(-1)!;
  return { id: "HY", name: "CDX HY", quote: "price", currency: "USD", couponBp: 500, recovery: 0.3, date: last.date, maturity: last.maturity,
    level: last.level, prints: 300, spreadBp: last.spreadBp, change1D: null, change1W: null, points } as CdxBoardIndex;
}

test("HY's spread equivalent charts in bp from its daily history, reaching past the board's year when the chart starts earlier", async () => {
  cdxBoardCache.attach(new MemoryPluginPersistence());
  const asked: string[] = [];
  const board = (days: number): CdxBoardPayload => ({ source: "DTCC PPD", asOf: null, tenor: "5Y",
    indexes: [days > 365 ? hy("2024-09-30", 700) : hy("2025-09-01", 365)] });
  setCloudApiFetchTransport(async (url) => {
    const days = Number(new URL(String(url)).searchParams.get("days"));
    asked.push(String(days));
    return Response.json(board(days));
  });
  const series = CREDIT_BOARD_SERIES.find((entry) => entry.id === "cdx:hy-spread")!;
  expect(series).toMatchObject({ name: "CDX HY 5Y spread eq", unit: "bp" });

  // A year back is the board's own year.
  const year = await series.load!({ start: new Date("2025-09-05T00:00:00Z") }) as SeriesLoadResult;
  expect(year.points[0]).toEqual({ date: "2025-09-01", value: 340 });
  expect(year.points).toHaveLength(365);
  expect(asked).toEqual(["365"]);

  // ALL reaches back to the server's first day.
  const all = await series.load!({}) as SeriesLoadResult;
  expect(all.points[0]).toEqual({ date: "2024-09-30", value: 340 });
  expect(all.points).toHaveLength(700);
  expect(asked).toEqual(["365", "1100"]);
});
