import { saveConfigImmediately, scheduleConfigSave } from "../state/config-save-scheduler";
import { persistTickerCleanup } from "../state/ticker-cleanup";
import { hasPendingTickerWrites } from "../data/ticker-writes";
import { debugLog } from "../utils/debug-log";
import type { AppConfig } from "../types/config";
import type { SyncContributor } from "./types";
import { isRecord } from "../utils/guards";
import { reportTelemetryConfig } from "../telemetry/live-config";
import { localOnlyScope, publicConfig } from "./local-only";
import { removedBrokerHoldings, withoutRemovedBrokerHoldings } from "./broker-instances";
import { collectCoreConfigPayload, mergeConfigPayload, valuesEqual } from "./config-merge";
import { noteLayoutEdit, rememberCloudLayout, withLayoutProvenance } from "./layout-merge";

export const log = debugLog.createLogger("sync");

export const CORE_CONFIG_CONTRIBUTOR_ID = "core.config";

export const coreConfigSyncContributor: SyncContributor = {
  id: CORE_CONFIG_CONTRIBUTOR_ID,
  schemaVersion: 1,
  collect: ({ state, baselinePayload, memo }) => withLayoutProvenance(
    collectCoreConfigPayload(publicConfig(state.config, localOnlyScope(state.config))) as Record<string, unknown>,
    baselinePayload,
    memo?.get(),
  ),
  observe: ({ state, baselinePayload, memo, launch }) => {
    const edit = noteLayoutEdit(state.config, baselinePayload, memo.get(), launch);
    if (edit) memo.set(edit);
  },
  apply: async (payload, { snapshot, baselinePayload, baselineState, state, getState, isCurrent, dispatch, tickerRepository, memo }) => {
    const pushedAt = snapshot?.contributors[CORE_CONFIG_CONTRIBUTOR_ID]?.updatedAt;
    const merge = (config: AppConfig) => mergeConfigPayload(config, payload, baselineState.config, baselinePayload, {
      memo: memo?.get(),
      pushedAt,
    }, localOnlyScope(config));
    let nextConfig = merge(state.config);
    if (!nextConfig) return;
    const removed = removedBrokerHoldings(state.config, nextConfig);
    if (removed) {
      // Keep the profile until row and config writes succeed, so a failed
      // cleanup remains visible to the next attempt.
      const cleanTickers = () => persistTickerCleanup({
        tickerRepository,
        getTickers: () => getState().tickers,
        transform: (ticker) => withoutRemovedBrokerHoldings(ticker, removed),
        publish: (symbol, ticker) => {
          const tickers = new Map(getState().tickers);
          if (ticker) tickers.set(symbol, ticker);
          else tickers.delete(symbol);
          dispatch({ type: "SET_TICKERS", tickers });
        },
        isCurrent,
      });
      let savedRemoval = false;
      for (;;) {
        const cleaned = await cleanTickers().catch(async (error: unknown) => {
          // Restore the profile if a late row fails after config was saved,
          // so retry can also recover after restarting the app.
          if (savedRemoval) await saveConfigImmediately(getState().config);
          throw error;
        });
        if (!cleaned || !isCurrent()) return;
        if (hasPendingTickerWrites(tickerRepository) || getState().tickers !== cleaned) continue;
        const source = getState().config;
        const merged = merge(source);
        if (!merged) return;
        // Preserve unrelated edits while retaining the removal already applied
        // to rows, including pulls from builds that merged whole profile lists.
        nextConfig = {
          ...merged,
          brokerInstances: merged.brokerInstances.filter((instance) => !removed.instanceIds.has(instance.id)),
          portfolios: merged.portfolios.filter((portfolio) => !removed.portfolioIds.has(portfolio.id)),
        };
        await saveConfigImmediately(nextConfig);
        savedRemoval = true;
        if (!isCurrent()) return;
        if (getState().config !== source || getState().tickers !== cleaned
          || hasPendingTickerWrites(tickerRepository)) continue;
        break;
      }
    }
    const configChanged = !valuesEqual(nextConfig, getState().config);
    if (configChanged) {
      // Adopting another device's workspace rearranges the screen under the
      // user, so it is worth a line in the log when a report says "my panes
      // moved on their own".
      if (nextConfig.layout !== state.config.layout) {
        log.info("config.layout.adopted", {
          panes: nextConfig.layout.instances.length,
          activeLayoutIndex: nextConfig.activeLayoutIndex,
        });
      }
      // An Attention Counts off from another device drops unsent counts before React commits.
      if (nextConfig.telemetry !== getState().config.telemetry) reportTelemetryConfig(nextConfig.telemetry);
      dispatch({ type: "SET_CONFIG", config: nextConfig });
      if (!removed) scheduleConfigSave(nextConfig);
    }
    if (memo && isRecord(payload)) rememberCloudLayout(payload, pushedAt, getState().config, memo, nextConfig.layouts !== state.config.layouts);
  },
};
