import type { ChartSeriesSpec, ChartSpec, ChartStudySpec } from "../../../time-series/types";
import { isLeverageFactor } from "../../../time-series/leverage";
import { priceComparisonSeriesIds } from "../../../time-series/price-comparison";
import { isUsListingExchange, parsePublicTickerKey } from "../../../utils/exchanges";
import { MAX_CHART_COMPOSER_SERIES } from "./chart-spec";
import { buildSeriesSpec, reconcilePanels } from "./chart-spec-edit";
import { normalizeInstrument } from "./series-expression";

/** A fund's daily objective as CMP draws it: `factor` times the index fund `proxy` each session. */
export interface DailyObjective {
  factor: number;
  proxy: string;
}

/** What CMP needs of a fund's facts: a daily objective with an index fund to draw it from. */
export interface LeverageFacts {
  leverage?: { value: number; reset: string; proxy: { ticker: string } | null } | null;
}

export function dailyObjective(facts: LeverageFacts | null | undefined): DailyObjective | null {
  const leverage = facts?.leverage;
  if (!leverage || leverage.reset !== "daily" || !isLeverageFactor(leverage.value) || !leverage.proxy?.ticker) return null;
  return { factor: leverage.value, proxy: leverage.proxy.ticker.toUpperCase() };
}

const LEVERAGE_STUDY_PREFIX = "leverage:";
const DECAY_STUDY_PREFIX = "leverage-decay:";

/** The bare ticker a compared leg is of (`TQQQ` for TQQQ:NASDAQ). */
function legTicker(series: ChartSeriesSpec): string | null {
  return series.source.kind === "security" ? parsePublicTickerKey(series.source.instrument.symbol).symbol.toUpperCase() : null;
}

/** A ticker the fund facts read: US-listed, as its symbol is written there (SPY, BRK.B). */
const US_FUND_TICKER = /^[A-Z][A-Z0-9]{0,5}(?:\.[A-Z])?$/;

/** The US-listed tickers of a price comparison, whose facts can say they are leveraged funds. */
export function comparedFundTickers(spec: ChartSpec): string[] {
  const compared = new Set(priceComparisonSeriesIds(spec) ?? []);
  return [...new Set(spec.series.flatMap((series) => {
    if (!compared.has(series.id) || series.source.kind !== "security") return [];
    const exchange = series.source.instrument.exchange || parsePublicTickerKey(series.source.instrument.symbol).exchange;
    const ticker = legTicker(series);
    return ticker && US_FUND_TICKER.test(ticker) && (!exchange || isUsListingExchange(exchange)) ? [ticker] : [];
  }))];
}

/** Whether the chart already draws a fund's objective, as built here or kept from before. */
export function hasLeverageOverlay(spec: ChartSpec): boolean {
  return spec.studies.some((study) => study.kind === "leverage" || study.kind === "leverage-decay");
}

/**
 * A price comparison with each leveraged or inverse fund's daily objective
 * drawn beside it: `factor` times its index fund each session, compounded
 * from where the chart compares (3× daily QQQ beside TQQQ), with the index
 * fund added as a leg when the chart has no room for it otherwise, and the
 * fund's decay against that line and against the factor times the index
 * fund's period return in a Decay panel. Any other chart, or a chart that
 * already draws an objective, is returned as it was.
 */
export function withLeverageOverlay(spec: ChartSpec, objectives: ReadonlyMap<string, DailyObjective>): ChartSpec {
  const compared = priceComparisonSeriesIds(spec);
  if (!compared || hasLeverageOverlay(spec) || objectives.size === 0) return spec;
  const series = [...spec.series];
  const studies: ChartStudySpec[] = [...spec.studies];
  for (const fund of spec.series.filter((entry) => compared.includes(entry.id))) {
    const objective = objectives.get(legTicker(fund) ?? "");
    if (!objective || fund.source.kind !== "security") continue;
    // A compared leg of the index fund, or the one added for another fund (TQQQ and SQQQ share QQQ).
    let index = series.find((entry) => legTicker(entry) === objective.proxy && (compared.includes(entry.id) || !spec.series.includes(entry)));
    if (!index) {
      const instrument = normalizeInstrument(objective.proxy, true);
      if (!instrument || series.length >= MAX_CHART_COMPOSER_SERIES) continue;
      index = buildSeriesSpec({ kind: "security", ...instrument, fieldId: fund.source.fieldId }, series.length, {
        style: fund.style, transform: fund.transform, axis: fund.axis, panelId: fund.panelId,
      });
      series.push(index);
    }
    const parameters = { factor: objective.factor };
    studies.push(
      { id: `${LEVERAGE_STUDY_PREFIX}${fund.id}`, kind: "leverage", inputSeriesIds: [index.id], parameters, panelId: fund.panelId, axis: "left" },
      { id: `${DECAY_STUDY_PREFIX}${fund.id}`, kind: "leverage-decay", inputSeriesIds: [fund.id, index.id], parameters, panelId: "decay", axis: "auto" },
    );
  }
  if (studies.length === spec.studies.length) return spec;
  return { ...spec, series, studies, panels: reconcilePanels(spec.panels, series, studies) };
}

/**
 * Each compared fund's daily objective, from its facts. A fund whose facts
 * fail to load is charted without one: the comparison never waits on them
 * failing.
 */
export async function loadDailyObjectives(
  tickers: readonly string[],
  loadFacts: (ticker: string) => Promise<LeverageFacts | null>,
): Promise<Map<string, DailyObjective>> {
  const objectives = new Map<string, DailyObjective>();
  await Promise.all(tickers.map(async (ticker) => {
    const objective = dailyObjective(await loadFacts(ticker).catch(() => null));
    // An index fund charted beside its leveraged fund is not leveraged itself.
    if (objective && objective.proxy !== ticker) objectives.set(ticker, objective);
  }));
  return objectives;
}
