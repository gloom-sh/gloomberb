import { afterEach, expect, setSystemTime, test } from "bun:test";
import { AppPersistence } from "../../data/app-persistence";
import type { DataProvider } from "../../types/data-provider";
import type { PricePoint } from "../../types/financials";
import type { PriceHistoryResult } from "../../types/price-history";
import { fallbackProvider } from "../../test-support/data-provider";
import { AssetDataRouter } from "./index";

// One-day history saved earlier and read later, the way the CLI asks: no
// exchange, the venue read off the symbol. Five-minute bars as Gloom Cloud
// serves them, in UTC. A copy that holds the venue's latest session answers
// from the cache; one that does not is refetched, on weeknights, in the US
// pre-market, on weekends and on holidays alike, and still answers when the
// source is down. An intraday copy expires two days after it is saved, so
// Friday's copies are not read on Monday.

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
  symbol: string;
  /** First bar, last bar and when the copy was saved. */
  saved: [string, string, string];
  readAt: string;
  /** Behind: the bars the source has at `readAt`, which the refetch answers. Current: answered from the cache. */
  later?: [string, string];
}

// Sessions in UTC in October 2026: New York 13:30 to 20:00, London 07:00 to
// 15:40 with the closing auction, Hong Kong 01:30 to 08:10 with bars from the
// 01:15 pre-opening, Tel Aviv 06:59 to 14:30 (Friday to 10:50), the FX week
// Sunday 21:00 to Friday 21:00. Thanksgiving week New York is 14:30 to 21:00.
const US_THU = ["2026-10-08T13:30:00Z", "2026-10-08T19:55:00Z"] as const;
const LSE_THU = ["2026-10-08T07:00:00Z", "2026-10-08T15:25:00Z"] as const;
const HK_THU = ["2026-10-08T01:15:00Z", "2026-10-08T08:05:00Z"] as const;
const TASE_THU = ["2026-10-08T06:59:00Z", "2026-10-08T14:09:00Z"] as const;

const ROWS: Record<string, Row> = {
  "US weeknight, a copy saved at 10:00": { symbol: "AAPL", saved: [US_THU[0], "2026-10-08T13:55:00Z", "2026-10-08T14:00:00Z"],
    readAt: "2026-10-08T23:00:00Z", later: [...US_THU] },
  "US weeknight, the whole session": { symbol: "AAPL", saved: [...US_THU, "2026-10-08T20:40:00Z"], readAt: "2026-10-08T23:00:00Z" },
  "US pre-market, yesterday's copy saved at 10:00": { symbol: "AAPL", saved: [US_THU[0], "2026-10-08T13:55:00Z", "2026-10-08T14:00:00Z"],
    readAt: "2026-10-09T11:00:00Z", later: [...US_THU] },
  "US pre-market, yesterday's whole session": { symbol: "AAPL", saved: [...US_THU, "2026-10-08T20:40:00Z"], readAt: "2026-10-09T11:00:00Z" },
  "US next session at noon, yesterday's whole session": { symbol: "AAPL", saved: [...US_THU, "2026-10-08T20:40:00Z"],
    readAt: "2026-10-09T16:00:00Z", later: ["2026-10-09T13:30:00Z", "2026-10-09T15:40:00Z"] },
  "US weekend, Friday's copy saved at 10:00": { symbol: "AAPL", saved: ["2026-10-09T13:30:00Z", "2026-10-09T13:40:00Z", "2026-10-09T14:00:00Z"],
    readAt: "2026-10-10T18:30:00Z", later: ["2026-10-09T13:30:00Z", "2026-10-09T19:55:00Z"] },
  "US weekend, Friday's whole session": { symbol: "AAPL", saved: ["2026-10-09T13:30:00Z", "2026-10-09T19:55:00Z", "2026-10-09T20:40:00Z"],
    readAt: "2026-10-10T18:30:00Z" },
  "US Thanksgiving, Wednesday's copy saved at 10:00": { symbol: "AAPL", saved: ["2026-11-25T14:30:00Z", "2026-11-25T14:55:00Z", "2026-11-25T15:00:00Z"],
    readAt: "2026-11-26T18:00:00Z", later: ["2026-11-25T14:30:00Z", "2026-11-25T20:55:00Z"] },
  "US Thanksgiving, Wednesday's whole session": { symbol: "AAPL", saved: ["2026-11-25T14:30:00Z", "2026-11-25T20:55:00Z", "2026-11-25T21:40:00Z"],
    readAt: "2026-11-26T18:00:00Z" },
  // Black Friday closes at 13:00 New York (18:00 UTC); saved ten minutes later.
  "US early close, the whole session": { symbol: "AAPL", saved: ["2026-11-27T14:30:00Z", "2026-11-27T17:55:00Z", "2026-11-27T18:10:00Z"],
    readAt: "2026-11-28T15:00:00Z" },
  "LSE weeknight, a copy saved at 10:00": { symbol: "VOD.L", saved: [LSE_THU[0], "2026-10-08T08:55:00Z", "2026-10-08T09:00:00Z"],
    readAt: "2026-10-08T19:00:00Z", later: [...LSE_THU] },
  "LSE before the next open, yesterday's whole session": { symbol: "VOD.L", saved: [...LSE_THU, "2026-10-08T16:30:00Z"], readAt: "2026-10-09T06:00:00Z" },
  // 11:00 London, 18.5 hours after the last bar.
  "LSE next session at 11:00, yesterday's whole session": { symbol: "VOD.L", saved: [...LSE_THU, "2026-10-08T16:30:00Z"],
    readAt: "2026-10-09T10:00:00Z", later: ["2026-10-09T07:00:00Z", "2026-10-09T09:40:00Z"] },
  "LSE weekend, Friday's copy saved at 10:00": { symbol: "VOD.L", saved: ["2026-10-09T07:00:00Z", "2026-10-09T08:55:00Z", "2026-10-09T09:00:00Z"],
    readAt: "2026-10-10T12:00:00Z", later: ["2026-10-09T07:00:00Z", "2026-10-09T15:25:00Z"] },
  "HKEX weeknight, a copy saved at 11:30": { symbol: "0700.HK", saved: [HK_THU[0], "2026-10-08T03:10:00Z", "2026-10-08T03:30:00Z"],
    readAt: "2026-10-08T14:00:00Z", later: [...HK_THU] },
  "HKEX before the next open, yesterday's whole session": { symbol: "0700.HK", saved: [...HK_THU, "2026-10-08T09:00:00Z"], readAt: "2026-10-09T00:30:00Z" },
  "HKEX next session at 11:00, yesterday's whole session": { symbol: "0700.HK", saved: [...HK_THU, "2026-10-08T09:00:00Z"],
    readAt: "2026-10-09T03:00:00Z", later: ["2026-10-09T01:15:00Z", "2026-10-09T02:40:00Z"] },
  "HKEX weekend, Friday's copy saved at 11:30": { symbol: "0700.HK", saved: ["2026-10-09T01:15:00Z", "2026-10-09T03:10:00Z", "2026-10-09T03:30:00Z"],
    readAt: "2026-10-11T00:30:00Z", later: ["2026-10-09T01:15:00Z", "2026-10-09T08:05:00Z"] },
  "HKEX weekend, Friday's whole session": { symbol: "0700.HK", saved: ["2026-10-09T01:15:00Z", "2026-10-09T08:05:00Z", "2026-10-09T09:00:00Z"],
    readAt: "2026-10-11T00:30:00Z" },
  // National Day, Thursday 1 October, is a published closure: Wednesday's session stays the latest.
  "HKEX National Day, Wednesday's copy saved at 11:30": { symbol: "0700.HK",
    saved: ["2026-09-30T01:15:00Z", "2026-09-30T03:10:00Z", "2026-09-30T03:30:00Z"], readAt: "2026-10-01T06:00:00Z",
    later: ["2026-09-30T01:15:00Z", "2026-09-30T08:05:00Z"] },
  "HKEX National Day, Wednesday's whole session": { symbol: "0700.HK", saved: ["2026-09-30T01:15:00Z", "2026-09-30T08:05:00Z", "2026-09-30T09:00:00Z"],
    readAt: "2026-10-01T06:00:00Z" },
  "TASE weeknight, a copy saved at 11:30": { symbol: "LUMI.TA", saved: [TASE_THU[0], "2026-10-08T08:09:00Z", "2026-10-08T08:30:00Z"],
    readAt: "2026-10-08T17:00:00Z", later: [...TASE_THU] },
  "TASE next session at noon, yesterday's whole session": { symbol: "LUMI.TA", saved: [...TASE_THU, "2026-10-08T15:00:00Z"],
    readAt: "2026-10-09T09:00:00Z", later: ["2026-10-09T06:59:00Z", "2026-10-09T08:39:00Z"] },
  "TASE weekend, Friday's copy saved at 11:30": { symbol: "LUMI.TA", saved: ["2026-10-09T06:59:00Z", "2026-10-09T08:09:00Z", "2026-10-09T08:30:00Z"],
    readAt: "2026-10-10T12:00:00Z", later: ["2026-10-09T06:59:00Z", "2026-10-09T10:29:00Z"] },
  // Saved at 13:40 Tel Aviv, before Friday's 13:50 close: the 13:29 bar is the last.
  "TASE weekend, Friday's session saved before its early close": { symbol: "LUMI.TA",
    saved: ["2026-10-09T06:59:00Z", "2026-10-09T10:29:00Z", "2026-10-09T10:40:00Z"], readAt: "2026-10-10T12:00:00Z" },
  // A pair is read on the FX week, not as a US listing: it trades through the New York evening.
  "FX weeknight, a copy saved at the New York close": { symbol: "EURUSD=X",
    saved: ["2026-10-07T20:05:00Z", "2026-10-08T20:00:00Z", "2026-10-08T20:05:00Z"], readAt: "2026-10-08T23:00:00Z",
    later: ["2026-10-07T23:00:00Z", "2026-10-08T22:50:00Z"] },
  "FX weekend, Friday's copy saved at noon": { symbol: "EURUSD=X", saved: ["2026-10-08T12:00:00Z", "2026-10-09T11:55:00Z", "2026-10-09T12:00:00Z"],
    readAt: "2026-10-10T18:30:00Z", later: ["2026-10-08T23:00:00Z", "2026-10-09T22:55:00Z"] },
  "FX weekend, the whole week to its close": { symbol: "EURUSD=X", saved: ["2026-10-08T23:00:00Z", "2026-10-09T22:55:00Z", "2026-10-10T10:00:00Z"],
    readAt: "2026-10-11T20:00:00Z" },
  "FX Monday morning, last week to its close": { symbol: "EURUSD=X", saved: ["2026-10-08T23:00:00Z", "2026-10-09T22:55:00Z", "2026-10-10T10:00:00Z"],
    readAt: "2026-10-12T08:00:00Z", later: ["2026-10-11T21:00:00Z", "2026-10-12T07:50:00Z"] },
};

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
    const got = await router.getPriceHistoryWithMetadata(symbol, "", "1D").catch(() => null);
    return { served: got?.points ?? [], behind: got?.savedCopyBehind === true, calls };
  } finally { store.close(); }
}

/** First bar, last bar, count and the last close (100 saved, 999 refetched). */
function span(points: PricePoint[]): [string | undefined, string | undefined, number, number | undefined] {
  const iso = (point: PricePoint | undefined) => point && new Date(point.date).toISOString();
  return [iso(points[0]), iso(points.at(-1)), points.length, points.at(-1)?.close];
}

afterEach(() => { setSystemTime(); });

test.each(Object.entries(ROWS))("%s", async (what, { symbol, saved: [first, last, savedAt], readAt, later }) => {
  const copy = bars(first, last);
  const fresh = later ? bars(...later, 999) : bars(first, last, 999);
  const online = await readAfterSaving(symbol, savedAt, copy, readAt, () => fresh);
  if (later) {
    expect(span(online.served), "refetched").toEqual(span(fresh));
    expect(online.calls, "refetched").toHaveLength(2);
  } else {
    expect(span(online.served), "from the cache").toEqual(span(copy));
  }
  expect(online.behind, "a current answer is not marked").toBe(false);
  // Offline, or with the source failing, the saved copy answers rather than
  // nothing, and says so when it stops short of the latest session.
  const offline = await readAfterSaving(symbol, savedAt, copy, readAt, () => { throw new Error("offline"); });
  expect(span(offline.served), `${what}, offline`).toEqual(span(copy));
  expect(offline.behind, `${what}, offline: marked behind`).toBe(later !== undefined);
});

test("a thin listing's copy is refetched once after the close, on a weeknight as on a weekend", async () => {
  // Saved at 11:15 New York; the listing did not trade after 11:00.
  for (const [day, readAt] of [["2026-10-08", "2026-10-08T21:00:00Z"], ["2026-10-09", "2026-10-10T18:30:00Z"]] as const) {
    const calls: string[] = [];
    const thin = bars(`${day}T13:30:00Z`, `${day}T15:00:00Z`);
    let answer = () => thin;
    const store = new AppPersistence(":memory:");
    const router = new AssetDataRouter(source(() => answer(), calls), [], store.resources);
    const read = () => router.getPriceHistoryWithMetadata("CODA", "", "1D");
    const lastClose = async () => (await read()).points.at(-1)?.close;
    try {
      setSystemTime(new Date(`${day}T15:15:00Z`));
      expect(await lastClose()).toBe(100);
      // After the close the copy predates it, so the source is asked again and
      // answers the same bars. That copy now stands for the session.
      setSystemTime(new Date(readAt));
      const answered = await read();
      expect(answered.points.at(-1)?.close, readAt).toBe(100);
      expect(answered.savedCopyBehind, readAt).toBeUndefined();
      expect(calls, readAt).toHaveLength(2);
      answer = () => bars(`${day}T13:30:00Z`, `${day}T15:00:00Z`, 999);
      setSystemTime(new Date(Date.parse(readAt) + 10 * MIN));
      expect(await lastClose(), readAt).toBe(100);
      // A short-lived process refetches a copy past its TTL and falls back to it
      // when the source fails: that complete copy is no behind copy.
      router.setBackgroundRevalidation(false);
      const before = calls.length;
      answer = () => { throw new Error("offline"); };
      setSystemTime(new Date(Date.parse(readAt) + 2 * 60 * MIN));
      const fallback = await read();
      expect(calls.length, readAt).toBeGreaterThan(before);
      expect(fallback.points.length, readAt).toBe(thin.length);
      expect(fallback.savedCopyBehind, readAt).toBeUndefined();
    } finally { store.close(); }
  }
});

test("a copy the source cannot replace answers without asking again until the next re-check", async () => {
  // HKEX, Friday's copy saved at 11:30 and read on Saturday while the source is down.
  const calls: string[] = [];
  const store = new AppPersistence(":memory:");
  let answer = () => bars("2026-10-09T01:15:00Z", "2026-10-09T03:10:00Z");
  const router = new AssetDataRouter(source(() => answer(), calls), [], store.resources);
  let behind: boolean | undefined;
  const read = async (at: string) => {
    setSystemTime(new Date(at));
    const value = await router.getPriceHistoryWithMetadata("0700.HK", "", "1D");
    behind = value.savedCopyBehind === true;
    return value.points.length;
  };
  try {
    await read("2026-10-09T03:30:00Z");
    expect(behind).toBe(false);
    answer = () => { throw new Error("offline"); };
    // The failed refetch, then the copy a re-check could not replace, answer marked.
    for (const at of ["2026-10-10T12:00:00Z", "2026-10-10T12:01:00Z", "2026-10-10T12:04:00Z"]) {
      expect(await read(at), at).toBe(24);
      expect(behind, at).toBe(true);
    }
    expect(calls).toHaveLength(2);
    expect(await read("2026-10-10T12:06:00Z")).toBe(24);
    expect(calls).toHaveLength(3);
  } finally { store.close(); }
});

test("a source that answers bars still behind during the session leaves the saved copy marked", async () => {
  // HKEX, saved at 11:30 and read at 14:00 in its session: the source has nothing newer.
  const calls: string[] = [];
  const store = new AppPersistence(":memory:");
  const router = new AssetDataRouter(source(() => bars("2026-10-09T01:15:00Z", "2026-10-09T03:10:00Z"), calls), [], store.resources);
  try {
    setSystemTime(new Date("2026-10-09T03:30:00Z"));
    await router.getPriceHistoryWithMetadata("0700.HK", "", "1D");
    setSystemTime(new Date("2026-10-09T06:00:00Z"));
    const answered = await router.getPriceHistoryWithMetadata("0700.HK", "", "1D");
    expect(calls).toHaveLength(2);
    expect(answered.points).toHaveLength(24);
    expect(answered.savedCopyBehind).toBe(true);
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
