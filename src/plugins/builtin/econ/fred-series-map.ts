
interface FredMapping {
  seriesId: string;
  /** How to display the value: "level" shows the raw number, "change" shows month-over-month or quarter-over-quarter percent change */
  displayMode: "level" | "change";
  relatedTickers: string[];
}

// Normalized event title → FRED mapping
const SERIES_MAP: Record<string, FredMapping> = {
  "cpi m/m": { seriesId: "CPIAUCSL", displayMode: "change", relatedTickers: ["TIP", "DX-Y.NYB", "^TNX"] },
  "core cpi m/m": { seriesId: "CPILFESL", displayMode: "change", relatedTickers: ["TIP", "DX-Y.NYB", "^TNX"] },
  "cpi y/y": { seriesId: "CPIAUCSL", displayMode: "level", relatedTickers: ["TIP", "DX-Y.NYB"] },
  "core cpi y/y": { seriesId: "CPILFESL", displayMode: "level", relatedTickers: ["TIP", "DX-Y.NYB"] },
  "ppi m/m": { seriesId: "PPIACO", displayMode: "change", relatedTickers: ["DX-Y.NYB"] },
  "core pce price index m/m": { seriesId: "PCEPILFE", displayMode: "change", relatedTickers: ["TIP", "DX-Y.NYB", "^TNX"] },
  "pce price index m/m": { seriesId: "PCEPI", displayMode: "change", relatedTickers: ["TIP", "DX-Y.NYB"] },
  "final gdp q/q": { seriesId: "GDP", displayMode: "change", relatedTickers: ["SPY", "DX-Y.NYB"] },
  "advance gdp q/q": { seriesId: "GDP", displayMode: "change", relatedTickers: ["SPY", "DX-Y.NYB"] },
  "prelim gdp q/q": { seriesId: "GDP", displayMode: "change", relatedTickers: ["SPY", "DX-Y.NYB"] },
  "gdp q/q": { seriesId: "GDP", displayMode: "change", relatedTickers: ["SPY", "DX-Y.NYB"] },
  "unemployment rate": { seriesId: "UNRATE", displayMode: "level", relatedTickers: ["SPY", "DX-Y.NYB"] },
  "unemployment claims": { seriesId: "ICSA", displayMode: "level", relatedTickers: ["SPY"] },
  "non-farm employment change": { seriesId: "PAYEMS", displayMode: "change", relatedTickers: ["SPY", "DX-Y.NYB", "^TNX"] },
  "adp non-farm employment change": { seriesId: "NPPTTL", displayMode: "change", relatedTickers: ["SPY"] },
  "retail sales m/m": { seriesId: "RSAFS", displayMode: "change", relatedTickers: ["XRT", "SPY"] },
  "core retail sales m/m": { seriesId: "RSFSXMV", displayMode: "change", relatedTickers: ["XRT", "SPY"] },
  "ism manufacturing pmi": { seriesId: "NAPM", displayMode: "level", relatedTickers: ["SPY", "XLI"] },
  "consumer confidence": { seriesId: "UMCSENT", displayMode: "level", relatedTickers: ["SPY"] },
  "prelim uom consumer sentiment": { seriesId: "UMCSENT", displayMode: "level", relatedTickers: ["SPY"] },
  "revised uom consumer sentiment": { seriesId: "UMCSENT", displayMode: "level", relatedTickers: ["SPY"] },
  "cb consumer confidence": { seriesId: "CSCICP03USM665S", displayMode: "level", relatedTickers: ["SPY"] },
  "federal funds rate": { seriesId: "FEDFUNDS", displayMode: "level", relatedTickers: ["^TNX", "TLT", "DX-Y.NYB"] },
  "crude oil inventories": { seriesId: "WCOILWTICO", displayMode: "level", relatedTickers: ["CL=F", "USO"] },
  "natural gas storage": { seriesId: "NATURALGAS", displayMode: "level", relatedTickers: ["NG=F", "UNG"] },
  "housing starts": { seriesId: "HOUST", displayMode: "level", relatedTickers: ["XHB", "ITB"] },
  "building permits": { seriesId: "PERMIT", displayMode: "level", relatedTickers: ["XHB", "ITB"] },
  "existing home sales": { seriesId: "EXHOSLUSM495S", displayMode: "level", relatedTickers: ["XHB"] },
  "new home sales": { seriesId: "HSN1F", displayMode: "level", relatedTickers: ["XHB", "ITB"] },
  "durable goods orders m/m": { seriesId: "DGORDER", displayMode: "change", relatedTickers: ["XLI", "SPY"] },
  "core durable goods orders m/m": { seriesId: "ADXTNO", displayMode: "change", relatedTickers: ["XLI"] },
  "factory orders m/m": { seriesId: "AMTMNO", displayMode: "change", relatedTickers: ["XLI"] },
  "trade balance": { seriesId: "BOPGSTB", displayMode: "level", relatedTickers: ["DX-Y.NYB"] },
  "industrial production m/m": { seriesId: "INDPRO", displayMode: "change", relatedTickers: ["XLI", "SPY"] },
  "capacity utilization rate": { seriesId: "TCU", displayMode: "level", relatedTickers: ["XLI"] },
  "personal income m/m": { seriesId: "PI", displayMode: "change", relatedTickers: ["SPY"] },
  "personal spending m/m": { seriesId: "PCE", displayMode: "change", relatedTickers: ["XRT", "SPY"] },
  "current account": { seriesId: "NETFI", displayMode: "level", relatedTickers: ["DX-Y.NYB"] },
  "import prices m/m": { seriesId: "IR", displayMode: "change", relatedTickers: ["DX-Y.NYB"] },
  "export prices m/m": { seriesId: "IQ", displayMode: "change", relatedTickers: ["DX-Y.NYB"] },
  "jolts job openings": { seriesId: "JTSJOL", displayMode: "level", relatedTickers: ["SPY"] },
  "nonfarm productivity q/q": { seriesId: "OPHNFB", displayMode: "change", relatedTickers: ["SPY"] },
  "unit labor costs q/q": { seriesId: "ULCNFB", displayMode: "change", relatedTickers: ["SPY", "^TNX"] },
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

  // Fuzzy: try partial match on key words
  for (const [key, mapping] of Object.entries(SERIES_MAP)) {
    if (normalized.includes(key) || key.includes(normalized)) return mapping;
  }

  return null;
}

export function getRelatedTickers(eventTitle: string, country: string): string[] {
  return resolveFredMapping(eventTitle, country)?.relatedTickers ?? [];
}

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
    label: key.replace(/\b\w/g, (char) => char.toUpperCase()),
  }));
})();

/**
 * Macro series the catalog should offer that are not economic-calendar releases, so
 * they have no natural home in SERIES_MAP above.
 */
const EXTRA_CATALOG_SERIES: ReadonlyArray<{ seriesId: string; label: string }> = [
  { seriesId: "M2SL", label: "M2 Money Stock" },
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
