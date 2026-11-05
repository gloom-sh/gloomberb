/**
 * A book's P&L between two closes, by position: what `portfolio show --from
 * --to` prints and the PF pane's period P&L shows. Each holding is valued at
 * the close before the window starts and at its last close in the window, as
 * RETURN measures a ticker over the same dates, so the two always agree. A
 * future's closes are its settlements, and a contract counts its size. A short
 * gains when the price falls. A holding in another currency earns its price
 * move at the end's FX rate, and the currency's own move on its start value
 * is the separate FX line, so price and currency are never mixed in one figure.
 */

/** A holding's close on a day: a share's regular close, a future's settlement. */
export interface PeriodClose {
  /** The session's local date. */
  day: string;
  price: number;
}

export interface PeriodPnlHolding {
  symbol: string;
  /** Signed price units held: shares, or contracts times their size; negative for a short. */
  priceUnits: number;
  /** The currency the price is quoted in. */
  currency: string;
  /** The close before the window, and the last one in it; null when the history has none. */
  start: PeriodClose | null;
  end: PeriodClose | null;
  /** The end is today's session still trading, not a close. */
  partialEnd?: boolean;
}

/** One unit of a currency in the book's currency on a day; null when no close of the pair could be read. */
export type PeriodFxRate = (currency: string, day: string) => number | null;

export interface PeriodPnlRow {
  symbol: string;
  priceUnits: number;
  currency: string;
  start: PeriodClose | null;
  end: PeriodClose | null;
  partialEnd: boolean;
  /** The price's move over the window, in percent. */
  changePercent: number | null;
  /** The position's value at the start, signed, in the book's currency at the start's rate. */
  startValue: number | null;
  /** The price move times the units held, in the book's currency at the end's rate. */
  pnl: number | null;
  /** The currency's move on the start value; 0 for a holding in the book's currency. */
  fx: number | null;
  /** The start and end rates of a holding in another currency. */
  rates: { start: number; end: number } | null;
  /** The price P&L over the book's start value (`PeriodPnl.contributionBase`), in percent; the FX line carries the currency's. */
  contribution: number | null;
}

export interface PeriodPnl {
  rows: PeriodPnlRow[];
  /** The FX line: every holding's currency move, together. */
  fx: number;
  fxContribution: number | null;
  /** Price P&L and FX together, over the holdings that have both closes. */
  total: number;
  totalContribution: number | null;
  /**
   * What contribution divides by: the book's value at the start, as its
   * weights are, net for a long-only book and gross (longs plus shorts at
   * their absolute value) for one that holds a short.
   */
  contributionBase: number | null;
  contributionBasis: "net" | "gross";
  /** Holdings without a close at one end of the window, or without a rate for their currency. */
  unpriced: string[];
}

const finite = (value: number | null | undefined): value is number => value != null && Number.isFinite(value);

export function periodPnl(holdings: readonly PeriodPnlHolding[], bookCurrency: string, rate: PeriodFxRate): PeriodPnl {
  const sameCurrency = (currency: string) => currency.toUpperCase() === bookCurrency.toUpperCase();
  const unpriced: string[] = [];
  const valued = holdings.map((holding) => {
    const { start, end } = holding;
    const own = sameCurrency(holding.currency);
    const startRate = start ? own ? 1 : rate(holding.currency, start.day) : null;
    const endRate = end ? own ? 1 : rate(holding.currency, end.day) : null;
    const priced = !!start && !!end && finite(startRate) && finite(endRate);
    if (!priced) unpriced.push(holding.symbol);
    const startValue = start && finite(startRate) ? holding.priceUnits * start.price * startRate : null;
    return {
      symbol: holding.symbol, priceUnits: holding.priceUnits, currency: holding.currency, start, end, partialEnd: !!holding.partialEnd,
      changePercent: start && end && start.price !== 0 ? (end.price / start.price - 1) * 100 : null,
      startValue,
      pnl: priced ? holding.priceUnits * (end!.price - start!.price) * endRate! : null,
      fx: priced ? holding.priceUnits * start!.price * (endRate! - startRate!) : null,
      rates: priced && !own ? { start: startRate!, end: endRate! } : null,
    };
  });
  const starts = valued.flatMap((row) => finite(row.startValue) && finite(row.pnl) ? [row.startValue] : []);
  const shorts = starts.some((value) => value < 0);
  const base = starts.length ? starts.reduce((sum, value) => sum + (shorts ? Math.abs(value) : value), 0) : null;
  const contributionBase = finite(base) && base > 0 ? base : null;
  const rows = valued.map((row): PeriodPnlRow => ({
    ...row,
    contribution: contributionBase && finite(row.pnl) ? (row.pnl / contributionBase) * 100 : null,
  }));
  const fx = rows.reduce((sum, row) => sum + (finite(row.fx) ? row.fx : 0), 0);
  const total = rows.reduce((sum, row) => sum + (finite(row.pnl) && finite(row.fx) ? row.pnl + row.fx : 0), 0);
  const share = (value: number) => contributionBase ? (value / contributionBase) * 100 : null;
  return { rows, fx, fxContribution: share(fx), total, totalContribution: share(total), contributionBase, contributionBasis: shorts ? "gross" : "net", unpriced };
}
