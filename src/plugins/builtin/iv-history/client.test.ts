import { expect, test } from "bun:test";
import { ivSymbol, loadIvHistory, loadIvScreen, loadStoredSurface, loadSurfaceDates } from "./client";

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
