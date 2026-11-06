import type { HeaderMarketChoice } from "../../types/config";
import { isRecord } from "../../utils/guards";

/** A market the header strip offers by name. */
export interface HeaderBenchmark {
  id: string;
  /** What the strip calls it: `S&P 500`, never its ETF. */
  name: string;
  symbol: string;
  /** The venue whose hours and holidays the strip's market state follows. */
  venue: string;
  /**
   * A listing that tracks it, shown under its own symbol when the benchmark
   * itself has no usable quote for this account or source.
   */
  fallback?: string;
  /** Other names the picker finds it by. */
  keywords: string;
}

export const HEADER_BENCHMARKS: readonly HeaderBenchmark[] = [
  { id: "sp500", name: "S&P 500", symbol: "^GSPC", venue: "NYSE", fallback: "SPY", keywords: "SPX US" },
  { id: "nasdaq100", name: "Nasdaq 100", symbol: "^NDX", venue: "NASDAQ", fallback: "QQQ", keywords: "NDX US" },
  { id: "dow", name: "Dow", symbol: "^DJI", venue: "NYSE", fallback: "DIA", keywords: "Dow Jones DJIA US" },
  { id: "hang-seng", name: "Hang Seng", symbol: "^HSI", venue: "HKEX", fallback: "2800.HK", keywords: "HSI Hong Kong" },
  { id: "csi300", name: "CSI 300", symbol: "000300.SS", venue: "SSE", fallback: "510300.SS", keywords: "China Shanghai Shenzhen" },
  { id: "nikkei225", name: "Nikkei 225", symbol: "^N225", venue: "JPX", fallback: "1321.T", keywords: "NKY Japan Tokyo" },
  { id: "sti", name: "STI", symbol: "^STI", venue: "SGX", fallback: "ES3.SI", keywords: "Straits Times Singapore" },
  { id: "ftse100", name: "FTSE 100", symbol: "^FTSE", venue: "LSE", fallback: "ISF.L", keywords: "UKX UK London" },
  { id: "dax", name: "DAX", symbol: "^GDAXI", venue: "XETRA", fallback: "EXS1.DE", keywords: "Germany Frankfurt Europe" },
  { id: "btc", name: "BTC", symbol: "BTC-USD", venue: "CCC", keywords: "Bitcoin crypto" },
];

const DEFAULT_BENCHMARK_ID = "sp500";
const BENCHMARKS_BY_ID = new Map(HEADER_BENCHMARKS.map((benchmark) => [benchmark.id, benchmark]));

/** Zones of continental Europe, whose default is the DAX. */
const DAX_ZONES = [
  "Amsterdam", "Andorra", "Athens", "Belgrade", "Berlin", "Bratislava", "Brussels", "Bucharest", "Budapest", "Busingen",
  "Chisinau", "Copenhagen", "Gibraltar", "Helsinki", "Kiev", "Kyiv", "Lisbon", "Ljubljana", "Luxembourg", "Madrid", "Malta",
  "Mariehamn", "Monaco", "Oslo", "Paris", "Podgorica", "Prague", "Riga", "Rome", "San_Marino", "Sarajevo", "Skopje", "Sofia",
  "Stockholm", "Tallinn", "Tirane", "Vaduz", "Vatican", "Vienna", "Vilnius", "Warsaw", "Zagreb", "Zurich",
].map((city) => `Europe/${city}`);

/** The benchmark a machine's time zone starts the header on; every other zone gets the S&P 500. */
const ZONE_BENCHMARKS: Readonly<Record<string, string>> = {
  "Asia/Hong_Kong": "hang-seng",
  Hongkong: "hang-seng",
  "Asia/Macau": "hang-seng",
  "Asia/Singapore": "sti",
  Singapore: "sti",
  "Asia/Shanghai": "csi300",
  "Asia/Chongqing": "csi300",
  "Asia/Harbin": "csi300",
  "Asia/Urumqi": "csi300",
  PRC: "csi300",
  "Asia/Tokyo": "nikkei225",
  Japan: "nikkei225",
  "Europe/London": "ftse100",
  "Europe/Belfast": "ftse100",
  "Europe/Guernsey": "ftse100",
  "Europe/Isle_of_Man": "ftse100",
  "Europe/Jersey": "ftse100",
  GB: "ftse100",
  ...Object.fromEntries(DAX_ZONES.map((zone) => [zone, "dax"])),
};

/** The benchmark the header shows before the user picks one, from the machine's time zone. */
export function defaultHeaderBenchmark(timeZone: string | null | undefined): HeaderBenchmark {
  const id = (timeZone && ZONE_BENCHMARKS[timeZone]) || DEFAULT_BENCHMARK_ID;
  return BENCHMARKS_BY_ID.get(id)!;
}

/** The zone this machine (or browser) reads local times in, as the header's default market follows it. */
export function systemTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch { /* Intentional ignore: a runtime without a zone database starts on the default benchmark. */ return undefined; }
}

/** What the header shows, resolved from the saved choice. */
export interface HeaderMarketTarget {
  /** Identifies the target for effects keyed on it. */
  key: string;
  /** What the strip calls the quote: a benchmark's name, or a listing's symbol. */
  label: string;
  symbol: string;
  exchange: string;
  /** The venue whose hours the market state follows; null for a listing, whose quote names its own. */
  venue: string | null;
  /** The listing shown when the benchmark itself has no usable quote. */
  fallback: { label: string; symbol: string; exchange: string } | null;
  /** The benchmark, when the target is one. */
  benchmarkId: string | null;
}

function benchmarkTarget(benchmark: HeaderBenchmark): HeaderMarketTarget {
  return {
    key: `benchmark:${benchmark.id}`,
    label: benchmark.name,
    symbol: benchmark.symbol,
    exchange: "",
    venue: benchmark.venue,
    fallback: benchmark.fallback ? { label: benchmark.fallback, symbol: benchmark.fallback, exchange: "" } : null,
    benchmarkId: benchmark.id,
  };
}

/**
 * The benchmark a listing is, when it is one the header offers: `^HSI`
 * searched for is the Hang Seng, on whichever venue its search row named.
 */
export function headerBenchmarkForListing(symbol: string): HeaderBenchmark | null {
  const normalized = symbol.trim().toUpperCase();
  return HEADER_BENCHMARKS.find((benchmark) => benchmark.symbol === normalized) ?? null;
}

/** The header's market: the user's choice, or the benchmark of `timeZone` while they have made none. */
export function resolveHeaderMarket(choice: HeaderMarketChoice | undefined, timeZone: string | null | undefined): HeaderMarketTarget {
  if (choice && "benchmark" in choice) {
    const benchmark = BENCHMARKS_BY_ID.get(choice.benchmark);
    if (benchmark) return benchmarkTarget(benchmark);
  } else if (choice?.symbol) {
    const benchmark = headerBenchmarkForListing(choice.symbol);
    if (benchmark) return benchmarkTarget(benchmark);
    const exchange = choice.exchange ?? "";
    return {
      key: `listing:${choice.symbol}:${exchange}`,
      label: choice.symbol,
      symbol: choice.symbol,
      exchange,
      venue: null,
      fallback: null,
      benchmarkId: null,
    };
  }
  return benchmarkTarget(defaultHeaderBenchmark(timeZone));
}

/**
 * A saved choice as this build reads it: a benchmark it offers, or a listing
 * with a symbol. Anything else is no choice, and the header starts on the
 * time zone's benchmark again.
 */
export function sanitizeHeaderMarketChoice(value: unknown): HeaderMarketChoice | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.benchmark === "string") {
    return BENCHMARKS_BY_ID.has(value.benchmark) ? { benchmark: value.benchmark } : undefined;
  }
  const symbol = typeof value.symbol === "string" ? value.symbol.trim() : "";
  if (!symbol) return undefined;
  const exchange = typeof value.exchange === "string" ? value.exchange.trim() : "";
  return exchange ? { symbol, exchange } : { symbol };
}
