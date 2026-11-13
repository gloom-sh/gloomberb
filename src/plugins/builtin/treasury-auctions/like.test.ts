import { expect, test } from "bun:test";
import { auctionPercentiles, projectAuctionAfter } from "./after";
import { likeTarget, rankAuctionAnalogs, summarizeAnalogMoves } from "./like";
import { auction } from "./test-fixture";
import type { TreasuryAuction } from "./types";

/** A monthly note on the 15th, `months` after January of `year`, its figures turning over on different cycles. */
function note(securityTerm: string, year: number, months: number, overrides: Partial<TreasuryAuction> = {}): TreasuryAuction {
  const auctionDate = new Date(Date.UTC(year, months, 15)).toISOString().slice(0, 10);
  return auction({
    secType: "Note", securityTerm, auctionDate, id: `${securityTerm}|${auctionDate}`,
    highYield: 4 + (months * 3 % 7) / 100, avgMedYield: 4, bidToCoverRatio: 2.2 + (months * 5 % 11) / 20,
    competitiveAccepted: 40e9, indirectAccepted: (20 + months * 7 % 13) * 1e9, primaryDealerAccepted: 5e9,
    ...overrides,
  });
}

const ids = (analogs: ReadonlyArray<{ auction: TreasuryAuction }>) => analogs.map((analog) => analog.auction.id);

test("a target in the middle of the history is compared with the auctions before it only, though a later one ranked the same", () => {
  const sevens = Array.from({ length: 60 }, (_, months) => note("7-Year", 2020, months));
  const target = sevens[40]!;
  // A later auction with the target's own figures would be the closest of all.
  sevens[50] = { ...target, id: "twin", auctionDate: "2024-03-15" };
  const percentiles = auctionPercentiles(sevens);
  const { dimensions, analogs } = rankAuctionAnalogs(target, sevens, percentiles);
  expect(dimensions).toEqual(["stopOutPercentile", "btcPercentile", "indirectPercentile"]);
  expect(analogs).toHaveLength(15);
  expect(analogs.every(({ auction }) => auction.auctionDate < target.auctionDate)).toBe(true);
  expect(ids(analogs)).not.toContain("twin");
});

test("a target missing a percentile is compared on the ones it has, and an earlier auction missing one of those is left out", () => {
  const sevens = Array.from({ length: 40 }, (_, months) => note("7-Year", 2020, months));
  // No bidder split, as before April 2008: no indirect percentile.
  const target = note("7-Year", 2020, 40, { competitiveAccepted: null, indirectAccepted: null, primaryDealerAccepted: null });
  // An earlier one without a bid-to-cover cannot be compared on it.
  sevens[30] = { ...sevens[30]!, bidToCoverRatio: null };
  const history = [...sevens, target];
  const percentiles = auctionPercentiles(history);
  const { dimensions, analogs } = rankAuctionAnalogs(target, history, percentiles);
  expect(dimensions).toEqual(["stopOutPercentile", "btcPercentile"]);
  expect(ids(analogs)).not.toContain(sevens[30]!.id);
  const own = percentiles.get(target.id)!;
  const theirs = percentiles.get(analogs[0]!.auction.id)!;
  const gap = Math.sqrt(((theirs.stopOutPercentile! - own.stopOutPercentile!) ** 2 + (theirs.btcPercentile! - own.btcPercentile!) ** 2) / 2);
  expect(analogs[0]!.distance).toBeCloseTo(gap, 1);
});

test("the stop-out ranks against the median from November 1998 and the average before, never across the change", () => {
  // Before the change every stop-out is 10 to 14bp over the average; from it, 1 to 3bp over the median.
  const tens = Array.from({ length: 60 }, (_, months) => {
    const bp = months >= 34 ? 1 + months % 3 : 10 + months % 5;
    return note("10-Year", 1996, months, { highYield: 6 + bp / 100, avgMedYield: 6 });
  });
  expect(tens[34]!.auctionDate).toBe("1998-11-15");
  const percentiles = auctionPercentiles(tens);
  const at = (date: string) => percentiles.get(tens.find((entry) => entry.auctionDate === date)!.id)!.stopOutPercentile;
  // The first against the median has none like it before; the 13th has 12.
  expect([at("1998-11-15"), at("1999-10-15"), at("1999-11-15")]).toEqual([null, null, expect.any(Number)]);
  // 3bp in June 2000 is high among the 19 medians before it; ranked with the 10bp-plus averages it would be the lowest.
  expect(at("2000-06-15")).toBe(84);
  // October 1998 ranks among the averages: 13bp against 24 of 10 to 14bp.
  expect(at("1998-10-15")).toBe(71);
});

test("for a past date a move that ends after it is blank and left out of the median and the share that rose", () => {
  const sevens = Array.from({ length: 30 }, (_, months) => note("7-Year", 2022, months));
  // Two weeks before the target: its +1d and +5d closes are in before the asked date, its +20d close after.
  const recent = note("7-Year", 2024, 6, { auctionDate: "2024-06-28", id: "recent" });
  const target = note("7-Year", 2024, 6, { auctionDate: "2024-07-15", id: "target" });
  const closes: Array<{ date: string; value: number }> = [];
  // A weekday close 1bp above the one before.
  for (let day = Date.UTC(2022, 0, 1); day <= Date.UTC(2024, 11, 31); day += 86_400_000) {
    const weekday = new Date(day).getUTCDay();
    if (weekday !== 0 && weekday !== 6) closes.push({ date: new Date(day).toISOString().slice(0, 10), value: 4 + closes.length / 100 });
  }
  const curves = new Map([["us:7Y", closes]]);
  const after = projectAuctionAfter([target, recent, ...sevens], [...sevens, recent, target], curves, target.auctionDate);
  expect(after.get("recent")).toMatchObject({ after1d: 1, after5d: 5, after20d: null, afterAskedDate: ["after20d"] });
  // Without the date the move is there, and the auction asked about keeps its own: what came next is what it is compared on.
  expect(projectAuctionAfter([recent], [recent], curves).get("recent")).toMatchObject({ after20d: 20 });
  expect(after.get("target")).toMatchObject({ after20d: 20 });
  // An auction months before keeps all three (the 15th of a month that falls on a weekday).
  const older = sevens.find((entry) => after.get(entry.id)!.after20d != null)!;
  expect(after.get(older.id)!.afterAskedDate).toBeUndefined();
  const summary = summarizeAnalogMoves([recent, older].map((entry) => ({ auction: entry, distance: 0 })), after);
  expect(summary.map((entry) => entry.count)).toEqual([2, 2, 1]);
});

// 2026-11-09 held the 3-year note and three bills; the hint named the 10Y, which was not sold that day.
test("a day of several auctions asks for a search naming a tenor held that day, a note's before a bill's", () => {
  const day = [
    auction({ secType: "Bill", securityTerm: "13-Week", auctionDate: "2026-11-09", bidToCoverRatio: 2.9 }),
    auction({ secType: "Note", securityTerm: "3-Year", auctionDate: "2026-11-09", bidToCoverRatio: 2.53 }),
    auction({ secType: "Bill", securityTerm: "26-Week", auctionDate: "2026-11-09", bidToCoverRatio: 3.1 }),
  ];
  expect(likeTarget(day, "2026-11-09")).toEqual({
    error: "2026-11-09 held 3 auctions (13-Week Bill, 3-Year Note, 26-Week Bill): search for one, as in fn AUCT 3Y --like 2026-11-09.",
  });
  expect(likeTarget([day[0]!, day[2]!], "2026-11-09")).toMatchObject({ error: expect.stringContaining("as in fn AUCT 13W --like 2026-11-09.") });
});
