import type { AppConfig, BrokerExcludedAccount, BrokerInstanceConfig } from "../types/config";
import type { Portfolio, TickerRecord } from "../types/ticker";
import { isRecord } from "../utils/guards";
import { readExcludedAccounts, sameExcludedAccounts } from "../brokers/account-choice";

function withExcludedAccounts(excludedAccounts: BrokerExcludedAccount[] | undefined): Pick<BrokerInstanceConfig, "excludedAccounts"> {
  return excludedAccounts ? { excludedAccounts } : {};
}

/**
 * A profile's left-out accounts once a pull meets this device's, with `synced` the list this device
 * last synced for it. A device that predates the choice sends none, which changes nothing here;
 * only a list does, an empty one taking every account back. A pulled list replaces one this device
 * has not changed since it last synced; one changed here stays, like any edit made here.
 */
function mergedExcludedAccounts(
  local: BrokerExcludedAccount[] | undefined,
  pulled: unknown,
  synced: unknown,
): BrokerExcludedAccount[] | undefined {
  const incoming = readExcludedAccounts(pulled);
  if (!incoming) return local;
  if (!local || sameExcludedAccounts(local, readExcludedAccounts(synced))) {
    return sameExcludedAccounts(local, incoming) && local ? local : incoming;
  }
  return local;
}

/** The entries of a pulled list that carry an id. */
export function idEntries(entries: unknown): Array<{ id: string }> {
  return Array.isArray(entries)
    ? entries.flatMap((entry) => (isRecord(entry) && typeof entry.id === "string" ? [{ id: entry.id }] : []))
    : [];
}

export function idsOf(entries: unknown[]): Set<string> {
  return new Set(entries.flatMap((entry) => (isRecord(entry) && typeof entry.id === "string" ? [entry.id] : [])));
}

/**
 * Takes the pulled profiles when this device has not changed its own since it
 * last synced. When it has (a broker sync alone moves `lastSyncedAt`), it keeps
 * its own, but profile by profile against the ones it last synced (`synced`):
 * one removed on another device goes, one removed here stays gone, and one
 * added elsewhere arrives. Keeping the whole list instead pushed a profile
 * removed elsewhere back to every device.
 *
 * An older build that changed its own profiles pushes its whole list, without
 * a profile added here since it last pulled, so only a list merged the same
 * way (`removalsCount`) can remove one: the profile's settings never sync and
 * would be lost for good.
 *
 * Which accounts a profile leaves out merges on its own even then
 * (`mergedExcludedAccounts`): a choice made on another device arrives at once,
 * not once this device stops changing its profiles, and this device's next
 * push carries it instead of dropping it from the account's copy.
 */
export function mergeBrokerInstances(
  local: BrokerInstanceConfig[],
  incoming: Array<Partial<BrokerInstanceConfig>>,
  localUnchanged: boolean,
  synced: readonly unknown[] | null,
  removalsCount: boolean,
): BrokerInstanceConfig[] {
  const localById = new Map(local.map((instance) => [instance.id, instance]));
  const fromIncoming = (instance: Partial<BrokerInstanceConfig>): BrokerInstanceConfig => {
    const current = instance.id ? localById.get(instance.id) : undefined;
    return {
      id: instance.id ?? current?.id ?? crypto.randomUUID(),
      brokerType: instance.brokerType ?? current?.brokerType ?? "",
      label: instance.label ?? current?.label ?? "",
      connectionMode: instance.connectionMode ?? current?.connectionMode,
      enabled: instance.enabled ?? current?.enabled,
      lastSyncedAt: instance.lastSyncedAt ?? current?.lastSyncedAt,
      // A device that predates the choice sends none: the one made here stays.
      ...withExcludedAccounts(readExcludedAccounts(instance.excludedAccounts) ?? current?.excludedAccounts),
      config: current?.config ?? {},
    };
  };
  if (localUnchanged) return incoming.map(fromIncoming);

  const pulledById = new Map(incoming.flatMap((instance) => (
    typeof instance.id === "string" ? [[instance.id, instance] as const] : []
  )));
  const syncedById = new Map((synced ?? []).flatMap((entry) => (
    isRecord(entry) && typeof entry.id === "string" ? [[entry.id, entry] as const] : []
  )));
  let choiceMerged = false;
  const merged = local.map((instance) => {
    const pulled = pulledById.get(instance.id);
    if (!pulled) return instance;
    const excludedAccounts = mergedExcludedAccounts(
      instance.excludedAccounts,
      pulled.excludedAccounts,
      syncedById.get(instance.id)?.excludedAccounts,
    );
    if (excludedAccounts === instance.excludedAccounts) return instance;
    choiceMerged = true;
    return { ...instance, ...withExcludedAccounts(excludedAccounts) };
  });
  const current = choiceMerged ? merged : local;
  if (!synced) return current;

  const incomingIds = idsOf(incoming);
  const kept = removalsCount
    ? current.filter((instance) => incomingIds.has(instance.id) || !syncedById.has(instance.id))
    : current;
  const added = incoming.filter((instance) => (
    typeof instance.id === "string" && !localById.has(instance.id) && !syncedById.has(instance.id)
  ));
  return kept.length === current.length && added.length === 0 ? current : [...kept, ...added.map(fromIncoming)];
}

/**
 * A broker portfolio goes with a profile the pull removed, unless the pulled
 * portfolios still list it: another device handed it to a profile it kept.
 * Only a profile this device had synced counts as removed elsewhere.
 */
export function withoutRemovedBrokerPortfolios(
  config: AppConfig,
  next: AppConfig,
  syncedIds: ReadonlySet<string>,
  pulledPortfolios: unknown,
): Portfolio[] {
  const remaining = new Set(next.brokerInstances.map((instance) => instance.id));
  const removed = new Set(config.brokerInstances.flatMap((instance) => (
    syncedIds.has(instance.id) && !remaining.has(instance.id) ? [instance.id] : []
  )));
  if (removed.size === 0) return next.portfolios;
  const pulledIds = Array.isArray(pulledPortfolios) ? idsOf(pulledPortfolios) : new Set<string>();
  const portfolios = next.portfolios.filter((portfolio) => (
    !portfolio.brokerInstanceId || !removed.has(portfolio.brokerInstanceId) || pulledIds.has(portfolio.id)
  ));
  return portfolios.length === next.portfolios.length ? next.portfolios : portfolios;
}

interface RemovedBrokerHoldings {
  instanceIds: ReadonlySet<string>;
  portfolioIds: ReadonlySet<string>;
}

/** The profiles a pull removed, and the portfolios that went with them. */
export function removedBrokerHoldings(before: AppConfig, after: AppConfig): RemovedBrokerHoldings | null {
  const remaining = new Set(after.brokerInstances.map((instance) => instance.id));
  const instanceIds = new Set(before.brokerInstances.flatMap((instance) => (
    remaining.has(instance.id) ? [] : [instance.id]
  )));
  if (instanceIds.size === 0) return null;
  const keptPortfolios = new Set(after.portfolios.map((portfolio) => portfolio.id));
  const portfolioIds = new Set(before.portfolios.flatMap((portfolio) => (
    portfolio.brokerInstanceId && instanceIds.has(portfolio.brokerInstanceId) && !keptPortfolios.has(portfolio.id)
      ? [portfolio.id]
      : []
  )));
  return { instanceIds, portfolioIds };
}

/**
 * The ticker as the removal on the other device left it: without the removed
 * profiles' positions and contracts, or its place in their portfolios. Null
 * when nothing is left to keep, as that removal deleted it; the same record
 * when the removal did not touch it.
 */
export function withoutRemovedBrokerHoldings(ticker: TickerRecord, removed: RemovedBrokerHoldings): TickerRecord | null {
  const { metadata } = ticker;
  const positions = metadata.positions.filter((position) => (
    !(position.brokerInstanceId && removed.instanceIds.has(position.brokerInstanceId))
    && !removed.portfolioIds.has(position.portfolio)
  ));
  const portfolios = metadata.portfolios.filter((portfolioId) => !removed.portfolioIds.has(portfolioId));
  const contracts = (metadata.broker_contracts ?? []).filter((contract) => (
    !(contract.brokerInstanceId && removed.instanceIds.has(contract.brokerInstanceId))
  ));
  if (
    positions.length === metadata.positions.length
    && portfolios.length === metadata.portfolios.length
    && contracts.length === (metadata.broker_contracts ?? []).length
  ) {
    return ticker;
  }
  const empty = positions.length === 0
    && portfolios.length === 0
    && contracts.length === 0
    && metadata.watchlists.length === 0
    && metadata.tags.length === 0
    && Object.keys(metadata.custom).length === 0;
  if (empty) return null;
  return { ...ticker, metadata: { ...metadata, positions, portfolios, broker_contracts: contracts } };
}
