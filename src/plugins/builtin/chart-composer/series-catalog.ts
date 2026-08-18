import {
  getTimeSeriesField,
  listTimeSeriesFields,
} from "../../../time-series/field-catalog";
import {
  chartSeriesSourceKey,
  type ChartSeriesCatalogItem,
} from "../../../capabilities";
import type { TimeSeriesFieldDefinition } from "../../../time-series/types";
import {
  canonicalExchange,
  parsePublicTickerKey,
  publicTickerKey,
} from "../../../utils/exchanges";
import {
  parseSeriesExpression,
  type ParsedSeriesExpression,
} from "./presets";

export interface SeriesCatalogInstrument {
  symbol: string;
  exchange?: string;
  name?: string;
}

export interface SeriesCatalogSuggestion {
  id: string;
  label: string;
  description: string;
  detail: string;
  expression: ParsedSeriesExpression;
}

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

function fieldCategory(field: TimeSeriesFieldDefinition): string {
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
      label: `FRED · ${expression.seriesId}`,
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
    label: `${instrument} · ${field?.label ?? expression.fieldId}`,
    description: field
      ? `${fieldCategory(field)} · ${fieldFrequency(field)}`
      : "Security series",
    detail: field ? fieldFrequency(field) : "Security",
    expression,
  };
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
