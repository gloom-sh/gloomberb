import { fredSeriesUrl, seriesNotOnFred } from "../../../sources/gloomberb-cloud/fred-series";
import type { SeriesDefinition, SeriesFrequency } from "../../../series/types";

type FredRow = readonly [seriesId: string, name: string, unit: string, frequency: SeriesFrequency, publisher: string, tags?: readonly string[]];

/** What people call a Treasury bill: a t-bill, a tbill, cash parked in a money market. */
const BILL_TAGS = ["bill", "T-bill", "T-bills", "tbill", "tbills", "money markets", "money market"] as const;

/**
 * The FRED series Gloom Cloud serves, by group, except the Treasury constant
 * maturities (UST:2Y and so on, from the yield curve) and the credit spreads
 * and yields (from the credit plugin). Ids follow the server's allowlist: a
 * series added there is listed here to reach the catalog.
 * Türkiye's CPI, Brazil's IPCA, MAS's SORA and NAHB's housing market index
 * are served the same way but are not on FRED; their rows name TurkStat,
 * IBGE, MAS and NAHB (`seriesNotOnFred`).
 */
const GROUPS: ReadonlyArray<{ group: string; rows: readonly FredRow[] }> = [
  {
    group: "Rates",
    rows: [
      ["FEDFUNDS", "Fed funds effective rate (monthly)", "%", "monthly", "Federal Reserve Board", ["fed funds"]],
      ["DFF", "Fed funds effective rate", "%", "daily", "Federal Reserve Board", ["fed funds"]],
      ["EFFR", "Effective federal funds rate", "%", "daily", "Federal Reserve Bank of New York", ["EFFR", "money markets"]],
      ["IORB", "Interest on reserve balances", "%", "daily", "Federal Reserve Board", ["IORB", "money markets"]],
      ["DFEDTARU", "Fed funds target range, upper limit", "%", "daily", "Federal Reserve Board", ["fed funds", "policy rate"]],
      ["DFEDTARL", "Fed funds target range, lower limit", "%", "daily", "Federal Reserve Board", ["fed funds", "policy rate"]],
      ["ECBDFR", "ECB deposit facility rate", "%", "daily", "European Central Bank", ["ECB", "euro area", "policy rate"]],
      ["DPRIME", "Bank prime loan rate", "%", "daily", "Federal Reserve Board"],
      ["DFII5", "5Y TIPS real yield", "%", "daily", "Federal Reserve Board", ["treasury", "real yield"]],
      ["DFII10", "10Y TIPS real yield", "%", "daily", "Federal Reserve Board", ["treasury", "real yield"]],
      ["T10Y2Y", "10Y minus 2Y Treasury spread", "bp", "daily", "Federal Reserve Bank of St. Louis", ["treasury", "curve", "2s10s"]],
      ["T10Y3M", "10Y minus 3M Treasury spread", "bp", "daily", "Federal Reserve Bank of St. Louis", ["treasury", "curve"]],
      // The Federal Reserve Board's Kim-Wright estimates, a week or so behind.
      ...Array.from({ length: 10 }, (_, index): FredRow =>
        [`THREEFYTP${index + 1}`, `${index + 1}Y Treasury term premium (Kim-Wright)`, "%", "daily", "Federal Reserve Board", ["treasury", "term premium", "Kim-Wright"]]),
      ["SOFR", "SOFR", "%", "daily", "Federal Reserve Bank of New York", ["secured overnight financing rate", "money markets"]],
      ["SORA", "SORA (Singapore overnight rate average)", "%", "daily", "MAS", ["SGD", "Singapore", "MAS", "overnight", "money markets"]],
      ["OBFR", "Overnight bank funding rate", "%", "daily", "Federal Reserve Bank of New York", ["OBFR", "money markets"]],
      ["DTB4WK", "4-week Treasury bill rate", "%", "daily", "Federal Reserve Board", BILL_TAGS],
      ["DTB3", "3-month Treasury bill rate", "%", "daily", "Federal Reserve Board", BILL_TAGS],
      ["DTB6", "6-month Treasury bill rate", "%", "daily", "Federal Reserve Board", BILL_TAGS],
      ["DTB1YR", "1-year Treasury bill rate", "%", "daily", "Federal Reserve Board", BILL_TAGS],
      ["DCPF3M", "3-month AA financial commercial paper rate", "%", "daily", "Federal Reserve Board", ["commercial paper", "money markets"]],
      ["DCPN3M", "3-month AA nonfinancial commercial paper rate", "%", "daily", "Federal Reserve Board", ["commercial paper", "money markets"]],
      ["RRPONTSYD", "Overnight reverse repo at the Fed", "billion USD", "daily", "Federal Reserve Bank of New York", ["RRP", "liquidity", "money markets"]],
      ["WDTGAL", "Treasury General Account", "million USD", "weekly", "Federal Reserve Board", ["TGA", "liquidity", "money markets"]],
      ["WRESBAL", "Bank reserves at the Fed", "million USD", "weekly", "Federal Reserve Board", ["reserves", "liquidity", "money markets"]],
      ["WALCL", "Fed total assets", "million USD", "weekly", "Federal Reserve Board", ["balance sheet", "liquidity"]],
      ["M2SL", "M2 money stock", "billion USD", "monthly", "Federal Reserve Board", ["money supply", "liquidity"]],
    ],
  },
  {
    group: "Volatility",
    rows: [
      ["VIXCLS", "VIX", "index", "daily", "Cboe", ["volatility index", "30 day"]],
      ["VXVCLS", "VIX 3M", "index", "daily", "Cboe", ["volatility index", "3 month"]],
    ],
  },
  {
    group: "Economy",
    rows: [
      ["GDP", "Gross domestic product", "billion USD", "quarterly", "Bureau of Economic Analysis", ["GDP", "growth"]],
      ["GDPC1", "Real gross domestic product", "billion USD", "quarterly", "Bureau of Economic Analysis", ["GDP", "growth"]],
      ["UNRATE", "Unemployment rate", "%", "monthly", "Bureau of Labor Statistics", ["labor", "jobs"]],
      ["ICSA", "Initial jobless claims", "count", "weekly", "Department of Labor", ["labor", "claims"]],
      ["PAYEMS", "Nonfarm payrolls", "thousand people", "monthly", "Bureau of Labor Statistics", ["labor", "jobs", "employment"]],
      ["NPPTTL", "Private payroll employment (discontinued)", "thousand people", "monthly", "ADP Research Institute", ["labor", "jobs"]],
      ["JTSJOL", "Job openings", "thousand jobs", "monthly", "Bureau of Labor Statistics", ["labor", "JOLTS"]],
      ["OPHNFB", "Nonfarm labor productivity", "index", "quarterly", "Bureau of Labor Statistics", ["labor", "productivity"]],
      ["ULCNFB", "Unit labor costs", "index", "quarterly", "Bureau of Labor Statistics", ["labor", "wages"]],
      ["RSAFS", "Retail sales", "million USD", "monthly", "Census Bureau", ["consumer", "spending"]],
      ["RSFSXMV", "Retail sales excluding autos", "million USD", "monthly", "Census Bureau", ["consumer", "spending"]],
      ["UMCSENT", "University of Michigan consumer sentiment", "index", "monthly", "University of Michigan", ["consumer", "sentiment"]],
      ["CSCICP03USM665S", "Consumer confidence (OECD)", "index", "monthly", "OECD", ["consumer", "sentiment"]],
      ["HOUST", "Housing starts", "thousand units", "monthly", "Census Bureau", ["housing", "homebuilders"]],
      ["PERMIT", "Building permits", "thousand units", "monthly", "Census Bureau", ["housing", "homebuilders"]],
      ["EXHOSLUSM495S", "Existing home sales", "units", "monthly", "National Association of Realtors", ["housing", "homebuilders"]],
      ["HSN1F", "New home sales", "thousand units", "monthly", "Census Bureau", ["housing", "homebuilders"]],
      ["MORTGAGE30US", "30-year fixed mortgage rate (Freddie Mac PMMS)", "%", "weekly", "Freddie Mac", ["housing", "mortgage rate", "PMMS", "Freddie Mac", "homebuilders"]],
      ["MORTGAGE15US", "15-year fixed mortgage rate (Freddie Mac PMMS)", "%", "weekly", "Freddie Mac", ["housing", "mortgage rate", "PMMS", "Freddie Mac", "homebuilders"]],
      // Computed by Gloom Cloud: MORTGAGE30US less DGS10 on each PMMS date.
      ["MORTGAGE30US10Y", "30-year mortgage rate minus 10Y Treasury, on the PMMS date", "bp", "weekly", "Freddie Mac and Federal Reserve Board", ["housing", "mortgage spread", "PMMS", "treasury", "homebuilders"]],
      ["NAHBHMI", "NAHB housing market index (builder sentiment)", "index", "monthly", "NAHB", ["housing", "NAHB", "HMI", "homebuilders", "sentiment"]],
      ["DGORDER", "Durable goods orders", "million USD", "monthly", "Census Bureau", ["manufacturing", "orders"]],
      ["ADXTNO", "Durable goods orders excluding transportation", "million USD", "monthly", "Census Bureau", ["manufacturing", "orders"]],
      ["AMTMNO", "Manufacturing new orders", "million USD", "monthly", "Census Bureau", ["manufacturing", "factory orders"]],
      ["BOPGSTB", "Trade balance", "million USD", "monthly", "Bureau of Economic Analysis and Census Bureau", ["trade"]],
      ["INDPRO", "Industrial production", "index", "monthly", "Federal Reserve Board", ["manufacturing", "output"]],
      ["TCU", "Capacity utilization", "%", "monthly", "Federal Reserve Board", ["manufacturing"]],
      ["PI", "Personal income", "billion USD", "monthly", "Bureau of Economic Analysis", ["consumer", "income"]],
      ["PCE", "Personal consumption expenditures", "billion USD", "monthly", "Bureau of Economic Analysis", ["consumer", "spending"]],
      ["NETFI", "Current account balance", "billion USD", "quarterly", "Bureau of Economic Analysis", ["trade", "external"]],
    ],
  },
  {
    group: "Defense & fiscal",
    rows: [
      ["FDEFX", "National defense spending (annual rate)", "billion USD", "quarterly", "Bureau of Economic Analysis", ["defense", "military", "DoD", "budget", "government spending", "GDP"]],
      ["ADEFNO", "New orders for defense capital goods", "million USD", "monthly", "Census Bureau", ["defense", "military", "DoD", "orders", "manufacturing"]],
      ["MTSO133FMS", "Federal outlays (Monthly Treasury Statement)", "million USD", "monthly", "U.S. Treasury", ["budget", "government spending", "fiscal", "deficit", "Treasury"]],
    ],
  },
  {
    group: "Inflation",
    rows: [
      ["CPIAUCSL", "CPI, all items", "index", "monthly", "Bureau of Labor Statistics", ["CPI", "headline", "seasonally adjusted"]],
      ["CPIAUCNS", "CPI, all items (not seasonally adjusted)", "index", "monthly", "Bureau of Labor Statistics", ["CPI", "headline"]],
      ["CPILFESL", "Core CPI", "index", "monthly", "Bureau of Labor Statistics", ["CPI", "core", "ex food and energy"]],
      ["CPILFENS", "Core CPI (not seasonally adjusted)", "index", "monthly", "Bureau of Labor Statistics", ["CPI", "core"]],
      ["CPIUFDSL", "CPI: Food", "index", "monthly", "Bureau of Labor Statistics", ["CPI", "component"]],
      ["CUSR0000SAF11", "CPI: Food at home", "index", "monthly", "Bureau of Labor Statistics", ["CPI", "component", "groceries"]],
      ["CUSR0000SEFV", "CPI: Food away from home", "index", "monthly", "Bureau of Labor Statistics", ["CPI", "component", "restaurants"]],
      ["CPIENGSL", "CPI: Energy", "index", "monthly", "Bureau of Labor Statistics", ["CPI", "component"]],
      ["CUSR0000SETB01", "CPI: Gasoline", "index", "monthly", "Bureau of Labor Statistics", ["CPI", "component", "energy"]],
      ["CUSR0000SEHF01", "CPI: Electricity", "index", "monthly", "Bureau of Labor Statistics", ["CPI", "component", "energy"]],
      ["CUSR0000SEHF02", "CPI: Utility gas service", "index", "monthly", "Bureau of Labor Statistics", ["CPI", "component", "energy"]],
      ["CUSR0000SACL1E", "CPI: Core goods", "index", "monthly", "Bureau of Labor Statistics", ["CPI", "component", "goods"]],
      ["CUSR0000SETA01", "CPI: New vehicles", "index", "monthly", "Bureau of Labor Statistics", ["CPI", "component", "goods", "cars"]],
      ["CUSR0000SETA02", "CPI: Used cars and trucks", "index", "monthly", "Bureau of Labor Statistics", ["CPI", "component", "goods", "cars"]],
      ["CPIAPPSL", "CPI: Apparel", "index", "monthly", "Bureau of Labor Statistics", ["CPI", "component", "goods"]],
      ["CUSR0000SAM1", "CPI: Medical care goods", "index", "monthly", "Bureau of Labor Statistics", ["CPI", "component", "goods", "health"]],
      ["CUSR0000SASLE", "CPI: Core services", "index", "monthly", "Bureau of Labor Statistics", ["CPI", "component", "services"]],
      ["CUSR0000SAH1", "CPI: Shelter", "index", "monthly", "Bureau of Labor Statistics", ["CPI", "component", "services", "housing"]],
      ["CUSR0000SEHA", "CPI: Rent", "index", "monthly", "Bureau of Labor Statistics", ["CPI", "component", "services", "housing"]],
      ["CUSR0000SEHC", "CPI: Owners' equivalent rent", "index", "monthly", "Bureau of Labor Statistics", ["CPI", "component", "services", "housing", "OER"]],
      ["CUSR0000SEHB", "CPI: Lodging away from home", "index", "monthly", "Bureau of Labor Statistics", ["CPI", "component", "services", "hotels"]],
      ["CUSR0000SAM2", "CPI: Medical care services", "index", "monthly", "Bureau of Labor Statistics", ["CPI", "component", "services", "health"]],
      ["CUSR0000SAS4", "CPI: Transportation services", "index", "monthly", "Bureau of Labor Statistics", ["CPI", "component", "services"]],
      ["CUSR0000SETG01", "CPI: Airline fares", "index", "monthly", "Bureau of Labor Statistics", ["CPI", "component", "services", "travel"]],
      ["PCEPI", "PCE price index", "index", "monthly", "Bureau of Economic Analysis", ["PCE", "headline"]],
      ["PCEPILFE", "Core PCE price index", "index", "monthly", "Bureau of Economic Analysis", ["PCE", "core"]],
      ["PPIACO", "Producer prices, all commodities", "index", "monthly", "Bureau of Labor Statistics", ["PPI"]],
      ["PPIFIS", "Producer prices, final demand", "index", "monthly", "Bureau of Labor Statistics", ["PPI"]],
      ["PPIFID", "Producer prices, final demand (not seasonally adjusted)", "index", "monthly", "Bureau of Labor Statistics", ["PPI"]],
      ["IR", "Import prices", "index", "monthly", "Bureau of Labor Statistics", ["trade"]],
      ["IQ", "Export prices", "index", "monthly", "Bureau of Labor Statistics", ["trade"]],
      ["T5YIE", "5Y breakeven inflation", "%", "daily", "Federal Reserve Bank of St. Louis", ["breakeven", "expectations", "TIPS"]],
      ["T10YIE", "10Y breakeven inflation", "%", "daily", "Federal Reserve Bank of St. Louis", ["breakeven", "expectations", "TIPS"]],
      ["T5YIFR", "5Y, 5Y forward inflation expectation", "%", "daily", "Federal Reserve Bank of St. Louis", ["breakeven", "expectations", "5y5y"]],
      ["TURCPIYOY", "Türkiye CPI, y/y", "%", "monthly", "TurkStat", ["CPI", "headline", "Turkey", "TR", "inflation", "lira"]],
      ["TURCPIMOM", "Türkiye CPI, m/m", "%", "monthly", "TurkStat", ["CPI", "headline", "Turkey", "TR", "inflation", "lira"]],
      ["BRAIPCAMOM", "Brazil IPCA, m/m", "%", "monthly", "IBGE", ["IPCA", "CPI", "headline", "Brazil", "BR", "Brazil inflation", "inflation", "real"]],
      ["BRAIPCA15MOM", "Brazil IPCA-15 mid-month, m/m", "%", "monthly", "IBGE",
        ["IPCA-15", "IPCA", "CPI", "mid-month", "Brazil", "BR", "Brazil inflation", "inflation", "real"]],
    ],
  },
  {
    group: "FX",
    rows: [
      ["DEXUSEU", "Euro (USD per EUR)", "USD", "daily", "Federal Reserve Board", ["EURUSD", "EUR", "euro"]],
      ["DEXUSUK", "British pound (USD per GBP)", "USD", "daily", "Federal Reserve Board", ["GBPUSD", "GBP", "sterling", "pound"]],
      ["DEXUSAL", "Australian dollar (USD per AUD)", "USD", "daily", "Federal Reserve Board", ["AUDUSD", "AUD"]],
      ["DEXUSNZ", "New Zealand dollar (USD per NZD)", "USD", "daily", "Federal Reserve Board", ["NZDUSD", "NZD"]],
      ["DEXJPUS", "Japanese yen (JPY per USD)", "JPY", "daily", "Federal Reserve Board", ["USDJPY", "JPY", "yen"]],
      ["DEXCHUS", "Chinese yuan (CNY per USD)", "CNY", "daily", "Federal Reserve Board", ["USDCNY", "CNY", "renminbi", "yuan"]],
      ["DEXINUS", "Indian rupee (INR per USD)", "INR", "daily", "Federal Reserve Board", ["USDINR", "INR"]],
      ["DEXBZUS", "Brazilian real (BRL per USD)", "BRL", "daily", "Federal Reserve Board", ["USDBRL", "BRL"]],
      ["DEXMXUS", "Mexican peso (MXN per USD)", "MXN", "daily", "Federal Reserve Board", ["USDMXN", "MXN"]],
      ["DEXKOUS", "South Korean won (KRW per USD)", "KRW", "daily", "Federal Reserve Board", ["USDKRW", "KRW"]],
      ["DEXCAUS", "Canadian dollar (CAD per USD)", "CAD", "daily", "Federal Reserve Board", ["USDCAD", "CAD"]],
      ["DEXSZUS", "Swiss franc (CHF per USD)", "CHF", "daily", "Federal Reserve Board", ["USDCHF", "CHF", "franc", "swiss franc"]],
      ["DEXTAUS", "Taiwan dollar (TWD per USD)", "TWD", "daily", "Federal Reserve Board", ["USDTWD", "TWD"]],
      ["DEXHKUS", "Hong Kong dollar (HKD per USD)", "HKD", "daily", "Federal Reserve Board", ["USDHKD", "HKD"]],
      ["DEXSIUS", "Singapore dollar (SGD per USD)", "SGD", "daily", "Federal Reserve Board", ["USDSGD", "SGD"]],
      ["DEXTHUS", "Thai baht (THB per USD)", "THB", "daily", "Federal Reserve Board", ["USDTHB", "THB"]],
      ["DEXMAUS", "Malaysian ringgit (MYR per USD)", "MYR", "daily", "Federal Reserve Board", ["USDMYR", "MYR"]],
      ["DEXNOUS", "Norwegian krone (NOK per USD)", "NOK", "daily", "Federal Reserve Board", ["USDNOK", "NOK"]],
      ["DEXSDUS", "Swedish krona (SEK per USD)", "SEK", "daily", "Federal Reserve Board", ["USDSEK", "SEK"]],
      ["DEXDNUS", "Danish krone (DKK per USD)", "DKK", "daily", "Federal Reserve Board", ["USDDKK", "DKK"]],
      ["DEXSLUS", "Sri Lankan rupee (LKR per USD)", "LKR", "daily", "Federal Reserve Board", ["USDLKR", "LKR"]],
      ["DEXSFUS", "South African rand (ZAR per USD)", "ZAR", "daily", "Federal Reserve Board", ["USDZAR", "ZAR"]],
      ["DEXVZUS", "Venezuelan bolivar (VES per USD)", "VES", "daily", "Federal Reserve Board", ["USDVES", "VES"]],
      ["DTWEXBGS", "Broad dollar index", "index", "daily", "Federal Reserve Board", ["dollar", "trade weighted"]],
      ["DTWEXAFEGS", "Dollar index against advanced economies", "index", "daily", "Federal Reserve Board", ["dollar", "trade weighted"]],
      ["DTWEXEMEGS", "Dollar index against emerging markets", "index", "daily", "Federal Reserve Board", ["dollar", "trade weighted"]],
      ["RTWEXBGS", "Real broad dollar index", "index", "monthly", "Federal Reserve Board", ["dollar", "trade weighted", "real"]],
      ["RTWEXAFEGS", "Real dollar index against advanced economies", "index", "monthly", "Federal Reserve Board", ["dollar", "trade weighted", "real"]],
      ["RTWEXEMEGS", "Real dollar index against emerging markets", "index", "monthly", "Federal Reserve Board", ["dollar", "trade weighted", "real"]],
    ],
  },
  {
    group: "Energy",
    rows: [
      ["DCOILWTICO", "WTI crude oil spot", "USD/barrel", "daily", "U.S. Energy Information Administration", ["oil", "crude"]],
      ["WCOILWTICO", "WTI crude oil spot (weekly)", "USD/barrel", "weekly", "U.S. Energy Information Administration", ["oil", "crude"]],
      ["DCOILBRENTEU", "Brent crude oil spot", "USD/barrel", "daily", "U.S. Energy Information Administration", ["oil", "crude"]],
      ["DHHNGSP", "Henry Hub natural gas spot", "USD/MMBtu", "daily", "U.S. Energy Information Administration", ["natural gas"]],
      ["DJFUELUSGULF", "US Gulf Coast jet fuel spot", "USD/gallon", "daily", "U.S. Energy Information Administration",
        ["jet fuel", "kerosene", "aviation fuel", "jet kerosene"]],
      ["NATURALGAS", "Natural gas consumption", "billion cubic feet", "monthly", "U.S. Energy Information Administration", ["natural gas"]],
    ],
  },
  {
    // The IMF's monthly world prices: the closest public series to LME copper and aluminium, which FUT does not list,
    // and to iron ore, whose futures are licensed.
    group: "Commodities",
    rows: [
      ["PCOPPUSDM", "Global price of copper", "USD/ton", "monthly", "International Monetary Fund", ["copper", "metals", "LME"]],
      ["PALUMUSDM", "Global price of aluminum", "USD/ton", "monthly", "International Monetary Fund", ["aluminum", "aluminium", "metals", "LME"]],
      ["PIORECRUSDM", "Global price of iron ore (dry metric ton)", "USD/ton", "monthly", "International Monetary Fund", ["iron ore", "iron", "steel", "metals"]],
    ],
  },
  {
    group: "Valuation",
    rows: [
      ["NCBEILQ027S", "Nonfinancial corporate equities (Z.1)", "million USD", "quarterly", "Federal Reserve Board", ["market cap", "Buffett"]],
      ["FBCELLQ027S", "Financial sector corporate equities (Z.1)", "million USD", "quarterly", "Federal Reserve Board", ["market cap"]],
      ["BOGZ1FL153064486Q", "Household corporate equity holdings (Z.1)", "million USD", "quarterly", "Federal Reserve Board", ["households", "equity allocation"]],
      ["BOGZ1FL663067003Q", "Broker-dealer customer receivables (Z.1)", "million USD", "quarterly", "Federal Reserve Board", ["margin debt"]],
      ["CPROFIT", "Corporate profits after tax", "billion USD", "quarterly", "Bureau of Economic Analysis", ["earnings", "profits"]],
      ["TNWMVBSNNCB", "Nonfinancial corporate net worth (Z.1)", "million USD", "quarterly", "Federal Reserve Board", ["Tobin's Q"]],
    ],
  },
];

/** The FRED series the rates and macro panes chart, each listed once. */
export const FRED_CATALOG_SERIES: readonly SeriesDefinition[] = GROUPS.flatMap(({ group, rows }) => (
  rows.map(([seriesId, name, unit, frequency, publisher, tags]): SeriesDefinition => ({
    id: `fred:${seriesId}`,
    name,
    unit,
    frequency,
    group,
    ...(tags?.length ? { tags } : {}),
    publisher,
    // The licence a publisher's data comes under, which the catalog lists beside the series (SORA's).
    ...(seriesNotOnFred(seriesId)?.attribution ? { limitation: seriesNotOnFred(seriesId)!.attribution } : {}),
    url: fredSeriesUrl(seriesId),
    expression: `FRED:${seriesId}`,
  }))
));

/** Spellings of a Treasury bill a person types, as the series names say it. */
const BILL_WORDS: ReadonlyArray<[RegExp, string]> = [
  [/\bt-?bills?\b|\bt bills?\b|\btreasury bills?\b/g, "treasury bill"],
  [/\b(\d+|three|six|one|four)[\s-]*(month|mo|m)\b/g, "$1-month"],
  [/\bthree-month\b/g, "3-month"],
  [/\bsix-month\b/g, "6-month"],
  [/\b(\d+|four)[\s-]*(week|wk|w)\b/g, "$1-week"],
  [/\bfour-week\b/g, "4-week"],
  [/\b(1|one)[\s-]*(year|yr|y)\b/g, "1-year"],
];

/**
 * The served FRED series a name asks for, when one alone fits every word: `3 month t-bill` is DTB3. Null for an id
 * (DTB3), for words several series fit and for none.
 */
export function fredSeriesIdForName(text: string): string | null {
  const normalized = BILL_WORDS.reduce((value, [pattern, replacement]) => value.replace(pattern, replacement), text.trim().toLowerCase());
  const words = normalized.split(/\s+/).filter((word) => word && word !== "rate" && word !== "yield");
  if (words.length < 2) return null;
  const fits = FRED_CATALOG_SERIES.filter((series) => {
    const name = `${series.name} ${(series.tags ?? []).join(" ")}`.toLowerCase();
    return words.every((word) => name.includes(word));
  });
  return fits.length === 1 ? fits[0]!.id.replace(/^fred:/, "") : null;
}
