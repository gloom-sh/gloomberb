import { auctionTenorKey, type AfterMove, type AuctionAfter, type AuctionPercentiles } from "./after";
import { auctionBenchmark, isPendingAuction } from "./model";
import type { TreasuryAuction } from "./types";

/**
 * `fn AUCT 3Y --like 2026-11-09`: the earlier auctions of the same tenor
 * that ranked most like one, and what the Treasury yield did after them.
 *
 * Likeness is read on the percentiles the after view shows (after.ts), which
 * already put each auction against its own tenor's recent history: a 2.46
 * bid-to-cover reads differently in 2008 and 2026, its percentile does not.
 * The distance is the root mean square of the gaps between the two auctions'
 * stop-out vs median, B/C and indirect percentiles, 0 for an auction that
 * ranked the same on all three; only the ones the auction has count, and an
 * earlier auction is compared only when it has them all.
 */

/** How many of the closest earlier auctions `--like` lists. */
export const LIKE_LIMIT = 15;

type LikeDimension = "stopOutPercentile" | "btcPercentile" | "indirectPercentile";
const LIKE_DIMENSIONS: readonly LikeDimension[] = ["stopOutPercentile", "btcPercentile", "indirectPercentile"];

export interface AuctionAnalog {
  auction: TreasuryAuction;
  /** Root mean square of the percentile gaps, 0 to 100. */
  distance: number;
}

export interface AuctionAnalogs {
  /** The percentiles the distance reads: those the auction has. */
  dimensions: LikeDimension[];
  /** The closest first; ties keep the newest first. */
  analogs: AuctionAnalog[];
}

/**
 * The search that names an auction's tenor (`3Y`, `13W`, `10Y TIPS`), as
 * `fn AUCT` takes it; null for a term with no benchmark.
 */
function tenorSearch(auction: TreasuryAuction): string | null {
  const benchmark = auctionBenchmark(auction.securityTerm);
  if (!benchmark) return null;
  const kind = auction.secType === "TIPS" || auction.secType === "FRN" ? ` ${auction.secType}` : "";
  return `${benchmark.count}${benchmark.unit[0]!.toUpperCase()}${kind}`;
}

/**
 * The completed auctions on `date` among `listed` (already narrowed by the
 * search and group): one is the auction to compare with, several ask for a
 * search that tells them apart, naming a tenor held that day (a note or bond's
 * before a bill's), none says so.
 */
export function likeTarget(listed: readonly TreasuryAuction[], date: string): { target: TreasuryAuction } | { error: string } {
  const held = listed.filter((auction) => auction.auctionDate === date);
  const completed = held.filter((auction) => !isPendingAuction(auction));
  if (completed.length === 1) return { target: completed[0]! };
  if (completed.length > 1) {
    const named = completed.map((auction) => `${auction.securityTerm} ${auction.secType}`).join(", ");
    const example = [...completed.filter((auction) => auction.secType !== "Bill" && auction.secType !== "CMB"), ...completed]
      .map(tenorSearch).find((search) => search != null);
    return { error: `${date} held ${completed.length} auctions (${named}): search for one${example ? `, as in fn AUCT ${example} --like ${date}` : " by its term"}.` };
  }
  if (held.length > 0) return { error: `The ${held[0]!.securityTerm} ${held[0]!.secType.toLowerCase()} auction of ${date} has no results yet.` };
  return { error: `No auction on ${date} matches the search: --like takes the date an auction was held, as in fn AUCT 3Y --like 2026-11-09.` };
}

/**
 * The earlier auctions of the target's tenor in `history` closest to it on
 * the percentiles it has, at most `limit`. No dimensions when the target has
 * no percentile: fewer than 12 auctions of its tenor came before it.
 */
export function rankAuctionAnalogs(
  target: TreasuryAuction,
  history: readonly TreasuryAuction[],
  percentiles: ReadonlyMap<string, AuctionPercentiles>,
  limit = LIKE_LIMIT,
): AuctionAnalogs {
  const own = percentiles.get(target.id);
  const dimensions = LIKE_DIMENSIONS.filter((key) => own?.[key] != null);
  if (!own || dimensions.length === 0) return { dimensions, analogs: [] };
  const tenor = auctionTenorKey(target);
  const analogs: AuctionAnalog[] = [];
  for (const auction of history) {
    if (auction.id === target.id || auction.auctionDate >= target.auctionDate || isPendingAuction(auction)) continue;
    if (auctionTenorKey(auction) !== tenor) continue;
    const theirs = percentiles.get(auction.id);
    if (!theirs || dimensions.some((key) => theirs[key] == null)) continue;
    const squares = dimensions.reduce((sum, key) => sum + (theirs[key]! - own[key]!) ** 2, 0);
    analogs.push({ auction, distance: Math.round(Math.sqrt(squares / dimensions.length) * 10) / 10 });
  }
  analogs.sort((left, right) => left.distance - right.distance || right.auction.auctionDate.localeCompare(left.auction.auctionDate));
  return { dimensions, analogs: analogs.slice(0, limit) };
}

const AFTER_MOVES: ReadonlyArray<{ key: AfterMove; label: string }> = [
  { key: "after1d", label: "+1d" }, { key: "after5d", label: "+5d" }, { key: "after20d", label: "+20d" },
];

export interface AnalogMoveSummary {
  move: AfterMove;
  /** "+1d", "+5d", "+20d". */
  label: string;
  /** The median move, bp; null when no analog has it yet. */
  medianBp: number | null;
  /** The share of them whose yield rose, 0 to 100. */
  rosePct: number | null;
  /** The analogs with the move: a recent one has no +20d yet. */
  count: number;
}

const median = (values: readonly number[]) => {
  const sorted = values.toSorted((left, right) => left - right);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

/**
 * The median of each move after the analogs, and the share of them whose
 * yield rose. A move left blank (not in yet, or after the asked date) is not
 * counted.
 */
export function summarizeAnalogMoves(analogs: readonly AuctionAnalog[], after: ReadonlyMap<string, Pick<AuctionAfter, AfterMove>>): AnalogMoveSummary[] {
  return AFTER_MOVES.map(({ key, label }) => {
    const moves = analogs.flatMap(({ auction }) => {
      const value = after.get(auction.id)?.[key];
      return value == null ? [] : [value];
    });
    return {
      move: key,
      label,
      medianBp: moves.length ? Math.round(median(moves) * 10) / 10 : null,
      rosePct: moves.length ? Math.round((moves.filter((value) => value > 0).length / moves.length) * 100) : null,
      count: moves.length,
    };
  });
}
