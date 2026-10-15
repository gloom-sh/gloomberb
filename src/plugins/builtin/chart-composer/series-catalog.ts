import {
  getTimeSeriesField,
  listTimeSeriesFields,
} from "../../../time-series/field-catalog";
import {
  chartSeriesSourceKey,
  type ChartSeriesCatalogItem,
} from "../../../capabilities";
import type { TimeSeriesFieldDefinition } from "../../../time-series/types";
import type { SeriesCatalogEntry } from "../../../series/types";
import {
  canonicalExchange,
  parsePublicTickerKey,
  publicTickerKey,
} from "../../../utils/exchanges";
import { parseSeriesExpression, type ParsedSeriesExpression } from "./series-expression";
import { parseFormulaExpression } from "./formula";

export interface SeriesCatalogInstrument {
  symbol: string;
  exchange?: string;
  name?: string;
  assetCategory?: string;
}

interface SeriesCatalogSuggestionText {
  id: string;
  label: string;
  description: string;
  detail: string;
}

/**
 * One series to add, or a catalog formula (`42*HO=F - CL=F`): its legs join
 * the chart with the study that weighs them.
 */
export type SeriesCatalogSuggestion = SeriesCatalogSuggestionText & (
  | { expression: ParsedSeriesExpression; formula?: never }
  | { formula: string; expression?: never }
);

export interface SeriesSearchAnalysis {
  directInstrument: SeriesCatalogInstrument | null;
  instrumentQuery: string;
  metricQuery: string;
}

const PREFERRED_FIELD_IDS = [
  "market.ohlcv",
  "fundamental.totalRevenue",
  "fundamental.netIncome",
  "fundamental.eps",
  "fundamental.freeCashFlow",
  "market.volume",
  "valuation.trailingPE",
  "valuation.evEbitda",
] as const;

const FIELD_ALIASES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "market.ohlcv": ["stock price", "share price"],
  "market.volume": ["trading volume"],
  "fundamental.totalRevenue": ["sales"],
  "fundamental.operatingCashFlow": ["cash from operations", "cfo"],
  "valuation.trailingPE": ["price earnings", "price to earnings"],
  "valuation.forwardPE": ["forward price earnings"],
  "valuation.priceSales": ["price to sales"],
  "valuation.evSales": ["enterprise value sales"],
  "valuation.evEbitda": ["enterprise value ebitda"],
  "valuation.priceFcf": ["price free cash flow"],
});

function words(value: string): string[] {
  return value
    .trim()
    .split(/\s+/)
    .map((token) => token.toLowerCase().replace(/[^a-z0-9^:._=-]+/g, ""))
    .filter(Boolean);
}

function compact(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function splitCamelCase(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
}

function fieldPhrases(field: TimeSeriesFieldDefinition): string[][] {
  const suffix = field.id.split(".").at(-1) ?? field.id;
  const values = new Set([
    field.label,
    field.shortLabel,
    splitCamelCase(suffix),
    field.id.replaceAll(".", " "),
    ...(FIELD_ALIASES[field.id] ?? []),
  ]);
  const phrases = [...values].flatMap((value) => {
    const normal = words(value);
    const joined = compact(value);
    return [
      normal,
      ...(joined.length > 1 ? [[joined]] : []),
    ];
  });
  return phrases.filter((phrase) => phrase.length > 0);
}

function findContiguousWords(haystack: readonly string[], needle: readonly string[]): number {
  if (needle.length === 0 || needle.length > haystack.length) return -1;
  for (let start = 0; start <= haystack.length - needle.length; start += 1) {
    if (needle.every((token, index) => haystack[start + index] === token)) return start;
  }
  return -1;
}

function matchedMetricSpan(queryWords: readonly string[]): {
  field: TimeSeriesFieldDefinition;
  start: number;
  length: number;
} | null {
  let best: { field: TimeSeriesFieldDefinition; start: number; length: number; weight: number } | null = null;
  for (const field of listTimeSeriesFields()) {
    for (const phrase of fieldPhrases(field)) {
      const start = findContiguousWords(queryWords, phrase);
      if (start < 0) continue;
      const weight = phrase.join("").length;
      if (!best || phrase.length > best.length || (phrase.length === best.length && weight > best.weight)) {
        best = { field, start, length: phrase.length, weight };
      }
    }
  }
  return best;
}

function explicitInstrument(value: string): SeriesCatalogInstrument | null {
  const trimmed = value.trim();
  const token = trimmed.split(/\s+/)[0] ?? "";
  if (!token || token !== token.toUpperCase() || !/^[A-Z0-9^][A-Z0-9.^_=-]*(?::[A-Z0-9._-]+)?$/.test(token)) {
    return null;
  }
  const parsed = parsePublicTickerKey(token);
  return {
    symbol: parsed.symbol,
    ...(parsed.exchange ? { exchange: parsed.exchange } : {}),
  };
}

export function analyzeSeriesSearchQuery(query: string): SeriesSearchAnalysis {
  const queryWords = words(query);
  const rawWords = query.trim().split(/\s+/).filter(Boolean);
  if (queryWords.length === 0) {
    return { directInstrument: null, instrumentQuery: "", metricQuery: "" };
  }

  const metric = matchedMetricSpan(queryWords);
  const remaining = metric
    ? queryWords.filter((_, index) => index < metric.start || index >= metric.start + metric.length)
    : queryWords;
  const remainingRaw = metric
    ? rawWords.filter((_, index) => index < metric.start || index >= metric.start + metric.length)
    : rawWords;
  const remainingText = remaining.join(" ");
  const directInstrument = explicitInstrument(remainingRaw.join(" "));

  if (directInstrument) {
    return {
      directInstrument,
      instrumentQuery: "",
      metricQuery: metric
        ? metric.field.label
        : remaining.slice(1).join(" "),
    };
  }

  if (metric) {
    return {
      directInstrument: null,
      instrumentQuery: remainingText,
      metricQuery: metric.field.label,
    };
  }

  return {
    directInstrument: null,
    instrumentQuery: query.trim(),
    metricQuery: "",
  };
}

export function fieldCategory(field: TimeSeriesFieldDefinition): string {
  if (field.id.startsWith("market.")) return "Market";
  if (field.id.startsWith("valuation.")) return "Valuation";
  return "Fundamentals";
}

function fieldFrequency(field: TimeSeriesFieldDefinition): string {
  return field.nativeFrequency === "auto"
    ? "Automatic"
    : `${field.nativeFrequency[0]!.toUpperCase()}${field.nativeFrequency.slice(1)}`;
}

function fieldScore(field: TimeSeriesFieldDefinition, query: string): number {
  const queryWords = words(query);
  if (queryWords.length === 0) {
    const preferredIndex = PREFERRED_FIELD_IDS.indexOf(field.id as typeof PREFERRED_FIELD_IDS[number]);
    return preferredIndex >= 0 ? 1_000 - preferredIndex : 100;
  }

  const queryCompact = compact(query);
  let best = -1;
  for (const phrase of fieldPhrases(field)) {
    const phraseText = phrase.join(" ");
    const phraseCompact = compact(phraseText);
    if (phraseCompact === queryCompact) best = Math.max(best, 2_000 + phraseCompact.length);
    else if (phraseCompact.startsWith(queryCompact)) best = Math.max(best, 1_500 + queryCompact.length);
    else if (phraseCompact.includes(queryCompact)) best = Math.max(best, 1_200 + queryCompact.length);
    else if (queryWords.every((token) => phrase.some((part) => part.startsWith(token)))) {
      best = Math.max(best, 900 + queryWords.join("").length);
    }
  }
  return best;
}

function uniqueInstruments(instruments: readonly SeriesCatalogInstrument[]): SeriesCatalogInstrument[] {
  const seen = new Set<string>();
  return instruments.filter((instrument) => {
    const key = publicTickerKey(instrument.symbol, instrument.exchange);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function exactExpressionSuggestion(query: string): SeriesCatalogSuggestion | null {
  if (!query.includes(":")) return null;
  const expression = parseSeriesExpression(query);
  if (!expression) return null;
  if (expression.kind === "economic") {
    return {
      id: `fred:${expression.seriesId}`,
      label: expression.label ?? `FRED · ${expression.seriesId}`,
      description: "Economic series from FRED",
      detail: "FRED",
      expression,
    };
  }
  if (expression.kind === "capability") {
    return {
      id: chartSeriesSourceKey({
        kind: "capability",
        capabilityId: expression.capabilityId,
        seriesId: expression.seriesId,
      }),
      label: expression.label ?? expression.seriesId,
      description: `Plugin series from ${expression.capabilityId}`,
      detail: "Plugin",
      expression,
    };
  }
  const field = getTimeSeriesField(expression.fieldId);
  const instrument = publicTickerKey(expression.symbol, expression.exchange);
  return {
    id: `${instrument}:${expression.fieldId}`,
    label: expression.label ?? `${instrument} · ${field?.label ?? expression.fieldId}`,
    description: field
      ? `${fieldCategory(field)} · ${fieldFrequency(field)}`
      : "Security series",
    detail: field ? fieldFrequency(field) : "Security",
    expression,
  };
}

function matchesAliasQuery(query: string, ...values: string[]): boolean {
  const tokens = words(query).map(compact);
  const searchable = compact(values.join(" "));
  return tokens.length > 0 && tokens.every((token) => searchable.includes(token));
}

function suggestionId(expression: ParsedSeriesExpression): string {
  if (expression.kind === "economic") return `fred:${expression.seriesId}`;
  if (expression.kind === "capability") {
    return chartSeriesSourceKey({ kind: "capability", capabilityId: expression.capabilityId, seriesId: expression.seriesId });
  }
  return `${publicTickerKey(expression.symbol, expression.exchange)}:${expression.fieldId}`;
}

function registeredMatchRank(entry: SeriesCatalogEntry, query: string): number {
  const name = compact(entry.name);
  const needle = compact(query);
  if (name === needle || compact(entry.expression) === needle) return 0;
  if (name.startsWith(needle)) return 1;
  return 2;
}

/**
 * Registered catalog series the query names: by name, expression, group or
 * tags. A series that takes a ticker is filled in with the one the query
 * names, or the chart's own; ticker fields come from the field ranking instead.
 */
function registeredSeriesSuggestions(
  query: string,
  registered: readonly SeriesCatalogEntry[],
  analysis: SeriesSearchAnalysis,
  defaultInstrument: SeriesCatalogInstrument,
): SeriesCatalogSuggestion[] {
  if (!query.trim() || registered.length === 0) return [];
  const instrument = analysis.directInstrument ?? defaultInstrument;
  const tickerQuery = analysis.directInstrument ? analysis.metricQuery : query;
  const hits: Array<{ entry: SeriesCatalogEntry; rank: number } & (
    | { expression: ParsedSeriesExpression; formula?: never }
    | { formula: string; expression?: never }
  )> = [];
  for (const entry of registered) {
    let template = entry.expression;
    let text = query;
    if (entry.input) {
      // Ticker fields are ranked against the security below; options and pairs need their own symbol.
      if (entry.input !== "ticker" || /^\{ticker\}:[A-Za-z]/.test(template) || !tickerQuery.trim()) continue;
      const symbol = publicTickerKey(instrument.symbol, instrument.exchange);
      template = template.replaceAll("{ticker}", template.startsWith("CAP:") ? encodeURIComponent(symbol) : symbol);
      text = tickerQuery;
    }
    if (!matchesAliasQuery(text, entry.name, entry.expression, entry.id, entry.group ?? "", ...(entry.tags ?? []))) continue;
    const parsed = parseSeriesExpression(template);
    if (!parsed) {
      if (!entry.input && catalogFormula(template)) hits.push({ entry, rank: registeredMatchRank(entry, text), formula: template });
      continue;
    }
    const label = entry.input ? `${publicTickerKey(instrument.symbol, instrument.exchange)} · ${entry.name}` : entry.name;
    hits.push({ entry, rank: registeredMatchRank(entry, text), expression: { ...parsed, label } });
  }
  hits.sort((left, right) => left.rank - right.rank || left.entry.name.length - right.entry.name.length);
  return hits.map(({ entry, expression, formula }): SeriesCatalogSuggestion => {
    const description = [entry.group, entry.unit, entry.frequency].filter(Boolean).join(" · ");
    const detail = entry.group ?? "Series";
    if (formula !== undefined) {
      // A formula runs long: its name leads, and the formula is in the description.
      const formulaDescription = [formula, entry.unit, entry.frequency].filter(Boolean).join(" · ");
      return { id: `formula:${formula}`, label: entry.name, description: formulaDescription, detail, formula };
    }
    return {
      id: suggestionId(expression),
      label: expression.kind === "capability" ? expression.label ?? entry.name : `${entry.expression} · ${entry.name}`,
      description,
      detail,
      expression,
    };
  });
}

/** Whether a catalog series is a formula G can chart: a registered one that does not read is left out. */
function catalogFormula(expression: string): boolean {
  try {
    return parseFormulaExpression(expression) !== null;
  } catch {
    return false;
  }
}

export function buildCapabilitySeriesSuggestions(
  items: ReadonlyArray<ChartSeriesCatalogItem & { capabilityId: string; capabilityName: string }>,
): SeriesCatalogSuggestion[] {
  return items.map((item) => ({
    id: chartSeriesSourceKey({
      kind: "capability",
      capabilityId: item.capabilityId,
      seriesId: item.seriesId,
    }),
    label: item.label,
    description: item.description ?? item.capabilityName,
    detail: item.detail ?? item.capabilityName,
    expression: {
      kind: "capability",
      capabilityId: item.capabilityId,
      seriesId: item.seriesId,
      label: item.label,
      style: item.style,
      transform: item.transform,
    },
  }));
}

export function buildSeriesCatalogSuggestions(
  query: string,
  defaultInstrument: SeriesCatalogInstrument,
  searchedInstruments: readonly SeriesCatalogInstrument[] = [],
  limit = 8,
  registered: readonly SeriesCatalogEntry[] = [],
): SeriesCatalogSuggestion[] {
  const exact = exactExpressionSuggestion(query.trim());
  const analysis = analyzeSeriesSearchQuery(query);
  const instruments = uniqueInstruments(
    analysis.directInstrument
      ? [analysis.directInstrument]
      : analysis.instrumentQuery
        ? searchedInstruments
        : [defaultInstrument],
  );

  const rankedFields = listTimeSeriesFields()
    .map((field) => ({ field, score: fieldScore(field, analysis.metricQuery) }))
    .filter((entry) => entry.score >= 0)
    .sort((left, right) => right.score - left.score || left.field.label.localeCompare(right.field.label));

  const suggestions: SeriesCatalogSuggestion[] = exact ? [exact] : [];
  for (const suggestion of registeredSeriesSuggestions(query, registered, analysis, defaultInstrument)) {
    if (!suggestions.some((entry) => entry.id === suggestion.id)) suggestions.push(suggestion);
  }
  const fieldLimit = instruments.length > 1 && !analysis.metricQuery ? 1 : rankedFields.length;
  for (const instrument of instruments) {
    const instrumentLabel = publicTickerKey(instrument.symbol, instrument.exchange);
    for (const { field } of rankedFields.slice(0, fieldLimit)) {
      const expression: ParsedSeriesExpression = {
        kind: "security",
        symbol: instrument.symbol,
        ...(instrument.exchange ? { exchange: canonicalExchange(instrument.exchange) } : {}),
        fieldId: field.id,
      };
      const suggestion: SeriesCatalogSuggestion = {
        id: `${instrumentLabel}:${field.id}`,
        label: `${instrumentLabel} · ${field.label}`,
        description: [
          instrument.name,
          fieldCategory(field),
          fieldFrequency(field),
        ].filter(Boolean).join(" · "),
        detail: fieldFrequency(field),
        expression,
      };
      if (!suggestions.some((entry) => entry.id === suggestion.id)) suggestions.push(suggestion);
    }
  }
  return suggestions.slice(0, Math.max(1, limit));
}
