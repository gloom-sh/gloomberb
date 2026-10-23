import { publicTickerKey } from "../utils/exchanges";
import type { ChartSeriesSpec } from "./types";

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
