import { findPaneInstance, type AppConfig } from "../../types/config";
import type { BrokerContractRef } from "../../types/instrument";
import type { TickerRecord } from "../../types/ticker";
import { getDockedPaneIds } from "../../plugins/pane-manager";
import { normalizeBuiltinPaneStatePluginOwners } from "../../plugins/ownership";
import { canonicalExchange, normalizeSymbol } from "../../utils/exchanges";
import { instrumentFromTicker } from "../../market-data/request-types";
import { instrumentIdentityKey } from "../../utils/instrument-identity";
import { hasAmbiguousTickerContracts, resolveInstrumentForPane } from "./app/instrument";
import { resolveCollectionForPane } from "./app/layout";
import type { AppState } from "./app/types";

export const APP_SESSION_SCHEMA_VERSION = 1;
export const APP_SESSION_ID = "app";

interface HydrationTarget {
  symbol: string;
  exchange?: string;
  brokerId?: string;
  brokerInstanceId?: string;
  instrument?: BrokerContractRef | null;
}

export interface AppSessionSnapshot {
  paneState: Record<string, Record<string, unknown>>;
  focusedPaneId: string | null;
  activePanel: "left" | "right";
  statusBarVisible: boolean;
  openPaneIds: string[];
  hydrationTargets: HydrationTarget[];
  exchangeCurrencies: string[];
  savedAt: number;
}

interface SessionStateInput {
  config: AppConfig;
  paneState: Record<string, Record<string, unknown>>;
  focusedPaneId: string | null;
  activePanel: "left" | "right";
  statusBarVisible: boolean;
  recentTickers: string[];
  tickers: Map<string, TickerRecord>;
  exchangeRates: Map<string, number>;
}

function normalizeHydrationTarget(target: HydrationTarget): HydrationTarget {
  return {
    symbol: normalizeSymbol(target.symbol),
    exchange: target.exchange ? canonicalExchange(target.exchange) : undefined,
    brokerId: target.brokerId,
    brokerInstanceId: target.brokerInstanceId,
    instrument: target.instrument ?? null,
  };
}

function hydrationTargetKey(target: HydrationTarget): string {
  return instrumentIdentityKey(normalizeHydrationTarget(target));
}

function tickerInCollection(ticker: TickerRecord, collectionId: string | null): boolean {
  if (!collectionId) return false;
  return ticker.metadata.portfolios.includes(collectionId)
    || ticker.metadata.watchlists.includes(collectionId);
}

export function buildAppSessionSnapshot(state: SessionStateInput): AppSessionSnapshot {
  const seen = new Set<string>();
  const hydrationTargets: HydrationTarget[] = [];
  const exchangeCurrencies = [...new Set(
    [...state.exchangeRates.keys()]
      .map((currency) => currency.trim().toUpperCase())
      .filter(Boolean),
  )];

  const pushTarget = (input: HydrationTarget | null | undefined) => {
    if (!input) return;
    const target = normalizeHydrationTarget(input);
    if (!state.tickers.has(target.symbol)) return;
    const key = hydrationTargetKey(target);
    if (seen.has(key)) return;
    seen.add(key);
    hydrationTargets.push(target);
  };

  for (const symbol of state.recentTickers) {
    const ticker = state.tickers.get(symbol);
    if (ticker && !hasAmbiguousTickerContracts(ticker)) pushTarget(instrumentFromTicker(ticker));
  }

  for (const instance of state.config.layout.instances) {
    pushTarget(resolveInstrumentForPane(state, instance.instanceId));
    if (instance.paneId === "portfolio-list") {
      const collectionId = resolveCollectionForPane(state as AppState, instance.instanceId);
      for (const ticker of state.tickers.values()) {
        if (tickerInCollection(ticker, collectionId)) {
          pushTarget(resolveInstrumentForPane({ ...state, paneState: {
            ...state.paneState,
            [instance.instanceId]: { ...state.paneState[instance.instanceId], cursorSymbol: ticker.metadata.ticker },
          } }, instance.instanceId));
        }
      }
    }
  }

  return {
    paneState: Object.fromEntries(
      Object.entries(state.paneState)
        .filter(([paneId]) => !!findPaneInstance(state.config.layout, paneId))
        .map(([paneId, value]) => [paneId, { ...value }]),
    ),
    focusedPaneId: state.focusedPaneId,
    activePanel: state.activePanel,
    statusBarVisible: state.statusBarVisible,
    openPaneIds: [
      ...getDockedPaneIds(state.config.layout),
      ...state.config.layout.floating.map((entry) => entry.instanceId),
    ],
    hydrationTargets,
    exchangeCurrencies,
    savedAt: Date.now(),
  };
}

export function reconcileAppSessionSnapshot(
  config: AppConfig,
  snapshot: AppSessionSnapshot | null | undefined,
): AppSessionSnapshot | null {
  if (!snapshot) return null;

  const validPaneIds = new Set(config.layout.instances.map((instance) => instance.instanceId));
  const validBrokerInstanceIds = new Set(config.brokerInstances.map((instance) => instance.id));
  const paneState = normalizeBuiltinPaneStatePluginOwners(Object.fromEntries(
    Object.entries(snapshot.paneState ?? {}).filter(([paneId]) => validPaneIds.has(paneId)),
  ));
  const openPaneIds = (snapshot.openPaneIds ?? []).filter((paneId) => validPaneIds.has(paneId));
  const defaultOpenPaneId = getDockedPaneIds(config.layout)[0] ?? config.layout.floating[0]?.instanceId ?? null;
  const focusedPaneId = snapshot.focusedPaneId && validPaneIds.has(snapshot.focusedPaneId)
    ? snapshot.focusedPaneId
    : openPaneIds[0] ?? defaultOpenPaneId;
  const hydrationTargets = (snapshot.hydrationTargets ?? [])
    .map(normalizeHydrationTarget)
    .filter((target) => !target.brokerInstanceId || validBrokerInstanceIds.has(target.brokerInstanceId));

  return {
    paneState,
    focusedPaneId,
    activePanel: snapshot.activePanel === "right" ? "right" : "left",
    statusBarVisible: snapshot.statusBarVisible !== false,
    openPaneIds,
    hydrationTargets,
    exchangeCurrencies: [...new Set(
      (snapshot.exchangeCurrencies ?? [])
        .map((currency) => currency.trim().toUpperCase())
        .filter(Boolean),
    )],
    savedAt: typeof snapshot.savedAt === "number" ? snapshot.savedAt : Date.now(),
  };
}
