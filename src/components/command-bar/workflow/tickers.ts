import type { Dispatch } from "react";
import type { AppAction, AppState } from "../../../state/app/context";
import type { AppTickerRepositoryPort } from "../../../core/app-service-ports";
import type { PluginRegistry } from "../../../plugins/registry";
import { isManualPortfolio } from "../../../plugins/builtin/portfolio-list/mutations";
import type { DataProvider } from "../../../types/data-provider";
import type { Portfolio, TickerRecord, Watchlist } from "../../../types/ticker";
import { resolveTickerSearch, upsertTickerFromSearchResult } from "../../../tickers/search";
import { parseTickerListInput } from "../../../tickers/list";

export interface SharedWorkflowDeps {
  dataProvider: DataProvider;
  tickerRepository: AppTickerRepositoryPort;
  pluginRegistry: PluginRegistry;
  dispatch: Dispatch<AppAction>;
  getState: () => AppState;
}

export type CollectionKind = "watchlist" | "portfolio";
export type CollectionMembershipAction = "add" | "remove";

interface CollectionTargetOption {
  id: string;
  label: string;
  description?: string;
}

interface ResolvedTickerInput {
  symbol: string;
  ticker: TickerRecord;
  created: boolean;
  source: "local" | "provider";
}

function getTickerSearchContext(state: AppState, collectionId: string | null) {
  const activePortfolio = state.config.portfolios.find((portfolio) => portfolio.id === collectionId);
  return {
    preferBroker: true,
    interactive: true,
    brokerId: activePortfolio?.brokerId,
    brokerInstanceId: activePortfolio?.brokerInstanceId,
  };
}

async function materializeResolvedTicker(
  resolvedTicker: NonNullable<Awaited<ReturnType<typeof resolveTickerSearch>>>,
  deps: SharedWorkflowDeps,
): Promise<ResolvedTickerInput> {
  if (resolvedTicker.kind === "local") {
    return {
      symbol: resolvedTicker.ticker.metadata.ticker,
      ticker: resolvedTicker.ticker,
      created: false,
      source: "local",
    };
  }

  const { ticker, created } = await upsertTickerFromSearchResult(
    deps.tickerRepository,
    resolvedTicker.result,
  );
  deps.dispatch({ type: "UPDATE_TICKER", ticker });
  if (created) {
    deps.pluginRegistry.events.emit("ticker:added", {
      symbol: ticker.metadata.ticker,
      ticker,
    });
  }

  return {
    symbol: ticker.metadata.ticker,
    ticker,
    created,
    source: "provider",
  };
}

function getCollectionOptions(
  state: AppState,
  kind: CollectionKind,
): Array<Portfolio | Watchlist> {
  if (kind === "watchlist") {
    return state.config.watchlists;
  }
  return state.config.portfolios.filter(isManualPortfolio);
}

export function getCollectionTargetOptions(
  state: AppState,
  kind: CollectionKind,
  action: CollectionMembershipAction,
  ticker: TickerRecord | null,
): CollectionTargetOption[] {
  const collections = getCollectionOptions(state, kind);
  const membershipIds = ticker
    ? new Set(kind === "watchlist" ? ticker.metadata.watchlists : ticker.metadata.portfolios)
    : new Set<string>();

  return collections
    .filter((collection) => {
      if (!ticker) return true;
      const isMember = membershipIds.has(collection.id);
      return action === "add" ? !isMember : isMember;
    })
    .map((collection) => ({
      id: collection.id,
      label: collection.name,
      description: action === "add"
        ? `Add to "${collection.name}"`
        : `Remove from "${collection.name}"`,
    }));
}

export function resolvePreferredCollectionTarget(
  state: AppState,
  kind: CollectionKind,
  activeCollectionId: string | null,
  action: CollectionMembershipAction,
  ticker: TickerRecord | null,
): string | null {
  if (!activeCollectionId) return null;
  const options = getCollectionTargetOptions(state, kind, action, ticker);
  return options.some((option) => option.id === activeCollectionId) ? activeCollectionId : null;
}

export function resolveSoleCollectionTarget(
  state: AppState,
  kind: CollectionKind,
  action: CollectionMembershipAction,
  ticker: TickerRecord | null,
): string | null {
  const options = getCollectionTargetOptions(state, kind, action, ticker);
  return options.length === 1 ? options[0]!.id : null;
}

export async function resolveTickerInput(
  rawInput: string | undefined,
  activeTicker: string | null,
  collectionId: string | null,
  deps: SharedWorkflowDeps,
): Promise<ResolvedTickerInput | null> {
  const state = deps.getState();
  const resolvedTicker = await resolveTickerSearch({
    query: rawInput,
    activeTicker,
    tickers: state.tickers,
    dataProvider: deps.dataProvider,
    searchContext: getTickerSearchContext(state, collectionId),
  });
  if (!resolvedTicker) return null;
  return materializeResolvedTicker(resolvedTicker, deps);
}

export async function resolveTickerInputOrThrow(
  rawInput: string | undefined,
  activeTicker: string | null,
  collectionId: string | null,
  deps: SharedWorkflowDeps,
): Promise<ResolvedTickerInput> {
  const resolved = await resolveTickerInput(rawInput, activeTicker, collectionId, deps);
  if (!resolved) {
    throw new Error(`No ticker match found for "${rawInput ?? activeTicker ?? ""}".`);
  }
  return resolved;
}

export async function applyCollectionMembershipChange(
  ticker: TickerRecord,
  kind: CollectionKind,
  action: CollectionMembershipAction,
  collectionId: string,
  deps: SharedWorkflowDeps,
): Promise<{ changed: boolean; ticker: TickerRecord }> {
  const field = kind === "watchlist" ? "watchlists" : "portfolios";
  const currentValues = ticker.metadata[field];
  const nextValues = action === "add"
    ? (currentValues.includes(collectionId) ? currentValues : [...currentValues, collectionId])
    : currentValues.filter((entry) => entry !== collectionId);

  if (nextValues.length === currentValues.length && nextValues.every((entry, index) => entry === currentValues[index])) {
    return { changed: false, ticker };
  }

  const nextTicker: TickerRecord = {
    ...ticker,
    metadata: {
      ...ticker.metadata,
      [field]: nextValues,
    },
  };
  await deps.tickerRepository.saveTicker(nextTicker);
  deps.dispatch({ type: "UPDATE_TICKER", ticker: nextTicker });
  return { changed: true, ticker: nextTicker };
}

export async function resolveTickerListInput(
  rawInput: string,
  collectionId: string | null,
  deps: SharedWorkflowDeps,
): Promise<string[]> {
  const tokens = parseTickerListInput(rawInput);
  const symbols: string[] = [];
  const seen = new Set<string>();

  for (const token of tokens) {
    const resolvedTicker = await resolveTickerInputOrThrow(token, null, collectionId, deps);
    const symbol = resolvedTicker.symbol;

    if (seen.has(symbol)) continue;
    seen.add(symbol);
    symbols.push(symbol);
  }

  return symbols;
}
