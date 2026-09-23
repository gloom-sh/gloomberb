import { Box, Text } from "../../../../ui";
import { TextAttributes } from "../../../../ui";
import { colors, priceColor } from "../../../../theme/colors";
import type { AppState } from "../../../../state/app/context";
import type { PaneFooterSegment } from "../../../../components/layout/pane/footer/model";
import type { BrokerConnectionStatus } from "../../../../types/broker";
import type { TickerFinancials } from "../../../../types/financials";
import type { Portfolio, TickerRecord } from "../../../../types/ticker";
import type { BrokerAccount, BrokerCashBalance } from "../../../../types/trading";
import { displayWidth, formatCompact, formatPercentRaw } from "../../../../utils/format";
import { getBrokerInstance } from "../../../../utils/broker-instances";
import { resolvePortfolioAccountMetrics, resolvePortfolioMarketValue } from "../account-metrics";
import { calculatePortfolioSummaryTotals, type PortfolioSummaryTotals } from "./totals";
import { getMostRecentQuoteUpdate } from "../../../../market-data/quotes/time";
import { fxStatusLabel, type FxRateStatus } from "../../../../utils/fx-status";
import { t } from "../../../../i18n";

export interface PortfolioSummarySegment {
  id: string;
  parts: Array<{
    text: string;
    tone: "label" | "value" | "muted";
    color?: string;
    bold?: boolean;
  }>;
  length: number;
}

export interface PortfolioSummaryAccountState {
  account: BrokerAccount;
  sourceLabel: string;
}

export interface ResolvedPortfolioAccountState extends PortfolioSummaryAccountState {
  sourceKind: "live" | "cached" | "flex";
  visibleCashBalances: BrokerCashBalance[];
}

export interface LiveBrokerAccountSnapshot {
  status: BrokerConnectionStatus | null;
  accounts: BrokerAccount[];
}

function createSummarySegment(
  id: string,
  parts: PortfolioSummarySegment["parts"],
): PortfolioSummarySegment {
  return {
    id,
    parts,
    length: parts.reduce((sum, part) => sum + displayWidth(t(part.text)), 0) + Math.max(0, parts.length - 1),
  };
}

function formatSignedCompact(value: number): string {
  return `${value >= 0 ? "+" : ""}${formatCompact(value)}`;
}

function formatMonthDay(date: Date): string {
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function parseIsoDateAsLocalDate(value: string): Date | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const [, year, month, day] = match;
  return new Date(Number(year), Number(month) - 1, Number(day));
}

function getAccountFreshnessTime(account: BrokerAccount): number {
  const asOfDate = account.asOfDate ? parseIsoDateAsLocalDate(account.asOfDate) : null;
  return asOfDate?.getTime() ?? account.updatedAt ?? 0;
}

export function fitSummarySegments(candidates: PortfolioSummarySegment[], widthBudget: number): PortfolioSummarySegment[] {
  const fitted: PortfolioSummarySegment[] = [];
  let used = 0;
  for (const segment of candidates) {
    const nextUsed = used + (fitted.length > 0 ? 2 : 0) + segment.length;
    if (fitted.length > 0 && nextUsed > widthBudget) break;
    fitted.push(segment);
    used = nextUsed;
  }
  return fitted;
}

function formatSourceBadge(account: BrokerAccount, liveGateway: boolean): { label: string; kind: "live" | "cached" | "flex" } {
  if (liveGateway) {
    return { label: "Live", kind: "live" };
  }
  if (account.source === "flex") {
    const asOfDate = account.asOfDate ? parseIsoDateAsLocalDate(account.asOfDate) : null;
    return {
      label: asOfDate
        ? `Flex ${formatMonthDay(asOfDate)}`
        : account.updatedAt
          ? `Flex ${formatMonthDay(new Date(account.updatedAt))}`
        : "Flex",
      kind: "flex",
    };
  }
  return { label: "Cached", kind: "cached" };
}

function getVisibleCashBalances(cashBalances: BrokerCashBalance[] | undefined): BrokerCashBalance[] {
  if (!cashBalances) return [];
  return cashBalances
    .filter((balance) => {
      const quantity = Math.abs(balance.quantity);
      const baseValue = Math.abs(balance.baseValue ?? 0);
      return quantity > 1e-9 || baseValue > 1e-9;
    })
    .sort((left, right) => {
      const leftValue = Math.abs(left.baseValue ?? left.quantity);
      const rightValue = Math.abs(right.baseValue ?? right.quantity);
      return rightValue - leftValue;
    });
}

function findPortfolioAccount(
  accounts: BrokerAccount[],
  portfolio: Portfolio,
): BrokerAccount | undefined {
  if (accounts.length === 0) return undefined;

  const accountId = portfolio.brokerAccountId?.trim();
  const portfolioName = portfolio.name.trim();
  const collectionAccountId = portfolio.id.split(":").pop()?.trim();
  const explicitAccountIds = [accountId, collectionAccountId === "default" ? undefined : collectionAccountId]
    .filter((value): value is string => !!value);

  for (const id of explicitAccountIds) {
    const matched = accounts.find((account) => account.accountId === id || account.name === id);
    if (matched) return matched;
  }

  const nameMatched = accounts.find((account) => account.accountId === portfolioName || account.name === portfolioName);
  if (nameMatched) return nameMatched;

  return explicitAccountIds.length === 0 && accounts.length === 1 ? accounts[0] : undefined;
}

function sortAccountsByFreshness(accounts: BrokerAccount[]): BrokerAccount[] {
  return [...accounts].sort((left, right) => getAccountFreshnessTime(right) - getAccountFreshnessTime(left));
}

export function resolvePortfolioAccountState(
  portfolio: Portfolio | null,
  state: Pick<AppState, "config" | "brokerAccounts">,
  liveSnapshot: LiveBrokerAccountSnapshot,
): ResolvedPortfolioAccountState | null {
  if (!portfolio?.brokerInstanceId) return null;

  const brokerInstance = getBrokerInstance(state.config.brokerInstances, portfolio.brokerInstanceId);
  const relatedInstanceIds = [
    portfolio.brokerInstanceId,
    ...state.config.brokerInstances
      .filter((instance) =>
        instance.id !== portfolio.brokerInstanceId
        && instance.brokerType === (portfolio.brokerId ?? brokerInstance?.brokerType)
      )
      .map((instance) => instance.id),
  ];
  const cachedAccounts = sortAccountsByFreshness(
    relatedInstanceIds.flatMap((instanceId) => state.brokerAccounts[instanceId] ?? []),
  );
  const cachedAccount = findPortfolioAccount(cachedAccounts, portfolio);

  const liveAccount = brokerInstance
    && liveSnapshot.status?.state === "connected"
    ? findPortfolioAccount(liveSnapshot.accounts, portfolio)
    : undefined;

  const account = liveAccount ?? cachedAccount;
  if (!account) return null;

  const source = formatSourceBadge(account, !!liveAccount);
  return {
    account,
    sourceLabel: source.label,
    sourceKind: source.kind,
    visibleCashBalances: getVisibleCashBalances(account.cashBalances),
  };
}

/** Headline numbers in priority order, so the narrowest header row keeps the most important ones. */
export function buildPortfolioSummarySegments({
  totals,
  accountState,
  isPortfolioTab = true,
  convertAccountValue = (value) => value,
}: {
  totals: PortfolioSummaryTotals;
  accountState: PortfolioSummaryAccountState | null;
  isPortfolioTab?: boolean;
  convertAccountValue?: (value: number) => number;
}): PortfolioSummarySegment[] {
  if (!isPortfolioTab) {
    return totals.watchlistCount > 0
      ? [createSummarySegment("avg-day", [
        { text: "Avg Day", tone: "label" },
        { text: formatPercentRaw(totals.avgWatchlistChange), tone: "value", color: priceColor(totals.avgWatchlistChange), bold: true },
      ])]
      : [];
  }
  if (!totals.hasPositions && !accountState) return [];

  const candidates: PortfolioSummarySegment[] = [];
  const account = accountState?.account;
  const accountMetrics = resolvePortfolioAccountMetrics(totals, account, convertAccountValue);
  const totalMarketValue = resolvePortfolioMarketValue(totals, account, convertAccountValue);
  const accountValue = (id: string, label: string, value: number | undefined) => value != null
    ? createSummarySegment(id, [
      { text: label, tone: "label" },
      { text: formatCompact(convertAccountValue(value)), tone: "value", bold: true },
    ])
    : null;

  const netLiq = accountValue("netliq", "Net Liq", account?.netLiquidation);
  if (netLiq) candidates.push(netLiq);

  candidates.push(createSummarySegment("val", [
    { text: totals.hasShorts ? "Gross" : "Val", tone: "label" },
    { text: formatCompact(totalMarketValue), tone: "value", bold: true },
  ]));

  if (totals.hasShorts && totals.netMktValue != null) {
    candidates.push(createSummarySegment("net-value", [
      { text: "Net", tone: "label" },
      { text: formatCompact(totals.netMktValue), tone: "value", bold: true },
    ]));
  }

  // A broker account always states its cash, so a missing balance reads as unknown rather than zero.
  if (account) candidates.push(accountValue("cash", "Cash", account.totalCashValue ?? Number.NaN)!);

  candidates.push(createSummarySegment("day", [
    { text: "Day", tone: "label" },
    { text: formatSignedCompact(accountMetrics.dailyPnl), tone: "value", color: priceColor(accountMetrics.dailyPnl), bold: true },
    { text: `(${formatPercentRaw(accountMetrics.dailyPnlPct)})`, tone: "muted", color: priceColor(accountMetrics.dailyPnlPct) },
  ]));
  candidates.push(createSummarySegment("pnl", [
    { text: !Number.isFinite(account?.unrealizedPnl)
      && totals.unrealizedPnlBasis === "broker-snapshot" ? "Broker P&L"
      : !Number.isFinite(account?.unrealizedPnl)
        && totals.unrealizedPnlBasis === "mixed" ? "Mixed P&L" : "P&L", tone: "label" },
    { text: formatSignedCompact(accountMetrics.unrealizedPnl), tone: "value", color: priceColor(accountMetrics.unrealizedPnl), bold: true },
    { text: `(${formatPercentRaw(accountMetrics.unrealizedPnlPct)})`, tone: "muted", color: priceColor(accountMetrics.unrealizedPnlPct) },
  ]));

  if (!account) return candidates;

  const realized = accountMetrics.realizedPnl != null
    ? createSummarySegment("realized", [
      { text: "Realized", tone: "label" },
      { text: formatSignedCompact(accountMetrics.realizedPnl), tone: "value", color: priceColor(accountMetrics.realizedPnl), bold: true },
    ])
    : null;
  return [
    ...candidates,
    ...[
      realized,
      accountValue("settled", "Settled", account.settledCash),
      accountValue("avail", "Avail", account.availableFunds),
      accountValue("excess", "Excess", account.excessLiquidity),
      accountValue("bp", "BP", account.buyingPower),
      accountValue("init", "Init", account.initMarginReq),
      accountValue("maint", "Maint", account.maintMarginReq),
    ].filter((segment): segment is PortfolioSummarySegment => segment != null),
  ];
}

export interface PortfolioSummaryHeaderLayout {
  /** The header row above the table. */
  row: PortfolioSummarySegment[];
  /** What the row had no room for, shown once the cash drawer opens. */
  detail: PortfolioSummarySegment[];
}

export function layoutPortfolioSummaryHeader(
  segments: PortfolioSummarySegment[],
  width: number,
  { cashDrawer, hideHeader }: { cashDrawer: boolean; hideHeader: boolean },
): PortfolioSummaryHeaderLayout {
  const row = hideHeader ? [] : fitSummarySegments(segments, width);
  const detail = cashDrawer ? fitSummarySegments(segments.slice(row.length), width) : [];
  return { row, detail };
}

/** Changing status only: where the account numbers come from, account failures, and quote refresh time. */
export function buildPortfolioFooterSegments({
  accountState,
  accountStatusText,
  financialsMap,
  isPortfolioTab,
  refreshingSize,
  sortedTickers,
  totals,
}: {
  accountState: PortfolioSummaryAccountState | null;
  accountStatusText?: string;
  financialsMap: Map<string, TickerFinancials>;
  isPortfolioTab: boolean;
  refreshingSize: number;
  sortedTickers: TickerRecord[];
  totals: PortfolioSummaryTotals;
}): PaneFooterSegment[] {
  const accountStatus: PaneFooterSegment[] = isPortfolioTab && accountStatusText
    ? [{ id: "account-status", parts: [{ text: accountStatusText, tone: "muted" }] }]
    : [];
  // Cached account numbers stay on screen when a live refresh fails, so the failure sits beside their date.
  if (accountState) return [{ id: "source", parts: [{ text: accountState.sourceLabel, tone: "muted" }] }, ...accountStatus];
  if (isPortfolioTab ? !totals.hasPositions && !accountStatusText : totals.watchlistCount === 0) return [];

  const lastRefreshTimestamp = getMostRecentQuoteUpdate(
    sortedTickers.map((ticker) => financialsMap.get(ticker.metadata.ticker)?.quote),
  );
  const refreshText = refreshingSize > 0
    ? "Refreshing..."
    : lastRefreshTimestamp != null
      ? new Date(lastRefreshTimestamp).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
      : "-";
  return [...accountStatus, { id: "refresh", parts: [{ text: refreshText, tone: "muted" }] }];
}

const MAX_NOTICE_SYMBOLS = 12;

function listSymbols(symbols: string[]): string {
  const shown = symbols.slice(0, MAX_NOTICE_SYMBOLS).join(", ");
  return symbols.length > MAX_NOTICE_SYMBOLS ? `${shown} +${symbols.length - MAX_NOTICE_SYMBOLS} more` : shown;
}

/** Gaps behind the totals, for the pane's warning notice instead of text in the footer. */
export function buildPortfolioSummaryNotices({
  totals,
  accountState,
  baseCurrency,
  convertAccountValue = (value) => value,
  fxStatus,
}: {
  totals: PortfolioSummaryTotals;
  accountState: PortfolioSummaryAccountState | null;
  baseCurrency: string;
  convertAccountValue?: (value: number) => number;
  fxStatus?: FxRateStatus;
}): string[] {
  const notices: string[] = [];
  const accountCurrency = accountState?.account.currency?.trim().toUpperCase();
  const accountFxMissing = !!accountState && !Number.isFinite(convertAccountValue(1));
  const missingPairs = new Set(totals.unavailableConversions ?? []);
  if (accountFxMissing && accountCurrency) missingPairs.add(`${accountCurrency}/${baseCurrency}`);
  if (accountFxMissing && !accountCurrency) notices.push("Account currency unknown, so account values are unavailable");
  if (missingPairs.size > 0) notices.push(`FX unavailable: ${[...missingPairs].sort().join(", ")}`);
  if (fxStatus && (fxStatus.stale || fxStatus.unknownTime || (fxStatus.unavailable && missingPairs.size === 0))) {
    // Missing pairs are named above, so the rate summary only adds staleness and timing.
    notices.push(`FX ${fxStatusLabel(missingPairs.size > 0 ? { ...fxStatus, unavailable: 0 } : fxStatus)}`);
  }
  if (totals.unavailableSymbols?.length) notices.push(`Market value unavailable: ${listSymbols(totals.unavailableSymbols)}`);
  if (totals.unavailableCostSymbols?.length) notices.push(`Cost unavailable: ${listSymbols(totals.unavailableCostSymbols)}`);
  return notices;
}

export function renderSummarySegments(segments: PortfolioSummarySegment[], width: number) {
  if (segments.length === 0) return null;
  return (
    <Box flexDirection="row" width={width} justifyContent="flex-start" overflow="hidden">
      {segments.map((segment, segmentIndex) => (
        <Box key={segment.id} flexDirection="row">
          {segmentIndex > 0 && <Text fg={colors.textDim}>{"  "}</Text>}
          {segment.parts.map((part, partIndex) => (
            <Box key={`${segment.id}:${partIndex}`} flexDirection="row">
              {partIndex > 0 && <Text fg={colors.textDim}>{" "}</Text>}
              <Text
                fg={part.color ?? (part.tone === "label" || part.tone === "muted" ? colors.textDim : colors.text)}
                attributes={part.bold ? TextAttributes.BOLD : 0}
              >
                {t(part.text)}
              </Text>
            </Box>
          ))}
        </Box>
      ))}
    </Box>
  );
}
