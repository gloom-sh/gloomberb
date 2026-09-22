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
export const RISK_WINDOW = 60;
const interval = (point: DatedReturn) =>
  `${point.startDateKey}/${point.dateKey}`;
const valid = (point: DatedReturn) =>
  point.startDateKey < point.dateKey &&
  Number.isFinite(point.value) &&
  point.value > -1;
export const compoundReturns = (values: readonly number[]) =>
  values.reduce((wealth, value) => wealth * (1 + value), 1) - 1;
export function drawdownPath(values: readonly number[]) {
  let wealth = 1,
    peak = 1;
  return values.map((value) => {
    wealth *= 1 + value;
    peak = Math.max(peak, wealth);
    return wealth / peak - 1;
  });
}
export function sampleVolatility(values: readonly number[]): number | null {
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
/** Matched start and end dates prevent pairing a multi-session return with a daily one. */
export function regressReturns(
  asset: readonly DatedReturn[],
  factor: readonly DatedReturn[],
  minimum = 60,
): Regression | null {
  const other = new Map(
    factor
      .filter(
        (point) =>
          point.startDateKey < point.dateKey && Number.isFinite(point.value),
      )
      .map((point) => [interval(point), point.value]),
  );
  const sample = asset
    .filter(valid)
    .filter((point) => other.has(interval(point)));
  if (sample.length < minimum) return null;
  const x = sample.map((point) => other.get(interval(point))!),
    y = sample.map((point) => point.value);
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

export function rollingBasketRisk(
  sample: readonly RiskSamplePoint[],
  window = RISK_WINDOW,
): RiskStatistic[] {
  if (!Number.isInteger(window) || window < 60)
    throw new Error("Risk window must contain at least 60 daily sessions");
  const definitions = [
    {
      id: "return",
      label: `${window}D basket return`,
      value: (rows: RiskSamplePoint[]) =>
        100 * compoundReturns(rows.map((row) => row.value)),
    },
    {
      id: "benchmark",
      label: `${window}D benchmark return`,
      value: (rows: RiskSamplePoint[]) =>
        100 * compoundReturns(rows.map((row) => row.benchmark)),
    },
    {
      id: "active",
      label: `${window}D active return`,
      value: (rows: RiskSamplePoint[]) =>
        100 *
        (compoundReturns(rows.map((row) => row.value)) -
          compoundReturns(rows.map((row) => row.benchmark))),
    },
    {
      id: "volatility",
      label: `${window}D annualized volatility`,
      value: (rows: RiskSamplePoint[]) =>
        100 * sampleVolatility(rows.map((row) => row.value))!,
    },
    {
      id: "drawdown",
      label: `${window}D max drawdown`,
      value: (rows: RiskSamplePoint[]) =>
        100 * Math.min(0, ...drawdownPath(rows.map((row) => row.value))),
    },
    {
      id: "var",
      label: `1D VaR 95% (${window}D)`,
      value: (rows: RiskSamplePoint[]) =>
        100 * historicalTail(rows.map((row) => row.value))!.var,
    },
    {
      id: "es",
      label: `1D expected shortfall (${window}D)`,
      value: (rows: RiskSamplePoint[]) =>
        100 * historicalTail(rows.map((row) => row.value))!.expectedShortfall,
    },
    {
      id: "tracking",
      label: `${window}D tracking error`,
      value: (rows: RiskSamplePoint[]) =>
        100 * sampleVolatility(rows.map((row) => row.value - row.benchmark))!,
    },
  ];
  return definitions.map((definition) => {
    const history = sample.map((point, index) => {
      const rows = sample.slice(index - window + 1, index + 1);
      const contiguous =
        index >= window - 1 &&
        rows.every(
          (row, i) => i === 0 || row.startDateKey === rows[i - 1]!.dateKey,
        );
      const value = contiguous ? definition.value(rows) : null;
      return {
        date: point.dateKey,
        value: value != null && Number.isFinite(value) ? value : null,
      };
    });
    const latest = history.at(-1),
      value = latest?.value ?? null,
      asOf = latest?.date ?? null;
    return {
      id: definition.id,
      label: definition.label,
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
