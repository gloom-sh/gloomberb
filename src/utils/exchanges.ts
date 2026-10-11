export const CANONICAL_EXCHANGE_ALIASES: Record<string, string> = {
  NAS: "NASDAQ",
  NASDAQ: "NASDAQ",
  XNAS: "NASDAQ",
  NMS: "NASDAQ",
  NGM: "NASDAQ",
  NASDAQGM: "NASDAQ",
  NASDAQGS: "NASDAQ",
  NCM: "NASDAQ",
  NYQ: "NYSE",
  NYS: "NYSE",
  NYSE: "NYSE",
  XNYS: "NYSE",
  ASE: "AMEX",
  AMEX: "AMEX",
  XASE: "AMEX",
  PCX: "ARCA",
  NYSEARCA: "ARCA",
  "NYSE ARCA": "ARCA",
  ARCA: "ARCA",
  ARCX: "ARCA",
  BATS: "BATS",
  // Cboe's US equities listing venue (BZX); quotes label it "CBOE US" or BTS.
  "CBOE US": "BATS",
  BTS: "BATS",
  TYO: "JPX",
  // Toronto, as brokers and quote sites spell it; typed after a symbol it can
  // also be Tokyo (SHARED_EXCHANGE_CODES).
  TSE: "TSX",
  TSEJ: "JPX",
  JPX: "JPX",
  XTKS: "JPX",
  HKG: "HKEX",
  HKEX: "HKEX",
  SEHK: "HKEX",
  XHKG: "HKEX",
  LON: "LSE",
  LSE: "LSE",
  LSEETF: "LSE",
  XLON: "LSE",
  TOR: "TSX",
  TSX: "TSX",
  XTSE: "TSX",
  TSXV: "TSXV",
  XTSX: "TSXV",
  VAN: "TSXV",
  CVE: "TSXV",
  CN: "CSE",
  CNSX: "CSE",
  XCNQ: "CSE",
  CSE: "CSE",
  ASX: "ASX",
  XASX: "ASX",
  NZX: "NZX",
  XNZE: "NZX",
  NZE: "NZX",
  SIX: "SWX",
  SWX: "SWX",
  EBS: "SWX",
  XSWX: "SWX",
  ETR: "XETRA",
  XETR: "XETRA",
  XETRA: "XETRA",
  IBIS: "XETRA",
  IBIS2: "XETRA",
  GER: "XETRA",
  FSE: "FWB2",
  FSX: "FWB2",
  FRA: "FWB2",
  XFRA: "FWB2",
  FWB: "FWB2",
  FWB2: "FWB2",
  EPA: "EPA",
  XPAR: "EPA",
  PAR: "EPA",
  SBF: "EPA",
  AMS: "AMS",
  XAMS: "AMS",
  AEB: "AMS",
  EURONEXT: "AMS",
  BRU: "BRU",
  XBRU: "BRU",
  LIS: "LIS",
  XLIS: "LIS",
  BIT: "BIT",
  XMIL: "BIT",
  MIL: "BIT",
  OMX: "SFB",
  STO: "SFB",
  XSTO: "SFB",
  HEL: "HEL",
  XHEL: "HEL",
  CPH: "CPH",
  XCSE: "CPH",
  OSL: "OSL",
  XOSL: "OSL",
  ICE: "ICEX",
  ICEX: "ICEX",
  XICE: "ICEX",
  WSE: "WSE",
  GPW: "WSE",
  XWAR: "WSE",
  PRA: "PSE",
  XPRA: "PSE",
  VIE: "VIE",
  XWBO: "VIE",
  TPE: "TWSE",
  TWSE: "TWSE",
  TAI: "TWSE",
  TWO: "TPEX",
  TPEX: "TPEX",
  ROCO: "TPEX",
  NSE: "NSE",
  NSI: "NSE",
  XNSE: "NSE",
  BSE: "BSE",
  BOM: "BSE",
  XBOM: "BSE",
  SSE: "SSE",
  XSHG: "SSE",
  SHH: "SSE",
  SHA: "SSE",
  SZSE: "SZSE",
  XSHE: "SZSE",
  SHE: "SZSE",
  SHZ: "SZSE",
  // KOSPI; typed after a symbol it can also be KOSDAQ, which the Korea Exchange runs too.
  KRX: "KRX",
  XKRX: "KRX",
  KOSPI: "KRX",
  KSC: "KRX",
  KOSDAQ: "KOSDAQ",
  XKOS: "KOSDAQ",
  KOE: "KOSDAQ",
  SGX: "SGX",
  XSES: "SGX",
  BMV: "BMV",
  XMEX: "BMV",
  B3: "B3",
  BVMF: "B3",
  B3SA: "B3",
  SAO: "B3",
  BUE: "BYMA",
  BCBA: "BYMA",
  JSE: "JSE",
  XJSE: "JSE",
  TLV: "TASE",
  XTAE: "TASE",
  TADAWUL: "TADAWUL",
  XSAU: "TADAWUL",
  QE: "QE",
  QSE: "QE",
  DSMD: "QE",
  // Bahrain Bourse, which Gloom Cloud names BHB.
  BHB: "BHB",
  XBAH: "BHB",
  BAHRAIN: "BHB",
  "BAHRAIN BOURSE": "BHB",
  DFM: "DFM",
  XDFM: "DFM",
  // The Muscat Stock Exchange, which Gloom Cloud names MSX.
  MSX: "MSX",
  XMUS: "MSX",
  MSM: "MSX",
  MUSCAT: "MSX",
  OMAN: "MSX",
  // Boursa Kuwait, which Gloom Cloud names KUWAIT.
  KUWAIT: "KUWAIT",
  XKUW: "KUWAIT",
  BOURSA: "KUWAIT",
  "BOURSA KUWAIT": "KUWAIT",
  // The Egyptian Exchange, which Gloom Cloud names EGX.
  EGX: "EGX",
  CAI: "EGX",
  XCAI: "EGX",
  EGYPT: "EGX",
  CAIRO: "EGX",
  CCC: "CCC",
  // Futures venues, by the code search gives each (GC=F on CMX). Quotes spell
  // the venue out (COMEX, NY MERCANTILE); both spellings are one venue, or the
  // quote for GC=F:CMX reads as another venue's and is dropped.
  CME: "CME",
  CBT: "CBT",
  CBOT: "CBT",
  NYM: "NYM",
  NYMEX: "NYM",
  "NY MERCANTILE": "NYM",
  CMX: "CMX",
  COMEX: "CMX",
  NYB: "NYB",
  NYBOT: "NYB",
  "ICE FUTURES": "NYB",
  CFE: "CFE",
  "CBOE FUTURES": "CFE",
  // The currency venue: EURUSD:CCY and EURUSD:FX are the pair EURUSD=X. Pairs
  // saved from an older search answer are on PHYSICAL CURRENCY.
  CCY: "CCY",
  FX: "CCY",
  "PHYSICAL CURRENCY": "CCY",
};

const PUBLIC_EXCHANGE_ALIASES: Record<string, string> = {
  NASDAQ: "XNAS",
  NYSE: "XNYS",
  AMEX: "XASE",
  ARCA: "ARCX",
  HKEX: "XHKG",
  LSE: "XLON",
  TSX: "XTSE",
  TSXV: "XTSX",
  CSE: "XCNQ",
  ASX: "XASX",
  NZX: "XNZE",
  SWX: "XSWX",
  XETRA: "XETR",
  FWB2: "XFRA",
  EPA: "XPAR",
  AMS: "XAMS",
  BRU: "XBRU",
  LIS: "XLIS",
  BIT: "XMIL",
  SFB: "XSTO",
  HEL: "XHEL",
  CPH: "XCSE",
  OSL: "XOSL",
  ICEX: "XICE",
  WSE: "XWAR",
  PSE: "XPRA",
  VIE: "XWBO",
  NSE: "XNSE",
  BSE: "XBOM",
  SSE: "XSHG",
  SZSE: "XSHE",
  KRX: "XKRX",
  KOSDAQ: "XKOS",
  SGX: "XSES",
  BMV: "XMEX",
  B3: "BVMF",
  JSE: "XJSE",
  TASE: "XTAE",
};

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
};

/**
 * Venue names by canonical code, for output that names the listing a command
 * resolved ("Euronext Paris (EPA)"). Codes whose name is the code itself
 * (NASDAQ, BSE) are left out.
 */
const EXCHANGE_NAMES: Record<string, string> = {
  NYSE: "New York Stock Exchange",
  AMEX: "NYSE American",
  ARCA: "NYSE Arca",
  BATS: "Cboe BZX",
  OTC: "OTC Markets",
  JPX: "Tokyo Stock Exchange",
  HKEX: "Hong Kong Stock Exchange",
  LSE: "London Stock Exchange",
  TSX: "Toronto Stock Exchange",
  TSXV: "TSX Venture Exchange",
  CSE: "Canadian Securities Exchange",
  NEO: "Cboe Canada",
  ASX: "Australian Securities Exchange",
  CXA: "Cboe Australia",
  NZX: "New Zealand Exchange",
  SWX: "SIX Swiss Exchange",
  XETRA: "Xetra",
  FWB2: "Frankfurt Stock Exchange",
  EPA: "Euronext Paris",
  AMS: "Euronext Amsterdam",
  BRU: "Euronext Brussels",
  LIS: "Euronext Lisbon",
  BIT: "Borsa Italiana",
  MCE: "Bolsa de Madrid",
  SFB: "Nasdaq Stockholm",
  HEL: "Nasdaq Helsinki",
  CPH: "Nasdaq Copenhagen",
  OSL: "Euronext Oslo",
  ICEX: "Nasdaq Iceland",
  WSE: "Warsaw Stock Exchange",
  PSE: "Prague Stock Exchange",
  VIE: "Vienna Stock Exchange",
  TWSE: "Taiwan Stock Exchange",
  TPEX: "Taipei Exchange",
  NSE: "National Stock Exchange of India",
  BSE: "BSE India",
  SSE: "Shanghai Stock Exchange",
  SZSE: "Shenzhen Stock Exchange",
  KRX: "Korea Exchange",
  SGX: "Singapore Exchange",
  BMV: "Mexican Stock Exchange",
  BYMA: "Bolsas y Mercados Argentinos",
  JSE: "Johannesburg Stock Exchange",
  TASE: "Tel Aviv Stock Exchange",
  TADAWUL: "Saudi Exchange",
  QE: "Qatar Stock Exchange",
  BHB: "Bahrain Bourse",
  DFM: "Dubai Financial Market",
  MSX: "Muscat Stock Exchange",
  KUWAIT: "Boursa Kuwait",
  EGX: "Egyptian Exchange",
  CBT: "CBOT",
  NYM: "NYMEX",
  CMX: "COMEX",
  NYB: "ICE Futures U.S.",
  CFE: "Cboe Futures Exchange",
};

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
const SHARED_EXCHANGE_CODES: Record<string, readonly string[]> = {
  TSE: ["TSX", "JPX"],
  KRX: ["KRX", "KOSDAQ"],
  EURONEXT: ["AMS", "EPA", "BRU", "LIS", "OSL", "BIT"],
};

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

export function parsePublicTickerKey(value: string): { symbol: string; exchange?: string } {
  const normalized = normalizeSymbol(value);
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
