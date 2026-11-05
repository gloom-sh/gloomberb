import type { Portfolio, TickerPosition } from "../types/ticker";

function brokerAccountIdFromPortfolioId(portfolioId: string): string | undefined {
  const [kind, instanceId, ...accountParts] = portfolioId.split(":");
  if (kind !== "broker" || !instanceId) return undefined;
  const accountId = accountParts.join(":").trim();
  return accountId && accountId !== "default" ? accountId : undefined;
}

function brokerPortfolioKey(brokerId: string | undefined, accountId: string | undefined): string | undefined {
  if (!brokerId || !accountId) return undefined;
  return [brokerId, accountId].join("\u0000");
}

function portfolioSyncTimestamp(portfolio: Portfolio): number {
  return typeof portfolio.lastSyncedAt === "number" && Number.isFinite(portfolio.lastSyncedAt)
    ? portfolio.lastSyncedAt
    : 0;
}

function latestBrokerSyncByType(portfolios: Portfolio[], linkedOnly: boolean): Map<string, number> {
  const latest = new Map<string, number>();
  for (const portfolio of portfolios) {
    if (!portfolio.brokerId || (linkedOnly && !portfolio.brokerInstanceId)) continue;
    const timestamp = portfolioSyncTimestamp(portfolio);
    latest.set(portfolio.brokerId, Math.max(latest.get(portfolio.brokerId) ?? 0, timestamp));
  }
  return latest;
}

/**
 * Broker identity is deliberately excluded from cloud payloads, but it is
 * still local state that must survive applying a sanitized portfolio back to
 * this device. Match by the stable portfolio ID first, then by the account
 * suffix in that stable ID. A newer local broker snapshot also wins over old
 * unlinked records left in a cloud snapshot from before a reset.
 */
export function mergeLocalBrokerPortfolioIdentity(
  localPortfolios: Portfolio[],
  syncedPortfolios: Portfolio[],
): Portfolio[] {
  const localById = new Map(localPortfolios.map((portfolio) => [portfolio.id, portfolio] as const));
  const localByBrokerAccount = new Map<string, Portfolio[]>();
  for (const portfolio of localPortfolios) {
    if (!portfolio.brokerInstanceId) continue;
    const key = brokerPortfolioKey(portfolio.brokerId, portfolio.brokerAccountId);
    if (!key) continue;
    const entries = localByBrokerAccount.get(key) ?? [];
    entries.push(portfolio);
    localByBrokerAccount.set(key, entries);
  }

  const exactIncomingIds = new Set(
    syncedPortfolios
      .map((portfolio) => portfolio.id)
      .filter((portfolioId) => localById.has(portfolioId)),
  );
  const localLatestByBroker = latestBrokerSyncByType(localPortfolios, true);
  const syncedLatestByBroker = latestBrokerSyncByType(syncedPortfolios, false);
  const merged: Portfolio[] = [];
  const seenIds = new Set<string>();

  for (const portfolio of syncedPortfolios) {
    const localByStableId = localById.get(portfolio.id);
    const accountId = brokerAccountIdFromPortfolioId(portfolio.id);
    const accountCandidates = localByBrokerAccount.get(brokerPortfolioKey(portfolio.brokerId, accountId) ?? "");
    const local = localByStableId?.brokerInstanceId && localByStableId.brokerId === portfolio.brokerId
      ? localByStableId
      : accountCandidates?.length === 1
        ? accountCandidates[0]
        : undefined;

    if (local) {
      // Prefer an exact stable-ID entry when an older duplicate appears first
      // in the remote array.
      if (portfolio.id !== local.id && exactIncomingIds.has(local.id)) continue;
      if (seenIds.has(local.id)) continue;

      const localIsNewer = portfolioSyncTimestamp(local) > portfolioSyncTimestamp(portfolio);
      merged.push(localIsNewer
        ? local
        : {
          ...portfolio,
          id: local.id,
          brokerInstanceId: local.brokerInstanceId,
          brokerAccountId: local.brokerAccountId,
        });
      seenIds.add(local.id);
      continue;
    }

    const localLatest = portfolio.brokerId ? localLatestByBroker.get(portfolio.brokerId) : undefined;
    if (localLatest !== undefined && localLatest > portfolioSyncTimestamp(portfolio)) continue;
    merged.push(portfolio);
    seenIds.add(portfolio.id);
  }

  // If the newer local broker snapshot is absent from the cloud array
  // altogether, keep it instead of treating the older array as authoritative.
  for (const portfolio of localPortfolios) {
    if (!portfolio.brokerInstanceId || seenIds.has(portfolio.id)) continue;
    const localLatest = portfolio.brokerId ? localLatestByBroker.get(portfolio.brokerId) : undefined;
    const syncedLatest = portfolio.brokerId ? syncedLatestByBroker.get(portfolio.brokerId) ?? 0 : 0;
    if (localLatest !== undefined && localLatest > syncedLatest) {
      merged.push(portfolio);
      seenIds.add(portfolio.id);
    }
  }

  return merged;
}

function brokerPositionKey(position: Pick<TickerPosition, "portfolio" | "broker" | "side">): string {
  return [position.portfolio, position.broker, position.side ?? ""].join("\u0000");
}

/** Keep broker position identity local while applying public cloud fields. */
export function mergeLocalBrokerPositionIdentity(
  localPositions: TickerPosition[],
  syncedPositions: TickerPosition[],
): TickerPosition[] {
  const localByKey = new Map<string, TickerPosition[]>();
  for (const position of localPositions) {
    if (!position.brokerInstanceId) continue;
    const key = brokerPositionKey(position);
    const entries = localByKey.get(key) ?? [];
    entries.push(position);
    localByKey.set(key, entries);
  }

  return syncedPositions.map((position) => {
    const entries = localByKey.get(brokerPositionKey(position));
    const local = entries?.shift();
    if (!local) return position;

    return {
      ...position,
      brokerInstanceId: local.brokerInstanceId,
      brokerAccountId: local.brokerAccountId,
      brokerContractId: local.brokerContractId,
    };
  });
}
