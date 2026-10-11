import { afterEach, expect, setSystemTime, test } from "bun:test";
import { AppPersistence } from "../../data/app-persistence";
import type { DataProvider } from "../../types/data-provider";
import type { PricePoint } from "../../types/financials";
import type { PriceHistoryResult } from "../../types/price-history";
import { fallbackProvider } from "../../test-support/data-provider";
import { AssetDataRouter } from "./index";

// One-day history saved in the middle of a session and read once that session
// is over, the way the CLI asks: no exchange, the venue read off the symbol.
// Five-minute bars as Gloom Cloud serves them, in UTC. An intraday copy
// expires two days after it is saved, so Friday's copies are read over the
// weekend: by Monday morning every venue's Friday copy has expired and is
// fetched again anyway.

const MIN = 60_000;

/** Five-minute bars from `first` to `last`, inclusive, each closing at `close`. */
function bars(first: string, last: string, close = 100): PricePoint[] {
  const points: PricePoint[] = [];
  for (let time = Date.parse(first); time <= Date.parse(last); time += 5 * MIN) {
    points.push({ date: new Date(time), open: close, high: close, low: close, close, volume: 1_000 });
  }
  return points;
}

interface Row {
  what: string;
  symbol: string;
  /** The bars of a copy saved mid-session, and when it was saved. */
  partial: { savedAt: string; points: PricePoint[] };
  /** The whole session as the source serves it after the close. */
  full: PricePoint[];
  readAt: string[];
}

const ROWS: Row[] = [
  {
    // 09:30 to 16:00 New York. Saved at 10:00, as in the report: three bars.
    what: "US, Friday's copy on the weekend",
    symbol: "AAPL",
    partial: { savedAt: "2026-10-09T14:00:00Z", points: bars("2026-10-09T13:30:00Z", "2026-10-09T13:40:00Z") },
    full: bars("2026-10-09T13:30:00Z", "2026-10-09T19:55:00Z"),
    readAt: ["2026-10-10T18:30:00Z", "2026-10-11T12:00:00Z"],
  },
  {
    // 09:30 to 16:10 Hong Kong, with the pre-opening session's bars from 09:15. Saved at 11:30.
    what: "HKEX, Friday's copy on the weekend",
    symbol: "0700.HK",
    partial: { savedAt: "2026-10-09T03:30:00Z", points: bars("2026-10-09T01:15:00Z", "2026-10-09T03:10:00Z") },
    full: bars("2026-10-09T01:15:00Z", "2026-10-09T08:05:00Z"),
    readAt: ["2026-10-10T12:00:00Z", "2026-10-11T00:30:00Z"],
  },
  {
    // National Day, Thursday 1 October, is a published closure: Wednesday's session stays the latest.
    what: "HKEX, Wednesday's copy on Thursday's holiday",
    symbol: "0700.HK",
    partial: { savedAt: "2026-09-30T03:30:00Z", points: bars("2026-09-30T01:15:00Z", "2026-09-30T03:10:00Z") },
    full: bars("2026-09-30T01:15:00Z", "2026-09-30T08:05:00Z"),
    readAt: ["2026-10-01T06:00:00Z"],
  },
  {
    // Tel Aviv closes early on Fridays: 09:59 to 13:29 for the last bar. Saved at 11:30.
    what: "TASE, Friday's copy on the weekend",
    symbol: "LUMI.TA",
    partial: { savedAt: "2026-10-09T08:30:00Z", points: bars("2026-10-09T06:59:00Z", "2026-10-09T08:09:00Z") },
    full: bars("2026-10-09T06:59:00Z", "2026-10-09T10:29:00Z"),
    readAt: ["2026-10-10T12:00:00Z", "2026-10-11T05:00:00Z"],
  },
  {
    // The FX week closes Friday 17:00 New York (21:00 UTC); the source's day
    // ends at London midnight. Saved Friday at noon UTC: the latest 288 bars.
    what: "FX, Friday's copy on the weekend",
    symbol: "EURUSD=X",
    partial: { savedAt: "2026-10-09T12:00:00Z", points: bars("2026-10-08T12:00:00Z", "2026-10-09T11:55:00Z") },
    full: bars("2026-10-08T23:00:00Z", "2026-10-09T22:55:00Z"),
    readAt: ["2026-10-10T18:30:00Z", "2026-10-11T10:00:00Z"],
  },
];

function source(answer: () => PricePoint[], calls: string[]): DataProvider {
  return {
    ...fallbackProvider,
    id: "gloomberb-cloud",
    async getPriceHistoryWithMetadata(): Promise<PriceHistoryResult> {
      calls.push(new Date().toISOString());
      return { points: answer(), resolution: "5m" };
    },
  };
}

/** Saves `points` at `savedAt`, then reads 1D at `readAt` with the source answering `later`. */
async function readAfterSaving(symbol: string, savedAt: string, points: PricePoint[], readAt: string, later: () => PricePoint[]) {
  const calls: string[] = [];
  let answer = () => points;
  const store = new AppPersistence(":memory:");
  const router = new AssetDataRouter(source(() => answer(), calls), [], store.resources);
  try {
    setSystemTime(new Date(savedAt));
    await router.getPriceHistoryWithMetadata(symbol, "", "1D");
    answer = later;
    setSystemTime(new Date(readAt));
    const served = await router.getPriceHistoryWithMetadata(symbol, "", "1D").then((value) => value.points, () => []);
    return { served, calls };
  } finally { store.close(); }
}

/** First bar, last bar and count. */
function span(points: PricePoint[]): [string | undefined, string | undefined, number] {
  const iso = (point: PricePoint | undefined) => point && new Date(point.date).toISOString();
  return [iso(points[0]), iso(points.at(-1)), points.length];
}

afterEach(() => { setSystemTime(); });

test.each(ROWS.map((row) => [row.what, row] as const))(
  "%s: a copy saved mid-session is refetched once the session is over, and still answers offline",
  async (what, { symbol, partial, full, readAt }) => {
    for (const at of readAt) {
      const refetched = await readAfterSaving(symbol, partial.savedAt, partial.points, at, () => full);
      expect(span(refetched.served), `${what} at ${at}`).toEqual(span(full));
      expect(refetched.calls, `${what} at ${at}`).toHaveLength(2);
      const offline = await readAfterSaving(symbol, partial.savedAt, partial.points, at, () => { throw new Error("offline"); });
      expect(span(offline.served), `${what} offline at ${at}`).toEqual(span(partial.points));
    }
  },
);

test("complete copies of a closed session answer from the cache", async () => {
  const marker = () => bars("2026-10-09T13:30:00Z", "2026-10-09T19:55:00Z", 999);
  const rows: Array<[string, string, string, PricePoint[], string]> = [
    // [what, symbol, saved at, bars, read at]
    ["US, saved after the close", "AAPL", "2026-10-09T20:40:00Z", bars("2026-10-09T13:30:00Z", "2026-10-09T19:55:00Z"), "2026-10-10T18:30:00Z"],
    // Black Friday closes at 13:00 New York (18:00 UTC); saved ten minutes later.
    ["US early close", "AAPL", "2026-11-27T18:10:00Z", bars("2026-11-27T14:30:00Z", "2026-11-27T17:55:00Z"), "2026-11-28T15:00:00Z"],
    ["HKEX", "0700.HK", "2026-10-09T09:00:00Z", bars("2026-10-09T01:15:00Z", "2026-10-09T08:05:00Z"), "2026-10-11T00:30:00Z"],
    // Saved at 13:40 Tel Aviv, before Friday's 13:50 close: the 13:29 bar is the last.
    ["TASE Friday, saved before the close", "LUMI.TA", "2026-10-09T10:40:00Z", bars("2026-10-09T06:59:00Z", "2026-10-09T10:29:00Z"), "2026-10-10T12:00:00Z"],
    ["FX, saved after the week closed", "EURUSD=X", "2026-10-10T01:00:00Z", bars("2026-10-08T23:00:00Z", "2026-10-09T22:55:00Z"), "2026-10-11T20:00:00Z"],
  ];
  for (const [what, symbol, savedAt, points, readAt] of rows) {
    const { served } = await readAfterSaving(symbol, savedAt, points, readAt, marker);
    expect(span(served), what).toEqual(span(points));
    expect(served.at(-1)?.close, what).toBe(100);
  }
});

test("a thin listing's copy is refetched once after the close, not on every request", async () => {
  const calls: string[] = [];
  const thin = bars("2026-10-09T13:30:00Z", "2026-10-09T15:00:00Z");
  let answer = () => thin;
  const store = new AppPersistence(":memory:");
  const router = new AssetDataRouter(source(() => answer(), calls), [], store.resources);
  const lastClose = async () => (await router.getPriceHistoryWithMetadata("CODA", "", "1D")).points.at(-1)?.close;
  try {
    setSystemTime(new Date("2026-10-09T15:15:00Z"));
    expect(await lastClose()).toBe(100);
    // Saturday: the copy predates the close, so the source is asked again and
    // answers the same bars. That copy now stands for the session.
    setSystemTime(new Date("2026-10-10T18:30:00Z"));
    expect(await lastClose()).toBe(100);
    expect(calls).toHaveLength(2);
    answer = () => bars("2026-10-09T13:30:00Z", "2026-10-09T15:00:00Z", 999);
    setSystemTime(new Date("2026-10-10T18:40:00Z"));
    expect(await lastClose()).toBe(100);
  } finally { store.close(); }
});

test("a short-lived process refetches a copy past its TTL before answering", async () => {
  // EURUSD=X saved Saturday at 12:13 UTC, when the source left out the hours
  // before Friday 12:15. It reaches the week's close, so it is complete at its end.
  const saved = bars("2026-10-09T12:15:00Z", "2026-10-09T22:55:00Z");
  const full = bars("2026-10-08T23:00:00Z", "2026-10-09T22:55:00Z");
  const run = async (readAt: string, later: () => PricePoint[]) => {
    const calls: string[] = [];
    let answer = () => saved;
    const store = new AppPersistence(":memory:");
    const router = new AssetDataRouter(source(() => answer(), calls), [], store.resources);
    try {
      setSystemTime(new Date("2026-10-10T12:13:00Z"));
      await router.getPriceHistoryWithMetadata("EURUSD=X", "", "1D");
      // The CLI's router.
      router.setBackgroundRevalidation(false);
      answer = later;
      setSystemTime(new Date(readAt));
      return { served: (await router.getPriceHistoryWithMetadata("EURUSD=X", "", "1D")).points.length, calls: calls.length };
    } finally { store.close(); }
  };
  expect(await run("2026-10-10T18:30:00Z", () => full)).toEqual({ served: full.length, calls: 2 });
  expect(await run("2026-10-10T18:30:00Z", () => { throw new Error("offline"); })).toEqual({ served: saved.length, calls: 2 });
  // Inside its TTL the copy answers without asking.
  expect(await run("2026-10-10T12:16:00Z", () => full)).toEqual({ served: saved.length, calls: 1 });
});
