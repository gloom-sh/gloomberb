import { apiClient } from "../../../api-client";
import type {
  DebtFact,
  DebtMaturitiesPayload,
  DebtMetric,
} from "../../../api-client/debt-maturities";
import { ApiRequestError } from "../../../api-client/errors";
import { createPluginCache } from "../../../data/plugin-cache";

export const debtMaturitiesCache = createPluginCache<DebtMaturitiesPayload>({
  kind: "debt-maturities",
  source: "gloom-cloud",
  schemaVersion: 1,
  policy: { staleMs: 6 * 60 * 60_000, expireMs: 14 * 24 * 60 * 60_000 },
});
export const BUCKET_IDS = [
  "InNextTwelveMonths",
  "InYearTwo",
  "InYearThree",
  "InYearFour",
  "InYearFive",
  "AfterYearFive",
] as const;
const number = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const nullableNumber = (value: unknown) => value === null || number(value);
const day = (value: unknown): value is string =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString().slice(0, 10) === value;
const nullableDay = (value: unknown) => value === null || day(value);
const annualPeriod = (start: string, end: string) => {
  const days = (Date.parse(end) - Date.parse(start)) / 86_400_000 + 1;
  return days >= 350 && days <= 380;
};
const accession = (value: unknown) =>
  typeof value === "string" && /^\d{10}-\d{2}-\d{6}$/.test(value);
const textOrNull = (value: unknown) =>
  value === null || typeof value === "string";
const currency = (value: unknown) =>
  typeof value === "string" && /^[A-Z]{3}$/.test(value);
const sourceUrl = (value: unknown) =>
  typeof value === "string" &&
  /^https:\/\/(?:www\.|data\.)?sec\.gov\//.test(value);
const near = (a: number | null, b: number | null) =>
  a === b ||
  (a !== null &&
    b !== null &&
    Math.abs(a - b) <= Math.max(1, Math.abs(b)) * 1e-8);

function validFact(fact: DebtFact): boolean {
  return (
    !!fact &&
    number(fact.value) &&
    typeof fact.tag === "string" &&
    !!fact.tag &&
    currency(fact.unit) &&
    nullableDay(fact.start) &&
    day(fact.end) &&
    day(fact.filed) &&
    fact.end <= fact.filed &&
    (fact.start === null || fact.start <= fact.end) &&
    accession(fact.accession) &&
    /^(10-K|20-F)(\/A)?$/.test(fact.form)
  );
}
function validMetric(
  metric: DebtMetric,
  latest: NonNullable<DebtMaturitiesPayload["latest"]>,
  unit: string,
): boolean {
  if (
    !metric ||
    !nullableNumber(metric.value) ||
    metric.unit !== unit ||
    metric.asOf !== latest.asOf ||
    metric.filed !== latest.filed
  )
    return false;
  const p = metric.percentile;
  return (
    !!p &&
    nullableNumber(p.value) &&
    (p.value === null || p.value <= 100) &&
    nullableNumber(p.rank) &&
    Number.isInteger(p.sampleCount) &&
    p.sampleCount >= 0 &&
    p.minimumSamples === 5 &&
    (p.value === null ||
      (metric.value !== null && p.sampleCount >= p.minimumSamples)) &&
    [p.min, p.max, p.mean].every(nullableNumber) &&
    day(p.windowStart) &&
    p.windowEnd === latest.asOf &&
    p.windowStart <= p.windowEnd &&
    nullableDay(p.historyStart) &&
    nullableDay(p.historyEnd) &&
    (p.historyStart === null || p.historyStart >= p.windowStart) &&
    (p.historyEnd === null || p.historyEnd <= p.windowEnd)
  );
}

/** Reject mixed filing/currency cohorts and preserve absent principal as null. */
export function validateDebtMaturities(
  data: DebtMaturitiesPayload,
  symbol: string,
): DebtMaturitiesPayload {
  const invalid = (): never => {
    throw new Error("Gloom Cloud returned an invalid debt maturity schedule");
  };
  if (
    !data ||
    data.version !== 1 ||
    data.symbol !== symbol ||
    !["available", "partial", "unavailable"].includes(data.status) ||
    !textOrNull(data.entityName) ||
    !["us-gaap", null].includes(data.taxonomy) ||
    !(
      data.cik === null ||
      (typeof data.cik === "string" && /^\d{10}$/.test(data.cik))
    ) ||
    typeof data.fetchedAt !== "string" ||
    !Number.isFinite(Date.parse(data.fetchedAt)) ||
    !nullableDay(data.asOf) ||
    !data.source ||
    typeof data.source.name !== "string" ||
    !sourceUrl(data.source.url) ||
    typeof data.source.cadence !== "string" ||
    !Array.isArray(data.warnings) ||
    data.warnings.some((value) => typeof value !== "string") ||
    !Array.isArray(data.history)
  )
    return invalid();
  const latest = data.latest;
  if (latest === null) {
    if (
      data.asOf !== null ||
      data.status !== "unavailable" ||
      data.history.length
    )
      return invalid();
    return data;
  }
  if (
    !latest ||
    data.status === "unavailable" ||
    data.taxonomy !== "us-gaap" ||
    !data.cik ||
    !day(latest.asOf) ||
    latest.asOf !== data.asOf ||
    !day(latest.filed) ||
    latest.asOf > latest.filed ||
    !accession(latest.accession) ||
    !/^(10-K|20-F)(\/A)?$/.test(latest.form) ||
    !currency(latest.currency) ||
    !sourceUrl(latest.filingUrl) ||
    typeof latest.complete !== "boolean" ||
    !Array.isArray(latest.buckets) ||
    latest.buckets.length !== 6
  )
    return invalid();
  const sameFiling = (fact: DebtFact) =>
    validFact(fact) &&
    fact.accession === latest.accession &&
    fact.filed === latest.filed &&
    fact.form === latest.form &&
    fact.unit === latest.currency;
  for (const [index, bucket] of latest.buckets.entries()) {
    if (
      !bucket ||
      bucket.id !== BUCKET_IDS[index] ||
      typeof bucket.label !== "string" ||
      !nullableNumber(bucket.value) ||
      (index === 5 ? bucket.year !== null : !Number.isInteger(bucket.year)) ||
      (bucket.fact === null
        ? bucket.value !== null
        : !sameFiling(bucket.fact) ||
          bucket.fact.end !== latest.asOf ||
          bucket.fact.start !== null ||
          bucket.fact.tag !==
            `LongTermDebtMaturitiesRepaymentsOfPrincipal${bucket.id}` ||
          bucket.fact.value !== bucket.value)
    )
      return invalid();
  }
  const amountKeys = [
    "totalPrincipal",
    "next12Months",
    "next3Years",
    "interestExpense",
  ] as const;
  const percentKeys = [
    "next12MonthsShare",
    "next3YearsShare",
    "borrowingCostPercent",
  ] as const;
  if (
    amountKeys.some(
      (key) => !validMetric(latest[key], latest, latest.currency),
    ) ||
    percentKeys.some((key) => !validMetric(latest[key], latest, "%"))
  )
    return invalid();
  const sum = (values: Array<number | null>) =>
    values.every((value) => value !== null)
      ? values.reduce<number>((a, b) => a + b!, 0)
      : null;
  const values = latest.buckets.map((row) => row.value),
    total = sum(values),
    next3 = sum(values.slice(0, 3));
  const share = (value: number | null) =>
    value !== null && total !== null && total > 0
      ? (100 * value) / total
      : null;
  if (
    latest.complete !== (total !== null) ||
    !near(latest.totalPrincipal.value, total) ||
    latest.next12Months.value !== values[0] ||
    !near(latest.next3Years.value, next3) ||
    !near(latest.next12MonthsShare.value, share(values[0]!)) ||
    !near(latest.next3YearsShare.value, share(next3))
  )
    return invalid();
  const interest = latest.interestExpenseFact;
  if (
    interest === null
      ? latest.interestExpense.value !== null
      : !sameFiling(interest) ||
        interest.end !== latest.asOf ||
        !interest.start ||
        !annualPeriod(interest.start, interest.end) ||
        interest.value !== latest.interestExpense.value
  )
    return invalid();
  const cost = latest.borrowingCostEvidence;
  if (cost === null) {
    if (latest.borrowingCostPercent.value !== null) return invalid();
  } else {
    if (
      !cost ||
      !day(cost.periodStart) ||
      cost.periodEnd !== latest.asOf ||
      !sameFiling(cost.interest) ||
      cost.interest.tag !== "InterestExpenseDebt" ||
      cost.interest.start !== cost.periodStart ||
      cost.interest.end !== cost.periodEnd ||
      !annualPeriod(cost.periodStart, cost.periodEnd) ||
      !Array.isArray(cost.opening) ||
      !Array.isArray(cost.closing) ||
      cost.opening.length !== 2 ||
      cost.closing.length !== 2
    )
      return invalid();
    const openingEnd = new Date(Date.parse(cost.periodStart) - 86_400_000)
      .toISOString()
      .slice(0, 10);
    for (const [index, facts] of [cost.opening, cost.closing].entries()) {
      if (
        facts.some(
          (fact) =>
            !sameFiling(fact) ||
            fact.start !== null ||
            fact.end !== (index ? latest.asOf : openingEnd),
        ) ||
        facts[0]!.tag !== "LongTermDebt" ||
        !["ShortTermBorrowings", "CommercialPaper"].includes(facts[1]!.tag)
      )
        return invalid();
    }
    const average =
      [...cost.opening, ...cost.closing].reduce(
        (sum, fact) => sum + fact.value,
        0,
      ) / 2;
    if (
      cost.opening[1]!.tag !== cost.closing[1]!.tag ||
      average <= 0 ||
      !near(cost.value, (100 * cost.interest.value) / average) ||
      !near(latest.borrowingCostPercent.value, cost.value)
    )
      return invalid();
  }
  for (const [index, point] of data.history.entries()) {
    if (
      !point ||
      !day(point.asOf) ||
      !day(point.filed) ||
      point.asOf > point.filed ||
      !accession(point.accession) ||
      point.currency !== latest.currency ||
      typeof point.complete !== "boolean" ||
      [...amountKeys, ...percentKeys].some(
        (key) => !nullableNumber(point[key]),
      ) ||
      !textOrNull(point.interestExpenseTag) ||
      !textOrNull(point.borrowingCostDebtTags) ||
      point.complete !== (point.totalPrincipal !== null) ||
      point.asOf > latest.asOf ||
      (index > 0 && point.asOf <= data.history[index - 1]!.asOf)
    )
      return invalid();
  }
  const last = data.history.at(-1);
  if (
    !last ||
    last.asOf !== latest.asOf ||
    last.filed !== latest.filed ||
    last.accession !== latest.accession ||
    [...amountKeys, ...percentKeys].some(
      (key) => !near(last[key], latest[key].value),
    )
  )
    return invalid();
  return data;
}

export async function fetchDebtMaturities(
  symbol: string,
  client: Pick<typeof apiClient, "getCloudDebtMaturities"> = apiClient,
) {
  try {
    return validateDebtMaturities(
      await client.getCloudDebtMaturities(symbol),
      symbol,
    );
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 404)
      throw new Error(
        "Debt maturities are not available on this Gloom Cloud server yet",
      );
    throw error;
  }
}
export interface DebtResource {
  payload: DebtMaturitiesPayload;
  stale: boolean;
  refreshError: string | null;
}
export function cachedDebtMaturities(symbol: string): DebtResource | null {
  const cached = debtMaturitiesCache.get(symbol, { allowExpired: true });
  if (!cached) return null;
  try {
    return {
      payload: validateDebtMaturities(cached.data, symbol),
      stale: cached.stale,
      refreshError: null,
    };
  } catch {
    return null;
  }
}
export async function loadDebtMaturities(
  symbol: string,
  force = false,
): Promise<DebtResource> {
  const result = await debtMaturitiesCache.load(
    symbol,
    () => fetchDebtMaturities(symbol),
    { force },
  );
  if (
    result.error instanceof ApiRequestError &&
    [401, 403].includes(result.error.status ?? 0)
  )
    throw result.error;
  return {
    payload: validateDebtMaturities(result.data, symbol),
    stale: result.stale,
    refreshError: result.refreshError ?? null,
  };
}
