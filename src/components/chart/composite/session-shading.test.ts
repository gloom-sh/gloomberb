import { expect, test } from "bun:test";
import { createTestResolvedSeries } from "../../../test-support/time-series";
import { extendedHoursSpans } from "./session-shading";

const NASDAQ_30M = createTestResolvedSeries({
  id: "px",
  points: [],
  historyResolution: "30m",
  timeBasis: { kind: "market", timeZone: "America/New_York", exchange: "NASDAQ", cadenceMs: 1_800_000 },
});

test("shades pre-market and after-hours bars, and after an early close, on intraday charts", () => {
  const dates = [
    "2026-11-25T13:00:00Z", // 08:00 New York, pre-market
    "2026-11-25T14:30:00Z", // the open
    "2026-11-25T20:30:00Z",
    "2026-11-25T21:00:00Z", // 16:00, the close
    "2026-11-25T21:30:00Z",
    "2026-11-27T17:30:00Z", // the day after Thanksgiving closes at 13:00
    "2026-11-27T18:00:00Z",
  ].map((iso) => new Date(iso));
  const ratios = dates.map((_date, index) => index / 6);
  const spans = extendedHoursSpans(NASDAQ_30M, dates, ratios);
  // Each span reaches halfway to the bars beside it.
  expect(spans.map(({ start, end }) => [start, end].map((ratio) => Math.round(ratio * 12)))).toEqual([[0, 1], [5, 9], [11, 12]]);

  expect(extendedHoursSpans({ ...NASDAQ_30M, historyResolution: "1d", timeBasis: { ...NASDAQ_30M.timeBasis!, cadenceMs: 86_400_000 } }, dates, ratios)).toEqual([]);
  expect(extendedHoursSpans({ ...NASDAQ_30M, timeBasis: { ...NASDAQ_30M.timeBasis!, exchange: undefined } }, dates, ratios)).toEqual([]);
});
