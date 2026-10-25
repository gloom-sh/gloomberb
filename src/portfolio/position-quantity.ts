import { resolveAssetDisplayKind } from "../market-data/market/format";
import type { TickerRecord } from "../types/ticker";
import { ambiguousNumberMessage, thousandsDotReadings } from "../utils/decimal-comma";
import { isKnownNonUsListing } from "../utils/sec";
import { isFuturesTicker } from "./futures-positions";
import { positionQuantityLabel, type PositionQuantityLabel } from "./mutations";

/** Fund units are issued in fractions wherever the fund is listed. */
const FRACTIONAL_FUND_TYPES = new Set(["FUND", "MUTUALFUND"]);

/**
 * Whether a listing is held in whole units: a future's or an option's
 * contracts, and shares listed outside the US, which trade in whole lots
 * (THYAO.IS, SAP:XETRA). US shares, which brokers split into fractions,
 * mutual funds, coins, currencies and bonds may be held in fractions.
 */
function tradesInWholeUnits(ticker: TickerRecord): boolean {
  const kind = resolveAssetDisplayKind({ assetCategory: ticker.metadata.assetCategory });
  if (isFuturesTicker(ticker) || kind === "contract") return true;
  const category = ticker.metadata.assetCategory?.trim().toUpperCase().replace(/[\s_-]/g, "") ?? "";
  const shares = kind === "equity" ? !FRACTIONAL_FUND_TYPES.has(category) : kind === "other" && !category;
  return shares && isKnownNonUsListing(ticker);
}

/**
 * Why a typed size cannot be stored as read: a dot and three digits (`1.000`,
 * `1.250`), which is as likely the thousands grouping many locales write
 * (1,000 shares, as cash reads `1.000`) as a fraction of a share, so the
 * command asks which, as it does for `1,250`. On a listing held in whole
 * units the thousands reading is the only one that can be held, and the
 * message says so. Null for any other size (`0.500`, `12.25`).
 */
export function ambiguousQuantityProblem(
  typed: string,
  ticker: TickerRecord,
  options: { label?: PositionQuantityLabel; listing?: string } = {},
): string | null {
  const reading = thousandsDotReadings(typed);
  if (!reading) return null;
  const label = options.label ?? positionQuantityLabel(ticker);
  const listing = options.listing ?? ticker.metadata.ticker;
  const because = tradesInWholeUnits(ticker)
    ? `${listing} trades in whole ${label === "Contracts" ? "contracts" : "shares"}`
    : undefined;
  // The fraction typed so it does not read two ways itself: 1.234 asks again, 1.2340 does not.
  const fraction = String(reading.decimal);
  const decimalAs = thousandsDotReadings(fraction) ? `${fraction}0` : fraction;
  return `${label} ${ambiguousNumberMessage(typed, reading, { because, decimalAs })}.`;
}
