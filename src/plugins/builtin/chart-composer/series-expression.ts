import { futuresGenericCaption, futuresGenericListing } from "../../../utils/futures-generic";
import type { ChartSeriesSpec, SeriesStyle, SeriesTransform } from "../../../time-series/types";
import {
  canonicalTimeSeriesFieldId,
  getTimeSeriesField,
  listTimeSeriesFields,
} from "../../../time-series/field-catalog";
import {
  CANONICAL_EXCHANGE_ALIASES,
  canonicalExchange,
  publicTickerKey,
} from "../../../utils/exchanges";
import { MAX_CHART_COMPOSER_SERIES } from "./chart-spec";
import {
  isValidChartCapabilityId,
  isValidChartSeriesId,
} from "../../../capabilities/chart-series";
import { futuresContractByCode } from "../../../market-data/futures-board";
import { getSharedRegistry } from "../../registry";
import { TREASURY_MATURITIES } from "../yield-curve/treasury-data";

export const CHART_FIELD_IDS = {
  price: "market.ohlcv",
  close: "market.close",
  volume: "market.volume",
  revenue: "fundamental.totalRevenue",
  grossProfit: "fundamental.grossProfit",
  operatingIncome: "fundamental.operatingIncome",
  netIncome: "fundamental.netIncome",
  freeCashFlow: "fundamental.freeCashFlow",
  eps: "fundamental.eps",
  trailingPE: "valuation.trailingPE",
  forwardPE: "valuation.forwardPE",
  evEbitda: "valuation.evEbitda",
} as const;

/** Series of things with a place (chokepoint transits, port calls), served with the map's layers. */
export const GEO_SERIES_CAPABILITY_ID = "geo-series";

/** `GEO:<series id or short alias>`, e.g. `GEO:SUEZ`. */
export function formatGeoSeriesExpression(seriesId: string): string {
  return `GEO:${seriesId}`;
}

export type ParsedSeriesExpression =
  | { kind: "security"; symbol: string; exchange?: string; fieldId: string; label?: string }
  | { kind: "economic"; provider: "fred"; seriesId: string; label?: string }
  | {
      kind: "capability";
      capabilityId: string;
      seriesId: string;
      label?: string;
      style?: SeriesStyle;
      transform?: SeriesTransform;
    };

function normalizeBaseSymbol(value: string): string | null {
  const symbol = value.trim().toUpperCase();
  return /^[A-Z0-9^][A-Z0-9.^_/=-]{0,31}$/.test(symbol) ? symbol : null;
}

export function normalizeInstrument(
  value: string,
  allowUnknownExchange = false,
): { symbol: string; exchange?: string } | null {
  const parts = value.trim().split(":");
  if (parts.length === 1) {
    const symbol = normalizeBaseSymbol(parts[0]!);
    return symbol ? { symbol } : null;
  }
  if (parts.length !== 2) return null;
  const symbol = normalizeBaseSymbol(parts[0]!);
  const exchangeToken = parts[1]!.trim().toUpperCase();
  const knownExchange = Object.prototype.hasOwnProperty.call(CANONICAL_EXCHANGE_ALIASES, exchangeToken);
  if (!symbol || !/^[A-Z0-9._-]{1,24}$/.test(exchangeToken) || (!knownExchange && !allowUnknownExchange)) {
    return null;
  }
  return { symbol, exchange: canonicalExchange(exchangeToken) };
}

export function resolveChartFieldAlias(value: string | undefined): string {
  if (!value?.trim()) return CHART_FIELD_IDS.price;
  const trimmed = value.trim();
  const canonical = canonicalTimeSeriesFieldId(trimmed);
  if (getTimeSeriesField(canonical)) return canonical;
  const searchable = trimmed.toLowerCase().replace(/[^a-z0-9]/g, "");
  const match = listTimeSeriesFields().find((field) => (
    field.id.toLowerCase().replace(/[^a-z0-9]/g, "") === searchable
    || field.label.toLowerCase().replace(/[^a-z0-9]/g, "") === searchable
    || field.shortLabel.toLowerCase().replace(/[^a-z0-9]/g, "") === searchable
  ));
  return match?.id ?? canonical;
}

export function parseSeriesExpression(value: string): ParsedSeriesExpression | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(":");
  if (parts[0]?.trim().toUpperCase() === "CAP") {
    const separator = trimmed.indexOf(":", 4);
    if (separator < 0) return null;
    const capabilityId = trimmed.slice(4, separator);
    const seriesId = trimmed.slice(separator + 1);
    if (!isValidChartCapabilityId(capabilityId) || !isValidChartSeriesId(seriesId)) return null;
    const label = registeredSeriesName({ capabilityId, seriesId });
    return { kind: "capability", capabilityId, seriesId, ...(label ? { label } : {}) };
  }
  if (parts[0]?.trim().toUpperCase() === "GEO") {
    const seriesId = trimmed.slice(trimmed.indexOf(":") + 1).trim();
    return parts.length >= 2 && isValidChartSeriesId(seriesId)
      ? { kind: "capability", capabilityId: GEO_SERIES_CAPABILITY_ID, seriesId }
      : null;
  }
  if (parts[0]?.trim().toUpperCase() === "FRED") {
    const seriesId = parts.length === 2 ? parts[1]?.trim().toUpperCase() ?? "" : "";
    if (!/^[A-Z0-9._-]{1,80}$/.test(seriesId)) return null;
    // The catalog's name for a listed series, so the legend says what the catalog said.
    const label = getSharedRegistry()?.series?.findByExpression(`FRED:${seriesId}`)?.definition.name;
    return { kind: "economic", provider: "fred", seriesId, ...(label ? { label } : {}) };
  }
  if (parts.length === 2 && parts[0]?.trim().toUpperCase() === "FUT") {
    const contract = futuresContractByCode(parts[1]);
    return contract
      ? { kind: "security", symbol: contract.symbol, fieldId: CHART_FIELD_IDS.price, label: contract.name }
      : null;
  }
  if (parts.length === 2 && parts[0]?.trim().toUpperCase() === "UST") {
    const maturity = parts[1]?.trim().toUpperCase();
    const treasury = TREASURY_MATURITIES.find((entry) => entry.maturity === maturity);
    return treasury
      ? {
          kind: "economic",
          provider: "fred",
          seriesId: treasury.seriesId,
          label: `${treasury.maturity} Treasury Yield`,
        }
      : null;
  }

  let instrument: { symbol: string; exchange?: string } | null = null;
  let fieldId: string = CHART_FIELD_IDS.price;
  if (parts.length === 1) {
    instrument = normalizeInstrument(trimmed);
  } else if (parts.length === 2) {
    const candidateFieldId = resolveChartFieldAlias(parts[1]);
    if (getTimeSeriesField(candidateFieldId)) {
      instrument = normalizeInstrument(parts[0]!);
      fieldId = candidateFieldId;
    } else {
      // A known public exchange suffix is unambiguously a qualified ticker.
      instrument = normalizeInstrument(trimmed);
    }
  } else if (parts.length === 3) {
    const candidateFieldId = resolveChartFieldAlias(parts[2]);
    if (getTimeSeriesField(candidateFieldId)) {
      instrument = normalizeInstrument(`${parts[0]}:${parts[1]}`, true);
      fieldId = candidateFieldId;
    }
  }
  if (!instrument) return null;
  if (!getTimeSeriesField(fieldId)) return null;
  return { kind: "security", ...instrument, fieldId };
}

const SERIES_FORMS = "Use SYMBOL, SYMBOL:field, FUT:code, UST:maturity, FRED:series, GEO:series, or CAP:capability-id:series-id.";

/** A word that reads as a series, not an operator or a number of a formula. */
const LIST_WORD = /^[A-Za-z^][\w.^=:/~-]*$/;

/**
 * One leg of a list: a series, or series typed with spaces between them
 * (`AAPL MSFT`, as `fn G AAPL MSFT` passes them), each word a series of its
 * own. Null when it is neither.
 */
function parseLeg(leg: string): ParsedSeriesExpression[] | null {
  const parsed = parseSeriesExpression(leg);
  if (parsed) return [parsed];
  const words = leg.trim().split(/\s+/);
  if (words.length < 2) return null;
  const series = words.map(parseSeriesExpression);
  return series.every((entry): entry is ParsedSeriesExpression => entry != null) ? series : null;
}

export function parseChartExpression(value: string): ParsedSeriesExpression[] {
  if (!value.trim()) return [];
  // A list pasted with a stray separator (`BRK.B,SPY,`, `,SPY`, `A,,B`) has no series between them.
  const legs = value.split(/[;,\n]/).filter((leg) => leg.trim());
  // Separators alone name no series at all.
  if (legs.length === 0) throw new Error(`Invalid chart series "${value.trim()}": no series between its separators. ${SERIES_FORMS}`);

  const series = legs.flatMap((leg) => {
    const parsed = parseLeg(leg);
    if (parsed) return parsed;
    // Words with spaces between them, none of them an operator, that are not all series: a list is written with commas.
    const words = leg.trim().split(/\s+/);
    const listHint = words.length > 1 && words.every((word) => LIST_WORD.test(word)) ? ` Separate series with commas: ${words.join(",")}.` : "";
    throw new Error(`Invalid chart series "${leg.trim()}".${listHint} ${SERIES_FORMS}`);
  });
  if (series.length > MAX_CHART_COMPOSER_SERIES) {
    throw new Error(`Charts support up to ${MAX_CHART_COMPOSER_SERIES} base series.`);
  }
  return series;
}

export function formatSeriesExpression(series: ChartSeriesSpec): string {
  if (series.source.kind === "economic") return `FRED:${series.source.seriesId}`;
  if (series.source.kind === "capability") {
    return series.source.capabilityId === GEO_SERIES_CAPABILITY_ID
      ? formatGeoSeriesExpression(series.source.seriesId)
      : `CAP:${series.source.capabilityId}:${series.source.seriesId}`;
  }
  return `${publicTickerKey(series.source.instrument.symbol, series.source.instrument.exchange)}:${series.source.fieldId}`;
}

/** A registered catalog series' name, with the ticker it was charted for. */
export function registeredSeriesName(source: { capabilityId: string; seriesId: string }): string | null {
  const found = getSharedRegistry()?.series?.findLoaded(source.capabilityId, source.seriesId);
  if (!found) return null;
  const name = found.line ? `${found.series.definition.name} · ${found.line.name}` : found.series.definition.name;
  return found.ticker ? `${found.ticker} ${name}` : name;
}

export function chartSeriesLabel(series: ChartSeriesSpec): string {
  if (series.label?.trim()) return series.label.trim();
  if (series.source.kind === "economic") return `FRED ${series.source.seriesId}`;
  if (series.source.kind === "capability") return registeredSeriesName(series.source) ?? series.source.seriesId;
  const generic = getTimeSeriesField(series.source.fieldId)?.unitGroup === "price"
    ? futuresGenericListing(series.source.instrument.symbol, series.source.instrument.exchange) : null;
  if (generic) return futuresGenericCaption(generic);
  const instrument = publicTickerKey(
    series.source.instrument.symbol,
    series.source.instrument.exchange,
  );
  const field = getTimeSeriesField(series.source.fieldId);
  return `${instrument} ${field?.seriesLabel ?? field?.shortLabel ?? series.source.fieldId.split(".").at(-1) ?? "Series"}`;
}
