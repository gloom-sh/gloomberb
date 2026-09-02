import { resolveAssetDisplayKind } from "../../../market-data/market/format";
import {
  getTimeSeriesField,
  isMarketFieldId,
  listTimeSeriesFields,
} from "../../../time-series/field-catalog";
import { parseOptionSymbol } from "../../../utils/options";
import { listFredCatalogSeries } from "../econ/fred-series-map";
import {
  FUTURES_CONTRACTS,
  FUTURES_SECTOR_LABELS,
} from "../futures/contracts";
import { INDICATORS as VALUATION_INDICATORS } from "../market-valuation/indicators";
import { MARKET_VALUATION_CAPABILITY_ID } from "../market-valuation/chart-series";
import { TREASURY_MATURITIES } from "../yield-curve/treasury-data";
import { fieldCategory, type SeriesCatalogInstrument } from "./series-catalog";

export const CHART_COMPOSER_TEMPLATE_ID = "chart-composer-pane";
export const DATA_CATALOG_PANE_ID = "data-catalog";
export const DATA_CATALOG_TEMPLATE_ID = "data-catalog-pane";

export type CatalogSourceId =
  | "security"
  | "option"
  | "crypto"
  | "fred"
  | "futures"
  | "treasury"
  | "valuation";

export type CatalogFilterId =
  | "all"
  | "securities"
  | "options"
  | "crypto"
  | "fred"
  | "futures"
  | "valuation";

export interface CatalogSeriesRow {
  id: string;
  label: string;
  source: string;
  sourceId: CatalogSourceId;
  kind: string;
  expression: string;
  url?: string;
  searchText: string;
  needsTicker?: boolean;
  fieldToken?: string;
}

export const CATALOG_FILTERS: ReadonlyArray<{ id: CatalogFilterId; label: string }> = [
  { id: "all", label: "All" },
  { id: "securities", label: "Securities" },
  { id: "options", label: "Options" },
  { id: "crypto", label: "Crypto" },
  { id: "fred", label: "FRED" },
  { id: "futures", label: "Futures" },
  { id: "valuation", label: "Valuation" },
];

const FILTER_SOURCES: Record<CatalogFilterId, ReadonlySet<CatalogSourceId> | null> = {
  all: null,
  securities: new Set(["security"]),
  options: new Set(["option"]),
  crypto: new Set(["crypto"]),
  fred: new Set(["fred", "treasury"]),
  futures: new Set(["futures"]),
  valuation: new Set(["valuation"]),
};

const CRYPTO_CATALOG: ReadonlyArray<{ symbol: string; name: string }> = [
  { symbol: "BTC-USD", name: "Bitcoin" },
  { symbol: "ETH-USD", name: "Ethereum" },
  { symbol: "SOL-USD", name: "Solana" },
  { symbol: "XRP-USD", name: "XRP" },
  { symbol: "BNB-USD", name: "BNB" },
  { symbol: "DOGE-USD", name: "Dogecoin" },
  { symbol: "ADA-USD", name: "Cardano" },
  { symbol: "AVAX-USD", name: "Avalanche" },
  { symbol: "LINK-USD", name: "Chainlink" },
  { symbol: "DOT-USD", name: "Polkadot" },
  { symbol: "LTC-USD", name: "Litecoin" },
  { symbol: "UNI-USD", name: "Uniswap" },
  { symbol: "ATOM-USD", name: "Cosmos" },
  { symbol: "NEAR-USD", name: "NEAR" },
  { symbol: "APT-USD", name: "Aptos" },
  { symbol: "SUI-USD", name: "Sui" },
  { symbol: "TON-USD", name: "Toncoin" },
  { symbol: "SHIB-USD", name: "Shiba Inu" },
];

function isOptionInstrument(instrument: SeriesCatalogInstrument): boolean {
  const category = instrument.assetCategory?.trim().toUpperCase();
  return category === "OPT" || parseOptionSymbol(instrument.symbol) != null;
}

function chartFieldToken(fieldId: string): string {
  if (fieldId === "market.ohlcv") return "price";
  return fieldId.split(".").at(-1) ?? fieldId;
}

function row(entry: {
  id: string;
  label: string;
  source: string;
  sourceId: CatalogSourceId;
  kind: string;
  expression: string;
  url?: string;
  searchExtra?: string;
  needsTicker?: boolean;
  fieldToken?: string;
}): CatalogSeriesRow {
  const { searchExtra, ...fields } = entry;
  return {
    ...fields,
    searchText: [
      entry.label,
      entry.source,
      entry.kind,
      entry.expression,
      entry.sourceId,
      searchExtra,
    ].filter(Boolean).join(" ").toLowerCase(),
  };
}

function isCatalogCryptoInstrument(instrument: SeriesCatalogInstrument): boolean {
  if (isOptionInstrument(instrument)) return false;
  const exchange = instrument.exchange?.trim().toUpperCase();
  if (exchange === "CCC") return true;
  if (resolveAssetDisplayKind({ assetCategory: instrument.assetCategory }) === "crypto") return true;
  return /^[A-Z0-9]{2,10}[-/]USD$/i.test(instrument.symbol.trim());
}

const COMPACT_OCC_RE = /^([A-Z]{1,6})(\d{6}[CP]\d{8})$/;

function compactOccSymbol(value: string): string | null {
  const upper = value.trim().toUpperCase();
  const compact = COMPACT_OCC_RE.exec(upper.replace(/\s+/g, ""));
  if (compact) return `${compact[1]}${compact[2]}`;
  const spaced = parseOptionSymbol(upper);
  if (!spaced) return null;
  const expiry = new Date(spaced.expTs * 1000);
  const yy = String(expiry.getUTCFullYear()).slice(2);
  const mm = String(expiry.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(expiry.getUTCDate()).padStart(2, "0");
  const strike = String(Math.round(spaced.strike * 1000)).padStart(8, "0");
  return `${spaced.underlying}${yy}${mm}${dd}${spaced.side}${strike}`;
}

function catalogTickerFromInput(value: string): string | null {
  const option = compactOccSymbol(value);
  if (option) return option;
  const symbol = value.trim().toUpperCase();
  return /^[A-Z0-9^][A-Z0-9.^_/-]{0,31}$/.test(symbol) ? symbol : null;
}

function isCatalogFieldNameQuery(query: string): boolean {
  const lower = query.trim().toLowerCase();
  if (!lower) return false;
  if (getTimeSeriesField(lower)) return true;
  return listTimeSeriesFields().some((field) => (
    field.label.toLowerCase() === lower
    || field.shortLabel.toLowerCase() === lower
  ));
}

export function looksLikeCatalogTickerQuery(query: string): boolean {
  const trimmed = query.trim();
  if (!trimmed || /\s/.test(trimmed) || trimmed.includes(":")) return false;
  const symbol = catalogTickerFromInput(trimmed);
  if (!symbol) return false;
  if (compactOccSymbol(trimmed) || /\d/.test(symbol) || /[-.^/_]/.test(symbol)) return true;
  if (isCatalogFieldNameQuery(trimmed)) return false;
  return symbol.length <= 6;
}

export function catalogInstrumentMatchesQuery(
  instrument: SeriesCatalogInstrument,
  query: string,
): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return false;
  if (instrument.symbol.toLowerCase().includes(needle)) return true;
  return (instrument.name ?? "").toLowerCase().includes(needle);
}

export function catalogRowsForResolvedInstruments(
  instruments: readonly SeriesCatalogInstrument[],
): CatalogSeriesRow[] {
  const fields = listTimeSeriesFields();
  const marketFields = fields.filter((field) => isMarketFieldId(field.id));
  return instruments.flatMap((instrument) => {
    if (isCatalogCryptoInstrument(instrument)) {
      return [cryptoPairRow(catalogSecuritySymbol(instrument), instrument.name)];
    }
    if (isOptionInstrument(instrument)) {
      const symbol = compactOccSymbol(instrument.symbol)
        ?? catalogTickerFromInput(instrument.symbol);
      if (!symbol) return [];
      return marketFields.map((field) => {
        const token = chartFieldToken(field.id);
        return row({
          id: `option:${symbol}:${field.id}`,
          label: `${symbol} · ${field.label}`,
          source: "Yahoo",
          sourceId: "option",
          kind: "Options",
          expression: `${symbol}:${token}`,
          searchExtra: [instrument.name, "option", field.shortLabel].filter(Boolean).join(" "),
        });
      });
    }
    const symbol = catalogTickerFromInput(instrument.symbol);
    if (!symbol) return [];
    return fields.map((field) => {
      const token = chartFieldToken(field.id);
      return row({
        id: `ticker:${symbol}:${field.id}`,
        label: `${symbol} · ${field.label}`,
        source: "Yahoo",
        sourceId: "security",
        kind: fieldCategory(field),
        expression: `${symbol}:${token}`,
        searchExtra: [instrument.name, field.shortLabel].filter(Boolean).join(" "),
      });
    });
  });
}

export function catalogExpressionForRow(entry: CatalogSeriesRow, ticker?: string): string | null {
  if (!entry.needsTicker) return entry.expression;
  const symbol = ticker ? catalogTickerFromInput(ticker) : null;
  if (!symbol || !entry.fieldToken) return null;
  return `${symbol}:${entry.fieldToken}`;
}

function catalogSecuritySymbol(instrument: SeriesCatalogInstrument): string {
  return instrument.symbol.trim();
}

function securityFieldRows(): CatalogSeriesRow[] {
  return listTimeSeriesFields().map((field) => {
    const token = chartFieldToken(field.id);
    return row({
      id: `field:${field.id}`,
      label: field.label,
      source: "Yahoo",
      sourceId: "security",
      kind: fieldCategory(field),
      expression: `TICKER:${token}`,
      needsTicker: true,
      fieldToken: token,
      searchExtra: field.shortLabel,
    });
  });
}

function optionFieldRows(): CatalogSeriesRow[] {
  return listTimeSeriesFields().flatMap((field) => {
    if (!isMarketFieldId(field.id)) return [];
    const token = chartFieldToken(field.id);
    return [row({
      id: `option:${field.id}`,
      label: field.label,
      source: "Yahoo",
      sourceId: "option",
      kind: "Options",
      expression: `TICKER:${token}`,
      needsTicker: true,
      fieldToken: token,
      searchExtra: `option ${field.shortLabel}`,
    })];
  });
}

function cryptoPairRow(symbol: string, name?: string): CatalogSeriesRow {
  return row({
    id: `crypto:${symbol.toUpperCase()}`,
    label: name ? `${symbol} · ${name}` : symbol,
    source: "Yahoo",
    sourceId: "crypto",
    kind: "Crypto",
    expression: `${symbol}:price`,
    searchExtra: name,
  });
}

function cryptoRows(instruments: readonly SeriesCatalogInstrument[]): CatalogSeriesRow[] {
  const seen = new Set<string>();
  const rows: CatalogSeriesRow[] = [];
  const add = (symbol: string, name?: string) => {
    const key = symbol.trim().toUpperCase().replace("/", "-");
    if (!key || seen.has(key)) return;
    seen.add(key);
    rows.push(cryptoPairRow(key, name));
  };
  for (const instrument of instruments) {
    if (!isCatalogCryptoInstrument(instrument)) continue;
    add(catalogSecuritySymbol(instrument), instrument.name);
  }
  for (const entry of CRYPTO_CATALOG) add(entry.symbol, entry.name);
  return rows;
}

const STATIC_CATALOG_INVENTORY: readonly CatalogSeriesRow[] = [
  ...securityFieldRows(),
  ...optionFieldRows(),
  ...listFredCatalogSeries().map((entry) => row({
    id: `fred:${entry.seriesId}`,
    label: entry.label,
    source: "FRED",
    sourceId: "fred",
    kind: "Economic",
    expression: `FRED:${entry.seriesId}`,
    url: `https://fred.stlouisfed.org/series/${entry.seriesId}`,
  })),
  ...TREASURY_MATURITIES.map((entry) => row({
    id: `ust:${entry.maturity}`,
    label: `${entry.maturity} Treasury Yield`,
    source: "FRED",
    sourceId: "treasury",
    kind: "Treasury",
    expression: `UST:${entry.maturity}`,
    url: `https://fred.stlouisfed.org/series/${entry.seriesId}`,
  })),
  ...VALUATION_INDICATORS.map((entry) => row({
    id: `valuation:${entry.id}`,
    label: entry.label,
    source: "Gloom Cloud",
    sourceId: "valuation",
    kind: "Valuation",
    expression: `CAP:${MARKET_VALUATION_CAPABILITY_ID}:${entry.id}`,
  })),
  ...FUTURES_CONTRACTS.map((entry) => row({
    id: `fut:${entry.code}`,
    label: `${entry.name} (${entry.code})`,
    source: "Yahoo",
    sourceId: "futures",
    kind: FUTURES_SECTOR_LABELS[entry.sector],
    expression: `FUT:${entry.code}`,
  })),
];

export function listStaticCatalogInventory(
  instruments: readonly SeriesCatalogInstrument[] = [],
): CatalogSeriesRow[] {
  return [...STATIC_CATALOG_INVENTORY, ...cryptoRows(instruments)];
}

function matchesCatalogQuery(entry: CatalogSeriesRow, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return normalized.split(/\s+/).every((token) => entry.searchText.includes(token));
}

export function filterCatalogRows(
  rows: readonly CatalogSeriesRow[],
  filter: CatalogFilterId,
  query: string,
): CatalogSeriesRow[] {
  const sources = FILTER_SOURCES[filter];
  return rows.filter((entry) => (
    (sources ? sources.has(entry.sourceId) : true)
    && matchesCatalogQuery(entry, query)
  ));
}

export function catalogEmptyCopy(
  loading: boolean,
  searchQuery: string,
): { title: string; hint?: string } {
  if (loading) return { title: "Loading catalog…" };
  const query = searchQuery.trim();
  if (query) return { title: `No series matching "${query}"`, hint: "Press / to search." };
  return { title: "No series", hint: "Press / to search." };
}
