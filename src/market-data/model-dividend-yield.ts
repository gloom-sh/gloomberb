import type { CorporateActionsData } from "../types/financials";
import { abortable, settleWithin } from "../utils/async-deadline";

/**
 * How long a distribution history must go without a dividend before it says a
 * security pays none: fifteen months, since an annual payer's next ex-date can
 * slip a few weeks past a year (Gloom Cloud withdraws a lapsed yield the same
 * way). Gloom Cloud's history reaches back ten years (SAP's and Novartis's
 * annual dividends from 2017 on), well past this window.
 */
const NO_DIVIDEND_WINDOW_MS = 455 * 86_400_000;

/** How long the history may take before the yield is left unknown. */
const HISTORY_DEADLINE_MS = 5_000;

/**
 * The continuous dividend yield an option model values an underlying at, read
 * the same way by OSA and the options chain's Greeks
 * (docs/research-data.md#greeks-spot-and-time):
 *
 * - `stated`: the yield the underlying's fundamentals state, which the caller
 *   reads (0 for a company whose quote affirms it pays none);
 * - `none-paid`: 0, when no yield is stated but its distribution history,
 *   current and covering dividends, has none paid or declared in the last
 *   fifteen months (a fund that pays none, such as GLD).
 *
 * Null when neither says: an unknown yield is never taken as 0.
 */
export interface ModelDividendYield {
  /** Decimal annual yield. */
  value: number;
  basis: "stated" | "none-paid";
}

const symbolKey = (value: string | null | undefined) => (value ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");

/** Whether a current history that covers dividends shows none paid or declared for `symbol` in the last fifteen months. */
function paysNoDividend(actions: CorporateActionsData | null | undefined, symbol: string, now: number): boolean {
  if (!actions || actions.stale || actions.coverage?.dividends !== "available" || symbolKey(actions.symbol) !== symbolKey(symbol)) return false;
  const since = now - NO_DIVIDEND_WINDOW_MS;
  // A date that cannot be read counts as recent: it cannot show the dividend stopped.
  const recent = (exDate: unknown) => {
    const time = typeof exDate === "string" ? Date.parse(`${exDate.slice(0, 10)}T00:00:00Z`) : Number.NaN;
    return !Number.isFinite(time) || time >= since;
  };
  return !actions.dividends.some((dividend) => recent(dividend.exDate))
    && !(actions.declaredDividends ?? []).some((dividend) => recent(dividend.exDate));
}

interface DividendHistoryOptions {
  now?: number;
  /** Stops waiting for the history; the request itself is shared and keeps running. */
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * The yield to value `symbol` at: `stated` when it is a yield, else 0 when its
 * distribution history shows none paid, else null. The history is read only
 * when no yield is stated; one that fails, is stale or takes over five seconds
 * leaves the yield unknown.
 */
export async function loadModelDividendYield(
  stated: number | null | undefined,
  symbol: string,
  loadActions: (() => Promise<CorporateActionsData | null | undefined>) | null | undefined,
  { now = Date.now(), signal, timeoutMs = HISTORY_DEADLINE_MS }: DividendHistoryOptions = {},
): Promise<ModelDividendYield | null> {
  if (typeof stated === "number" && Number.isFinite(stated) && stated >= 0) return { value: stated, basis: "stated" };
  if (!loadActions) return null;
  const actions = await abortable(settleWithin(Promise.resolve().then(loadActions), timeoutMs), signal, "Dividend history read was cancelled");
  return paysNoDividend(actions, symbol, now) ? { value: 0, basis: "none-paid" } : null;
}

/** What a yield the history shows none paid is, beside the 0%: `no dividend in the last 15 months`. */
export const NO_DIVIDEND_PAID = "no dividend in the last 15 months";
