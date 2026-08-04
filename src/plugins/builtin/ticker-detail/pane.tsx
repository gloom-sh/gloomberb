import { Box } from "../../../ui";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { PaneProps, TickerResearchTabDef } from "../../../types/plugin";
import { t, tf } from "../../../i18n";
import { quoteSubscriptionTargetFromTicker } from "../../../market-data/request-types";
import {
  useAppDispatch,
  useAppSelector,
  usePaneCollection,
  usePaneInstance,
  usePaneStateValue,
  usePaneTicker,
} from "../../../state/app/context";
import { useQuoteUpdates } from "../../../state/hooks/quote-streaming";
import { getCollectionName, getCollectionTickerCount } from "../../../state/selectors";
import { getSharedRegistry } from "../../registry";
import { EmptyState, PaneFooterScope, Tabs } from "../../../components";
import { useThrottledCommitValue } from "../../../react/use-throttled-commit-value";
import { resolveOptionsTarget } from "../../../utils/options";
import {
  buildVisibleTickerResearchTabs,
  getTickerResearchPaneSettings,
  resolveLockedTabId,
} from "./settings";
import { useLiveStreamingSetting } from "../shared/live-streaming";

const TICKER_RESEARCH_TAB_COMMIT_DELAY_MS = 120;

function sameStringSet(left: Set<string>, right: Set<string>): boolean {
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}

function registryTickerResearchTabsSnapshot(registry: ReturnType<typeof getSharedRegistry>): string {
  if (!registry) return "";
  return [...registry.tickerResearchTabs.values()]
    .map((tab) => `${tab.id}:${tab.name}:${tab.order}:${registry.getTickerResearchTabPluginId?.(tab.id) ?? ""}`)
    .join("\0");
}

function useRegistryTickerResearchTabsSnapshot(registry: ReturnType<typeof getSharedRegistry>): string {
  const subscribe = useCallback((onStoreChange: () => void) => {
    const events = registry?.events;
    if (!events) return () => {};
    const unregisterRegistered = events.on("plugin:registered", onStoreChange);
    const unregisterUnregistered = events.on("plugin:unregistered", onStoreChange);
    return () => {
      unregisterRegistered();
      unregisterUnregistered();
    };
  }, [registry]);

  const getSnapshot = useCallback(() => registryTickerResearchTabsSnapshot(registry), [registry]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function TickerResearchPane({ focused, width, height }: PaneProps) {
  const dispatch = useAppDispatch();
  const config = useAppSelector((state) => state.config);
  const paneInstance = usePaneInstance();
  const { ticker, financials } = usePaneTicker();
  const liveStreaming = useLiveStreamingSetting();
  const streamingTarget = quoteSubscriptionTargetFromTicker(ticker, ticker?.metadata.ticker, "provider");
  const streamingTargets = useMemo(() => (
    streamingTarget
      ? [{
        ...streamingTarget,
        surface: "detail" as const,
        visible: true,
        selected: true,
        weight: 100,
      }]
      : []
  ), [
    streamingTarget?.symbol,
    streamingTarget?.exchange,
    streamingTarget?.route,
    streamingTarget?.context?.brokerId,
    streamingTarget?.context?.brokerInstanceId,
    streamingTarget?.context?.instrument,
  ]);
  useQuoteUpdates(streamingTargets, { liveStreaming });

  const { collectionId } = usePaneCollection();
  const [committedActiveTabId, setCommittedActiveTabId] = usePaneStateValue<string>("activeTabId", "overview");
  const {
    value: activeTabId,
    setValue: setActiveTabId,
  } = useThrottledCommitValue(
    committedActiveTabId,
    setCommittedActiveTabId,
    TICKER_RESEARCH_TAB_COMMIT_DELAY_MS,
    { commitPendingOnUnmount: true },
  );
  const [pluginCaptured, setPluginCaptured] = useState(false);
  const [mountedTabIds, setMountedTabIds] = useState<Set<string>>(() => new Set());
  const paneSettings = getTickerResearchPaneSettings(paneInstance?.settings);
  const hasOptionsChain = !!resolveOptionsTarget(ticker)?.effectiveTicker;
  const collectionTickerCount = useAppSelector((state) => getCollectionTickerCount(state, collectionId));
  const collectionName = useAppSelector((state) => getCollectionName(state, collectionId));

  const disabledPlugins = config.disabledPlugins;
  const registry = getSharedRegistry();
  const tickerResearchTabsSnapshot = useRegistryTickerResearchTabsSnapshot(registry);
  const tickerResearchTabs = useMemo<TickerResearchTabDef[]>(() => (
    registry
      ? [...registry.tickerResearchTabs.values()].filter((tab) => {
        const ownerId = registry.getTickerResearchTabPluginId?.(tab.id);
        return !ownerId || !disabledPlugins.includes(ownerId);
      })
      : []
  ), [disabledPlugins, registry, tickerResearchTabsSnapshot]);
  const allTabs = buildVisibleTickerResearchTabs(tickerResearchTabs, ticker, financials, {
    config,
    hasOptionsChain,
  });
  const resolvedTabId = paneSettings.hideTabs
    ? resolveLockedTabId(paneSettings, allTabs)
    : (allTabs.some((tab) => tab.id === activeTabId) ? activeTabId : (allTabs[0]?.id ?? "overview"));
  const tabBarHeight = paneSettings.hideTabs ? 0 : 1;
  const contentHeight = Math.max(1, height - tabBarHeight);
  const visibleTabIdKey = allTabs.map((tab) => tab.id).join("\0");
  const visibleTabIds = useMemo(() => new Set(allTabs.map((tab) => tab.id)), [visibleTabIdKey]);
  const renderedTabIds = useMemo(() => {
    const next = new Set<string>();
    for (const tabId of mountedTabIds) {
      if (visibleTabIds.has(tabId)) next.add(tabId);
    }
    if (visibleTabIds.has(resolvedTabId)) {
      next.add(resolvedTabId);
    }
    return next;
  }, [mountedTabIds, resolvedTabId, visibleTabIds]);

  const handlePluginCapture = useCallback((capturing: boolean) => {
    setPluginCaptured(capturing);
    dispatch({ type: "SET_INPUT_CAPTURED", captured: capturing });
  }, [dispatch]);
  const ignorePluginCapture = useCallback(() => {}, []);

  useEffect(() => {
    setPluginCaptured(false);
    dispatch({ type: "SET_INPUT_CAPTURED", captured: false });
  }, [resolvedTabId, dispatch]);

  useEffect(() => {
    setMountedTabIds((current) => {
      const next = new Set<string>();
      for (const tabId of current) {
        if (visibleTabIds.has(tabId)) next.add(tabId);
      }
      if (visibleTabIds.has(resolvedTabId)) {
        next.add(resolvedTabId);
      }
      return sameStringSet(current, next) ? current : next;
    });
  }, [resolvedTabId, visibleTabIds]);

  if (!ticker) {
    const isEmptyFollowCollection = paneInstance?.binding?.kind === "follow" && !!collectionId && collectionTickerCount === 0;
    const message = isEmptyFollowCollection
      ? tf("No tickers in {name}.", { name: collectionName || t("this collection") })
      : t("No ticker selected.");

    return (
      <Box flexDirection="column" flexGrow={1} paddingX={1}>
        <EmptyState title={message} />
      </Box>
    );
  }

  return (
    <Box flexDirection="column" flexGrow={1} flexBasis={0} overflow="hidden">
      {!paneSettings.hideTabs && (
        <Tabs
          tabs={allTabs.map((tab) => ({ label: t(tab.name), value: tab.id }))}
          activeValue={resolvedTabId}
          onSelect={setActiveTabId}
          focused={focused && !pluginCaptured}
        />
      )}

      <Box height={contentHeight} flexGrow={1} flexBasis={0} overflow="hidden">
        {tickerResearchTabs.map((tab) => {
          if (!renderedTabIds.has(tab.id) || !visibleTabIds.has(tab.id)) return null;
          const TickerResearchTab = tab.component;
          const isActive = resolvedTabId === tab.id;
          return (
            <Box
              key={tab.id}
              visible={isActive}
              flexDirection="column"
              flexGrow={1}
              flexBasis={0}
              height={contentHeight}
              overflow="hidden"
            >
              <PaneFooterScope active={isActive}>
                <TickerResearchTab
                  width={width}
                  height={contentHeight}
                  focused={focused && isActive}
                  onCapture={isActive ? handlePluginCapture : ignorePluginCapture}
                />
              </PaneFooterScope>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
