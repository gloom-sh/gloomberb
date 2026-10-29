/**
 * The listing a pane's company data comes from when it is not the listing on
 * screen: a receipt or a foreign line (SKHY, HY9H in Frankfurt) reads its
 * company's home line (000660 on KRX) for news, filings, holders, hiring and
 * the other company panes. Gloom Cloud names it on those answers.
 */
export interface CompanyFrom {
  symbol: string;
  /** The venue's code (KRX, FWB2, NASDAQ). */
  exchange: string;
  /** The company's name. */
  name?: string;
}

const US_VENUES = new Set(["NASDAQ", "NYSE", "AMEX", "ARCA", "BATS", "CBOE", "IEX"]);

/** The listing as the note names it: `000660 KRX`, or `SKHY` on a US venue. */
export function companyFromLabel(from: CompanyFrom): string {
  const exchange = from.exchange.trim().toUpperCase();
  return exchange && !US_VENUES.has(exchange) ? `${from.symbol} ${exchange}` : from.symbol;
}

/** The note's listing from an answer's field, or null when the answer names none or something malformed. */
export function readCompanyFrom(value: unknown): CompanyFrom | null {
  if (!value || typeof value !== "object") return null;
  const { symbol, exchange, name } = value as Record<string, unknown>;
  if (typeof symbol !== "string" || !symbol.trim() || typeof exchange !== "string") return null;
  return { symbol: symbol.trim(), exchange: exchange.trim(), ...(typeof name === "string" && name.trim() ? { name: name.trim() } : {}) };
}

/**
 * What a report says under company data read from another listing, as the
 * pane's footer does: "Company data from 000660 KRX (SK hynix)." Empty when
 * the data is the listing's own, so a report's notes spread it as they are.
 */
export function companyDataNotes(from: CompanyFrom | null | undefined): string[] {
  if (!from) return [];
  const listing = companyFromLabel(from);
  return [`Company data from ${listing}${from.name && from.name !== from.symbol ? ` (${from.name})` : ""}.`];
}
