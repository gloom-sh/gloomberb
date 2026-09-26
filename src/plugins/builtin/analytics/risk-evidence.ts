import type { BrokerPortfolioPerformance } from "../../../types/trading";
import {
  validatePosition,
  type ScenarioPosition,
} from "../options-scenario/model";
/** Explicit local account evidence. Current positions cannot establish this history. */
export interface PerformanceObservation {
  date: string;
  value: number;
  /** Positive deposits, negative withdrawals, valued after the closing flow. */
  externalFlow: number;
}
export interface PerformanceEvidence {
  flowTiming: "end-of-day";
  externalFlowsComplete: true;
  observations: PerformanceObservation[];
}
export interface AttributionSector {
  sector: string;
  portfolioWeight: number;
  benchmarkWeight: number;
  portfolioReturn: number;
  benchmarkReturn: number;
}
export interface AttributionEvidence {
  method: "brinson-fachler";
  startDate: string;
  endDate: string;
  benchmark: string;
  sectors: AttributionSector[];
}
export interface PortfolioRiskEvidence {
  version: 1;
  portfolioId: string;
  currency: string;
  source: string;
  performance?: PerformanceEvidence;
  attribution?: AttributionEvidence;
  options?: { scope: "imported"; positions: ScenarioPosition[] };
}
const DAY = 86_400_000;
const fail = (message: string): never => {
  throw new Error(`Portfolio evidence: ${message}`);
};
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const label = (value: unknown, maximum = 200): value is string =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  value.length <= maximum;
export const evidenceDay = (value: unknown): value is string =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString().slice(0, 10) === value;
const ownKeys = (value: Record<string, unknown>, keys: string[]) => {
  const unknown = Object.keys(value).find((key) => !keys.includes(key));
  if (unknown) fail(`unknown field ${unknown}`);
};

/** Reject ambiguous dates, missing flows and partial sector books before persistence. */
export function parsePortfolioRiskEvidence(
  text: string,
  now = new Date(),
): PortfolioRiskEvidence | null {
  if (!text.trim()) return null;
  if (new TextEncoder().encode(text).byteLength > 1_000_000) return fail("input exceeds 1 MB");
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return fail("enter valid JSON");
  }
  if (!record(data)) return fail("expected an object");
  ownKeys(data, [
    "version",
    "portfolioId",
    "currency",
    "source",
    "performance",
    "attribution",
    "options",
  ]);
  if (
    data.version !== 1 ||
    !label(data.portfolioId, 100) ||
    !label(data.source) ||
    typeof data.currency !== "string" ||
    !/^[A-Z]{3}$/.test(data.currency)
  ) {
    return fail("version 1, portfolioId, currency and source are required");
  }
  const through = now.toISOString().slice(0, 10);
  const result: PortfolioRiskEvidence = {
    version: 1,
    portfolioId: data.portfolioId,
    currency: data.currency,
    source: data.source,
  };
  if (data.performance !== undefined) {
    const performance = data.performance;
    if (!record(performance)) return fail("performance must be an object");
    ownKeys(performance, [
      "flowTiming",
      "externalFlowsComplete",
      "observations",
    ]);
    if (
      performance.flowTiming !== "end-of-day" ||
      performance.externalFlowsComplete !== true
    ) {
      return fail("declare end-of-day flow timing and complete external flows");
    }
    if (
      !Array.isArray(performance.observations) ||
      performance.observations.length < 2 ||
      performance.observations.length > 10_000
    ) {
      return fail("performance requires 2 to 10,000 dated valuations");
    }
    const observations: PerformanceObservation[] = [];
    for (const [index, row] of performance.observations.entries()) {
      if (!record(row)) return fail(`valuation ${index + 1} must be an object`);
      ownKeys(row, ["date", "value", "externalFlow"]);
      if (
        !evidenceDay(row.date) ||
        row.date > through ||
        !finite(row.value) ||
        row.value <= 0 ||
        !finite(row.externalFlow)
      ) {
        return fail(
          `valuation ${index + 1} needs a valid completed date, positive NAV and explicit externalFlow`,
        );
      }
      if (index === 0 && row.externalFlow !== 0)
        return fail(
          "the opening NAV is the starting investment; its externalFlow must be zero",
        );
      if (index > 0 && row.date <= observations[index - 1]!.date)
        return fail("valuations must have strictly increasing dates");
      if (row.value - row.externalFlow <= 0)
        return fail("pre-flow NAV must be positive");
      observations.push({
        date: row.date,
        value: row.value,
        externalFlow: row.externalFlow,
      });
    }
    if (
      Date.parse(observations.at(-1)!.date) -
        Date.parse(observations[0]!.date) >
      20 * 366 * DAY
    )
      return fail("performance history exceeds 20 years");
    result.performance = {
      flowTiming: "end-of-day",
      externalFlowsComplete: true,
      observations,
    };
  }
  if (data.attribution !== undefined) {
    const attribution = data.attribution;
    if (!record(attribution)) return fail("attribution must be an object");
    ownKeys(attribution, [
      "method",
      "startDate",
      "endDate",
      "benchmark",
      "sectors",
    ]);
    if (
      attribution.method !== "brinson-fachler" ||
      !evidenceDay(attribution.startDate) ||
      !evidenceDay(attribution.endDate) ||
      attribution.startDate >= attribution.endDate ||
      attribution.endDate > through ||
      !label(attribution.benchmark, 100)
    ) {
      return fail(
        "attribution requires a benchmark and one dated Brinson-Fachler period",
      );
    }
    if (
      !Array.isArray(attribution.sectors) ||
      !attribution.sectors.length ||
      attribution.sectors.length > 100
    )
      return fail("attribution requires 1 to 100 sectors");
    const sectors: AttributionSector[] = [];
    const names = new Set<string>();
    for (const row of attribution.sectors) {
      if (!record(row)) return fail("each sector must be an object");
      ownKeys(row, [
        "sector",
        "portfolioWeight",
        "benchmarkWeight",
        "portfolioReturn",
        "benchmarkReturn",
      ]);
      if (!label(row.sector, 100) || names.has(row.sector.trim().toUpperCase()))
        return fail("sector names must be nonempty and unique");
      for (const field of ["portfolioWeight", "benchmarkWeight"] as const) {
        if (!finite(row[field]) || row[field] < 0 || row[field] > 1)
          return fail(`${row.sector}: ${field} must be a fraction from 0 to 1`);
      }
      for (const field of ["portfolioReturn", "benchmarkReturn"] as const) {
        if (!finite(row[field]) || row[field] < -1)
          return fail(
            `${row.sector}: ${field} must be a fractional return at least -1`,
          );
      }
      names.add(row.sector.trim().toUpperCase());
      sectors.push({
        sector: row.sector.trim(),
        portfolioWeight: row.portfolioWeight as number,
        benchmarkWeight: row.benchmarkWeight as number,
        portfolioReturn: row.portfolioReturn as number,
        benchmarkReturn: row.benchmarkReturn as number,
      });
    }
    for (const field of ["portfolioWeight", "benchmarkWeight"] as const) {
      if (
        Math.abs(sectors.reduce((sum, row) => sum + row[field], 0) - 1) > 1e-8
      )
        return fail(
          `${field} must sum to 1, including cash and unclassified sectors`,
        );
    }
    result.attribution = {
      method: "brinson-fachler",
      startDate: attribution.startDate,
      endDate: attribution.endDate,
      benchmark: attribution.benchmark,
      sectors,
    };
  }
  if (data.options !== undefined) {
    const options = data.options;
    if (!record(options)) return fail("options must be an object");
    ownKeys(options, ["scope", "positions"]);
    if (
      options.scope !== "imported" ||
      !Array.isArray(options.positions) ||
      !options.positions.length ||
      options.positions.length > 32
    )
      return fail(
        "declare imported options with 1 to 32 OSA position snapshots",
      );
    const positions: ScenarioPosition[] = [];
    for (const value of options.positions) {
      if (!record(value)) return fail("option snapshot must be an object");
      ownKeys(value, [
        "symbol",
        "exchange",
        "currency",
        "spot",
        "rate",
        "dividendYield",
        "asOf",
        "legs",
      ]);
      const position = value as unknown as ScenarioPosition;
      const error = validatePosition(position);
      if (error) return fail(error);
      if (
        position.currency !== result.currency ||
        position.asOf > now.getTime()
      )
        return fail(
          "option snapshot currency and date must match the evidence",
        );
      for (const leg of position.legs)
        ownKeys(leg as unknown as Record<string, unknown>, [
          "id",
          "side",
          "quantity",
          "strike",
          "expiration",
          "price",
          "volatility",
          "multiplier",
        ]);
      positions.push({
        ...position,
        legs: position.legs.map((leg) => ({ ...leg })),
      });
    }
    result.options = { scope: "imported", positions };
  }
  if (!result.performance && !result.attribution && !result.options)
    return fail("provide performance, attribution or option evidence");
  return result;
}

export interface AccountReturnPoint {
  date: string;
  return: number | null;
  wealth: number;
  drawdown: number;
}
export interface AccountPerformance {
  startDate: string;
  endDate: string;
  twr: number;
  mwr: number | null;
  mwrReason: string | null;
  maxDrawdown: number;
  netFlows: number;
  points: AccountReturnPoint[];
}

/** Actual/365 XIRR, restricted to conventional flows so the root is unique. */
export function moneyWeightedReturn(
  observations: readonly PerformanceObservation[],
): { value: number | null; reason: string | null } {
  if (observations.length < 2)
    return {
      value: null,
      reason: "At least two dated NAV observations are required.",
    };
  const first = observations[0]!,
    last = observations.at(-1)!;
  const flows = new Map<string, number>([[first.date, -first.value]]);
  for (const row of observations.slice(1))
    flows.set(row.date, (flows.get(row.date) ?? 0) - row.externalFlow);
  flows.set(last.date, (flows.get(last.date) ?? 0) + last.value);
  const cash = [...flows]
    .sort(([a], [b]) => a.localeCompare(b))
    .filter(([, value]) => value !== 0);
  let changes = 0;
  for (let index = 1; index < cash.length; index++)
    if (Math.sign(cash[index]![1]) !== Math.sign(cash[index - 1]![1]))
      changes++;
  if (changes !== 1 || cash[0]?.[1]! >= 0 || cash.at(-1)?.[1]! <= 0) {
    return {
      value: null,
      reason:
        "Cashflow signs can admit multiple IRRs; no arbitrary root is selected.",
    };
  }
  const start = Date.parse(first.date),
    scale = Math.max(...cash.map(([, amount]) => Math.abs(amount)));
  const terms = cash.map(([date, amount]) => ({
    years: (Date.parse(date) - start) / (365 * DAY),
    amount: amount / scale,
  }));
  const npv = (logRate: number) =>
    terms.reduce(
      (sum, row) => sum + row.amount * Math.exp(-logRate * row.years),
      0,
    );
  let low = Math.log(0.0001),
    high = Math.log(101);
  const lower = npv(low),
    upper = npv(high);
  if (
    !Number.isFinite(lower) ||
    !Number.isFinite(upper) ||
    lower < 0 ||
    upper > 0
  ) {
    return {
      value: null,
      reason:
        "No unique annualized MWR in the supported -99.99% to 10,000% range.",
    };
  }
  for (let iteration = 0; iteration < 160; iteration++) {
    const middle = (low + high) / 2;
    if (npv(middle) > 0) low = middle;
    else high = middle;
  }
  return { value: Math.expm1((low + high) / 2), reason: null };
}

export function calculateAccountPerformance(
  evidence: PerformanceEvidence,
): AccountPerformance {
  const rows = evidence.observations;
  let wealth = 1,
    peak = 1,
    maxDrawdown = 0;
  const points: AccountReturnPoint[] = [
    { date: rows[0]!.date, return: null, wealth, drawdown: 0 },
  ];
  for (let index = 1; index < rows.length; index++) {
    const row = rows[index]!,
      prior = rows[index - 1]!;
    const gain = (row.value - row.externalFlow) / prior.value;
    wealth *= gain;
    if (!Number.isFinite(wealth) || wealth <= 0)
      return fail("linked return exceeds the supported numeric range");
    peak = Math.max(peak, wealth);
    const drawdown = wealth / peak - 1;
    maxDrawdown = Math.min(maxDrawdown, drawdown);
    points.push({ date: row.date, return: gain - 1, wealth, drawdown });
  }
  const mwr = moneyWeightedReturn(rows);
  return {
    startDate: rows[0]!.date,
    endDate: rows.at(-1)!.date,
    twr: wealth - 1,
    mwr: mwr.value,
    mwrReason: mwr.reason,
    maxDrawdown,
    netFlows: rows.slice(1).reduce((sum, row) => sum + row.externalFlow, 0),
    points,
  };
}

export function calculateBrinson(evidence: AttributionEvidence) {
  const portfolioReturn = evidence.sectors.reduce(
    (sum, row) => sum + row.portfolioWeight * row.portfolioReturn,
    0,
  );
  const benchmarkReturn = evidence.sectors.reduce(
    (sum, row) => sum + row.benchmarkWeight * row.benchmarkReturn,
    0,
  );
  const rows = evidence.sectors.map((row) => {
    const allocation =
      (row.portfolioWeight - row.benchmarkWeight) *
      (row.benchmarkReturn - benchmarkReturn);
    const selection =
      row.benchmarkWeight * (row.portfolioReturn - row.benchmarkReturn);
    const interaction =
      (row.portfolioWeight - row.benchmarkWeight) *
      (row.portfolioReturn - row.benchmarkReturn);
    return {
      ...row,
      allocation,
      selection,
      interaction,
      total: allocation + selection + interaction,
    };
  });
  const sum = (key: "allocation" | "selection" | "interaction" | "total") =>
    rows.reduce((total, row) => total + row[key], 0);
  return {
    startDate: evidence.startDate,
    endDate: evidence.endDate,
    benchmark: evidence.benchmark,
    portfolioReturn,
    benchmarkReturn,
    activeReturn: portfolioReturn - benchmarkReturn,
    allocation: sum("allocation"),
    selection: sum("selection"),
    interaction: sum("interaction"),
    reconciliationError: sum("total") - (portfolioReturn - benchmarkReturn),
    rows,
  };
}

/**
 * Performance evidence from the broker's own history, for a portfolio with no
 * imported evidence. Only a series whose external flows are known (reported by
 * the broker, or implied from its time-weighted return) qualifies, and it runs
 * through the same validation as imported JSON.
 */
export function brokerPerformanceEvidence(
  portfolio: { id: string; currency: string },
  performance: BrokerPortfolioPerformance | null,
  now = new Date(),
): PortfolioRiskEvidence | null {
  if (!performance?.flowBasis || performance.measure === "MWR") return null;
  if (performance.currency && performance.currency !== portfolio.currency) return null;
  const points = [...performance.points].sort((left, right) => left.date.localeCompare(right.date));
  const observations: PerformanceObservation[] = [];
  for (const [index, point] of points.entries()) {
    if (!finite(point.value) || (index > 0 && !finite(point.externalFlow))) return null;
    observations.push({ date: point.date, value: point.value, externalFlow: index === 0 ? 0 : point.externalFlow! });
  }
  try {
    return parsePortfolioRiskEvidence(JSON.stringify({
      version: 1,
      portfolioId: portfolio.id,
      currency: portfolio.currency,
      source: performance.flowBasis === "derived" ? "Account history, implied flows" : "Account history",
      performance: { flowTiming: "end-of-day", externalFlowsComplete: true, observations },
    }), now);
  } catch {
    return null;
  }
}
