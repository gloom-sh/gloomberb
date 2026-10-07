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
import { FUTURES_CONTRACTS } from "../futures/contracts";
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
    return isValidChartCapabilityId(capabilityId) && isValidChartSeriesId(seriesId)
      ? { kind: "capability", capabilityId, seriesId }
      : null;
  }
  if (parts[0]?.trim().toUpperCase() === "FRED") {
    const seriesId = parts.length === 2 ? parts[1]?.trim().toUpperCase() ?? "" : "";
    return /^[A-Z0-9._-]{1,80}$/.test(seriesId)
      ? { kind: "economic", provider: "fred", seriesId }
      : null;
  }
  if (parts.length === 2 && parts[0]?.trim().toUpperCase() === "FUT") {
    const code = parts[1]?.trim().toUpperCase();
    const contract = FUTURES_CONTRACTS.find((entry) => entry.code === code);
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

export function parseChartExpression(value: string): ParsedSeriesExpression[] {
  if (!value.trim()) return [];

  const legs = value.split(/[;,\n]/);
  if (legs.length > MAX_CHART_COMPOSER_SERIES) {
    throw new Error(`Charts support up to ${MAX_CHART_COMPOSER_SERIES} base series.`);
  }

  return legs.map((leg) => {
    const parsed = parseSeriesExpression(leg);
    if (parsed) return parsed;
    const display = leg.trim() || "empty series";
    throw new Error(
      `Invalid chart series "${display}". Use SYMBOL, SYMBOL:field, FUT:code, UST:maturity, FRED:series, or CAP:capability-id:series-id.`,
    );
  });
}

export function formatSeriesExpression(series: ChartSeriesSpec): string {
  if (series.source.kind === "economic") return `FRED:${series.source.seriesId}`;
  if (series.source.kind === "capability") {
    return `CAP:${series.source.capabilityId}:${series.source.seriesId}`;
  }
  return `${publicTickerKey(series.source.instrument.symbol, series.source.instrument.exchange)}:${series.source.fieldId}`;
}

export function chartSeriesLabel(series: ChartSeriesSpec): string {
  if (series.label?.trim()) return series.label.trim();
  if (series.source.kind === "economic") return `FRED ${series.source.seriesId}`;
  if (series.source.kind === "capability") return series.source.seriesId;
  const generic = getTimeSeriesField(series.source.fieldId)?.unitGroup === "price"
    ? futuresGenericListing(series.source.instrument.symbol, series.source.instrument.exchange) : null;
  if (generic) return futuresGenericCaption(generic);
  const instrument = publicTickerKey(
    series.source.instrument.symbol,
    series.source.instrument.exchange,
  );
  const field = getTimeSeriesField(series.source.fieldId);
  return `${instrument} ${field?.shortLabel ?? series.source.fieldId.split(".").at(-1) ?? "Series"}`;
}
