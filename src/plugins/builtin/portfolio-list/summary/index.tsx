import { Box, Text } from "../../../../ui";
import { TextAttributes } from "../../../../ui";
import { colors, priceColor } from "../../../../theme/colors";
import type { AppState } from "../../../../state/app/context";
import { savedCopyFooterSegment, type PaneFooterSegment } from "../../../../components/layout/pane/footer/model";
import { oldestSavedCopyAt } from "../../../../data/saved-copies";
import type { BrokerConnectionStatus } from "../../../../types/broker";
import type { TickerFinancials } from "../../../../types/financials";
import type { Portfolio, TickerRecord } from "../../../../types/ticker";
import type { BrokerAccount, BrokerCashBalance } from "../../../../types/trading";
import { formatShortDate } from "../../../../utils/datetime-format";
import { displayWidth, formatPercentRaw } from "../../../../utils/format";
import { getBrokerInstance } from "../../../../utils/broker-instances";
import {
  resolvePortfolioAccountMetrics,
  resolvePortfolioLeverage,
  resolvePortfolioMarketValue,
  resolvePortfolioNetLiquidation,
  type BrokerSnapshotBasis,
} from "../account-metrics";
import { formatPortfolioAmount, type PortfolioSummaryTotals } from "./totals";
import { formatAllocationDrift, formatAllocationWeight, type PortfolioCashLine } from "../../../../portfolio/allocation";
import { getMostRecentQuoteUpdate } from "../../../../market-data/quotes/time";
import { fxStatusLabel, type FxRateStatus } from "../../../../utils/fx-status";
import { t } from "../../../../i18n";
import type { PortfolioValuationBasis } from "../../../../portfolio/valuation-basis";

/** What the value beside it is priced at, short enough that the header row keeps it with the value. */
const PRICED_AT_TEXT: Record<PortfolioValuationBasis, string> = {
  "latest-print": "(latest print)",
  "regular-close": "(regular close)",
};
/** A book holding futures at the close: they have no regular close, and are valued at their settlement. */
const PRICED_AT_SETTLE_TEXT = "(regular close, futures settle)";

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
  /** How the account figures line up with the position marks. */
  snapshotBasis?: BrokerSnapshotBasis;
}

export interface ResolvedPortfolioAccountState extends PortfolioSummaryAccountState {
  sourceKind: "live" | "cached" | "flex" | "cloud";
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

function parseIsoDateAsLocalDate(value: string): Date | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const [, year, month, day] = match;
  return new Date(Number(year), Number(month) - 1, Number(day));
}

/**
 * A cached account taken no later than the positions were imported was
 * priced at the same broker marks. A live listing, or one taken after the
 * import (on connect), already holds later moves.
 */
function resolveSnapshotBasis(account: BrokerAccount, portfolio: Portfolio, live: boolean): BrokerSnapshotBasis {
  if (live) return "loaded";
  const asOfDate = account.asOfDate ? parseIsoDateAsLocalDate(account.asOfDate) : null;
  const takenAt = account.updatedAt || asOfDate?.getTime();
  const importedAt = portfolio.lastSyncedAt;
  return typeof takenAt === "number" && Number.isFinite(takenAt)
    && typeof importedAt === "number" && Number.isFinite(importedAt)
    && takenAt <= importedAt
    ? "marks"
    : "loaded";
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

function formatSourceBadge(account: BrokerAccount, liveGateway: boolean): { label: string; kind: "live" | "cached" | "flex" | "cloud" } {
  if (liveGateway) {
    return { label: "Live", kind: "live" };
  }
  if (account.source === "cloud") {
    const syncedAt = account.updatedAt ? new Date(account.updatedAt) : null;
    const today = syncedAt?.toDateString() === new Date().toDateString();
    return {
      label: !syncedAt
        ? "Synced"
        : today
          ? `Synced ${syncedAt.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false })}`
          : `Synced ${formatShortDate(syncedAt, { year: false })}`,
      kind: "cloud",
    };
  }
  if (account.source === "flex") {
    const asOfDate = account.asOfDate ? parseIsoDateAsLocalDate(account.asOfDate) : null;
    return {
      label: asOfDate
        ? `Flex ${formatShortDate(asOfDate, { year: false })}`
        : account.updatedAt
          ? `Flex ${formatShortDate(account.updatedAt, { year: false })}`
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
    snapshotBasis: resolveSnapshotBasis(account, portfolio, !!liveAccount),
    visibleCashBalances: getVisibleCashBalances(account.cashBalances),
  };
}

/**
 * What the day's move is measured from, after it, as every change line says
 * it ("vs Fri 16 Oct close", "vs mixed closes"), so a narrow row never shows
 * the move without it.
 */
function dayBasisPart(totals: Pick<PortfolioSummaryTotals, "dayChangeBasis">): PortfolioSummarySegment["parts"] {
  return totals.dayChangeBasis ? [{ text: totals.dayChangeBasis, tone: "muted" }] : [];
}

/** Headline numbers in priority order, so the narrowest header row keeps the most important ones. */
export function buildPortfolioSummarySegments({
  totals,
  accountState,
  isPortfolioTab = true,
  convertAccountValue = (value) => value,
  currency = "USD",
  baseCurrency = "USD",
  manualCash = null,
  brokerPortfolio = false,
  valuationBasis,
}: {
  totals: PortfolioSummaryTotals;
  /** What the values are priced at, said beside the value; left out when absent. */
  valuationBasis?: PortfolioValuationBasis;
  accountState: PortfolioSummaryAccountState | null;
  isPortfolioTab?: boolean;
  /** Synced from a broker, so it is worth its account's equity even while the account is missing. */
  brokerPortfolio?: boolean;
  /** Into the totals currency. */
  convertAccountValue?: (value: number) => number;
  /** The totals currency. */
  currency?: string;
  /** The app's base currency: amounts are bare only when both are USD. */
  baseCurrency?: string;
  /** Cash entered by hand, in the totals currency, with the total it is weighed against. */
  manualCash?: (PortfolioCashLine & { total: number | null }) | null;
}): PortfolioSummarySegment[] {
  const money = (value: number | undefined, signed = false) => formatPortfolioAmount(value, currency, { signed, baseCurrency });
  if (!isPortfolioTab) {
    return totals.watchlistCount > 0
      ? [createSummarySegment("avg-day", [
        { text: "Avg Day", tone: "label" },
        { text: formatPercentRaw(totals.avgWatchlistChange), tone: "value", color: priceColor(totals.avgWatchlistChange), bold: true },
        ...dayBasisPart(totals),
      ])]
      : [];
  }
  if (!totals.hasPositions && !accountState && !manualCash) return [];

  const candidates: PortfolioSummarySegment[] = [];
  const account = accountState?.account;
  // A broker account is worth its equity. Its positions alone are its gross,
  // which margin or shorts put above it, so that sum never reads as its value.
  const broker = brokerPortfolio || !!account;
  const basis = accountState?.snapshotBasis;
  const accountMetrics = resolvePortfolioAccountMetrics(totals, account, convertAccountValue, basis);
  const totalMarketValue = resolvePortfolioMarketValue(totals, account, convertAccountValue, basis);
  // Net Liq moves with live quotes from the broker's snapshot; cash and margin stay as reported.
  const netLiquidation = resolvePortfolioNetLiquidation(totals, account, convertAccountValue, basis);
  const accountValue = (id: string, label: string, value: number | undefined) => value != null
    ? createSummarySegment(id, [
      { text: label, tone: "label" },
      { text: money(convertAccountValue(value)), tone: "value", bold: true },
    ])
    : null;

  // Holdings plus the cash, as weights divide by it; like Net Liq for a broker account.
  if (manualCash) {
    candidates.push(createSummarySegment("total", [
      { text: "Total", tone: "label" },
      { text: money(manualCash.total ?? Number.NaN), tone: "value", bold: true },
    ]));
  }

  // Unknown without the account, so it reads as missing rather than disappearing,
  // unless cash entered by hand gives the Total above in its place.
  if (broker && (netLiquidation != null || !manualCash)) {
    candidates.push(createSummarySegment("netliq", [
      { text: "Net Liq", tone: "label" },
      { text: money(netLiquidation ?? Number.NaN), tone: "value", bold: true },
    ]));
  }

  // Which price the value uses goes with it, so a narrow row never shows one without the other.
  candidates.push(createSummarySegment("val", [
    { text: broker || totals.hasShorts ? "Gross" : "Val", tone: "label" },
    { text: money(totalMarketValue), tone: "value", bold: true },
    ...(valuationBasis ? [{
      text: valuationBasis === "regular-close" && totals.hasFutures ? PRICED_AT_SETTLE_TEXT : PRICED_AT_TEXT[valuationBasis],
      tone: "muted" as const,
    }] : []),
  ]));

  if (totals.hasShorts && totals.netMktValue != null) {
    candidates.push(createSummarySegment("net-value", [
      { text: "Net", tone: "label" },
      { text: money(totals.netMktValue), tone: "value", bold: true },
    ]));
  }

  // A broker account always states its cash, so a missing balance reads as unknown rather than zero.
  if (broker && !manualCash) candidates.push(accountValue("cash", "Cash", account?.totalCashValue ?? Number.NaN)!);
  if (manualCash) {
    const drift = formatAllocationDrift(manualCash.drift);
    candidates.push(createSummarySegment("cash", [
      { text: "Cash", tone: "label" },
      { text: money(manualCash.value), tone: "value", bold: true },
      ...(manualCash.weight != null ? [{ text: `(${formatAllocationWeight(manualCash.weight)})`, tone: "muted" as const }] : []),
      ...(manualCash.targetWeight != null && manualCash.drift != null
        ? [{ text: drift, tone: "muted" as const, color: /[1-9]/.test(drift) ? priceColor(manualCash.drift) : undefined }]
        : []),
    ]));
  }

  candidates.push(createSummarySegment("day", [
    { text: "Day", tone: "label" },
    { text: money(accountMetrics.dailyPnl, true), tone: "value", color: priceColor(accountMetrics.dailyPnl), bold: true },
    { text: `(${formatPercentRaw(accountMetrics.dailyPnlPct)})`, tone: "muted", color: priceColor(accountMetrics.dailyPnlPct) },
    // The broker's own day is from its account's close, not the quotes': it names none.
    ...(accountMetrics.brokerDay || !Number.isFinite(accountMetrics.dailyPnl) ? [] : dayBasisPart(totals)),
  ]));
  candidates.push(createSummarySegment("pnl", [
    { text: !Number.isFinite(account?.unrealizedPnl)
      && totals.unrealizedPnlBasis === "broker-snapshot" ? "Broker P&L"
      : !Number.isFinite(account?.unrealizedPnl)
        && totals.unrealizedPnlBasis === "mixed" ? "Mixed P&L" : "P&L", tone: "label" },
    { text: money(accountMetrics.unrealizedPnl, true), tone: "value", color: priceColor(accountMetrics.unrealizedPnl), bold: true },
    { text: `(${formatPercentRaw(accountMetrics.unrealizedPnlPct)})`, tone: "muted", color: priceColor(accountMetrics.unrealizedPnlPct) },
  ]));

  // A book with shorts splits its gross into the two sides, after the headline numbers.
  if (totals.hasShorts && totals.longMktValue != null && totals.shortMktValue != null) {
    candidates.push(createSummarySegment("long-value", [
      { text: "Long", tone: "label" },
      { text: money(totals.longMktValue), tone: "value", bold: true },
    ]));
    candidates.push(createSummarySegment("short-value", [
      { text: "Short", tone: "label" },
      { text: money(totals.shortMktValue), tone: "value", bold: true },
    ]));
  }

  if (!account) return candidates;

  const leverage = resolvePortfolioLeverage(totalMarketValue, netLiquidation);
  // Only while the account borrows or is short enough to read above 1.0x, as the analytics pane rounds it.
  const lev = leverage != null && leverage >= 1.05
    ? createSummarySegment("lev", [
      { text: "Lev", tone: "label" },
      { text: `${leverage.toFixed(1)}x`, tone: "value", bold: true },
    ])
    : null;
  const realized = accountMetrics.realizedPnl != null
    ? createSummarySegment("realized", [
      { text: "Realized", tone: "label" },
      { text: money(accountMetrics.realizedPnl, true), tone: "value", color: priceColor(accountMetrics.realizedPnl), bold: true },
    ])
    : null;
  return [
    ...candidates,
    ...[
      lev,
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
  brokerOffline,
  financialsMap,
  isPortfolioTab,
  refreshingSize,
  sortedTickers,
  totals,
}: {
  accountState: PortfolioSummaryAccountState | null;
  accountStatusText?: string;
  /**
   * The portfolio's broker is offline. The pane says why, which stands in for
   * the missing account and the quote time, and when it knows, when the
   * positions were synced, which also dates the account.
   */
  brokerOffline?: { dated: boolean };
  financialsMap: Map<string, TickerFinancials>;
  isPortfolioTab: boolean;
  refreshingSize: number;
  sortedTickers: TickerRecord[];
  totals: PortfolioSummaryTotals;
}): PaneFooterSegment[] {
  const source: PaneFooterSegment[] = accountState ? [{ id: "source", parts: [{ text: accountState.sourceLabel, tone: "muted" }] }] : [];
  if (isPortfolioTab && brokerOffline) return brokerOffline.dated ? [] : source;
  const accountStatus: PaneFooterSegment[] = isPortfolioTab && accountStatusText
    ? [{ id: "account-status", parts: [{ text: accountStatusText, tone: "muted" }] }]
    : [];
  // Cached account numbers stay on screen when a live refresh fails, so the failure sits beside their date.
  if (accountState) return [...source, ...accountStatus];
  const quotes = sortedTickers.map((ticker) => financialsMap.get(ticker.metadata.ticker)?.quote);
  // Offline, the quotes listed are copies saved when they last refreshed: the footer says when, in place of the quote time.
  const savedAt = refreshingSize > 0 ? null : oldestSavedCopyAt(quotes);
  if (savedAt != null) return [...accountStatus, savedCopyFooterSegment("refresh", savedAt)];
  if (isPortfolioTab ? !totals.hasPositions && !accountStatusText : totals.watchlistCount === 0) return [];

  const lastRefreshTimestamp = getMostRecentQuoteUpdate(quotes);
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
  /** The totals currency, which missing account pairs convert into. */
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
  // A future without its contract size is named for that, not again as a missing value and cost.
  const unsized = new Set(totals.unknownContractSizeSymbols ?? []);
  const unpriced = (totals.unavailableSymbols ?? []).filter((symbol) => !unsized.has(symbol));
  const uncosted = (totals.unavailableCostSymbols ?? []).filter((symbol) => !unsized.has(symbol));
  if (unsized.size > 0) notices.push(`No contract size, so not valued: ${listSymbols([...unsized])}`);
  if (unpriced.length) notices.push(`Market value unavailable: ${listSymbols(unpriced)}`);
  if (uncosted.length) notices.push(`Cost unavailable: ${listSymbols(uncosted)}`);
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
