import type { BrokerInstanceConfig } from "../../../types/config";
import type { Portfolio } from "../../../types/ticker";

/** Broker account ids look like "U13268153" or "DU1234567": a letter prefix then digits. */
const RAW_ACCOUNT_ID = /^[A-Z]{1,2}\d{5,}$/;

/**
 * A portfolio auto-created from a broker sync is named after the raw account id,
 * which is meaningless on its own, so prefix it with the broker instance label.
 */
export function describePortfolioTab(
  portfolio: Portfolio,
  brokerInstances: BrokerInstanceConfig[] | undefined,
): string {
  const name = portfolio.name.trim();
  if (!RAW_ACCOUNT_ID.test(name)) return portfolio.name;
  const instance = brokerInstances?.find((candidate) => candidate.id === portfolio.brokerInstanceId);
  const prefix = instance?.label?.trim() || instance?.brokerType?.toUpperCase();
  return prefix ? `${prefix} ${name}` : name;
}

export function resolvePortfolioId(portfolios: Portfolio[], portfolioId: string | null | undefined): string | null {
  if (!portfolioId) return null;
  return portfolios.some((portfolio) => portfolio.id === portfolioId) ? portfolioId : null;
}

export function resolveTemplatePortfolioId(portfolios: Portfolio[], activeCollectionId: string | null): string | null {
  return resolvePortfolioId(portfolios, activeCollectionId) ?? portfolios[0]?.id ?? null;
}
