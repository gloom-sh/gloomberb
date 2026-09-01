import {
  EventName,
  type Contract,
  type IBApiNext,
} from "@stoqey/ib";
import { firstValueFrom, filter, take, timeout } from "rxjs";
import type { BrokerPosition } from "gloomberb/types/broker";
import type {
  BrokerAccount,
  BrokerExecution,
  BrokerOrder,
} from "gloomberb/types/trading";
import { debugLog } from "gloomberb/utils";
import {
  finiteNumber,
  summarizeBrokerAccount,
  type AccountPnlSnapshot,
  type AccountSummaryTags,
} from "./account-summary";
import { contractToBrokerRef } from "./contracts";
import { openIbkrOrderToBrokerOrder, type OpenIbkrOrder } from "./orders";
import { getIbkrPriceDivisor, normalizeIbkrPriceValue } from "./price-normalization";
import {
  IBKR_DATA_TIMEOUT,
  IBKR_PNL_TIMEOUT,
  withTimeout,
} from "./timeouts";

interface AccountPortfolioSnapshotPosition {
  contract: Contract;
  avgCost?: number;
  marketPrice?: number;
  marketValue?: number;
  unrealizedPNL?: number;
}

interface GatewayAccountLoadOptions {
  api: IBApiNext;
  rawApi: any;
  instanceId?: string;
  cachedAccountIds: string[];
  setCachedAccountIds(accountIds: string[]): void;
}

interface GatewayApiOptions {
  api: IBApiNext;
  instanceId?: string;
}

const gatewayLog = debugLog.createLogger("ibkr-gateway");

function buildPortfolioPositionKey(accountId: string, contract: Contract): string {
  return [
    accountId.trim(),
    contract.conId ?? "",
    contract.localSymbol ?? "",
    contract.symbol ?? "",
    contract.secType ?? "",
  ].join("|");
}

export async function loadIbkrAccounts({
  api,
  rawApi,
  instanceId,
  cachedAccountIds,
  setCachedAccountIds,
}: GatewayAccountLoadOptions): Promise<BrokerAccount[]> {
  let managedAccounts: string[];
  try {
    managedAccounts = await withTimeout(api.getManagedAccounts(), IBKR_DATA_TIMEOUT, "getManagedAccounts");
  } catch {
    // getManagedAccounts() can hang after reconnects or when another client with the same
    // clientId is connected. Fall back to requesting via the raw event API, or use cached IDs.
    if (cachedAccountIds.length > 0) {
      managedAccounts = cachedAccountIds;
    } else {
      managedAccounts = await withTimeout(
        new Promise<string[]>((resolve) => {
          const handler = (accountsList: string) => {
            rawApi.off(EventName.managedAccounts, handler);
            resolve(accountsList.split(",").map((s: string) => s.trim()).filter(Boolean));
          };
          rawApi.on(EventName.managedAccounts, handler);
          rawApi.reqManagedAccts();
        }),
        IBKR_DATA_TIMEOUT,
        "getManagedAccounts-fallback",
      );
      setCachedAccountIds(managedAccounts);
    }
  }
  if (!managedAccounts.length) return [];
  let summary: ReadonlyMap<string, AccountSummaryTags> | undefined;
  try {
    const result = await firstValueFrom(
      api.getAccountSummary(
        "All",
        "NetLiquidation,GrossPositionValue,TotalCashValue,SettledCash,AvailableFunds,BuyingPower,ExcessLiquidity,InitMarginReq,MaintMarginReq,$LEDGER:ALL",
      )
        .pipe(take(1), timeout(10_000)),
    );
    summary = result.all;
  } catch {
    // Account summary may fail; return accounts with basic info only.
  }

  const updatedAt = Date.now();
  const aggregateTags = summary?.get("All");
  const allowAggregateCashBalances = managedAccounts.length === 1;
  const pnlByAccount = await loadAccountPnlForAccounts(api, instanceId, managedAccounts);
  return managedAccounts.map((accountId) => summarizeBrokerAccount(
    accountId,
    summary?.get(accountId),
    updatedAt,
    aggregateTags,
    allowAggregateCashBalances,
    pnlByAccount.get(accountId),
  ));
}

export async function loadIbkrPositions({
  api,
  instanceId,
}: GatewayApiOptions): Promise<BrokerPosition[]> {
  const update = await firstValueFrom(api.getPositions().pipe(take(1), timeout(10_000)));
  const portfolioSnapshots = await loadPortfolioSnapshotsForAccounts(api, instanceId, [...update.all.keys()]);
  const positions: BrokerPosition[] = [];
  for (const [accountId, accountPositions] of update.all) {
    for (const position of accountPositions) {
      if (!position.contract.symbol) continue;
      const portfolioSnapshot = portfolioSnapshots.get(buildPortfolioPositionKey(accountId, position.contract));
      const priceDivisor = getIbkrPriceDivisor(position.contract);
      positions.push({
        ticker: position.contract.localSymbol || position.contract.symbol,
        exchange: position.contract.primaryExch || position.contract.exchange || "",
        shares: Math.abs(position.pos),
        avgCost: portfolioSnapshot?.avgCost ?? position.avgCost,
        currency: position.contract.currency || "USD",
        accountId,
        name: position.contract.description || position.contract.localSymbol || position.contract.symbol,
        assetCategory: position.contract.secType,
        markPrice: normalizeIbkrPriceValue(portfolioSnapshot?.marketPrice ?? position.marketPrice, priceDivisor),
        marketValue: portfolioSnapshot?.marketValue ?? position.marketValue,
        unrealizedPnl: portfolioSnapshot?.unrealizedPNL ?? position.unrealizedPNL,
        side: position.pos < 0 ? "short" : "long",
        multiplier: position.contract.multiplier,
        brokerContract: contractToBrokerRef(position.contract, instanceId),
      });
    }
  }
  return positions;
}

export async function loadIbkrOpenOrders({
  api,
  instanceId,
}: GatewayApiOptions): Promise<BrokerOrder[]> {
  const orders = await withTimeout(api.getAllOpenOrders(), IBKR_DATA_TIMEOUT, "getAllOpenOrders");
  return orders.map((order) => openIbkrOrderToBrokerOrder(
    order as OpenIbkrOrder,
    instanceId,
    (contract) => contractToBrokerRef(contract, instanceId),
  ));
}

export async function loadIbkrExecutions({
  api,
  instanceId,
}: GatewayApiOptions): Promise<BrokerExecution[]> {
  const executions = await withTimeout(api.getExecutionDetails({}), IBKR_DATA_TIMEOUT, "getExecutionDetails");
  return executions.map((detail) => ({
    execId: detail.execution.execId || `${detail.execution.orderId ?? "exec"}-${detail.execution.time ?? Date.now()}`,
    brokerInstanceId: instanceId,
    orderId: detail.execution.orderId,
    accountId: detail.execution.acctNumber,
    side: detail.execution.side || "",
    shares: detail.execution.shares ?? 0,
    price: detail.execution.price ?? 0,
    time: detail.execution.time ? Date.parse(detail.execution.time) : Date.now(),
    exchange: detail.execution.exchange,
    contract: contractToBrokerRef(detail.contract, instanceId),
  }));
}

async function loadAccountPnlForAccounts(
  api: IBApiNext,
  instanceId: string | undefined,
  accountIds: string[],
): Promise<Map<string, AccountPnlSnapshot>> {
  const entries = await Promise.all(accountIds.map(async (accountId) => {
    const pnl = await loadAccountPnl(api, instanceId, accountId);
    return pnl ? ([accountId, pnl] as const) : null;
  }));
  return new Map(entries.filter((entry): entry is readonly [string, AccountPnlSnapshot] => entry != null));
}

async function loadAccountPnl(
  api: IBApiNext,
  instanceId: string | undefined,
  accountId: string,
): Promise<AccountPnlSnapshot | null> {
  if (typeof api.getPnL !== "function") return null;

  try {
    const pnl = await firstValueFrom(
      api.getPnL(accountId).pipe(
        take(1),
        timeout(IBKR_PNL_TIMEOUT),
      ),
    );
    return {
      dailyPnl: finiteNumber(pnl.dailyPnL),
      unrealizedPnl: finiteNumber(pnl.unrealizedPnL),
      realizedPnl: finiteNumber(pnl.realizedPnL),
    };
  } catch (error: any) {
    gatewayLog.warn("Failed to load IBKR account P&L", {
      instanceId,
      accountId,
      error: error?.message || String(error || ""),
    });
    return null;
  }
}

async function loadPortfolioSnapshotsForAccounts(
  api: IBApiNext,
  instanceId: string | undefined,
  accountIds: string[],
): Promise<Map<string, AccountPortfolioSnapshotPosition>> {
  const snapshots = new Map<string, AccountPortfolioSnapshotPosition>();
  for (const accountId of accountIds) {
    const positions = await loadPortfolioSnapshotForAccount(api, instanceId, accountId);
    for (const position of positions) {
      snapshots.set(buildPortfolioPositionKey(accountId, position.contract), position);
    }
  }
  return snapshots;
}

async function loadPortfolioSnapshotForAccount(
  api: IBApiNext,
  instanceId: string | undefined,
  accountId: string,
): Promise<AccountPortfolioSnapshotPosition[]> {
  if (!accountId) return [];

  try {
    const update = await firstValueFrom(
      api.getAccountUpdates(accountId).pipe(
        filter((value) => value.changed == null && value.added == null && value.removed == null),
        take(1),
        timeout(IBKR_DATA_TIMEOUT),
      ),
    );
    return (update.all.portfolio?.get(accountId) ?? []) as AccountPortfolioSnapshotPosition[];
  } catch (error: any) {
    gatewayLog.warn("Failed to load IBKR portfolio snapshot", {
      instanceId,
      accountId,
      error: error?.message || String(error || ""),
    });
    return [];
  }
}
