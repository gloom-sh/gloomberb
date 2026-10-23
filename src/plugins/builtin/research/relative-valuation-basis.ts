/**
 * What RV's figures run through, as its footer says it under the text table,
 * in the pane and in a capture: the statement period the trailing figures
 * reach, and the basis of each column that is not trailing twelve months.
 */

interface DatedPeer {
  symbol: string;
  date: string | null | undefined;
}

/**
 * `2026-06-30`, or with peers dated apart, the date most of them share and
 * each other peer's own: `2026-06-30 (LRN 2026-03-31)`. Null when none is dated.
 */
export function peerDatesText(peers: readonly DatedPeer[]): string | null {
  const dated = peers.flatMap(({ symbol, date }) => (date ? [{ symbol, date: date.slice(0, 10) }] : []));
  if (dated.length === 0) return null;
  const counts = new Map<string, number>();
  for (const { date } of dated) counts.set(date, (counts.get(date) ?? 0) + 1);
  const [common] = [...counts].sort(([leftDate, left], [rightDate, right]) => right - left || rightDate.localeCompare(leftDate))[0]!;
  const others = dated.filter(({ date }) => date !== common).map(({ symbol, date }) => `${symbol} ${date}`);
  return others.length > 0 ? `${common} (${others.join(", ")})` : common;
}

interface BasisRow {
  symbol: string;
  fundamentalsThrough?: string | null;
  revenueGrowth?: number | null;
  revenueGrowthQuarter?: string | null;
}

/**
 * `fundamentals through 2026-06-30` and the quarter the revenue growth column
 * compares with a year earlier, named by the column's header where the table
 * is read: `, Q REV% for that quarter` when it is the one the fundamentals run
 * through for every peer, else on its own (`Q REV%: quarter to 2026-03-31`).
 * P/E, EV/S, FCF yield and the operating margin are trailing twelve months
 * through that date; the forward P/E says forward in its own header.
 */
export function fundamentalsBasisParts(rows: readonly BasisRow[], revenueGrowthHeader: string): string[] {
  const through = peerDatesText(rows.map(({ symbol, fundamentalsThrough }) => ({ symbol, date: fundamentalsThrough })));
  const growing = rows.filter((row) => row.revenueGrowth != null);
  const quarter = peerDatesText(growing.map(({ symbol, revenueGrowthQuarter }) => ({ symbol, date: revenueGrowthQuarter })));
  if (through && quarter && growing.every((row) => row.revenueGrowthQuarter === row.fundamentalsThrough)) {
    return [`fundamentals through ${through}, ${revenueGrowthHeader} for that quarter`];
  }
  return [
    ...(through ? [`fundamentals through ${through}`] : []),
    ...(quarter ? [`${revenueGrowthHeader}: quarter to ${quarter}`] : []),
  ];
}
