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
  fcfYield?: number | null;
  /** The quarter end the filed quarters' free cash flow runs through, where the yield is theirs and not the served TTM. */
  fcfYieldThrough?: string | null;
}

/** `fundamentals through 2026-06-30`, the newest statement period of each peer's trailing figures; null when none is dated. */
export function fundamentalsThroughText(rows: readonly BasisRow[]): string | null {
  const through = peerDatesText(rows.map(({ symbol, fundamentalsThrough }) => ({ symbol, date: fundamentalsThrough })));
  return through ? `fundamentals through ${through}` : null;
}

/**
 * `fundamentals through 2026-06-30` and the quarter the revenue growth column
 * compares with a year earlier, named by the column's header where the table
 * is read: `, Q REV% for that quarter` when it is the one the fundamentals run
 * through for every peer, else on its own (`Q REV%: quarter to 2026-03-31`).
 * P/E, EV/S, FCF yield and the operating margin are trailing twelve months
 * through that date; the forward P/E says forward in its own header. An FCF
 * yield summed from the filed quarters, where none was served, says so by the
 * column's header (filedFreeCashFlowText).
 */
export function fundamentalsBasisParts(rows: readonly BasisRow[], revenueGrowthHeader: string, fcfYieldHeader = "FCF Yield"): string[] {
  const through = fundamentalsThroughText(rows);
  const growing = rows.filter((row) => row.revenueGrowth != null);
  const quarter = peerDatesText(growing.map(({ symbol, revenueGrowthQuarter }) => ({ symbol, date: revenueGrowthQuarter })));
  const filed = filedFreeCashFlowText(rows, fcfYieldHeader);
  if (through && quarter && growing.every((row) => row.revenueGrowthQuarter === row.fundamentalsThrough)) {
    return [`${through}, ${revenueGrowthHeader} for that quarter`, ...(filed ? [filed] : [])];
  }
  return [
    ...(through ? [through] : []),
    ...(quarter ? [`${revenueGrowthHeader}: quarter to ${quarter}`] : []),
    ...(filed ? [filed] : []),
  ];
}

/**
 * `FCF Yield: filed quarters to 2026-06-30` when every yield shown sums the
 * filed quarters, else `FCF Yield of 8058:JPX, 8001:JPX: filed quarters to
 * 2026-06-30` naming those that do; null when none does.
 */
export function filedFreeCashFlowText(rows: readonly BasisRow[], header: string): string | null {
  const filed = rows.filter((row) => row.fcfYield != null && row.fcfYieldThrough);
  const dates = peerDatesText(filed.map(({ symbol, fcfYieldThrough }) => ({ symbol, date: fcfYieldThrough })));
  if (!dates) return null;
  const every = filed.length === rows.filter((row) => row.fcfYield != null).length;
  return `${header}${every ? "" : ` of ${filed.map((row) => row.symbol).join(", ")}`}: filed quarters to ${dates}`;
}
