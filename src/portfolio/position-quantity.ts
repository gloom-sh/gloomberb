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
 * Why a typed size cannot be stored as read: a dot and three digits (`1.250`)
 * on a listing held in whole units, where it is far likelier the thousands
 * grouping many locales write (1,250 shares) than a quarter of a share, so the
 * command asks which, as it does for `1,250`. Null for any other size, and
 * for a listing that may be held in fractions, where `1.250` is 1.25.
 */
export function wholeUnitQuantityProblem(
  typed: string,
  ticker: TickerRecord,
  options: { label?: PositionQuantityLabel; listing?: string } = {},
): string | null {
  const reading = thousandsDotReadings(typed);
  if (!reading || !tradesInWholeUnits(ticker)) return null;
  const label = options.label ?? positionQuantityLabel(ticker);
  const listing = options.listing ?? ticker.metadata.ticker;
  const because = `${listing} trades in whole ${label === "Contracts" ? "contracts" : "shares"}`;
  return `${label} ${ambiguousNumberMessage(typed, reading, { because })}.`;
}
