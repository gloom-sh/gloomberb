import type { FinancialStatement, Fundamentals, StatementScope, TickerFinancials } from "../types/financials";
import { completeAvailability, financialAvailabilityTime } from "./financial-statements";

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

function reviewedEarnings(data: TickerFinancials, stats: Fundamentals): NonNullable<Fundamentals["scopedEarnings"]> | null {
  const { eps, epsCurrency, trailingPeriodEnd, trailingPE } = stats;
  const reviewedThrough = data.statementReview?.reviewedThrough;
  if (!listingOwnsSeries(data) || typeof eps !== "number" || !Number.isFinite(eps) || !epsCurrency || !/^[A-Z]{3}$/.test(epsCurrency)
    || !trailingPeriodEnd || !reviewedThrough) return null;
  const quarters = data.quarterlyStatements.filter(row => row.date <= trailingPeriodEnd)
    .sort((first, second) => first.date.localeCompare(second.date)).slice(-4);
  const rows = data.annualStatements.filter(row => row.date === trailingPeriodEnd);
  if (quarters.at(-1)?.date === trailingPeriodEnd && (rows.length || quarters.length === 4)) rows.push(...quarters);
  const availableAt = completeAvailability(rows.map(row => row.currency === epsCurrency ? row.availableAt : undefined));
  return availableAt && Date.parse(availableAt) >= Date.parse(trailingPeriodEnd) && financialAvailabilityTime(availableAt) <= financialAvailabilityTime(reviewedThrough)
    ? { eps, currency: epsCurrency, periodEnd: trailingPeriodEnd, availableAt, priced: typeof trailingPE === "number" && Number.isFinite(trailingPE) && trailingPE > 0 }
    : null;
}

export function captureScopedEarnings(data: TickerFinancials): TickerFinancials {
  if (!data.statementScope || !data.fundamentals) return data;
  const scopedEarnings = reviewedEarnings(data, data.fundamentals);
  return { ...data, fundamentals: priceScopedEarnings({ ...data.fundamentals, scopedEarnings },
    data.quote?.price, data.quote?.currency, data.quote?.lastUpdated) };
}

export function priceScopedEarnings(stats: Fundamentals, price: number | null | undefined, currency: string | undefined,
  priceTime: number | undefined, now = Date.now()): Fundamentals {
  const { eps: _eps, epsCurrency: _currency, trailingPE: _pe, trailingPEConversion: _conversion,
    trailingEpsSource: _source, trailingEpsPeriodEnd: _end, ...rest } = stats;
  const earnings = stats.scopedEarnings;
  if (!earnings) return rest;
  const filed = financialAvailabilityTime(earnings.availableAt);
  if (!(filed <= now)) return rest;
  const eligible = earnings.priced && !stats.notMeaningful?.trailingPE && earnings.eps > 0 && currency === earnings.currency
    && priceTime !== undefined && priceTime >= filed && priceTime <= now && typeof price === "number" && Number.isFinite(price) && price > 0;
  return { ...rest, eps: earnings.eps, epsCurrency: earnings.currency, ...(eligible ? { trailingPE: price / earnings.eps } : {}) };
}
