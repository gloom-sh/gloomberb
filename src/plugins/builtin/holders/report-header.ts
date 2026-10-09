import { currencyUnitLabel, resolveCurrencyUnit } from "../../../utils/currency-units";
import { canonicalExchange, isUsListingExchange, resolveExchangeTimeZone } from "../../../utils/exchanges";

/**
 * The lines above a holder table in text reports (`holders`, `insider`,
 * `13f`, `fn HDS`): which listing, in which unit, and how much of the list
 * is shown. Holder lists come as the source's own top holders, usually
 * without a total, so the count says that rather than implying a full list.
 */
export interface HolderReportFacts {
  name?: string | null;
  /** Left out when the report title already names it. */
  symbol?: string | null;
  exchange?: string | null;
  currency?: string | null;
  /** Left out when the report's closing line already carries it. */
  asOf?: string | null;
  /** Rows printed. */
  shown: number;
  /** Rows the source returned, before any limit. */
  reported: number;
  /** Every holder the source counts, when it says so. */
  total?: number | null;
}

/** "Value (GBp)": a money column names its unit. */
export function moneyColumnHeader(label: string, currency?: string | null): string {
  const unit = currency?.trim();
  return unit ? `${label} (${unit})` : label;
}

function holderCountText(shown: number, reported: number, total?: number | null): string {
  if (total != null && Number.isFinite(total) && total >= reported) {
    return `${shown.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} holders`;
  }
  if (reported === 0) return "none reported";
  // Without a total the source's list is its largest holders, cut where it cuts it.
  return shown < reported ? `${shown} of top ${reported} reported` : `top ${reported} reported`;
}

/** A venue the app knows by its short name (NasdaqGS is NASDAQ); any other as the source wrote it. */
function venueLabel(exchange?: string | null): string {
  const canonical = canonicalExchange(exchange ?? "");
  return resolveExchangeTimeZone(canonical) ? canonical : (exchange ?? "").trim();
}

/** What the list is, after the listing is named: its unit, date and how much of it is shown. */
export function holderListFacts(
  facts: Pick<HolderReportFacts, "currency" | "asOf" | "shown" | "reported" | "total">,
): string[] {
  return [
    currencyUnitLabel(facts.currency),
    facts.asOf ? `as of ${facts.asOf}` : "",
    holderCountText(facts.shown, facts.reported, facts.total),
  ].filter(Boolean);
}

export function holdersHeaderLine(facts: HolderReportFacts): string {
  const name = facts.name?.trim();
  const symbol = facts.symbol?.trim();
  const identity = name && symbol && name !== symbol ? `${name} (${symbol})` : name || symbol || "";
  return [identity, venueLabel(facts.exchange), ...holderListFacts(facts)].filter(Boolean).join(" | ");
}

/** The one report date every row shares, or null when they differ or none has one. */
export function sharedReportDate(rows: ReadonlyArray<{ reportDate?: unknown }>): string | null {
  const dates = new Set(rows.map((row) => (typeof row.reportDate === "string" ? row.reportDate : "")));
  const [only] = dates;
  return dates.size === 1 && only ? only : null;
}

/** How a holder value was reached: reported shares times a current price, not the filing's own value. */
export function holderValueBasis(reportDate: string | null): string {
  return `shares reported${reportDate ? ` at ${reportDate}` : ""} x latest price`;
}

/** A listing outside the US, by its venue, or by a currency other than the dollar. */
function isNonUsHolderListing(exchange?: string | null, currency?: string | null): boolean {
  const venue = canonicalExchange(exchange ?? "");
  if (venue && !isUsListingExchange(venue) && resolveExchangeTimeZone(venue)) return true;
  const unit = resolveCurrencyUnit(currency).currency;
  return unit !== "" && unit !== "USD";
}

/**
 * Holder lists are institutions' quarterly filings, mostly US 13F. On a
 * listing outside the US they are not that market's share register, which a
 * reader would otherwise assume.
 */
export function nonUsHolderCaveat(exchange?: string | null, currency?: string | null): string | null {
  if (!isNonUsHolderListing(exchange, currency)) return null;
  const canonical = canonicalExchange(exchange ?? "");
  const venue = resolveExchangeTimeZone(canonical) ? canonical : "local";
  return `Positions come from institutional filings (mostly US 13F), not the ${venue} share register.`;
}
