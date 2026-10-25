import { expect, test } from "bun:test";
import { realizedVolatility } from "../shared/volatility";
import { ivSymbol, loadIvHistory, loadIvScreen, loadStoredSurface, loadSurfaceDates, screenHv } from "./client";

test("listing keys reach Cloud IV as bare US symbols", async () => {
  const paths: string[] = [];
  const api = { impliedVolatility: async (path: string) => { paths.push(path); return {} as never; } };
  await loadIvHistory("SPY:ARCX", { days: 30 }, api);
  await loadSurfaceDates("amd:xnas", {}, api);
  await loadStoredSurface("SPY:ARCX", "2026-09-23", {}, api);
  await loadIvScreen(["SPY:ARCX", "AAPL"], {}, api);
  expect(paths).toEqual([
    "history?symbol=SPY&days=30",
    "surface-dates?symbol=AMD",
    "surface?symbol=SPY&date=2026-09-23",
    "screen?symbols=SPY%2CAAPL",
  ]);
  expect(ivSymbol("BRK.B")).toBe("BRK.B");
});

test("a symbol's HV is kept after every session, ending on the figure VCA's HV20 shows", () => {
  const closes = Array.from({ length: 40 }, (_, index) => ({ date: new Date(Date.UTC(2026, 8, 1 + index)), close: 100 + (index % 3) * 2 + index * 0.1 }));
  const hv = screenHv(closes, 20);
  expect(hv.value).toBe(realizedVolatility(closes, 20));
  expect(hv.date).toBe("2026-10-10");
  // Twenty returns need twenty-one closes: the first window ends on the twenty-first.
  expect(hv.series).toHaveLength(20);
  expect(hv.series[0]![0]).toBe("2026-09-21");
  expect(hv.series.at(-1)).toEqual(["2026-10-10", hv.value!]);
  // Weekly bars from a provider fallback would misstate daily HV: none is given.
  expect(screenHv(Array.from({ length: 30 }, (_, index) => ({ date: new Date(Date.UTC(2026, 0, 1 + index * 7)), close: 100 + index })), 20))
    .toEqual({ value: null, date: null, series: [] });
});
