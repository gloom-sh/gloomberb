import type { Dispatch } from "react";
import type { ColumnConfig } from "../../../../types/config";
import type { DataProvider } from "../../../../types/data-provider";
import type { TickerFinancials } from "../../../../types/financials";
import type { InstrumentSearchResult } from "../../../../types/instrument";
import type { TickerRecord } from "../../../../types/ticker";
import type { AppAction } from "../../../../state/app/context";
import { canonicalExchange, parsePublicTickerKey } from "../../../../utils/exchanges";
import { compareSortValues } from "../../../../utils/sort-values";
import { findExactTickerSearchMatch, upsertTickerFromSearchResult } from "../../../../tickers/search";
import { getSharedRegistry } from "../../../registry";
import { getSortValue, type ColumnContext } from "../../portfolio-list/metrics";
import type { ScreenerSortPreference } from "./model";
import type { ValidatedScreenerResult } from "./contract";

function summarizeWarning(unresolved: string[], duplicateCount: number): string | null {
  const parts: string[] = [];
  if (duplicateCount > 0) {
    parts.push(`Dropped ${duplicateCount} duplicate${duplicateCount === 1 ? "" : "s"}.`);
  }
  if (unresolved.length > 0) {
    parts.push(`Could not resolve ${unresolved.length}: ${unresolved.slice(0, 5).join(", ")}${unresolved.length > 5 ? "..." : ""}.`);
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

function matchesExchange(result: InstrumentSearchResult, exchange: string): boolean {
  if (!exchange) return true;
  const normalized = canonicalExchange(exchange);
  return canonicalExchange(result.exchange) === normalized
    || canonicalExchange(result.primaryExchange) === normalized
    || canonicalExchange(result.brokerContract?.exchange) === normalized
    || canonicalExchange(result.brokerContract?.primaryExchange) === normalized;
}

function matchesCandidate(result: InstrumentSearchResult, candidate: { symbol: string; exchange: string }): boolean {
  const requested = parsePublicTickerKey(candidate.symbol);
  const parsedResult = parsePublicTickerKey(result.brokerContract?.localSymbol || result.symbol);
  const resultExchange = parsedResult.exchange || result.exchange;
  if (!matchesExchange({ ...result, exchange: resultExchange }, requested.exchange || candidate.exchange)) return false;
  return findExactTickerSearchMatch([{
    label: parsedResult.symbol,
    exchangeLabel: resultExchange,
    primaryExchangeLabel: result.primaryExchange || result.brokerContract?.primaryExchange,
  }], candidate.symbol) != null;
}

async function resolveCandidateTicker(
  candidate: { symbol: string; exchange: string; reason: string },
  localTickers: ReadonlyMap<string, TickerRecord>,
  stateDispatch: Dispatch<AppAction>,
  dataProvider: DataProvider | null,
): Promise<ValidatedScreenerResult | null> {
  const registry = getSharedRegistry();
  if (!registry || !dataProvider) {
    throw new Error("AI screener could not access the ticker repository.");
  }

  const localTicker = [...localTickers.values()].find((ticker) => matchesCandidate({
    providerId: "saved", symbol: ticker.metadata.ticker, exchange: ticker.metadata.exchange,
    name: ticker.metadata.name, currency: ticker.metadata.currency, type: ticker.metadata.assetCategory || "",
    brokerContract: ticker.metadata.broker_contracts?.[0],
  }, candidate));
  if (localTicker) {
    return {
      symbol: localTicker.metadata.ticker,
      exchange: localTicker.metadata.exchange,
      reason: candidate.reason,
      resolvedName: localTicker.metadata.name,
    };
  }

  const searchResults = await dataProvider.search(candidate.symbol);
  const selected = searchResults.find((result) => matchesCandidate(result, candidate)) ?? null;
  if (!selected) return null;

  const { ticker, created } = await upsertTickerFromSearchResult(registry.tickerRepository, selected);
  stateDispatch({ type: "UPDATE_TICKER", ticker });
  if (created) {
    registry.events.emit("ticker:added", {
      symbol: ticker.metadata.ticker,
      ticker,
    });
  }

  return {
    symbol: ticker.metadata.ticker,
    exchange: ticker.metadata.exchange,
    reason: candidate.reason,
    resolvedName: ticker.metadata.name,
  };
}

export async function validateScreenerResults(
  candidates: Array<{ symbol: string; exchange: string; reason: string }>,
  localTickers: ReadonlyMap<string, TickerRecord>,
  stateDispatch: Dispatch<AppAction>,
  dataProvider: DataProvider | null,
): Promise<{ results: ValidatedScreenerResult[]; warning: string | null }> {
  const resolved: ValidatedScreenerResult[] = [];
  const unresolved: string[] = [];
  let duplicateCount = 0;
  const seen = new Set<string>();

  for (const candidate of candidates) {
    const result = await resolveCandidateTicker(candidate, localTickers, stateDispatch, dataProvider);
    if (!result) {
      unresolved.push(candidate.symbol);
      continue;
    }
    if (seen.has(result.symbol)) {
      duplicateCount += 1;
      continue;
    }
    seen.add(result.symbol);
    resolved.push(result);
  }

  return {
    results: resolved,
    warning: summarizeWarning(unresolved, duplicateCount),
  };
}

export function sortScreenerRows(
  rows: TickerRecord[],
  resultMap: Map<string, ValidatedScreenerResult>,
  financialsMap: Map<string, TickerFinancials>,
  sortPreference: ScreenerSortPreference,
  columnContext: ColumnContext,
  columns: ColumnConfig[],
): TickerRecord[] {
  if (!sortPreference.columnId) return rows;

  const column = columns.find((entry) => entry.id === sortPreference.columnId);
  if (!column) return rows;

  return [...rows].sort((left, right) => {
    const leftValue = column.id === "reason"
      ? (resultMap.get(left.metadata.ticker)?.reason ?? "")
      : getSortValue(column, left, financialsMap.get(left.metadata.ticker), columnContext);
    const rightValue = column.id === "reason"
      ? (resultMap.get(right.metadata.ticker)?.reason ?? "")
      : getSortValue(column, right, financialsMap.get(right.metadata.ticker), columnContext);

    return compareSortValues(leftValue, rightValue, sortPreference.direction);
  });
}
