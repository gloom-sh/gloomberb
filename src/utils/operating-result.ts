import type { DerivedOperatingObservation, FinancialStatement, ProviderOperatingField, TickerFinancials } from "../types/financials";
import { canonicalExchange, parsePublicTickerKey } from "./exchanges";
import {
  OPERATING_FIELDS, OPERATING_PROVIDER_FIELDS, isShopOperatingTarget,
  ownedReportedOperatingCohort, mergeOperatingResults,
  providerOperatingObservation as directProviderObservation,
  derivedOperatingObservation as directDerivedObservation,
} from "./reported-operating-result";

// The pure cohort parser/merge is shared with the Cloud adapter. Keep its
// source in parity; this module owns application type/context boundaries.
export * from "./reported-operating-result";
type Period = "annual" | "quarterly";

export function reportedOperatingCohort(row: FinancialStatement | undefined, period?: Period) {
  const group = ownedReportedOperatingCohort(row);
  return group && (!period || group.period === period) ? group : undefined;
}

export function providerOperatingObservation(row: FinancialStatement | undefined, field: ProviderOperatingField, period?: Period) {
  const observation = directProviderObservation(row, field);
  return observation && (!period || observation.period === period) ? observation : undefined;
}

export function derivedOperatingObservation(row: FinancialStatement | undefined, field: "ebitda", period?: Period): DerivedOperatingObservation | undefined {
  const value = field === "ebitda" ? directDerivedObservation(row) : undefined;
  return value && (!period || value.period === period) ? value : undefined;
}

export function normalizeStatementOperatingResult(row: FinancialStatement, period?: Period): FinancialStatement {
  if (!row.operatingResult) return row;
  const next = { ...row };
  const reported = reportedOperatingCohort(row, period);
  const provider = Object.fromEntries(OPERATING_PROVIDER_FIELDS.flatMap(field => {
    const observation = providerOperatingObservation(row, field, period);
    return observation ? [[field, observation]] : [];
  }));
  const ebitda = derivedOperatingObservation(row, "ebitda", period);
  if (reported || Object.keys(provider).length || ebitda) next.operatingResult = {
    version: 1, ...(reported ? { reported } : {}),
    ...(Object.keys(provider).length ? { provider } : {}),
    ...(ebitda ? { derived: { ebitda } } : {}),
  };
  else delete next.operatingResult;
  return next;
}

export function mergeStatementOperatingResult(target: FinancialStatement, primary?: FinancialStatement, fallback?: FinancialStatement): void {
  // Generic financial merging tolerates nearby vendor dates. An owned operating
  // observation does not: a neighboring period cannot supply its missing field.
  if ((primary?.operatingResult || fallback?.operatingResult) && primary && fallback && primary.date !== fallback.date) {
    const owner = [primary, fallback].find(row => row.date === target.date);
    for (const field of OPERATING_PROVIDER_FIELDS) {
      if (owner?.[field] !== undefined) target[field] = owner[field];
      else delete target[field];
    }
  }
  mergeOperatingResults(target, primary, fallback);
  const normalized = normalizeStatementOperatingResult(target);
  if (normalized.operatingResult) target.operatingResult = normalized.operatingResult;
  else delete target.operatingResult;
}

export function operatingResultDisagrees(row: FinancialStatement): boolean {
  const reported = reportedOperatingCohort(row);
  return !!reported && OPERATING_FIELDS.some(field => {
    const source = providerOperatingObservation(row, field, reported.period);
    return !!source && source.value !== reported.values[field];
  });
}

/** Listing qualification is independent from an issuer CIK claimed in a wire row. */
export function hasShopOperatingIdentity(financials: Pick<TickerFinancials, "quote" | "quoteMetadata" | "financialCurrency">,
  target?: { symbol: string; exchange?: string }): boolean {
  const metadata = financials.quote ?? financials.quoteMetadata;
  const parsed = parsePublicTickerKey(target?.symbol ?? metadata?.symbol ?? "");
  const exchange = parsed.exchange ?? canonicalExchange(target?.exchange || metadata?.listingExchangeName || financials.quote?.exchangeName);
  if (!isShopOperatingTarget(parsed.symbol, exchange) || (financials.financialCurrency && financials.financialCurrency !== "USD")) return false;
  if (metadata?.symbol && parsePublicTickerKey(metadata.symbol).symbol !== "SHOP") return false;
  const declaredExchange = canonicalExchange(metadata?.listingExchangeName || financials.quote?.exchangeName);
  return (!declaredExchange || declaredExchange === "NASDAQ") && (!metadata?.currency || metadata.currency === "USD");
}

export function normalizeFinancialOperatingResults<T extends TickerFinancials>(financials: T,
  target?: { symbol: string; exchange?: string }): T {
  const qualified = hasShopOperatingIdentity(financials, target);
  const normalize = (row: FinancialStatement, period: Period) => {
    if (qualified) return normalizeStatementOperatingResult(row, period);
    if (!row.operatingResult) return row;
    const next = { ...row };
    delete next.operatingResult;
    return next;
  };
  return { ...financials,
    annualStatements: financials.annualStatements.map(row => normalize(row, "annual")),
    quarterlyStatements: financials.quarterlyStatements.map(row => normalize(row, "quarterly")),
  };
}
