import { publicTickerKey } from "../utils/exchanges";
import type { ChartSeriesSpec, ChartStudySpec } from "./types";

/**
 * What a series' errors are prefixed with: its label, else what was asked for
 * (`VIX`, `FRED GDP`), never the internal id a preset gave it (`vix-market-close-3`).
 */
export function seriesMessageName(spec: Pick<ChartSeriesSpec, "label" | "source">): string {
  const label = spec.label?.trim();
  if (label) return label;
  switch (spec.source.kind) {
    case "security": return publicTickerKey(spec.source.instrument.symbol, spec.source.instrument.exchange);
    case "economic": return `FRED ${spec.source.seriesId}`;
    case "capability": return spec.source.seriesId;
  }
}

const STUDY_MESSAGE_NAMES: Partial<Record<ChartStudySpec["kind"], string>> = {
  "realized-vol": "Realized volatility",
  "volume-profile": "Volume profile",
  "anchored-vwap": "Anchored VWAP",
  "leverage-decay": "Leverage decay",
  atr: "ATR",
  sma: "SMA",
  ema: "EMA",
  rsi: "RSI",
  macd: "MACD",
  vwap: "VWAP",
};

/**
 * What a study's errors and warnings are prefixed with: what it is
 * (`Ratio`, `Realized volatility`), never the id the chart gave it
 * (`pair:ratio`, `builtin:realized-vol:price`).
 */
export function studyMessageName(spec: Pick<ChartStudySpec, "kind">): string {
  return STUDY_MESSAGE_NAMES[spec.kind] ?? `${spec.kind[0]!.toUpperCase()}${spec.kind.slice(1)}`;
}
