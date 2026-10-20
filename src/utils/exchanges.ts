import { EXCHANGE_NOTATION } from "./exchange-notation.generated";

/**
 * Every spelling read as a venue, by the venue's code. The table is Gloom
 * Cloud's, generated into exchange-notation.generated.ts so the terminal, the
 * phone and Gloom Cloud read every spelling the same way: add one there, not
 * here.
 */
export const CANONICAL_EXCHANGE_ALIASES: Readonly<Record<string, string>> = EXCHANGE_NOTATION.aliases;

/** What a listing key writes for a venue when it is not the code: its MIC (VOD:XLON). */
const PUBLIC_EXCHANGE_ALIASES: Readonly<Record<string, string>> = EXCHANGE_NOTATION.keyCodes;

export const EXCHANGE_TIME_ZONES: Record<string, string> = {
  NASDAQ: "America/New_York",
  NYSE: "America/New_York",
  ARCA: "America/New_York",
  AMEX: "America/New_York",
  BATS: "America/New_York",
  FWB: "Europe/Berlin",
  FWB2: "Europe/Berlin",
  XETRA: "Europe/Berlin",
  SWX: "Europe/Zurich",
  SFB: "Europe/Stockholm",
  HKEX: "Asia/Hong_Kong",
  JPX: "Asia/Tokyo",
  TSX: "America/Toronto",
  TSXV: "America/Toronto",
  CSE: "America/Toronto",
  EPA: "Europe/Paris",
  AMS: "Europe/Amsterdam",
  BRU: "Europe/Brussels",
  LIS: "Europe/Lisbon",
  BIT: "Europe/Rome",
  HEL: "Europe/Helsinki",
  CPH: "Europe/Copenhagen",
  OSL: "Europe/Oslo",
  ICEX: "Atlantic/Reykjavik",
  WSE: "Europe/Warsaw",
  PSE: "Europe/Prague",
  VIE: "Europe/Vienna",
  WBDM: "Europe/Vienna",
  TPEX: "Asia/Taipei",
  TWSE: "Asia/Taipei",
  NSE: "Asia/Kolkata",
  BSE: "Asia/Kolkata",
  LSE: "Europe/London",
  ASX: "Australia/Sydney",
  SGX: "Asia/Singapore",
  KRX: "Asia/Seoul",
  KOSDAQ: "Asia/Seoul",
  NZX: "Pacific/Auckland",
  SSE: "Asia/Shanghai",
  SZSE: "Asia/Shanghai",
  BMV: "America/Mexico_City",
  B3: "America/Sao_Paulo",
  BYMA: "America/Argentina/Buenos_Aires",
  JSE: "Africa/Johannesburg",
  TASE: "Asia/Jerusalem",
  TADAWUL: "Asia/Riyadh",
  QE: "Asia/Qatar",
  BHB: "Asia/Bahrain",
  DFM: "Asia/Dubai",
  MSX: "Asia/Muscat",
  KUWAIT: "Asia/Kuwait",
  EGX: "Africa/Cairo",
  CCC: "UTC",
  HYPERLIQUID: "UTC",
  BINANCE: "UTC",
  BYBIT: "UTC",
  OKX: "UTC",
  DERIBIT: "UTC",
  DYDX: "UTC",
};

/**
 * Venue names by canonical code, for output that names the listing a command
 * resolved ("Euronext Paris (EPA)"). Codes whose name is the code itself
 * (NASDAQ, BSE) are left out.
 */
const EXCHANGE_NAMES: Readonly<Record<string, string>> = EXCHANGE_NOTATION.names;

const KNOWN_EXCHANGE_CODES: ReadonlySet<string> = new Set([
  ...Object.keys(CANONICAL_EXCHANGE_ALIASES),
  ...Object.values(CANONICAL_EXCHANGE_ALIASES),
  ...Object.keys(EXCHANGE_TIME_ZONES),
  ...Object.keys(EXCHANGE_NAMES),
]);

/** Whether a code (any spelling the alias table takes) names a venue the app knows. */
export function isKnownExchangeCode(value?: string): boolean {
  const normalized = normalizeExchange(value);
  return !!normalized && KNOWN_EXCHANGE_CODES.has(normalized);
}

/** "Euronext Paris (EPA)" for a venue with a name, the canonical code otherwise. */
export function exchangeLabel(value?: string): string {
  const code = canonicalExchange(value);
  const name = EXCHANGE_NAMES[code];
  return name ? `${name} (${code})` : code;
}

export function normalizeSymbol(value: string): string {
  return value.trim().toUpperCase();
}

function normalizeExchange(value?: string): string {
  return (value ?? "").trim().toUpperCase();
}

export function canonicalExchange(value?: string): string {
  const normalized = normalizeExchange(value);
  return CANONICAL_EXCHANGE_ALIASES[normalized] ?? normalized;
}

/**
 * Codes people type for more than one venue, the venue `canonicalExchange`
 * reads them as first. TSE is the Tokyo Stock Exchange's own short name, and
 * the code brokers and quote sites give Toronto; KRX is the Korea Exchange,
 * which runs both KOSPI and KOSDAQ; EURONEXT runs Paris, Amsterdam, Brussels,
 * Lisbon, Oslo and Milan. Data that arrives with one (a broker's contract)
 * keeps the first venue; a listing typed with one is the venue its symbol
 * trades on.
 */
const SHARED_EXCHANGE_CODES: Readonly<Record<string, readonly string[]>> = Object.fromEntries(
  Object.entries(EXCHANGE_NOTATION.sharedCodes).map(([code, shared]) => [code, shared.venues]),
);

/** Whether a typed exchange code names more than one venue (TSE: Tokyo or Toronto). */
export function isSharedExchangeCode(value?: string): boolean {
  return normalizeExchange(value) in SHARED_EXCHANGE_CODES;
}

/**
 * Every venue a typed exchange code can name, as canonical codes: TSE is
 * TSX or JPX, PAR is EPA. Empty for no code.
 */
export function exchangeCodeVenues(value?: string): string[] {
  const normalized = normalizeExchange(value);
  if (!normalized) return [];
  return [...(SHARED_EXCHANGE_CODES[normalized] ?? [canonicalExchange(normalized)])];
}

/** The exchange code after a listing key's colon, as typed: TSE for 7203:TSE; "" when there is none. */
export function typedExchangeCode(key: string): string {
  const normalized = normalizeSymbol(key);
  const separator = normalized.lastIndexOf(":");
  return separator > 0 ? normalized.slice(separator + 1) : "";
}

/**
 * The US primary listing venues, as canonical exchanges. All of them trade the
 * US regular and extended-hours sessions.
 */
export const US_LISTING_EXCHANGES: ReadonlySet<string> = new Set(["NASDAQ", "NYSE", "AMEX", "ARCA", "BATS"]);

export function isUsListingExchange(value?: string): boolean {
  return US_LISTING_EXCHANGES.has(canonicalExchange(value));
}

export function resolveExchangeTimeZone(value?: string): string | null {
  const canonical = canonicalExchange(value);
  return canonical ? EXCHANGE_TIME_ZONES[canonical] ?? null : null;
}

export function publicExchange(value?: string): string {
  const canonical = canonicalExchange(value);
  return PUBLIC_EXCHANGE_ALIASES[canonical] ?? canonical;
}

/**
 * Prediction-market venues. A market is saved venue first, `KALSHI:KXGREENLAND-29`,
 * the reverse of a listing key, so what follows the colon is its market id.
 */
const PREDICTION_MARKET_EXCHANGES: ReadonlySet<string> = new Set(["KALSHI"]);

/** Whether an exchange code is a prediction-market venue's. */
export function isPredictionMarketExchange(value?: string): boolean {
  return PREDICTION_MARKET_EXCHANGES.has(canonicalExchange(value));
}

export function parsePublicTickerKey(value: string): { symbol: string; exchange?: string } {
  const normalized = normalizeSymbol(value);
  const venueEnd = normalized.indexOf(":");
  if (venueEnd > 0 && PREDICTION_MARKET_EXCHANGES.has(normalized.slice(0, venueEnd))) {
    // What follows the colon is the market id, not an exchange.
    const marketId = normalized.slice(venueEnd + 1);
    if (marketId && !marketId.includes(":")) return { symbol: marketId, exchange: normalized.slice(0, venueEnd) };
  }
  const separator = normalized.lastIndexOf(":");
  if (separator <= 0 || separator === normalized.length - 1) return { symbol: normalized };
  const exchange = canonicalExchange(normalized.slice(separator + 1));
  let symbol = normalized.slice(0, separator);
  // Older callers could append the same exchange more than once. Repair only
  // repeated aliases of that exchange, preserving any other symbol content.
  for (let nested = symbol.lastIndexOf(":"); nested > 0; nested = symbol.lastIndexOf(":")) {
    if (canonicalExchange(symbol.slice(nested + 1)) !== exchange) break;
    symbol = symbol.slice(0, nested);
  }
  return { symbol, exchange };
}

export function canonicalTickerKey(symbol: string, exchange?: string): string {
  const parsed = parsePublicTickerKey(symbol);
  // An explicit listing in the symbol wins over remembered/default metadata.
  const canonical = parsed.exchange ?? canonicalExchange(exchange);
  return canonical ? `${parsed.symbol}:${canonical}` : parsed.symbol;
}

export function publicTickerKey(symbol: string, exchange?: string): string {
  const parsed = parsePublicTickerKey(symbol);
  const publicValue = publicExchange(parsed.exchange ?? exchange);
  return publicValue ? `${parsed.symbol}:${publicValue}` : parsed.symbol;
}
