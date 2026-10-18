import {
  historyStatistics,
  type HistoryStatistics,
} from "../../../components/chart/curve/model";
import type { DatedReturn } from "./metrics";

export interface RiskSamplePoint extends DatedReturn {
  benchmark: number;
}
export interface RiskStatistic {
  id: string;
  label: string;
  value: number | null;
  unit: "%" | "beta" | "ratio";
  asOf: string | null;
  startDate: string | null;
  samples: number;
  rank: HistoryStatistics;
  history: Array<{ date: string; value: number | null }>;
}
const RISK_WINDOW = 60;
const interval = (point: DatedReturn) =>
  `${point.startDateKey}/${point.dateKey}`;
const valid = (point: DatedReturn) =>
  point.startDateKey < point.dateKey &&
  Number.isFinite(point.value) &&
  point.value > -1;
export const compoundReturns = (values: readonly number[]) =>
  values.reduce((wealth, value) => wealth * (1 + value), 1) - 1;
function drawdownPath(values: readonly number[]) {
  let wealth = 1,
    peak = 1;
  return values.map((value) => {
    wealth *= 1 + value;
    peak = Math.max(peak, wealth);
    return wealth / peak - 1;
  });
}
function sampleVolatility(values: readonly number[]): number | null {
  if (values.length < 2) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return (
    Math.sqrt(
      values.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
        (values.length - 1),
    ) * Math.sqrt(252)
  );
}
/** Nearest-rank historical loss, without distribution or square-root horizon assumptions. */
export function historicalTail(
  values: readonly number[],
  confidence = 0.95,
): { var: number; expectedShortfall: number } | null {
  if (
    values.length < 60 ||
    confidence <= 0 ||
    confidence >= 1 ||
    values.some((value) => !Number.isFinite(value))
  )
    return null;
  const sorted = [...values].sort((a, b) => a - b);
  // Roundoff must not move an exact 5% boundary from the third to fourth observation.
  const count = Math.max(
    1,
    Math.ceil(values.length * (1 - confidence) - 1e-10),
  );
  const tail = sorted.slice(0, count);
  return {
    var: Math.max(0, -tail.at(-1)!),
    expectedShortfall: Math.max(
      0,
      -tail.reduce((sum, value) => sum + value, 0) / tail.length,
    ),
  };
}
export interface Regression {
  beta: number;
  intercept: number;
  correlation: number | null;
  rSquared: number | null;
  samples: number;
  startDate: string;
  asOf: string;
}
/**
 * A series is indexed once by interval: the correlation view regresses each
 * basket holding against every other, and rolling betas reuse one factor for
 * every window. Return series are never mutated after they are built.
 */
const intervalIndex = new WeakMap<readonly DatedReturn[], Map<string, number>>();
function byInterval(series: readonly DatedReturn[]): Map<string, number> {
  let index = intervalIndex.get(series);
  if (!index) {
    index = new Map(
      series
        .filter(
          (point) =>
            point.startDateKey < point.dateKey && Number.isFinite(point.value),
        )
        .map((point) => [interval(point), point.value]),
    );
    intervalIndex.set(series, index);
  }
  return index;
}
/** Matched start and end dates prevent pairing a multi-session return with a daily one. */
export function regressReturns(
  asset: readonly DatedReturn[],
  factor: readonly DatedReturn[],
  minimum = 60,
): Regression | null {
  const other = byInterval(factor);
  const sample: DatedReturn[] = [],
    x: number[] = [],
    y: number[] = [];
  for (const point of asset) {
    if (!valid(point)) continue;
    const matched = other.get(interval(point));
    if (matched === undefined) continue;
    sample.push(point);
    x.push(matched);
    y.push(point.value);
  }
  if (sample.length < minimum) return null;
  const meanX = x.reduce((a, b) => a + b, 0) / x.length,
    meanY = y.reduce((a, b) => a + b, 0) / y.length;
  let xx = 0,
    yy = 0,
    xy = 0;
  for (let index = 0; index < x.length; index++) {
    const dx = x[index]! - meanX,
      dy = y[index]! - meanY;
    xx += dx * dx;
    yy += dy * dy;
    xy += dx * dy;
  }
  if (xx <= 1e-20) return null;
  const correlation =
    yy <= 1e-20 ? null : Math.max(-1, Math.min(1, xy / Math.sqrt(xx * yy)));
  return {
    beta: xy / xx,
    intercept: meanY - (xy / xx) * meanX,
    correlation,
    rSquared: correlation == null ? null : correlation ** 2,
    samples: sample.length,
    startDate: sample[0]!.startDateKey,
    asOf: sample.at(-1)!.dateKey,
  };
}
export function pairedReturns(
  asset: readonly DatedReturn[],
  benchmark: readonly DatedReturn[],
): RiskSamplePoint[] {
  const byDate = new Map(
    benchmark.filter(valid).map((point) => [interval(point), point.value]),
  );
  return asset
    .filter(valid)
    .filter((point) => byDate.has(interval(point)))
    .map((point) => ({ ...point, benchmark: byDate.get(interval(point))! }));
}
export function subtractReturns(
  left: readonly DatedReturn[],
  right: readonly DatedReturn[],
): DatedReturn[] {
  return pairedReturns(left, right).map((point) => ({
    startDateKey: point.startDateKey,
    dateKey: point.dateKey,
    value: point.value - point.benchmark,
  }));
}

const percentile = (
  history: RiskStatistic["history"],
  current: number | null,
  asOf: string | null,
) => {
  const result = historyStatistics(history, current, {
    asOf: asOf ?? "1970-01-01",
    windowDays: 365,
  });
  return {
    ...result,
    percentile: result.count >= 20 ? result.percentile : null,
    rank: result.count >= 20 ? result.rank : null,
  };
};

/** The return and risk statistics of a basket against its benchmark, over one window of paired sessions. */
function basketRiskDefinitions(benchmark: string) {
  return [
    {
      id: "return",
      name: "basket return",
      value: (rows: RiskSamplePoint[]) =>
        100 * compoundReturns(rows.map((row) => row.value)),
    },
    {
      id: "benchmark",
      name: `benchmark return (${benchmark})`,
      value: (rows: RiskSamplePoint[]) =>
        100 * compoundReturns(rows.map((row) => row.benchmark)),
    },
    {
      id: "active",
      name: "active return",
      value: (rows: RiskSamplePoint[]) =>
        100 *
        (compoundReturns(rows.map((row) => row.value)) -
          compoundReturns(rows.map((row) => row.benchmark))),
    },
    {
      id: "volatility",
      name: "annualized volatility",
      value: (rows: RiskSamplePoint[]) => {
        const volatility = sampleVolatility(rows.map((row) => row.value));
        return volatility == null ? null : 100 * volatility;
      },
    },
    {
      id: "drawdown",
      name: "max drawdown",
      value: (rows: RiskSamplePoint[]) =>
        100 * Math.min(0, ...drawdownPath(rows.map((row) => row.value))),
    },
    {
      id: "var",
      name: "1D VaR 95%",
      value: (rows: RiskSamplePoint[]) => {
        const tail = historicalTail(rows.map((row) => row.value));
        return tail == null ? null : 100 * tail.var;
      },
    },
    {
      id: "es",
      name: "1D expected shortfall",
      value: (rows: RiskSamplePoint[]) => {
        const tail = historicalTail(rows.map((row) => row.value));
        return tail == null ? null : 100 * tail.expectedShortfall;
      },
    },
    {
      id: "tracking",
      name: "tracking error",
      value: (rows: RiskSamplePoint[]) => {
        const volatility = sampleVolatility(rows.map((row) => row.value - row.benchmark));
        return volatility == null ? null : 100 * volatility;
      },
    },
  ];
}
const TAIL_IDS = new Set(["var", "es"]);
const finiteOrNull = (value: number | null) =>
  value != null && Number.isFinite(value) ? value : null;

export function rollingBasketRisk(
  sample: readonly RiskSamplePoint[],
  window = RISK_WINDOW,
  benchmark = "SPY",
): RiskStatistic[] {
  if (!Number.isInteger(window) || window < 60)
    throw new Error("Risk window must contain at least 60 daily sessions");
  return basketRiskDefinitions(benchmark).map((definition) => {
    const history = sample.map((point, index) => {
      const rows = sample.slice(index - window + 1, index + 1);
      const contiguous =
        index >= window - 1 &&
        rows.every(
          (row, i) => i === 0 || row.startDateKey === rows[i - 1]!.dateKey,
        );
      return {
        date: point.dateKey,
        value: contiguous ? finiteOrNull(definition.value(rows)) : null,
      };
    });
    const latest = history.at(-1),
      value = latest?.value ?? null,
      asOf = latest?.date ?? null;
    return {
      id: definition.id,
      label: TAIL_IDS.has(definition.id)
        ? `${definition.name} (${window}D)`
        : `${window}D ${definition.name}`,
      value,
      unit: "%" as const,
      asOf,
      startDate:
        value == null ? null : (sample.at(-window)?.startDateKey ?? null),
      samples: value == null ? 0 : window,
      rank: percentile(history, value, asOf),
      history,
    };
  });
}

/**
 * The same statistics over every paired session since `since` (a 13F filing
 * date), measured from the last close on or before it: the trailing
 * contiguous run of sessions that end after that day. Each row's history is
 * the statistic as of each session in the run; there is no rolling sample to
 * rank it against, so it has no percentile. VaR and expected shortfall need
 * 60 sessions.
 */
export function sinceBasketRisk(
  sample: readonly RiskSamplePoint[],
  since: string,
  benchmark = "SPY",
): RiskStatistic[] {
  let first = sample.length;
  while (
    first > 0 &&
    sample[first - 1]!.dateKey > since &&
    (first === sample.length || sample[first]!.startDateKey === sample[first - 1]!.dateKey)
  )
    first -= 1;
  const rows = sample.slice(first);
  const start = rows[0]?.startDateKey ?? since;
  const capitalized = (text: string) => `${text[0]!.toUpperCase()}${text.slice(1)}`;
  return basketRiskDefinitions(benchmark).map((definition) => {
    const history = rows.map((point, index) => ({
      date: point.dateKey,
      value: finiteOrNull(definition.value(rows.slice(0, index + 1))),
    }));
    const value = history.at(-1)?.value ?? null,
      asOf = rows.at(-1)?.dateKey ?? null;
    return {
      id: definition.id,
      label: TAIL_IDS.has(definition.id)
        ? `${definition.name} (since ${start})`
        : `${capitalized(definition.name)} since ${start}`,
      value,
      unit: "%" as const,
      asOf,
      startDate: rows.length ? start : null,
      // The sessions in the window, also when too few for a value (a tail estimate needs 60).
      samples: rows.length,
      rank: { ...historyStatistics([], value, { asOf: asOf ?? since }), percentile: null, rank: null },
      history,
    };
  });
}

/** A held basket's daily returns, and why it stops or leaves a holding out when it does. */
export interface HeldBasket {
  returns: DatedReturn[];
  /**
   * Set when the basket ends before the last session: the holding (its index
   * in the input) whose daily closes end first, and the day they end.
   */
  cutShort: { holding: number; date: string } | null;
  /** Holdings with no close on or before `since`, which cannot be bought at it and are left out. */
  unpriced: number[];
}

/**
 * Daily returns of a basket bought at the close on or before `since` (a 13F
 * filing date) at `weights` and held: each holding's share drifts with its
 * price, nothing is rebalanced. The basket is valued at every session of
 * `calendar` (the benchmark's, so the two pair; the holdings' own dates when
 * left out). A holding with no close for a session (a halt, a missing bar)
 * holds its value flat, and its multi-day return lands on the session it
 * arrives. The basket ends where the first holding's closes end, and says
 * which.
 */
export function buyAndHoldReturns(
  holdings: readonly { weight: number; returns: readonly DatedReturn[] }[],
  since: string,
  calendar?: readonly DatedReturn[],
): HeldBasket {
  const unpriced: number[] = [];
  // Each holding's price relative to its start close, by date, along its own unbroken run of closes.
  const paths = holdings.flatMap((row, index) => {
    if (!Number.isFinite(row.weight) || row.weight <= 0) return [];
    const points = row.returns
      .filter((point) => valid(point) && point.dateKey > since)
      .toSorted((left, right) => left.dateKey.localeCompare(right.dateKey));
    if (!points.length || points[0]!.startDateKey > since) {
      unpriced.push(index);
      return [];
    }
    const levels: Array<{ date: string; level: number }> = [];
    let level = 1;
    for (const [at, point] of points.entries()) {
      if (at > 0 && point.startDateKey !== points[at - 1]!.dateKey) break;
      level *= 1 + point.value;
      levels.push({ date: point.dateKey, level });
    }
    return [{ index, weight: row.weight, start: points[0]!.startDateKey, levels }];
  });
  if (!paths.length) return { returns: [], cutShort: null, unpriced };
  const sessions = (calendar
    ? calendar.filter((point) => valid(point) && point.dateKey > since).map((point) => point.dateKey)
    : [...new Set(paths.flatMap((path) => path.levels.map((point) => point.date)))]
  ).toSorted();
  // Known up to the earliest last close: past it a holding's value is unknown, not flat.
  const last = paths.reduce((first, path) => (path.levels.at(-1)!.date < first.levels.at(-1)!.date ? path : first));
  const end = last.levels.at(-1)!.date;
  const total = paths.reduce((sum, path) => sum + path.weight, 0);
  // The close the basket is bought at: the latest start close among the holdings.
  const bought = paths.reduce((latest, path) => (path.start > latest ? path.start : latest), "");
  const cursor = paths.map(() => -1);
  const returns: DatedReturn[] = [];
  let previous = { date: since, value: 1 };
  for (const date of sessions) {
    if (date > end) break;
    let value = 0;
    for (const [at, path] of paths.entries()) {
      let next = cursor[at]!;
      while (next + 1 < path.levels.length && path.levels[next + 1]!.date <= date) next += 1;
      cursor[at] = next;
      value += (path.weight / total) * (next < 0 ? 1 : path.levels[next]!.level);
    }
    const start = returns.length ? previous.date
      : (calendar?.find((point) => point.dateKey === date)?.startDateKey ?? bought);
    returns.push({ startDateKey: start, dateKey: date, value: value / previous.value - 1 });
    previous = { date, value };
  }
  const lastSession = sessions.at(-1);
  return {
    returns,
    cutShort: lastSession && end < lastSession ? { holding: last.index, date: end } : null,
    unpriced,
  };
}

export function rollingBeta(
  asset: readonly DatedReturn[],
  factor: readonly DatedReturn[],
  label: string,
  id: string,
): RiskStatistic {
  const history = asset.map((point, index) => {
    const rows = asset.slice(Math.max(0, index - RISK_WINDOW + 1), index + 1);
    const contiguous = rows.every(
      (row, i) => i === 0 || row.startDateKey === rows[i - 1]!.dateKey,
    );
    return {
      date: point.dateKey,
      value: contiguous ? (regressReturns(rows, factor)?.beta ?? null) : null,
    };
  });
  const latest = history.at(-1),
    value = latest?.value ?? null,
    asOf = latest?.date ?? null;
  const sample = regressReturns(asset.slice(-RISK_WINDOW), factor);
  return {
    id,
    label,
    value,
    unit: "beta",
    asOf,
    startDate: sample?.startDate ?? null,
    samples: sample?.samples ?? 0,
    rank: percentile(history, value, asOf),
    history,
  };
}

export function concentration(
  values: readonly { id: string; value: number | null }[],
) {
  if (
    !values.length ||
    values.some((row) => row.value == null || !Number.isFinite(row.value))
  )
    return null;
  const gross = values.reduce((sum, row) => sum + Math.abs(row.value!), 0);
  if (gross <= 0 || !Number.isFinite(gross)) return null;
  const rows = values
    .map((row) => ({
      id: row.id,
      value: row.value!,
      weight: Math.abs(row.value!) / gross,
    }))
    .sort((a, b) => b.weight - a.weight);
  const hhi = rows.reduce((sum, row) => sum + row.weight ** 2, 0);
  return {
    gross,
    net: rows.reduce((sum, row) => sum + row.value, 0),
    hhi,
    effectiveHoldings: 1 / hhi,
    top: rows[0]!.weight,
    topFive: rows.slice(0, 5).reduce((sum, row) => sum + row.weight, 0),
    rows,
  };
}
