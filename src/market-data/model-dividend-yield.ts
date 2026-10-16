import type { CorporateActionsData, TickerFinancials } from "../types/financials";

/**
 * How long a distribution history must go without a dividend before it says a
 * security pays none: fifteen months, since an annual payer's next ex-date can
 * slip a few weeks past a year (Gloom Cloud withdraws a lapsed yield the same way).
 */
const NO_DIVIDEND_WINDOW_MS = 455 * 86_400_000;

/**
 * The continuous dividend yield an option model values an underlying at, read
 * the same way by OSA and the options chain's Greeks
 * (docs/research-data.md#greeks-spot-and-time):
 *
 * - `stated`: the yield the underlying's fundamentals state, current and for
 *   that symbol (0 for a company whose quote affirms it pays none);
 * - `none-paid`: 0, when no yield is stated but its distribution history,
 *   which covers dividends, has none paid or declared in the last fifteen
 *   months (a fund that pays none, such as GLD).
 *
 * Null when neither says: an unknown yield is never taken as 0.
 */
export interface ModelDividendYield {
  /** Decimal annual yield. */
  value: number;
  basis: "stated" | "none-paid";
}

const symbolKey = (value: string | null | undefined) => (value ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");

/** The yield the fundamentals state for `symbol`, or null when they state none, are stale or name another symbol. */
function statedDividendYield(financials: TickerFinancials | null | undefined, symbol: string): number | null {
  const fundamentals = financials?.fundamentals;
  const named = financials?.quote?.symbol ?? financials?.quoteMetadata?.symbol;
  if (!fundamentals || fundamentals.stale || (named && symbolKey(named) !== symbolKey(symbol))) return null;
  const value = fundamentals.dividendYield;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Whether a distribution history that covers dividends shows none paid or declared for `symbol` in the last fifteen months. */
function paysNoDividend(actions: CorporateActionsData | null | undefined, symbol: string, now: number): boolean {
  if (!actions || actions.coverage?.dividends !== "available" || symbolKey(actions.symbol) !== symbolKey(symbol)) return false;
  const since = now - NO_DIVIDEND_WINDOW_MS;
  // A date that cannot be read counts as recent: it cannot show the dividend stopped.
  const recent = (exDate: unknown) => {
    const time = typeof exDate === "string" ? Date.parse(`${exDate.slice(0, 10)}T00:00:00Z`) : Number.NaN;
    return !Number.isFinite(time) || time >= since;
  };
  return !actions.dividends.some((dividend) => recent(dividend.exDate))
    && !(actions.declaredDividends ?? []).some((dividend) => recent(dividend.exDate));
}

/**
 * The yield to value `symbol` at: the stated one, else 0 when its distribution
 * history shows none paid, else null. The history is read only when no yield
 * is stated, and a history that cannot be read leaves the yield unknown.
 */
export async function loadModelDividendYield(
  financials: TickerFinancials | null | undefined,
  symbol: string,
  loadActions: (() => Promise<CorporateActionsData | null | undefined>) | null | undefined,
  now = Date.now(),
): Promise<ModelDividendYield | null> {
  const stated = statedDividendYield(financials, symbol);
  if (stated != null) return { value: stated, basis: "stated" };
  if (!loadActions) return null;
  const actions = await Promise.resolve().then(loadActions).catch(() => null);
  return paysNoDividend(actions, symbol, now) ? { value: 0, basis: "none-paid" } : null;
}

/** What a yield the history shows none paid is, beside the 0%: `no dividend in the last 15 months`. */
export const NO_DIVIDEND_PAID = "no dividend in the last 15 months";
