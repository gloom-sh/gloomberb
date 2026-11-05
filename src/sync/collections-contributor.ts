import { saveConfigImmediately } from "../state/config-save-scheduler";
import type { AppConfig } from "../types/config";
import type { TickerFinancials } from "../types/financials";
import type { TickerRecord } from "../types/ticker";
import type { BrokerAccount } from "../types/trading";
import { hydrateTickerMetadata } from "../tickers/metadata";
import type { SyncContributor } from "./types";
import { isRecord, recordOrNull } from "../utils/guards";
import { withoutMissingWatchlists } from "../portfolio/mutations";
import { mergeSuffixedListings, moveTargetWeights } from "../portfolio/suffixed-listings";
import { knownBrokerHoldings } from "../brokers/broker-portfolio-sync";
import {
  localOnlyScope,
  publicConfig,
  publicMarketData,
  publicTickers,
} from "./local-only";
import {
  collectAccountsByPortfolio,
  collectAnalyticsByPortfolio,
  hydrateProfileAnalytics,
  loadHoldingExchangeRates,
} from "./analytics-payload";
import { idEntries } from "./broker-instances";
import { CORE_CONFIG_CONTRIBUTOR_ID, log } from "./config-contributor";
import { sanitizePortfolio, sanitizeWatchlist } from "./sanitize";
import {
  lastSyncedTickersById,
  latestBrokerPortfolioSyncs,
  mergePulledTicker,
  sameAsStored,
  withoutUnpulledHoldings,
  type PulledTickersMerge,
} from "./ticker-merge";
import { isSyncableTicker, sanitizeTickerMetadata } from "./ticker-payload";

export function collectCoreCollectionsPayload(
  config: AppConfig,
  tickers: Map<string, TickerRecord>,
  financials: Map<string, TickerFinancials>,
  exchangeRates: Map<string, number>,
  brokerAccounts: Record<string, BrokerAccount[]>,
  /** The financials whose quotes may be uploaded: without those a source that keeps its market data local supplied. */
  quoted: Map<string, TickerFinancials> = financials,
) {
  const records = [...tickers.values()]
    .map((ticker) => sanitizeTickerMetadata(ticker.metadata, quoted.get(ticker.metadata.ticker)))
    .filter(isSyncableTicker);

  // Only the USD anchor goes on the wire, as before: readers of the snapshot
  // use any rate found here instead of fetching a current one, and a rate
  // loaded for this push would age with it.
  return {
    baseCurrency: config.baseCurrency,
    exchangeRates: { USD: 1 },
    portfolios: config.portfolios.map(sanitizePortfolio),
    watchlists: config.watchlists.map(sanitizeWatchlist),
    analyticsByPortfolio: collectAnalyticsByPortfolio(config, tickers, financials, exchangeRates, brokerAccounts),
    accountsByPortfolio: collectAccountsByPortfolio(config, brokerAccounts),
    tickers: records,
  };
}

export const coreCollectionsSyncContributor: SyncContributor = {
  id: "core.collections",
  schemaVersion: 1,
  collect: async ({ state, isLocalMarketData }) => {
    // Connections the user keeps on this device stay here, with their portfolios, account values and
    // positions; so do the quotes and bars of a source that keeps its market data local.
    const scope = localOnlyScope(state.config);
    const config = publicConfig(state.config, scope);
    const tickers = publicTickers(state.tickers, scope);
    return collectCoreCollectionsPayload(
      config,
      tickers,
      state.financials,
      await loadHoldingExchangeRates(config, tickers, state.financials),
      state.brokerAccounts,
      publicMarketData(state.financials, isLocalMarketData),
    );
  },
  apply: async (payload, { snapshot, baselinePayload, baselineState, getState, isCurrent, dispatch, tickerRepository }) => {
    if (!isRecord(payload)) return;
    const scope = localOnlyScope(getState().config);
    hydrateProfileAnalytics(payload);
    if (!isCurrent()) return;
    // The config contributor applies first, so this is the config this pull left.
    const state = getState();
    const pulledConfig = recordOrNull(snapshot?.contributors[CORE_CONFIG_CONTRIBUTOR_ID]?.payload);
    const pulledPortfolios = Array.isArray(payload.portfolios) ? payload.portfolios : pulledConfig?.portfolios;
    // A copy without its ticker list says nothing of what any portfolio holds:
    // a later sync stamp there must not take this device's broker positions.
    const pulledTickers = Array.isArray(payload.tickers) ? payload.tickers : null;
    const merge: PulledTickersMerge = {
      lastSyncedTickers: lastSyncedTickersById(baselinePayload),
      brokerPortfolios: pulledTickers
        ? latestBrokerPortfolioSyncs(baselineState.config, state.config, pulledPortfolios)
        : new Map(),
      // A broker portfolio the pull still lists may only exist on another device: it stays.
      known: knownBrokerHoldings(state.config, {
        portfolios: [pulledPortfolios, pulledConfig?.portfolios].flatMap(idEntries),
        brokerInstances: idEntries(pulledConfig?.brokerInstances),
      }),
      localOnly: scope,
    };
    // Tickers here and pulled ones drop the ids of any watchlist that is gone
    // (removed elsewhere, or deleted by an older build that left its id on the
    // tickers), so this device never pushes them back.
    const watchlistIds = new Set(state.config.watchlists.map((watchlist) => watchlist.id));

    // Merged and handed to the app in one go, with no wait in between, so a
    // broker sync committing meanwhile is not overwritten with an older row.
    const nextTickers = new Map(state.tickers);
    const changed: TickerRecord[] = [];
    const pulledSymbols = new Set<string>();
    for (const rawTicker of pulledTickers ?? []) {
      if (!isRecord(rawTicker) || typeof rawTicker.ticker !== "string") continue;
      pulledSymbols.add(rawTicker.ticker);
      const current = state.tickers.get(rawTicker.ticker);
      const record = withoutMissingWatchlists(mergePulledTicker(current, rawTicker, merge), watchlistIds);
      if (current ? sameAsStored(record.metadata, hydrateTickerMetadata({ ...current.metadata })) : !isSyncableTicker(record.metadata)) continue;
      nextTickers.set(record.metadata.ticker, record);
      changed.push(record);
    }
    for (const ticker of state.tickers.values()) {
      if (pulledSymbols.has(ticker.metadata.ticker)) continue;
      const kept = withoutUnpulledHoldings(ticker, merge) ?? ticker;
      const next = withoutMissingWatchlists(kept, watchlistIds);
      if (next === ticker) continue;
      nextTickers.set(next.metadata.ticker, next);
      changed.push(next);
    }
    const suffixed = mergePulledSuffixedListings(nextTickers, changed, state.config);
    if (changed.length === 0 && !suffixed.config) return;
    if (suffixed.config) dispatch({ type: "SET_CONFIG", config: suffixed.config });
    if (changed.length > 0) dispatch({ type: "SET_TICKERS", tickers: nextTickers });
    // The moved targets first, so a stop before the rows strands none on an emptied key.
    if (suffixed.config) await saveConfigImmediately(suffixed.config);
    // Written one at a time, so an edit or a broker sync can replace a row
    // before its turn. That copy is newer and its writer saves it; this one
    // written over it would come back at launch as an edit and be pushed.
    for (const record of changed) {
      if (getState().tickers.get(record.metadata.ticker) !== record) continue;
      await tickerRepository.saveTicker(record);
    }
  },
};

/**
 * An older build still files lots under a vendor's suffixed key (GARAN.IS)
 * and pushes them: pulled, they merge into the listing's row here as at
 * launch (`mergeSuffixedListings`), each lot once, so they never count in
 * both rows or go back out under the old key. The merged rows replace their
 * entries in `tickers` and `changed`; the config comes back with targets
 * moved, or null when none moved.
 */
function mergePulledSuffixedListings(
  tickers: Map<string, TickerRecord>,
  changed: TickerRecord[],
  config: AppConfig,
): { config: AppConfig | null } {
  const merged = mergeSuffixedListings([...tickers.values()]);
  if (!merged) return { config: null };
  for (const row of merged.saves) {
    tickers.set(row.metadata.ticker, row);
    const at = changed.findIndex((record) => record.metadata.ticker === row.metadata.ticker);
    if (at >= 0) changed[at] = row;
    else changed.push(row);
  }
  for (const kept of merged.keptCustom) log.info("sync.suffixed-listing.custom-kept", kept);
  const next = moveTargetWeights(config, merged.moved);
  return { config: next === config ? null : next };
}
