import type { CorporateActionsData, Fundamentals } from "../types/financials";
import { abortable, settleWithin } from "../utils/async-deadline";
import { distributionHistory, forwardYieldMayHaveLapsed, lapsedDividend, lastPaidNote, NO_CURRENT_DIVIDEND } from "../utils/forward-dividend";

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
 *   fifteen months (a fund that pays none, such as GLD);
 * - `stopped`: 0, when the dividend has stopped by the issuer's own cadence
 *   (lapsedDividend, as every pane reads a lapsed forward yield): WHR, last
 *   paid 2026-02-27, whose stated 12.91% annualized a payment that did not
 *   recur. `lastPaid` dates it.
 *
 * Null when none says: an unknown yield is never taken as 0.
 */
export interface ModelDividendYield {
  /** Decimal annual yield. */
  value: number;
  basis: "stated" | "none-paid" | "stopped";
  /** The last distribution's ex-date (YYYY-MM-DD) of a `stopped` dividend; null when unknown. */
  lastPaid?: string | null;
}

/** What the yield is read from: the fundamentals' yield, its basis, and the ex-date of the distribution it annualizes. */
export type StatedDividend = Pick<Fundamentals, "dividendYield" | "dividendYieldBasis" | "exDividendDate">;

const symbolKey = (value: string | null | undefined) => (value ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");

/** Whether a history is `symbol`'s own and current, covering dividends. */
function currentHistory(actions: CorporateActionsData | null | undefined, symbol: string): actions is CorporateActionsData {
  return !!actions && !actions.stale && actions.coverage?.dividends === "available" && symbolKey(actions.symbol) === symbolKey(symbol);
}

/** Whether a current history that covers dividends shows none paid or declared for `symbol` in the last fifteen months. */
function paysNoDividend(actions: CorporateActionsData, now: number): boolean {
  const since = now - NO_DIVIDEND_WINDOW_MS;
  // A date that cannot be read counts as recent: it cannot show the dividend stopped.
  const recent = (exDate: unknown) => {
    const time = typeof exDate === "string" ? Date.parse(`${exDate.slice(0, 10)}T00:00:00Z`) : Number.NaN;
    return !Number.isFinite(time) || time >= since;
  };
  return !actions.dividends.some((dividend) => recent(dividend.exDate))
    && !(actions.declaredDividends ?? []).some((dividend) => recent(dividend.exDate));
}

/** 0, dated by the last distribution, when the current history shows the dividend dated `asOf` stopped (lapsedDividend). */
function stoppedDividend(asOf: string | undefined, actions: CorporateActionsData, now: number): ModelDividendYield | null {
  const lapse = lapsedDividend(asOf, distributionHistory(actions, new Date(now)), new Date(now));
  return lapse ? { value: 0, basis: "stopped", lastPaid: lapse.lastPaid } : null;
}

interface DividendHistoryOptions {
  now?: number;
  /** Stops waiting for the history; the request itself is shared and keeps running. */
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * The yield to value `symbol` at: 0 when its distribution history shows the
 * dividend stopped, else `stated` when it is a yield, else 0 when the history
 * shows none paid, else null. The history is read when no yield is stated,
 * and for a forward yield old enough to have lapsed; one that fails, is stale
 * or takes over five seconds leaves a stated yield as it is and an unstated
 * one unknown.
 */
export async function loadModelDividendYield(
  stated: StatedDividend | null | undefined,
  symbol: string,
  loadActions: (() => Promise<CorporateActionsData | null | undefined>) | null | undefined,
  { now = Date.now(), signal, timeoutMs = HISTORY_DEADLINE_MS }: DividendHistoryOptions = {},
): Promise<ModelDividendYield | null> {
  const value = stated?.dividendYield;
  const statedYield: ModelDividendYield | null = typeof value === "number" && Number.isFinite(value) && value >= 0
    ? { value, basis: "stated" } : null;
  const mayHaveLapsed = !!statedYield && statedYield.value > 0 && forwardYieldMayHaveLapsed(stated, new Date(now));
  if ((statedYield && !mayHaveLapsed) || !loadActions) return statedYield;
  const read = await abortable(settleWithin(Promise.resolve().then(loadActions), timeoutMs), signal, "Dividend history read was cancelled");
  const actions = currentHistory(read, symbol) ? read : null;
  if (!actions) return statedYield;
  if (statedYield) return stoppedDividend(stated?.exDividendDate, actions, now) ?? statedYield;
  if (paysNoDividend(actions, now)) return { value: 0, basis: "none-paid" };
  return stoppedDividend(stated?.exDividendDate, actions, now);
}

/**
 * What a yield read as 0 is, beside the 0%: `no dividend in the last 15
 * months`, or `no current dividend, last paid 2026-02-27` in the words every
 * pane reads a stopped dividend in. Null for a stated yield.
 */
export function modelDividendYieldNote(dividend: Pick<ModelDividendYield, "basis" | "lastPaid"> | null | undefined): string | null {
  if (dividend?.basis === "none-paid") return NO_DIVIDEND_PAID;
  if (dividend?.basis !== "stopped") return null;
  const lastPaid = lastPaidNote({ lastPaid: dividend.lastPaid ?? null });
  return lastPaid ? `${NO_CURRENT_DIVIDEND}, ${lastPaid}` : NO_CURRENT_DIVIDEND;
}

/** What a yield the history shows none paid is, beside the 0%: `no dividend in the last 15 months`. */
export const NO_DIVIDEND_PAID = "no dividend in the last 15 months";
