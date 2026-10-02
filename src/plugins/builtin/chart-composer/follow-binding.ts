import type { InstrumentRef } from "../../../market-data/request-types";
import type { ChartSpec } from "../../../time-series/types";
import { canonicalExchange, parsePublicTickerKey, publicTickerKey } from "../../../utils/exchanges";
import { instrumentIdentityKey } from "../../../utils/instrument-identity";
import { isSameFuturesGeneric } from "../../../utils/futures-generic";
import { rebindChartSecuritySymbol, rebindResearchChartSpec } from "./chart-spec-edit";

export const CHART_FOLLOW_SERIES_SETTING_KEY = "chartFollowSeriesIds";

function normalized(instrument: InstrumentRef): InstrumentRef {
  const parsed = parsePublicTickerKey(instrument.symbol);
  return {
    ...instrument,
    symbol: parsed.symbol,
    exchange: parsed.exchange || canonicalExchange(instrument.exchange),
    brokerId: instrument.brokerId ?? instrument.instrument?.brokerId,
    brokerInstanceId: instrument.brokerInstanceId ?? instrument.instrument?.brokerInstanceId,
  };
}

const key = (instrument: InstrumentRef) => instrumentIdentityKey(normalized(instrument));
const publicKey = (instrument: InstrumentRef) => publicTickerKey(instrument.symbol, instrument.exchange);

/** Bootstrap old charts once; persisted IDs keep ownership through comparison collisions. */
export function resolveFollowSeriesIds(
  spec: ChartSpec,
  previous: InstrumentRef | null,
  target: InstrumentRef | null,
  saved?: unknown,
): string[] {
  const securities = spec.series.filter(series => series.source.kind === "security");
  if (Array.isArray(saved) && saved.every(id => typeof id === "string")) {
    const surviving = saved.filter(id => securities.some(series => series.id === id));
    // Deleting the followed sources must not transfer ownership to a comparison.
    return surviving.length === saved.length ? saved : surviving;
  }
  const prior = previous && normalized(previous);
  const next = target && normalized(target);
  const rebound = rebindResearchChartSpec(spec, prior ? publicKey(prior) : null, next ? publicKey(next) : null);
  // Prefer the complete previous identity when contracts share a ticker/venue.
  const owner = (prior && securities.find(series => series.source.kind === "security" && key(series.source.instrument) === key(prior)))
    || spec.series.find((series, index) => series !== rebound.series[index])
    || (next && securities.find(series => series.source.kind === "security" && key(series.source.instrument) === key(next)))
    || (next && securities.find(series => series.source.kind === "security" && publicKey(normalized(series.source.instrument)) === publicKey(next)))
    || securities[0];
  if (!owner || owner.source.kind !== "security") return [];
  const ownerKey = key(owner.source.instrument);
  return securities.filter(series => series.source.kind === "security" && key(series.source.instrument) === ownerKey).map(series => series.id);
}

/** Only the followed series move; other contracts and comparisons stay authored. */
export function rebindFollowChartSpec(
  spec: ChartSpec,
  previous: InstrumentRef | null,
  target: InstrumentRef | null,
  ownedIds = resolveFollowSeriesIds(spec, previous, target),
): ChartSpec {
  if (!target) return spec;
  const next = normalized(target);
  // The Roll and Adjust controls rewrite a generic (CL1 to CL1F5R): it keeps
  // following an unchanged target and moves on only when the target does.
  const unchanged = !previous || key(normalized(previous)) === key(next);
  let changed = false;
  const series = spec.series.map(series => {
    if (series.source.kind !== "security" || !ownedIds.includes(series.id) || key(series.source.instrument) === key(next)
      || (unchanged && isSameFuturesGeneric(normalized(series.source.instrument), next))) {
      return series;
    }
    changed = true;
    const projected = rebindChartSecuritySymbol(
      { ...spec, series: [series] },
      publicKey(normalized(series.source.instrument)),
      publicKey(next),
    ).series[0]!;
    return { ...projected, source: { ...series.source, instrument: next } };
  });
  return changed ? { ...spec, series } : spec;
}
