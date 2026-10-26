import { CANONICAL_EXCHANGE_ALIASES, canonicalExchange, parsePublicTickerKey } from "../utils/exchanges";

const EXCHANGE_SUFFIX_MAP: Record<string, string> = {
  NASDAQ: "", NMS: "", NYSE: "", AMEX: "", ARCA: "", NYSEArca: "", BATS: "", BYX: "", IEX: "", PINK: "", OTC: "",
  TSX: ".TO", VENTURE: ".V", CSE2: ".CN", CNSX: ".CN",
  TYO: ".T", JPX: ".T", TSEJ: ".T",
  HKEX: ".HK", SEHK: ".HK", HKG: ".HK",
  SSE: ".SS", SHG: ".SS", SZSE: ".SZ", SHE: ".SZ",
  TWSE: ".TW", TPE: ".TW", TPEX: ".TWO",
  KRX: ".KS", KSE: ".KS", KOSDAQ: ".KQ",
  SGX: ".SI", SES: ".SI",
  IDX: ".JK",
  NSE: ".NS", BSE: ".BO",
  ASX: ".AX", NZE: ".NZ",
  SET: ".BK", BKK: ".BK", KLSE: ".KL", MYX: ".KL", PSE: ".PS", HOSE: ".VN", HNX: ".VN",
  LSE: ".L", LSEETF: ".L",
  XETRA: ".DE", XETR: ".DE", IBIS: ".DE", IBIS2: ".DE", FWB: ".F", FWB2: ".F", GETTEX: ".DE", TGATE: ".DE", SWB: ".SG",
  EURONEXT: ".AS", AEB: ".AS", AMS: ".AS", SBF: ".PA", EPA: ".PA", "ENEXT.BE": ".BR", BRU: ".BR", BVL: ".LS", LIS: ".LS",
  // MCE and VIE are Madrid and Vienna as Gloom Cloud names them (REP.MC, OMV.VI).
  BVME: ".MI", BIT: ".MI", BM: ".MC", MCE: ".MC",
  SIX: ".SW", EBS: ".SW", SWX: ".SW",
  SFB: ".ST", Stockholm: ".ST", OMX: ".ST", CPH: ".CO", HEX: ".HE", HEL: ".HE", OSE: ".OL", OSL: ".OL", OMXNO: ".OL", ICEX: ".IC",
  VSE: ".VI", VIE: ".VI", WSE: ".WA", GPW: ".WA", PRA: ".PR", BUX: ".BD", ATHEX: ".AT", BVB: ".RO", BIST: ".IS",
  TASE: ".TA",
  MSX: ".OM",
  JSE: ".JO",
  BHB: ".BH",
  BVMF: ".SA", MEXI: ".MX", BMV: ".MX", BYMA: ".BA", BCS: ".SN",
  TADAWUL: ".SR", QE: ".QA", DFM: ".AE", KUWAIT: ".KW",
  EGX: ".CA",
};

const EXCHANGE_FALLBACKS: Record<string, string[]> = {
  TSE: [".TO", ".T"],
  KRX: [".KS", ".KQ"], KSE: [".KS", ".KQ"],
  TWSE: [".TW", ".TWO"], TPE: [".TW", ".TWO"], TPEX: [".TWO", ".TW"],
  FWB2: [".F", ".DE"],
  EURONEXT: [".AS", ".PA", ".BR"], AEB: [".AS", ".PA", ".BR"], SBF: [".PA", ".AS", ".BR"],
};

const GENERIC_SUFFIX_FALLBACKS = [
  "", ".HK", ".T", ".TO", ".KS", ".KQ", ".TW", ".TWO", ".SS", ".SZ",
  ".AS", ".PA", ".BR", ".DE", ".F", ".L", ".MI", ".MC", ".SW", ".AX",
  ".SI", ".JK", ".OL", ".ST", ".CO", ".HE", ".NS", ".BO", ".SA",
  ".BK", ".KL", ".NZ", ".JO", ".TA", ".WA", ".VI",
];

const KNOWN_SUFFIXES = new Set(
  Object.values(EXCHANGE_SUFFIX_MAP).filter(Boolean)
    .concat(GENERIC_SUFFIX_FALLBACKS.filter(Boolean)),
);

// The legacy PSE suffix entry means the Philippines; the host's PSE means Prague (.PR).
// Keep that spelling out of host venue inference and conflict checks.
const HOST_SUFFIX_ENTRIES = Object.entries(EXCHANGE_SUFFIX_MAP)
  .filter(([venue, suffix]) => venue !== "PSE" || suffix !== ".PS")
  .map(([venue, suffix]) => [canonicalExchange(venue), suffix] as const);
const KNOWN_HOST_VENUES = new Set(Object.values(CANONICAL_EXCHANGE_ALIASES));
/** A venue's suffix by its canonical code, for a code the table spells another way (B3 for BVMF's .SA). */
const CANONICAL_SUFFIXES = new Map<string, string>();
for (const [venue, suffix] of HOST_SUFFIX_ENTRIES) if (!CANONICAL_SUFFIXES.has(venue)) CANONICAL_SUFFIXES.set(venue, suffix);

export function getListingSymbol(ticker: string, exchange: string): string {
  const qualified = parsePublicTickerKey(ticker);
  ticker = qualified.symbol;
  exchange = qualified.exchange || exchange;
  if (tickerHasListingSuffix(ticker)) return ticker;
  const canonical = canonicalExchange(exchange) || exchange;
  const suffix = EXCHANGE_SUFFIX_MAP[canonical] ?? EXCHANGE_SUFFIX_MAP[exchange] ?? CANONICAL_SUFFIXES.get(canonical) ?? "";
  return `${normalizeListingTicker(ticker, canonical)}${suffix}`;
}

export function getListingSymbolsToTry(
  ticker: string,
  exchange: string,
  options: { exactExchange?: boolean } = {},
): string[] {
  const qualified = parsePublicTickerKey(ticker);
  ticker = qualified.symbol;
  exchange = qualified.exchange || exchange;
  const canonical = canonicalExchange(exchange) || exchange;
  // Explicit listings may use symbol spelling alternatives, but must not
  // resolve an unknown exchange to the default US suffix or try another venue.
  const exactSuffix = options.exactExchange
    ? Object.entries(EXCHANGE_SUFFIX_MAP).find(([key]) => canonicalExchange(key) === canonical)?.[1]
    : undefined;
  if (options.exactExchange && exactSuffix === undefined) return [];
  if (tickerHasListingSuffix(ticker)) {
    if (options.exactExchange && (!exactSuffix || !ticker.endsWith(exactSuffix))) return [];
    return [ticker];
  }

  const normalized = normalizeListingTicker(ticker, canonical);
  const dotVariant = normalized.includes(".") ? normalized.replace(/\./g, "-") : null;

  if (!canonical) {
    const symbols = new Set<string>();
    const candidates = [normalized];
    if (dotVariant) candidates.unshift(dotVariant);
    if (/^\d+$/.test(normalized) && normalized.length < 4) {
      candidates.push(normalized.padStart(4, "0"));
    }
    for (const candidate of candidates) {
      for (const suffix of GENERIC_SUFFIX_FALLBACKS) symbols.add(`${candidate}${suffix}`);
    }
    return Array.from(symbols);
  }

  const fallbacks = options.exactExchange
    ? undefined
    : EXCHANGE_FALLBACKS[canonical] ?? EXCHANGE_FALLBACKS[exchange];
  if (fallbacks) {
    const results = fallbacks.map((suffix) => `${normalized}${suffix}`);
    if (dotVariant) results.unshift(...fallbacks.map((suffix) => `${dotVariant}${suffix}`));
    return results;
  }

  const primary = options.exactExchange ? `${normalized}${exactSuffix}` : getListingSymbol(ticker, canonical);
  if (dotVariant) {
    const suffix = exactSuffix ?? EXCHANGE_SUFFIX_MAP[canonical] ?? EXCHANGE_SUFFIX_MAP[exchange] ?? "";
    return [`${dotVariant}${suffix}`, primary];
  }
  return [primary];
}

export function tickerHasListingSuffix(ticker: string): boolean {
  const dot = ticker.indexOf(".");
  if (dot < 0) return false;
  return KNOWN_SUFFIXES.has(ticker.slice(dot));
}

/** Unknown venue mappings cannot establish a suffix conflict. */
export function listingSuffixConflictsWithExchange(ticker: string, exchange: string): boolean {
  if (!tickerHasListingSuffix(ticker)) return false;
  const canonical = canonicalExchange(exchange);
  const suffixes = HOST_SUFFIX_ENTRIES
    .filter(([venue]) => venue === canonical)
    .map(([, suffix]) => suffix);
  return suffixes.length > 0 && !suffixes.includes(ticker.slice(ticker.indexOf(".")));
}

/**
 * The venue a vendor's suffix names, whatever else it could be: GARAN.IS is
 * GARAN on BIST, 7203.T 7203 on JPX, and MKC.V reads as MKC on TSXV, though it
 * is McCormick's voting class on NYSE. For a caller that confirms it, by a row
 * saved on that venue or the listing's own quote (`listingSuffixVenue`). Null
 * for a symbol without a venue suffix (BRK.B) and a suffix several venues share.
 */
export function listingSuffixCandidate(ticker: string): { symbol: string; exchange: string } | null {
  if (!tickerHasListingSuffix(ticker)) return null;
  const dot = ticker.indexOf(".");
  const suffix = ticker.slice(dot);
  // The one host venue the suffix names, else the one venue the table names for it (BIST, which the host table lacks).
  const venues = new Set(HOST_SUFFIX_ENTRIES.filter(([, entry]) => entry === suffix).map(([venue]) => venue));
  const venue = listingSuffixExchange(ticker) ?? (venues.size === 1 ? [...venues][0] : undefined);
  return venue ? { symbol: ticker.slice(0, dot), exchange: venue } : null;
}

/**
 * The listing a vendor's suffixed symbol stands for, when that is settled:
 * GARAN.IS is GARAN on BIST, VOD.L on LSE is VOD there. A venue the table
 * knows settles it, either way: its own suffix maps, another's (MKC.V on NYSE,
 * McCormick's voting class) does not. With no venue, or one the table does not
 * know (IST, JNB), the suffix's own venue is read for a suffix of two letters
 * or more; a one-letter suffix is also a US class letter (MKC.V, BRK.B), so it
 * maps only when a venue agrees. Null when it does not map.
 */
export function listingSuffixVenue(ticker: string, exchange?: string): { symbol: string; exchange: string } | null {
  const candidate = listingSuffixCandidate(ticker);
  if (!candidate) return null;
  const suffix = ticker.slice(ticker.indexOf("."));
  const given = canonicalExchange(exchange);
  // SMART routes for a broker; it names no venue.
  const suffixes = given && given !== "SMART" ? HOST_SUFFIX_ENTRIES.filter(([venue]) => venue === given).map(([, entry]) => entry) : [];
  if (suffixes.length > 0) return suffixes.includes(suffix) ? { symbol: candidate.symbol, exchange: given } : null;
  return suffix.length > 2 ? candidate : null;
}

/** Infer a venue only when the suffix names one recognized host exchange. */
export function listingSuffixExchange(ticker: string): string | undefined {
  if (!tickerHasListingSuffix(ticker)) return undefined;
  const suffix = ticker.slice(ticker.indexOf("."));
  const venues = new Set(HOST_SUFFIX_ENTRIES
    .filter(([, candidate]) => candidate === suffix)
    .map(([venue]) => venue)
    .filter((venue) => KNOWN_HOST_VENUES.has(venue)));
  return venues.size === 1 ? [...venues][0] : undefined;
}

/**
 * A Hong Kong listing's four-digit code. Brokers such as Interactive Brokers
 * report Tencent as 700 and HSBC as 5; the exchange and market data know
 * them as 0700 and 0005.
 */
export function hongKongListingCode(ticker: string, exchange: string): string {
  return isHongKongExchange(exchange) && /^\d+$/.test(ticker) ? ticker.padStart(4, "0") : ticker;
}

function normalizeListingTicker(ticker: string, exchange: string): string {
  return hongKongListingCode(ticker, exchange).replace(/ /g, "-");
}

function isHongKongExchange(exchange: string): boolean {
  const canonical = canonicalExchange(exchange) || exchange;
  return canonical === "HKEX" || canonical === "SEHK" || canonical === "HKG";
}
