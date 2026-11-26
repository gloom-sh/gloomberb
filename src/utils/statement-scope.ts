import type { FinancialStatement, Fundamentals, Quote, StatementScope, TickerFinancials } from "../types/financials";
import { completeAvailability, financialAvailabilityTime, statementFieldAvailability, statementPeriodMonths } from "./financial-statements";
import { reportedEarnings } from "./trailing-eps";

export function listingOwnsRow(scope: StatementScope | undefined, row: FinancialStatement): boolean {
  if (!scope) return !row.statementScope;
  return scope.basis === "standalone" && !!scope.entity && row.statementScope?.basis === "standalone"
    && row.statementScope.entity === scope.entity && row.statementScope.registrant === scope.registrant;
}

export function listingOwnsSeries(data: Pick<TickerFinancials, "statementScope" | "quarterlyStatements" | "annualStatements">): boolean {
  const owned = (row: FinancialStatement) => listingOwnsRow(data.statementScope, row);
  return (!data.statementScope || data.statementScope.basis === "standalone")
    && data.annualStatements.every(owned) && data.quarterlyStatements.every(owned);
}

type ScopedEarnings = NonNullable<Fundamentals["scopedEarnings"]>;

const DAY_MS = 86_400_000;

function spansDays(start: string, end: string, min: number, max: number): boolean {
  const days = (Date.parse(end) - Date.parse(start)) / DAY_MS + 1;
  return days >= min && days <= max;
}

function completeQuarterWindow(rows: FinancialStatement[], end: string): boolean {
  if (rows.length !== 4 || rows[3]!.date !== end) return false;
  const firstStart = rows[0]!.dateEvidence?.startDate;
  return (firstStart === undefined || spansDays(firstStart, end, 350, 380)) && rows.every((row, index) => {
    if (row.shareBasis !== rows[0]!.shareBasis || (statementPeriodMonths(row) ?? 3) !== 3) return false;
    const start = row.dateEvidence?.startDate;
    if (start !== undefined && !spansDays(start, row.date, 77, 105)) return false;
    if (index === 0) return true;
    const previousEnd = Date.parse(rows[index - 1]!.date);
    const days = (Date.parse(row.date) - previousEnd) / DAY_MS;
    return days >= 77 && days <= 105 && (start === undefined || Date.parse(start) === previousEnd + DAY_MS);
  });
}

function sumFiledDecimals(values: number[]): number {
  if (values.length === 1) return values[0]!;
  const terms = values.map(value => {
    const [digits, exponent] = value.toExponential().split("e");
    const places = digits!.split(".")[1]?.length ?? 0;
    return { units: BigInt(digits!.replace(".", "")), power: Number(exponent) - places };
  });
  const power = Math.min(...terms.map(term => term.power));
  const units = terms.reduce((sum, term) => sum + term.units * 10n ** BigInt(term.power - power), 0n);
  return Number(`${units}e${power}`);
}

export function dateScopedEarnings(data: Pick<TickerFinancials, "statementScope" | "statementReview" | "annualStatements" | "quarterlyStatements">,
  earnings: Omit<ScopedEarnings, "epsAvailableAt"> | null | undefined): ScopedEarnings | null {
  const reviewedThrough = data.statementReview?.reviewedThrough;
  if (data.statementScope?.basis !== "standalone" || !earnings || !Number.isFinite(earnings.eps) || !/^[A-Z]{3}$/.test(earnings.currency)
    || !reviewedThrough || !listingOwnsSeries(data)) return null;
  const { eps, currency, periodEnd, priced } = earnings;
  const quarters = data.quarterlyStatements.filter(row => row.date <= periodEnd)
    .sort((first, second) => first.date.localeCompare(second.date)).slice(-4);
  const candidates = data.annualStatements.filter(row => row.date === periodEnd
    && (row.dateEvidence?.startDate === undefined || spansDays(row.dateEvidence.startDate, periodEnd, 350, 380))).map(row => [row]);
  if (completeQuarterWindow(quarters, periodEnd)) candidates.push(quarters);
  const admittedTotals = new Set([eps]);
  const totals = candidates.flatMap(rows => {
    if (!rows.every(row => row.currency === currency && reportedEarnings(row, "eps") !== null)) return [];
    const values = rows.map(row => row.eps!);
    const total = sumFiledDecimals(values);
    if (!Number.isFinite(total)) return [];
    const roundoff = values.length * values.reduce((bound, value) => bound + Number.EPSILON * Math.abs(value), 0);
    if (values.reduce((sum, value) => sum + value, 0) === eps && Math.abs(total - eps) <= roundoff) admittedTotals.add(total);
    return [{ rows, total }];
  });
  const matchingInputs = totals.filter(({ total }) => admittedTotals.has(total)).flatMap(({ rows }) => rows);
  const epsAvailableAt = completeAvailability(matchingInputs.map(row => {
    const available = statementFieldAvailability(row, "eps");
    return available && Date.parse(available) >= Date.parse(row.date) ? available : undefined;
  }));
  return epsAvailableAt && Date.parse(epsAvailableAt) >= Date.parse(periodEnd) && financialAvailabilityTime(epsAvailableAt) <= financialAvailabilityTime(reviewedThrough)
    ? { eps, currency, periodEnd, epsAvailableAt, priced }
    : null;
}

export function captureScopedEarnings(data: TickerFinancials): TickerFinancials {
  if (!data.statementScope || !data.fundamentals) return data;
  const { eps, epsCurrency, trailingPeriodEnd, trailingPE } = data.fundamentals;
  const scopedEarnings = typeof eps === "number" && epsCurrency && trailingPeriodEnd ? dateScopedEarnings(data, { eps, currency: epsCurrency,
    periodEnd: trailingPeriodEnd, priced: typeof trailingPE === "number" && Number.isFinite(trailingPE) && trailingPE > 0 }) : null;
  return { ...data, fundamentals: priceScopedEarnings({ ...data.fundamentals, scopedEarnings },
    data.quote?.price, data.quote, data.quote?.lastUpdated) };
}

export function priceScopedEarnings(stats: Fundamentals, price: number | null | undefined, quote: Pick<Quote, "currency" | "stale"> | null | undefined,
  priceTime: number | undefined, now = Date.now()): Fundamentals {
  const { eps: _eps, epsCurrency: _currency, trailingPE: _pe, trailingPEConversion: _conversion,
    trailingEpsSource: _source, trailingEpsPeriodEnd: _end, ...rest } = stats;
  const earnings = stats.scopedEarnings;
  if (!earnings?.epsAvailableAt) return rest;
  const filed = financialAvailabilityTime(earnings.epsAvailableAt);
  if (!(filed <= now)) return rest;
  const eligible = earnings.priced && !stats.notMeaningful?.trailingPE && earnings.eps > 0 && quote && !quote.stale && quote.currency === earnings.currency
    && priceTime !== undefined && priceTime >= filed && priceTime <= now && typeof price === "number" && Number.isFinite(price) && price > 0;
  return { ...rest, eps: earnings.eps, epsCurrency: earnings.currency, ...(eligible ? { trailingPE: price / earnings.eps } : {}) };
}
