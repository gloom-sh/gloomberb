import { applyTransform, type StatTransform } from "../econ-statistics/transform";
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
  "ism manufacturing pmi": { seriesId: "NAPM", displayMode: "level", relatedTickers: ["SPY", "XLI"] },
  "prelim uom consumer sentiment": { seriesId: "UMCSENT", displayMode: "level", relatedTickers: ["SPY"] },
  "revised uom consumer sentiment": { seriesId: "UMCSENT", displayMode: "level", relatedTickers: ["SPY"] },
  "federal funds rate": { seriesId: "DFEDTARU", displayMode: "level", relatedTickers: ["^TNX", "TLT", "DX-Y.NYB"] },
  "housing starts": { seriesId: "HOUST", displayMode: "level", relatedTickers: ["XHB", "ITB"] },
  "building permits": { seriesId: "PERMIT", displayMode: "level", relatedTickers: ["XHB", "ITB"] },
  "existing home sales": { seriesId: "EXHOSLUSM495S", displayMode: "level", relatedTickers: ["XHB"] },
  "new home sales": { seriesId: "HSN1F", displayMode: "level", relatedTickers: ["XHB", "ITB"] },
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

function normalizeEventTitle(title: string): string {
  return title.toLowerCase().trim();
}

export function resolveFredMapping(eventTitle: string, country: string): FredMapping | null {
  // Only US events have FRED data
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

export function getRelatedTickers(eventTitle: string, country: string): string[] {
  return resolveFredMapping(eventTitle, country)?.relatedTickers ?? [];
}

const SERIES_LABELS: Record<string, string> = {
  CPIAUCSL: "Consumer price index · seasonally adjusted",
  CPIAUCNS: "Consumer price index · not seasonally adjusted",
  CPILFESL: "Core consumer price index · seasonally adjusted",
  CPILFENS: "Core consumer price index · not seasonally adjusted",
  PPIFIS: "Producer price index · final demand",
  GDPC1: "Real gross domestic product",
  PAYEMS: "Total nonfarm payroll employment",
  DFEDTARU: "Federal funds target range · upper limit",
};

const FRED_CATALOG_SERIES: ReadonlyArray<{ seriesId: string; label: string }> = (() => {
  const labels = new Map<string, string>();
  for (const [key, mapping] of Object.entries(SERIES_MAP)) {
    const existing = labels.get(mapping.seriesId);
    if (existing == null || key.length < existing.length) {
      labels.set(mapping.seriesId, key);
    }
  }
  return [...labels.entries()].map(([seriesId, key]) => ({
    seriesId,
    label: SERIES_LABELS[seriesId] ?? key.replace(/\b\w/g, (char) => char.toUpperCase()),
  }));
})();

/**
 * Macro series the catalog should offer that are not economic-calendar releases, so
 * they have no natural home in SERIES_MAP above.
 */
const EXTRA_CATALOG_SERIES: ReadonlyArray<{ seriesId: string; label: string }> = [
  { seriesId: "M2SL", label: "M2 Money Stock" },
  { seriesId: "WCOILWTICO", label: "WTI crude oil spot price · weekly" },
  { seriesId: "NATURALGAS", label: "Natural gas consumption · monthly" },
  { seriesId: "DFII10", label: "10Y TIPS Real Yield" },
  { seriesId: "NCBEILQ027S", label: "Corporate Equities, Z.1" },
  { seriesId: "TNWMVBSNNCB", label: "Corporate Net Worth, Z.1" },
];

export function listFredCatalogSeries(): ReadonlyArray<{ seriesId: string; label: string }> {
  const known = new Set(FRED_CATALOG_SERIES.map((entry) => entry.seriesId));
  return [
    ...FRED_CATALOG_SERIES,
    ...EXTRA_CATALOG_SERIES.filter((entry) => !known.has(entry.seriesId)),
  ];
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
