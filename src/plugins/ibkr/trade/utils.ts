import type { AppConfig } from "../../../types/config";
import type { Quote } from "../../../types/financials";
import type { BrokerContractRef } from "../../../types/instrument";
import type { TickerRecord } from "../../../types/ticker";
import type { BrokerAccount, BrokerOrderPreview, BrokerOrderType } from "../../../types/trading";
import { colors } from "../../../theme/colors";
import { formatCompact, formatCurrency } from "../../../utils/format";
export { truncateWithEllipsis as truncateTradeText } from "../../../utils/text-wrap";
import { formatMarketPrice, formatMarketPriceWithCurrency, formatSignedMarketPrice, type AssetDisplayContext } from "../../../market-data/market/format";
import { getConfiguredIbkrGatewayInstances } from "../instance-selection";

export type TradeTone = "neutral" | "accent" | "positive" | "negative";

export function isLimitOrder(orderType: BrokerOrderType): boolean {
  return orderType === "LMT" || orderType === "STP LMT";
}

export function isStopOrder(orderType: BrokerOrderType): boolean {
  return orderType === "STP" || orderType === "STP LMT";
}

export function hasIbkrTradingProfiles(appConfig: AppConfig): boolean {
  return getConfiguredIbkrGatewayInstances(appConfig).length > 0;
}

export function inferDraftAccountId(
  appConfig: AppConfig,
  collectionId: string | null,
  accounts: BrokerAccount[],
  brokerInstanceId?: string,
  preferredAccountId?: string,
): string | undefined {
  const portfolio = appConfig.portfolios.find((entry) => entry.id === collectionId);
  if (
    portfolio?.brokerId === "ibkr"
    && portfolio.brokerAccountId
    && (!brokerInstanceId || portfolio.brokerInstanceId === brokerInstanceId)
  ) {
    return portfolio.brokerAccountId;
  }
  if (preferredAccountId && accounts.some((account) => account.accountId === preferredAccountId)) {
    return preferredAccountId;
  }
  if (accounts.length === 1) return accounts[0]!.accountId;
  return undefined;
}

export function getKnownIbkrAccounts(
  brokerAccountsByInstance: Record<string, BrokerAccount[]>,
  brokerInstanceId: string | undefined,
  liveAccounts: BrokerAccount[],
): BrokerAccount[] {
  if (!brokerInstanceId) return liveAccounts;
  const cachedAccounts = brokerAccountsByInstance[brokerInstanceId] ?? [];
  if (liveAccounts.length === 0) return cachedAccounts;
  if (cachedAccounts.length === 0) return liveAccounts;

  const merged = new Map<string, BrokerAccount>();
  for (const account of cachedAccounts) {
    if (!account.accountId) continue;
    merged.set(account.accountId, account);
  }
  for (const account of liveAccounts) {
    if (!account.accountId) continue;
    merged.set(account.accountId, { ...(merged.get(account.accountId) ?? {}), ...account });
  }
  return [...merged.values()];
}

export function formatContractLabel(contract: BrokerContractRef): string {
  const base = contract.localSymbol || contract.symbol;
  const suffix = contract.secType ? ` ${contract.secType}` : "";
  return `${base}${suffix}`;
}

export function formatQuoteSummary(quote?: Quote, formatContext: AssetDisplayContext = {}): string {
  if (!quote) return "No broker quote loaded";
  const change = formatSignedMarketPrice(quote.change, formatContext);
  const parts = [`${formatMarketPriceWithCurrency(quote.price, quote.currency, formatContext)}  ${change}`];
  if (quote.bid != null) parts.push(`Bid ${formatMarketPrice(quote.bid, formatContext)}`);
  if (quote.ask != null) parts.push(`Ask ${formatMarketPrice(quote.ask, formatContext)}`);
  if (quote.bid != null && quote.ask != null) parts.push(`Spd ${formatMarketPrice(quote.ask - quote.bid, formatContext)}`);
  return parts.join(" · ");
}

export function formatPreviewSummary(preview: BrokerOrderPreview | null): string {
  if (!preview) {
    return "Preview required before submit. Press p to review margin and commission.";
  }
  return `What-if: init ${formatCompact(preview.initMarginBefore || 0)} → ${formatCompact(preview.initMarginAfter || 0)} · commission ${preview.commission != null ? formatCurrency(preview.commission, preview.commissionCurrency || "USD") : "—"}`;
}

export function getTradeTonePalette(tone: TradeTone) {
  switch (tone) {
    case "accent":
      return { border: colors.borderFocused, text: colors.textBright, background: colors.selected };
    case "positive":
      return { border: colors.positive, text: colors.positive, background: colors.panel };
    case "negative":
      return { border: colors.negative, text: colors.negative, background: colors.panel };
    case "neutral":
    default:
      return { border: colors.border, text: colors.text, background: colors.panel };
  }
}

export function formatPreviewMetric(before?: number, after?: number): string {
  if (before == null && after == null) return "—";
  return `${formatCompact(before || 0)} → ${formatCompact(after || 0)}`;
}

export function findTickerForOrder(
  order: { contract: BrokerContractRef },
  tickers: Map<string, TickerRecord>,
): TickerRecord | null {
  const primaryKey = order.contract.localSymbol || order.contract.symbol;
  const direct = tickers.get(primaryKey);
  if (direct) return direct;

  const fallback = tickers.get(order.contract.symbol);
  if (fallback) return fallback;

  for (const ticker of tickers.values()) {
    const hasContract = (ticker.metadata.broker_contracts ?? []).some((contract) =>
      contract.brokerId === "ibkr"
      && contract.brokerInstanceId === order.contract.brokerInstanceId
      && (
        (contract.conId != null && contract.conId === order.contract.conId)
        || (contract.localSymbol && contract.localSymbol === order.contract.localSymbol)
        || contract.symbol === order.contract.symbol
      ),
    );
    if (hasContract) return ticker;
  }

  return null;
}

export function isMarketDataWarning(message?: string): boolean {
  const text = (message || "").toLowerCase();
  return text.includes("delayed market data")
    || text.includes("market data is not subscribed")
    || text.includes("market data requires additional subscription");
}
