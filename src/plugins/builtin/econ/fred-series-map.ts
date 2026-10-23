import { applyTransform, type StatTransform } from "../shared/stat-transform";
import type { DatedObservation } from "../shared/series-cache";


export interface FredMapping {
  seriesId: string;
  /** Transform the reference-period observations; these are revised history, not release vintages. */
  displayMode: StatTransform;
  relatedTickers: string[];
}

// Normalized event title → FRED mapping
const SERIES_MAP: Record<string, FredMapping> = {
  "cpi m/m": { seriesId: "CPIAUCSL", displayMode: "mom", relatedTickers: ["TIP", "DX-Y.NYB", "^TNX"] },
  "core cpi m/m": { seriesId: "CPILFESL", displayMode: "mom", relatedTickers: ["TIP", "DX-Y.NYB", "^TNX"] },
  "cpi y/y": { seriesId: "CPIAUCNS", displayMode: "yoy", relatedTickers: ["TIP", "DX-Y.NYB"] },
  "core cpi y/y": { seriesId: "CPILFENS", displayMode: "yoy", relatedTickers: ["TIP", "DX-Y.NYB"] },
  "ppi m/m": { seriesId: "PPIFIS", displayMode: "mom", relatedTickers: ["DX-Y.NYB"] },
  "core pce price index m/m": { seriesId: "PCEPILFE", displayMode: "mom", relatedTickers: ["TIP", "DX-Y.NYB", "^TNX"] },
  "pce price index m/m": { seriesId: "PCEPI", displayMode: "mom", relatedTickers: ["TIP", "DX-Y.NYB"] },
  "final gdp q/q": { seriesId: "GDPC1", displayMode: "qoq-annualized", relatedTickers: ["SPY", "DX-Y.NYB"] },
  "advance gdp q/q": { seriesId: "GDPC1", displayMode: "qoq-annualized", relatedTickers: ["SPY", "DX-Y.NYB"] },
  "prelim gdp q/q": { seriesId: "GDPC1", displayMode: "qoq-annualized", relatedTickers: ["SPY", "DX-Y.NYB"] },
  "gdp q/q": { seriesId: "GDPC1", displayMode: "qoq-annualized", relatedTickers: ["SPY", "DX-Y.NYB"] },
  "unemployment rate": { seriesId: "UNRATE", displayMode: "level", relatedTickers: ["SPY", "DX-Y.NYB"] },
  "unemployment claims": { seriesId: "ICSA", displayMode: "level", relatedTickers: ["SPY"] },
  "non-farm employment change": { seriesId: "PAYEMS", displayMode: "change", relatedTickers: ["SPY", "DX-Y.NYB", "^TNX"] },
  "adp non-farm employment change": { seriesId: "NPPTTL", displayMode: "change", relatedTickers: ["SPY"] },
  "retail sales m/m": { seriesId: "RSAFS", displayMode: "mom", relatedTickers: ["XRT", "SPY"] },
  "core retail sales m/m": { seriesId: "RSFSXMV", displayMode: "mom", relatedTickers: ["XRT", "SPY"] },
  "prelim uom consumer sentiment": { seriesId: "UMCSENT", displayMode: "level", relatedTickers: ["SPY"] },
  "revised uom consumer sentiment": { seriesId: "UMCSENT", displayMode: "level", relatedTickers: ["SPY"] },
  "federal funds rate": { seriesId: "DFEDTARU", displayMode: "level", relatedTickers: ["^TNX", "TLT", "DX-Y.NYB"] },
  "housing starts": { seriesId: "HOUST", displayMode: "level", relatedTickers: ["XHB", "ITB"] },
  "building permits": { seriesId: "PERMIT", displayMode: "level", relatedTickers: ["XHB", "ITB"] },
  "existing home sales": { seriesId: "EXHOSLUSM495S", displayMode: "level", relatedTickers: ["XHB"] },
  "new home sales": { seriesId: "HSN1F", displayMode: "level", relatedTickers: ["XHB", "ITB"] },
  // Freddie Mac's PMMS, not the MBA's contract rate ("mba 30-year mortgage rate"), which is another survey.
  "30-year mortgage rate": { seriesId: "MORTGAGE30US", displayMode: "level", relatedTickers: ["XHB", "ITB"] },
  "15-year mortgage rate": { seriesId: "MORTGAGE15US", displayMode: "level", relatedTickers: ["XHB", "ITB"] },
  "nahb housing market index": { seriesId: "NAHBHMI", displayMode: "level", relatedTickers: ["XHB", "ITB"] },
  "durable goods orders m/m": { seriesId: "DGORDER", displayMode: "mom", relatedTickers: ["XLI", "SPY"] },
  "core durable goods orders m/m": { seriesId: "ADXTNO", displayMode: "mom", relatedTickers: ["XLI"] },
  "factory orders m/m": { seriesId: "AMTMNO", displayMode: "mom", relatedTickers: ["XLI"] },
  "trade balance": { seriesId: "BOPGSTB", displayMode: "level", relatedTickers: ["DX-Y.NYB"] },
  "industrial production m/m": { seriesId: "INDPRO", displayMode: "mom", relatedTickers: ["XLI", "SPY"] },
  "capacity utilization rate": { seriesId: "TCU", displayMode: "level", relatedTickers: ["XLI"] },
  "personal income m/m": { seriesId: "PI", displayMode: "mom", relatedTickers: ["SPY"] },
  "personal spending m/m": { seriesId: "PCE", displayMode: "mom", relatedTickers: ["XRT", "SPY"] },
  "current account": { seriesId: "NETFI", displayMode: "level", relatedTickers: ["DX-Y.NYB"] },
  "import prices m/m": { seriesId: "IR", displayMode: "mom", relatedTickers: ["DX-Y.NYB"] },
  "export prices m/m": { seriesId: "IQ", displayMode: "mom", relatedTickers: ["DX-Y.NYB"] },
  "jolts job openings": { seriesId: "JTSJOL", displayMode: "level", relatedTickers: ["SPY"] },
  "nonfarm productivity q/q": { seriesId: "OPHNFB", displayMode: "qoq-annualized", relatedTickers: ["SPY"] },
  "unit labor costs q/q": { seriesId: "ULCNFB", displayMode: "qoq-annualized", relatedTickers: ["SPY", "^TNX"] },
};

/** Other countries' releases Gloom Cloud serves a series for, by country and normalized title. */
const COUNTRY_SERIES_MAP: Record<string, Record<string, FredMapping>> = {
  // TurkStat's CPI, published as percent changes; the related ticker is the US-listed MSCI Turkey ETF.
  TR: {
    "cpi y/y": { seriesId: "TURCPIYOY", displayMode: "level", relatedTickers: ["TUR"] },
    "cpi m/m": { seriesId: "TURCPIMOM", displayMode: "level", relatedTickers: ["TUR"] },
  },
};

function normalizeEventTitle(title: string): string {
  return title.toLowerCase().trim();
}

export function resolveFredMapping(eventTitle: string, country: string): FredMapping | null {
  const elsewhere = COUNTRY_SERIES_MAP[country];
  if (elsewhere) return elsewhere[normalizeEventTitle(eventTitle)] ?? null;
  // Otherwise only US events have FRED data
  if (country !== "US" && country !== "USD") return null;

  const normalized = normalizeEventTitle(eventTitle);

  // Direct match
  if (SERIES_MAP[normalized]) return SERIES_MAP[normalized];

  // Fuzzy: try removing common prefixes
  for (const prefix of ["final ", "prelim ", "revised ", "flash ", "advance "]) {
    const stripped = normalized.startsWith(prefix) ? normalized.slice(prefix.length) : null;
    if (stripped && SERIES_MAP[stripped]) return SERIES_MAP[stripped];
  }

  // Substring matching can replace an unknown release with a different metric.

  return null;
}

export function projectFredHistory(observations: readonly DatedObservation[], mapping: FredMapping) {
  return applyTransform(observations, mapping.displayMode);
}

export function fredHistoryUnits(mapping: FredMapping, rawUnits: string): string {
  if (mapping.displayMode === "yoy") return "Percent change from year ago";
  if (mapping.displayMode === "mom") return "Percent change from previous month";
  if (mapping.displayMode === "qoq-annualized") return "Percent change, annualized";
  if (mapping.displayMode === "change") return `${rawUnits} change from previous period`;
  return rawUnits;
}
