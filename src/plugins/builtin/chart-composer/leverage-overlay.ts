import { logFailure } from "../../../utils/log-failure";
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
function hasLeverageOverlay(spec: ChartSpec): boolean {
  return spec.studies.some((study) => study.kind === "leverage" || study.kind === "leverage-decay");
}

/**
 * Whether a report of this chart could draw a daily objective at all: a
 * price comparison without one yet, over daily bars. One session's chart, or
 * bars asked for by the week, month or hour, would only warn that the line
 * needs daily bars, so its legs' facts are not asked for.
 */
export function mayDrawDailyObjective(spec: ChartSpec): boolean {
  if (hasLeverageOverlay(spec) || !priceComparisonSeriesIds(spec)) return false;
  if (spec.viewport.range === "1D" && !spec.viewport.dateWindow) return false;
  return spec.viewport.resolution === "auto" || spec.viewport.resolution === "1d";
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

/** How long a comparison waits for its legs' fund facts before it is charted without objectives. */
const DAILY_OBJECTIVES_TIMEOUT_MS = 2_500;
/** A pane draws its chart meanwhile and adds the objectives when they come. */
export const LEVERAGE_FACTS_PANE_TIMEOUT_MS = 15_000;

/**
 * Each compared fund's daily objective, from its facts. A fund whose facts
 * fail to load, or are not in by `timeoutMs`, is charted without one: the
 * comparison never waits long on them. The reads still running then are
 * aborted through the signal `loadFacts` is given, as they are when `signal`
 * (the caller's) aborts.
 */
export async function loadDailyObjectives(
  tickers: readonly string[],
  loadFacts: (ticker: string, signal: AbortSignal) => Promise<LeverageFacts | null>,
  { timeoutMs = DAILY_OBJECTIVES_TIMEOUT_MS, signal }: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<Map<string, DailyObjective>> {
  const objectives = new Map<string, DailyObjective>();
  if (tickers.length === 0) return objectives;
  const deadline = new AbortController();
  const expired = new Promise<null>((resolve) => deadline.signal.addEventListener("abort", () => resolve(null), { once: true }));
  const timer = setTimeout(() => deadline.abort(new DOMException("Fund facts took too long.", "TimeoutError")), timeoutMs);
  const cancel = () => deadline.abort(signal?.reason);
  if (signal?.aborted) cancel();
  else signal?.addEventListener("abort", cancel, { once: true });
  try {
    await Promise.all(tickers.map(async (ticker) => {
      const facts = await Promise.race([loadFacts(ticker, deadline.signal).catch(logFailure("chart-composer.leverage-overlay", "Load chart fund objective failed", null)), expired]);
      const objective = dailyObjective(facts);
      // An index fund charted beside its leveraged fund is not leveraged itself.
      if (objective && objective.proxy !== ticker) objectives.set(ticker, objective);
    }));
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
    // Reads still running are no longer waited for.
    deadline.abort();
  }
  return objectives;
}
