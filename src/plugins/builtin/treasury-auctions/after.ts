import { apiClient } from "../../../api-client";
import type { CloudCurveHistory, CloudCurveId } from "../../../api-client/yield-curves";
import { createTtlCache } from "../../../data/ttl-cache";
import { toBasisPoints } from "../../../utils/basis-points";
import { AUCTION_HISTORY_ALL, type AuctionHistoryWindow } from "./client";
import {
  AUCTION_HISTORY_WINDOWS, auctionBenchmark, dealerPct, indirectPct, isPendingAuction, nextAuctionHistoryWindow, publishesMedian, stopOutVsAvgBp,
} from "./model";
import type { TreasuryAuction } from "./types";

/**
 * The after view (docs/research-data.md, Treasury auctions): how an auction
 * ranked against its tenor's own recent history, and what the matching
 * constant-maturity yield did after it.
 *
 * - Stop-out vs median, B/C, indirect and dealer share are each a percentile
 *   against the tenor's previous 24 auctions with that figure: the share of
 *   them below it, half the ones equal. A tenor is the security type and the
 *   benchmark it was sold as (the 10-year note and its 9-Year 10-Month
 *   reopenings are one; a 10-year TIPS is another). Fewer than 12 earlier
 *   auctions rank nothing. The stop-out ranks only against auctions on the
 *   same footing: the median from November 1998, the average before.
 * - The yield change is the Treasury par (CMT) yield of the auction's tenor,
 *   or the TIPS real yield for a TIPS, from the auction day's close to the
 *   close 1, 5 and 20 sessions later, in basis points. An FRN floats and has
 *   none; a day the curve has no close for has none.
 */

export type AuctionView = "results" | "after";
export const AUCTION_VIEWS: readonly AuctionView[] = ["results", "after"];

const PERCENTILE_LOOKBACK = 24;
const PERCENTILE_MIN = 12;

export interface AuctionAfter {
  stopOutPercentile: number | null;
  btcPercentile: number | null;
  indirectPercentile: number | null;
  dealerPercentile: number | null;
  /** The CMT yield's change, bp, 1, 5 and 20 sessions after the auction day's close. */
  after1d: number | null;
  after5d: number | null;
  after20d: number | null;
  /** The yield read: "7Y", "10Y real"; null when none matches. */
  cmt: string | null;
}

/**
 * The window the after view reads first: two years more than it lists, which
 * gives most tenors their 24 before the oldest row listed. A tenor sold a few
 * times a year (the 30-year TIPS) needs more: widerAfterWindow.
 */
export function afterLoadWindow(window: AuctionHistoryWindow): AuctionHistoryWindow {
  if (window === AUCTION_HISTORY_ALL) return AUCTION_HISTORY_ALL;
  return AUCTION_HISTORY_WINDOWS.find((next) => next === AUCTION_HISTORY_ALL || next >= window + 730) ?? AUCTION_HISTORY_ALL;
}

/** The first day the after view lists, for a window it read more than: undefined for ALL. */
export function afterWindowStart(window: AuctionHistoryWindow, now = Date.now()): string | undefined {
  return window === AUCTION_HISTORY_ALL ? undefined : new Date(now - window * 86_400_000).toISOString().slice(0, 10);
}

const DAY_MS = 86_400_000;
/** A tenor's oldest auction read this close to the window's start may have older ones before it. */
const MIN_GAP_MS = 400 * DAY_MS;

/**
 * The next window the after view should read, or null when the one read is
 * enough: every listed tenor has its 24 auctions before the oldest one listed,
 * or began inside the window (its oldest auction read is further from the
 * window's start than its longest gap between auctions, and at least 400
 * days), or the window is already ALL. Cash management bills are one-offs and
 * never ask for more.
 */
export function widerAfterWindow(
  listed: readonly TreasuryAuction[],
  loaded: readonly TreasuryAuction[],
  window: AuctionHistoryWindow,
  now = Date.now(),
): AuctionHistoryWindow | null {
  if (window === AUCTION_HISTORY_ALL) return null;
  const start = now - window * DAY_MS;
  const byTenor = new Map<string, number[]>();
  for (const auction of loaded) {
    const key = auctionTenorKey(auction);
    if (key && !isPendingAuction(auction)) byTenor.set(key, [...byTenor.get(key) ?? [], Date.parse(auction.auctionDate)]);
  }
  const oldestListed = new Map<string, number>();
  for (const auction of listed) {
    const key = auctionTenorKey(auction);
    if (!key || auction.secType === "CMB" || isPendingAuction(auction)) continue;
    const date = Date.parse(auction.auctionDate);
    oldestListed.set(key, Math.min(oldestListed.get(key) ?? date, date));
  }
  for (const [key, oldest] of oldestListed) {
    const dates = (byTenor.get(key) ?? []).toSorted((left, right) => left - right);
    if (dates.filter((date) => date < oldest).length >= PERCENTILE_LOOKBACK) continue;
    let gap = MIN_GAP_MS;
    for (let index = 1; index < dates.length; index++) gap = Math.max(gap, dates[index]! - dates[index - 1]!);
    if (dates.length && dates[0]! - start <= gap) return nextAuctionHistoryWindow(window);
  }
  return null;
}

const NO_AFTER: AuctionAfter = {
  stopOutPercentile: null, btcPercentile: null, indirectPercentile: null, dealerPercentile: null, after1d: null, after5d: null, after20d: null, cmt: null,
};

/** The tenor an auction ranks within: its type and the benchmark it was sold as. */
export function auctionTenorKey(auction: TreasuryAuction): string | null {
  const benchmark = auctionBenchmark(auction.securityTerm);
  return benchmark ? `${auction.secType}|${benchmark.count}${benchmark.unit}` : null;
}

/** 0 to 100: the share of `history` below `value`, half of those equal. */
function percentileOf(value: number, history: readonly number[]): number | null {
  if (history.length < PERCENTILE_MIN) return null;
  const below = history.filter((entry) => entry < value).length;
  const equal = history.filter((entry) => entry === value).length;
  return Math.round(((below + equal / 2) / history.length) * 100);
}

type Metric = (auction: TreasuryAuction) => number | null;
type PercentileKey = "stopOutPercentile" | "btcPercentile" | "indirectPercentile" | "dealerPercentile";
export type AuctionPercentiles = Pick<AuctionAfter, PercentileKey>;
/** Each figure ranked, and whether an earlier auction's figure is on the same footing as this one's. */
const METRICS: ReadonlyArray<[PercentileKey, Metric, ((auction: TreasuryAuction, past: TreasuryAuction) => boolean)?]> = [
  ["stopOutPercentile", stopOutVsAvgBp, (auction, past) => publishesMedian(auction) === publishesMedian(past)],
  ["btcPercentile", (auction) => auction.bidToCoverRatio],
  ["indirectPercentile", indirectPct],
  ["dealerPercentile", dealerPct],
];

/** Each completed auction's percentiles, by id, against the auctions of its tenor before it in `auctions`. */
export function auctionPercentiles(auctions: readonly TreasuryAuction[]): Map<string, AuctionPercentiles> {
  const byTenor = new Map<string, TreasuryAuction[]>();
  for (const auction of auctions) {
    const key = auctionTenorKey(auction);
    if (!key || isPendingAuction(auction)) continue;
    byTenor.set(key, [...byTenor.get(key) ?? [], auction]);
  }
  const ranked = new Map<string, AuctionPercentiles>();
  for (const group of byTenor.values()) {
    group.sort((left, right) => left.auctionDate.localeCompare(right.auctionDate) || left.id.localeCompare(right.id));
    group.forEach((auction, index) => {
      const entry: AuctionPercentiles = { stopOutPercentile: null, btcPercentile: null, indirectPercentile: null, dealerPercentile: null };
      for (const [key, metric, comparable] of METRICS) {
        const value = metric(auction);
        if (value == null) continue;
        const history: number[] = [];
        for (let earlier = index - 1; earlier >= 0 && history.length < PERCENTILE_LOOKBACK; earlier--) {
          if (comparable && !comparable(auction, group[earlier]!)) continue;
          const past = metric(group[earlier]!);
          if (past != null) history.push(past);
        }
        entry[key] = percentileOf(value, history);
      }
      ranked.set(auction.id, entry);
    });
  }
  return ranked;
}

/** A curve's tenor and its length in days, as Gloom Cloud stores the US curves. */
const NOMINAL_TENORS: ReadonlyArray<[string, number]> = [
  ["1M", 30], ["6W", 42], ["2M", 61], ["3M", 91], ["4M", 122], ["6M", 183], ["1Y", 365], ["2Y", 730], ["3Y", 1095],
  ["5Y", 1826], ["7Y", 2557], ["10Y", 3652], ["20Y", 7305], ["30Y", 10957],
];
const REAL_TENORS: ReadonlyArray<[string, number]> = [["5Y", 1826], ["7Y", 2557], ["10Y", 3652], ["20Y", 7305], ["30Y", 10957]];
const UNIT_DAYS = { day: 1, week: 7, month: 30.44, year: 365.25 } as const;

/** The curve and tenor whose yield matches an auction's: the nearest stored tenor to its benchmark; null for an FRN. */
export function cmtFor(auction: TreasuryAuction): { curve: CloudCurveId; tenor: string } | null {
  if (auction.secType === "FRN") return null;
  const benchmark = auctionBenchmark(auction.securityTerm);
  if (!benchmark) return null;
  const days = benchmark.count * UNIT_DAYS[benchmark.unit];
  const real = auction.secType === "TIPS";
  const tenors = real ? REAL_TENORS : NOMINAL_TENORS;
  const [tenor] = tenors.reduce((best, entry) => Math.abs(entry[1] - days) < Math.abs(best[1] - days) ? entry : best);
  return { curve: real ? "us-real" : "us", tenor };
}

const cmtLabel = (cmt: { curve: CloudCurveId; tenor: string }) => cmt.curve === "us-real" ? `${cmt.tenor} real` : cmt.tenor;

/** A curve tenor's closes, oldest first, as `date` and `value` (percent). */
export type CurveCloses = ReadonlyArray<{ date: string; value: number }>;

/** The change from the auction day's close to the close `sessions` later, in bp; null when either is missing. */
export function yieldChangeAfter(closes: CurveCloses, date: string, sessions: number): number | null {
  let low = 0, high = closes.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (closes[middle]!.date < date) low = middle + 1;
    else high = middle;
  }
  const base = closes[low];
  const later = closes[low + sessions];
  if (!base || base.date !== date || !later) return null;
  return toBasisPoints(later.value - base.value, 1);
}

/** The after view's figures for each auction shown, by id. */
export function projectAuctionAfter(
  shown: readonly TreasuryAuction[],
  history: readonly TreasuryAuction[],
  curves: ReadonlyMap<string, CurveCloses>,
): Map<string, AuctionAfter> {
  const percentiles = auctionPercentiles(history);
  return new Map(shown.map((auction) => {
    const cmt = cmtFor(auction);
    const closes = cmt ? curves.get(curveKey(cmt)) : undefined;
    const change = (sessions: number) => closes && !isPendingAuction(auction) ? yieldChangeAfter(closes, auction.auctionDate, sessions) : null;
    return [auction.id, {
      ...NO_AFTER,
      ...percentiles.get(auction.id),
      after1d: change(1), after5d: change(5), after20d: change(20),
      cmt: cmt ? cmtLabel(cmt) : null,
    }];
  }));
}

const curveKey = (cmt: { curve: CloudCurveId; tenor: string }) => `${cmt.curve}:${cmt.tenor}`;

/**
 * A curve tenor's closes as read, from `from` (null: its whole history); ten
 * minutes, since a session's close lands once a day. Keyed by curve and tenor
 * alone, so a list that changes reads again only when it needs older closes.
 */
const curveCache = createTtlCache<{ from: string | null; history: CloudCurveHistory }>({ ttlMs: 10 * 60_000, maxEntries: 64 });

export function resetAuctionCurvesForTests(): void {
  curveCache.clear();
}

type CurveRead = (curve: CloudCurveId, tenor: string, from: string | null) => Promise<CloudCurveHistory>;

async function readCurve(curve: CloudCurveId, tenor: string, from: string | null, read: CurveRead): Promise<CloudCurveHistory> {
  const key = curveKey({ curve, tenor });
  const load = async () => ({ from, history: await read(curve, tenor, from) });
  const held = await curveCache.load(key, load);
  const covers = held.from == null || (from != null && held.from <= from);
  return covers ? held.history : (await curveCache.load(key, load, { force: true })).history;
}

export interface AuctionCurveRead {
  curves: Map<string, CurveCloses>;
  /** Why a curve the view needs could not be read. */
  errors: string[];
}

/**
 * The closes of every curve tenor the shown auctions match, from `from`, the
 * first day of the window listed (null for ALL: the whole curve).
 */
export async function loadAuctionCurves(
  shown: readonly TreasuryAuction[],
  from: string | null,
  read: CurveRead = (curve, tenor, start) => apiClient.getCloudCurveHistory(curve, tenor, start),
): Promise<AuctionCurveRead> {
  const needed = new Map<string, { curve: CloudCurveId; tenor: string }>();
  for (const auction of shown) {
    const cmt = cmtFor(auction);
    if (cmt && !isPendingAuction(auction)) needed.set(curveKey(cmt), cmt);
  }
  const curves = new Map<string, CurveCloses>();
  const errors: string[] = [];
  await Promise.all([...needed].map(async ([key, { curve, tenor }]) => {
    try {
      const history = await readCurve(curve, tenor, from, read);
      curves.set(key, history.points);
    } catch (error) {
      errors.push(`${cmtLabel({ curve, tenor })} Treasury yields unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }));
  return { curves, errors };
}
