import type { FinancialStatement, Fundamentals, Quote, StatementScope, TickerFinancials } from "../types/financials";
import { completeAvailability, financialAvailabilityTime, statementFieldAvailability } from "./financial-statements";

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

export function dateScopedEarnings(data: Pick<TickerFinancials, "statementScope" | "statementReview" | "annualStatements" | "quarterlyStatements">,
  earnings: Omit<ScopedEarnings, "epsAvailableAt"> | null | undefined): ScopedEarnings | null {
  const reviewedThrough = data.statementReview?.reviewedThrough;
  if (data.statementScope?.basis !== "standalone" || !earnings || !Number.isFinite(earnings.eps) || !/^[A-Z]{3}$/.test(earnings.currency)
    || !reviewedThrough || !listingOwnsSeries(data)) return null;
  const { eps, currency, periodEnd, priced } = earnings;
  const quarters = data.quarterlyStatements.filter(row => row.date <= periodEnd)
    .sort((first, second) => first.date.localeCompare(second.date)).slice(-4);
  const annual = data.annualStatements.find(row => row.date === periodEnd);
  const sameEnd = quarters.at(-1)?.date === periodEnd;
  const amended = annual && sameEnd && quarters.some(row => (row.availableAt ?? "") > (annual.availableAt ?? ""));
  const inputs = annual && !amended ? [annual] : sameEnd && quarters.length === 4 ? quarters : [];
  const epsAvailableAt = completeAvailability(inputs.map(row => row.currency === currency ? statementFieldAvailability(row, "eps") : undefined));
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
