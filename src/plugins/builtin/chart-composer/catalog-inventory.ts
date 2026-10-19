import { resolveAssetDisplayKind } from "../../../market-data/market/format";
import {
  getTimeSeriesField,
  listTimeSeriesFields,
} from "../../../time-series/field-catalog";
import type { SeriesCatalogEntry, SeriesFrequency, SeriesInput, SeriesPlacement } from "../../../series/types";
import { parseOptionSymbol } from "../../../utils/options";
import type { SeriesCatalogInstrument } from "./series-catalog";

export const CHART_COMPOSER_TEMPLATE_ID = "chart-composer-pane";
export const DATA_CATALOG_PANE_ID = "data-catalog";
export const DATA_CATALOG_TEMPLATE_ID = "data-catalog-pane";

/** "all", or a catalog group such as "Credit". */
export type CatalogFilterId = string;

export interface CatalogSeriesRow {
  id: string;
  label: string;
  group: string;
  unit: string;
  frequency: SeriesFrequency;
  /**
   * The official publisher for public data (FRED, the BLS), blank for market
   * data: the catalog says what a series is, never which vendor serves it.
   */
  publisher: string;
  /** What the EXPRESSION column shows: `TICKER` where a symbol goes. */
  expression: string;
  /** The registered expression, `{ticker}` where a symbol goes. */
  template: string;
  url?: string;
  /** Asks for a symbol before charting. */
  input?: SeriesInput;
  /** The symbol a row filled in for a typed ticker charts. */
  symbol?: string;
  /** The registered series' own name, and where it asks to be drawn. */
  seriesName?: string;
  placement?: SeriesPlacement;
  /** The lines of a series that draws several, `{ticker}` where a symbol goes. */
  lines?: SeriesCatalogEntry["lines"];
  /** The plugin that registered the series. */
  pluginId: string;
  searchText: string;
  /** Position in the default order: by group, then by name. */
  order: number;
}

/** The order catalog tabs and the default sort follow; other groups come after, by name. */
const GROUP_ORDER = [
  "Securities",
  "Options",
  "Crypto",
  "Futures",
  "Rates",
  "Credit",
  "Economy",
  "Defense & fiscal",
  "Inflation",
  "FX",
  "Energy",
  "Volatility",
  "Sentiment",
  "Positioning",
  "Valuation",
  "Alternative data",
  "Your series",
] as const;
const OTHER_GROUP = "Other";
const GROUP_RANK = new Map<string, number>(GROUP_ORDER.map((group, index) => [group, index]));
const FREQUENCY_ORDER: readonly SeriesFrequency[] = [
  "intraday", "daily", "weekly", "monthly", "quarterly", "annual", "irregular",
];
const TICKER_PLACEHOLDER = "{ticker}";
const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

/** Tabs saved before the catalog was grouped, mapped onto the groups that replaced them. */
const LEGACY_FILTERS: Readonly<Record<string, string>> = {
  securities: "Securities",
  options: "Options",
  crypto: "Crypto",
  fred: "Economy",
  futures: "Futures",
  valuation: "Valuation",
};

function groupRank(group: string): number {
  return GROUP_RANK.get(group) ?? GROUP_ORDER.length;
}

export function frequencyRank(frequency: SeriesFrequency): number {
  return FREQUENCY_ORDER.indexOf(frequency);
}

export function compareCatalogGroups(left: string, right: string): number {
  return groupRank(left) - groupRank(right) || collator.compare(left, right);
}

export function compareCatalogText(left: string, right: string): number {
  return collator.compare(left, right);
}

function displayExpression(template: string): string {
  return template.replaceAll(TICKER_PLACEHOLDER, "TICKER");
}

function rowFromEntry(entry: SeriesCatalogEntry): Omit<CatalogSeriesRow, "order"> {
  const group = entry.group?.trim() || OTHER_GROUP;
  const publisher = entry.publisher ?? "";
  const expression = displayExpression(entry.expression);
  return {
    id: entry.id,
    label: entry.name,
    group,
    unit: entry.unit,
    frequency: entry.frequency,
    publisher,
    expression,
    template: entry.expression,
    ...(entry.url ? { url: entry.url } : {}),
    ...(entry.input ? { input: entry.input } : {}),
    ...(entry.placement || entry.lines?.length ? {
      seriesName: entry.name,
      ...(entry.placement ? { placement: entry.placement } : {}),
      ...(entry.lines?.length ? { lines: entry.lines } : {}),
    } : {}),
    pluginId: entry.pluginId,
    searchText: [
      entry.name, publisher, group, entry.unit, entry.frequency, expression, entry.id,
      entry.description, ...(entry.tags ?? []),
    ].filter(Boolean).join(" ").toLowerCase(),
  };
}

const rowsByEntries = new WeakMap<readonly SeriesCatalogEntry[], readonly CatalogSeriesRow[]>();

/**
 * The catalog's rows in their default order (group, then name), computed once
 * per registry snapshot so typing in the search only filters.
 */
export function catalogRowsFromEntries(entries: readonly SeriesCatalogEntry[]): readonly CatalogSeriesRow[] {
  const cached = rowsByEntries.get(entries);
  if (cached) return cached;
  const rows = entries.map(rowFromEntry).sort((left, right) => (
    compareCatalogGroups(left.group, right.group)
    || collator.compare(left.label, right.label)
    || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
  )).map((row, order): CatalogSeriesRow => ({ ...row, order }));
  rowsByEntries.set(entries, rows);
  return rows;
}

/** All, then each group the rows hold, in catalog order. */
export function catalogTabs(rows: readonly CatalogSeriesRow[]): Array<{ id: CatalogFilterId; label: string }> {
  const groups = [...new Set(rows.map((row) => row.group))].sort(compareCatalogGroups);
  return [{ id: "all", label: "All" }, ...groups.map((group) => ({ id: group, label: group }))];
}

/** A saved tab the catalog still has, else All. */
export function normalizeCatalogFilter(saved: string | null | undefined, rows: readonly CatalogSeriesRow[]): CatalogFilterId {
  if (!saved || saved === "all") return "all";
  const group = LEGACY_FILTERS[saved] ?? saved;
  return rows.some((row) => row.group === group) ? group : "all";
}

function isOptionInstrument(instrument: SeriesCatalogInstrument): boolean {
  const category = instrument.assetCategory?.trim().toUpperCase();
  return category === "OPT" || parseOptionSymbol(instrument.symbol) != null;
}

function isCatalogCryptoInstrument(instrument: SeriesCatalogInstrument): boolean {
  if (isOptionInstrument(instrument)) return false;
  const exchange = instrument.exchange?.trim().toUpperCase();
  if (exchange === "CCC") return true;
  if (resolveAssetDisplayKind({ assetCategory: instrument.assetCategory }) === "crypto") return true;
  return /^[A-Z0-9]{2,10}[-/]USD$/i.test(instrument.symbol.trim());
}

function instrumentInput(instrument: SeriesCatalogInstrument): SeriesInput {
  if (isCatalogCryptoInstrument(instrument)) return "crypto";
  return isOptionInstrument(instrument) ? "option" : "ticker";
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
  const symbol = value.trim().toUpperCase().replace("/", "-");
  return /^[A-Z0-9^][A-Z0-9.^_=-]{0,31}$/.test(symbol) ? symbol : null;
}

/** The template with the symbol in place; a loaded series' symbol is URL-encoded, like its id. */
function fillTemplate(template: string, symbol: string): string {
  return template.replaceAll(
    TICKER_PLACEHOLDER,
    template.startsWith("CAP:") ? encodeURIComponent(symbol) : symbol,
  );
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

/**
 * Each series that asks for a symbol, filled in for each instrument it fits:
 * a stock gets the ticker series, an option contract the option series, a
 * crypto pair the crypto series. Typing AAPL lists AAPL · Close next to AAPL's
 * short interest.
 */
export function catalogRowsForResolvedInstruments(
  rows: readonly CatalogSeriesRow[],
  instruments: readonly SeriesCatalogInstrument[],
): CatalogSeriesRow[] {
  const templates = rows.filter((row) => row.input);
  return instruments.flatMap((instrument, index) => {
    const symbol = catalogTickerFromInput(instrument.symbol);
    if (!symbol) return [];
    const input = instrumentInput(instrument);
    return templates.filter((row) => row.input === input).map((row): CatalogSeriesRow => {
      const expression = fillTemplate(row.template, symbol);
      return {
        ...row,
        id: `${row.id}@${symbol}`,
        label: `${symbol} · ${row.label}`,
        expression,
        template: expression,
        input: undefined,
        symbol,
        // Right after the series it fills in, instruments in the order given.
        order: row.order + (index + 1) / (instruments.length + 1),
        searchText: `${symbol.toLowerCase()} ${(instrument.name ?? "").toLowerCase()} ${row.searchText} ${expression.toLowerCase()}`,
      };
    });
  });
}

/** The crypto series of the pairs on the user's lists, which the catalog shows without a search. */
export function catalogRowsForListedCrypto(
  rows: readonly CatalogSeriesRow[],
  instruments: readonly SeriesCatalogInstrument[],
): CatalogSeriesRow[] {
  return catalogRowsForResolvedInstruments(rows, instruments.filter(isCatalogCryptoInstrument));
}

export function catalogExpressionForRow(entry: CatalogSeriesRow, ticker?: string): string | null {
  if (!entry.input) return entry.template;
  const symbol = ticker ? catalogTickerFromInput(ticker) : null;
  return symbol ? fillTemplate(entry.template, symbol) : null;
}

/**
 * For a row whose series asks where it is drawn or draws several lines: the
 * series as the chart builds it, with the symbol typed or filled in. Null for
 * a row a plain expression charts, or one still missing its symbol.
 */
export function catalogPlacedSeriesForRow(entry: CatalogSeriesRow, ticker?: string): {
  name: string;
  template: string;
  placement?: SeriesPlacement;
  lines?: SeriesCatalogEntry["lines"];
  symbol?: string;
} | null {
  if (!entry.seriesName) return null;
  const symbol = entry.input ? (ticker ? catalogTickerFromInput(ticker) : null) : entry.symbol ?? null;
  if (entry.input && !symbol) return null;
  // A filled-in row's template already holds its symbol; its lines still read `{ticker}`.
  return {
    name: entry.seriesName,
    template: entry.template,
    ...(entry.placement ? { placement: entry.placement } : {}),
    ...(entry.lines ? { lines: entry.lines } : {}),
    ...(symbol ? { symbol } : {}),
  };
}

function matchesCatalogQuery(entry: CatalogSeriesRow, tokens: readonly string[]): boolean {
  for (const token of tokens) if (!entry.searchText.includes(token)) return false;
  return true;
}

export function filterCatalogRows(
  rows: readonly CatalogSeriesRow[],
  filter: CatalogFilterId,
  query: string,
): CatalogSeriesRow[] {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const group = filter === "all" ? null : filter;
  return rows.filter((entry) => (
    (group === null || entry.group === group)
    && matchesCatalogQuery(entry, tokens)
  ));
}

/**
 * The registered rows with the filled-in ones slotted after the series they
 * fill in, one row per chart: a registered row (Bitcoin) wins over the same
 * chart filled in for a listed pair (BTC-USD · Price).
 */
export function mergeCatalogRows(
  rows: readonly CatalogSeriesRow[],
  filled: readonly CatalogSeriesRow[],
): readonly CatalogSeriesRow[] {
  if (filled.length === 0) return rows;
  const charted = new Set(rows.flatMap((row) => row.input ? [] : [row.template]));
  const added = filled.filter((row) => {
    if (charted.has(row.template)) return false;
    charted.add(row.template);
    return true;
  });
  return [...rows, ...added].sort((left, right) => left.order - right.order);
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
