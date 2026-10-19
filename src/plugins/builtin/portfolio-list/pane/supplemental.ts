import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { ColumnConfig } from "../../../../types/config";
import type { AnalystResearchData, CorporateActionsData, TickerFinancials } from "../../../../types/financials";
import type { DataProvider, EarningsEvent } from "../../../../types/data-provider";
import type { TickerRecord } from "../../../../types/ticker";
import { useAssetData } from "../../../runtime";
import { loadEarningsCalendar } from "../../earnings/data/cache";
import { forwardYieldMayHaveLapsed } from "../../../../utils/forward-dividend";
import { measuresTrailingYield } from "../../../../market-data/quotes/live-valuation";

const SUPPLEMENTAL_BATCH_LIMIT = 6;
const ANALYST_COLUMN_IDS = new Set(["target", "target_pct", "rating"]);
const CORPORATE_COLUMN_IDS = new Set(["ex_div", "next_earn"]);
// DIV% reads the distribution history of a trailing yield, measured from it, and of a forward yield old enough to have stopped.
const DIVIDEND_YIELD_COLUMN_ID = "dividend_yield";
const EARNINGS_COLUMN_IDS = new Set(["next_earn"]);

interface SupplementalTarget {
  symbol: string;
  exchange: string;
}

export interface PortfolioSupplementalData {
  analystResearch: Map<string, AnalystResearchData | null>;
  corporateActions: Map<string, CorporateActionsData | null>;
  earningsEvents: Map<string, EarningsEvent | null>;
  version: number;
}

type SupplementalState = PortfolioSupplementalData;

function targetKey(targets: SupplementalTarget[]): string {
  return targets.map((target) => `${target.symbol}:${target.exchange}`).join("|");
}

function targetsFromTickers(tickers: TickerRecord[]): SupplementalTarget[] {
  return tickers.map((ticker) => ({
    symbol: ticker.metadata.ticker,
    exchange: ticker.metadata.exchange ?? "",
  }));
}

/**
 * Whether the pane is still mounted. A batch's results are keyed by symbol and
 * land whenever it settles, even after the effect that started it re-ran:
 * the targets grow as each row's fundamentals arrive, and the new run skips
 * the symbols still in flight, so a batch dropped on cleanup would leave them
 * unread with nothing to ask again.
 */
function useMountedRef() {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return mounted;
}

function needsAnyColumn(columns: ColumnConfig[], ids: Set<string>): boolean {
  return columns.some((column) => ids.has(column.id));
}

function pickMissingBatch<T>(
  targets: SupplementalTarget[],
  values: Map<string, T | null>,
  inFlight: Set<string>,
): SupplementalTarget[] {
  const batch: SupplementalTarget[] = [];
  for (const target of targets) {
    if (values.has(target.symbol) || inFlight.has(target.symbol)) continue;
    batch.push(target);
    if (batch.length >= SUPPLEMENTAL_BATCH_LIMIT) break;
  }
  return batch;
}

function markMissing<T>(
  targets: SupplementalTarget[],
  values: Map<string, T | null>,
): Map<string, T | null> | null {
  let changed = false;
  const next = new Map(values);
  for (const target of targets) {
    if (next.has(target.symbol)) continue;
    next.set(target.symbol, null);
    changed = true;
  }
  return changed ? next : null;
}

function setAnalystValues(
  current: SupplementalState,
  entries: Array<readonly [string, AnalystResearchData | null]>,
): SupplementalState {
  const analystResearch = new Map(current.analystResearch);
  for (const [symbol, data] of entries) {
    analystResearch.set(symbol, data);
  }
  return { ...current, analystResearch, version: current.version + 1 };
}

function setCorporateValues(
  current: SupplementalState,
  entries: Array<readonly [string, CorporateActionsData | null]>,
): SupplementalState {
  const corporateActions = new Map(current.corporateActions);
  for (const [symbol, data] of entries) {
    corporateActions.set(symbol, data);
  }
  return { ...current, corporateActions, version: current.version + 1 };
}

function setEarningsValues(
  current: SupplementalState,
  symbols: string[],
  events: EarningsEvent[],
): SupplementalState {
  const eventsBySymbol = new Map<string, EarningsEvent>();
  const now = Date.now();
  for (const event of events) {
    const symbol = event.symbol.trim().toUpperCase();
    if (!symbol || event.earningsDate.getTime() < now) continue;
    const currentEvent = eventsBySymbol.get(symbol);
    if (!currentEvent || event.earningsDate < currentEvent.earningsDate) {
      eventsBySymbol.set(symbol, event);
    }
  }

  const earningsEvents = new Map(current.earningsEvents);
  for (const symbol of symbols) {
    earningsEvents.set(symbol, eventsBySymbol.get(symbol) ?? null);
  }
  return { ...current, earningsEvents, version: current.version + 1 };
}

function useAnalystSupplemental(
  provider: DataProvider | null | undefined,
  targets: SupplementalTarget[],
  enabled: boolean,
  state: SupplementalState,
  setState: Dispatch<SetStateAction<SupplementalState>>,
) {
  const inFlightRef = useRef(new Set<string>());
  const mountedRef = useMountedRef();
  const targetsKey = targetKey(targets);

  useEffect(() => {
    if (!enabled || targets.length === 0) return;
    if (!provider?.getAnalystResearch) {
      setState((current) => {
        const missing = markMissing(targets, current.analystResearch);
        return missing ? { ...current, analystResearch: missing, version: current.version + 1 } : current;
      });
      return;
    }

    const batch = pickMissingBatch(targets, state.analystResearch, inFlightRef.current);
    if (batch.length === 0) return;
    for (const target of batch) inFlightRef.current.add(target.symbol);

    Promise.all(batch.map(async (target) => {
      try {
        const data = await provider.getAnalystResearch!(target.symbol, target.exchange);
        return [target.symbol, data] as const;
      } catch {
        return [target.symbol, null] as const;
      } finally {
        inFlightRef.current.delete(target.symbol);
      }
    })).then((entries) => {
      if (mountedRef.current) setState((current) => setAnalystValues(current, entries));
    }).catch(() => {});
  }, [enabled, mountedRef, provider, setState, state.analystResearch, targetsKey]);
}

function useCorporateSupplemental(
  provider: DataProvider | null | undefined,
  targets: SupplementalTarget[],
  enabled: boolean,
  state: SupplementalState,
  setState: Dispatch<SetStateAction<SupplementalState>>,
) {
  const inFlightRef = useRef(new Set<string>());
  const mountedRef = useMountedRef();
  const targetsKey = targetKey(targets);

  useEffect(() => {
    if (!enabled || targets.length === 0) return;
    if (!provider?.getCorporateActions) {
      setState((current) => {
        const missing = markMissing(targets, current.corporateActions);
        return missing ? { ...current, corporateActions: missing, version: current.version + 1 } : current;
      });
      return;
    }

    const batch = pickMissingBatch(targets, state.corporateActions, inFlightRef.current);
    if (batch.length === 0) return;
    for (const target of batch) inFlightRef.current.add(target.symbol);

    Promise.all(batch.map(async (target) => {
      try {
        const data = await provider.getCorporateActions!(target.symbol, target.exchange);
        return [target.symbol, data] as const;
      } catch {
        return [target.symbol, null] as const;
      } finally {
        inFlightRef.current.delete(target.symbol);
      }
    })).then((entries) => {
      if (mountedRef.current) setState((current) => setCorporateValues(current, entries));
    }).catch(() => {});
  }, [enabled, mountedRef, provider, setState, state.corporateActions, targetsKey]);
}

function useEarningsSupplemental(
  provider: DataProvider | null | undefined,
  targets: SupplementalTarget[],
  enabled: boolean,
  state: SupplementalState,
  setState: Dispatch<SetStateAction<SupplementalState>>,
) {
  const inFlightRef = useRef(false);
  const mountedRef = useMountedRef();
  const targetsKey = targetKey(targets);

  useEffect(() => {
    if (!enabled || targets.length === 0) return;
    if (!provider?.getEarningsCalendar) {
      setState((current) => {
        const missing = markMissing(targets, current.earningsEvents);
        return missing ? { ...current, earningsEvents: missing, version: current.version + 1 } : current;
      });
      return;
    }

    const missingSymbols = targets
      .map((target) => target.symbol)
      .filter((symbol) => !state.earningsEvents.has(symbol));
    if (missingSymbols.length === 0 || inFlightRef.current) return;

    inFlightRef.current = true;
    loadEarningsCalendar(provider, missingSymbols)
      .then(({ events }) => {
        if (mountedRef.current) setState((current) => setEarningsValues(current, missingSymbols, events));
      })
      .catch(() => {
        if (!mountedRef.current) return;
        setState((current) => ({
          ...current,
          earningsEvents: markMissing(
            missingSymbols.map((symbol) => ({ symbol, exchange: "" })),
            current.earningsEvents,
          ) ?? current.earningsEvents,
          version: current.version + 1,
        }));
      })
      .finally(() => {
        inFlightRef.current = false;
      });
  }, [enabled, mountedRef, provider, setState, state.earningsEvents, targetsKey]);
}

export function usePortfolioSupplementalData(
  tickers: TickerRecord[],
  columns: ColumnConfig[],
  appActive: boolean,
  financialsMap: ReadonlyMap<string, TickerFinancials>,
): PortfolioSupplementalData {
  const provider = useAssetData();
  const targets = useMemo(() => targetsFromTickers(tickers), [tickers]);
  const allCorporate = needsAnyColumn(columns, CORPORATE_COLUMN_IDS);
  const dividendYield = columns.some((column) => column.id === DIVIDEND_YIELD_COLUMN_ID);
  // Every row for the ex-date and earnings columns; for DIV% alone, the rows whose yield is trailing or may have lapsed.
  const corporateTargets = useMemo(() => {
    if (allCorporate || !dividendYield) return targets;
    const now = new Date();
    return targets.filter((target) => {
      const fundamentals = financialsMap.get(target.symbol)?.fundamentals;
      return measuresTrailingYield(fundamentals) || forwardYieldMayHaveLapsed(fundamentals, now);
    });
  }, [allCorporate, dividendYield, financialsMap, targets]);
  const [state, setState] = useState<SupplementalState>(() => ({
    analystResearch: new Map(),
    corporateActions: new Map(),
    earningsEvents: new Map(),
    version: 0,
  }));
  const needsAnalyst = appActive && needsAnyColumn(columns, ANALYST_COLUMN_IDS);
  const needsCorporate = appActive && (allCorporate || dividendYield);
  const needsEarnings = appActive && needsAnyColumn(columns, EARNINGS_COLUMN_IDS);

  useAnalystSupplemental(provider, targets, needsAnalyst, state, setState);
  useCorporateSupplemental(provider, corporateTargets, needsCorporate, state, setState);
  useEarningsSupplemental(provider, targets, needsEarnings, state, setState);

  return state;
}
