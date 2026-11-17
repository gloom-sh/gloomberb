import { useEffect, type Dispatch } from "react";
import { watchExternalConfigChanges } from "../../data/config/store";
import { serializeJson } from "../../data/sqlite/json";
import { hasPendingTickerWrite, hasPendingTickerWrites } from "../../data/ticker-writes";
import type { AppTickerRepositoryPort } from "../../core/app-service-ports";
import type { PluginRegistry } from "../../plugins/registry";
import type { AppAction, AppState } from "../../state/app/context";
import type { TickerRecord } from "../../types/ticker";
import { logFailure } from "../../utils/log-failure";

/** How often the ticker rows are looked at for another program's write: a cheap question to SQLite. */
const TICKER_ROWS_LOOK_MS = 2_000;

type TickerRowsPort = AppTickerRepositoryPort & {
  /**
   * Changes when another program commits to the database; absent where no
   * one can say. The desktop app's windows ask the process that holds it.
   */
  changesElsewhere?(): number | null | Promise<number | null>;
  /**
   * The rows the repository held a copy of that a read found deleted by
   * another program (`TickerRepository.takeRowsDeletedElsewhere`), whoever
   * wrote them last: rows the app added itself since its last look included.
   */
  takeRowsDeletedElsewhere?(): string[] | Promise<string[]>;
};

/**
 * Takes in what a `gloom` command run beside the app writes to the profile:
 * config.json (alerts, settings, watchlists and portfolios, layouts) as soon
 * as the file changes, and ticker rows (watchlist members, positions) within
 * a couple of seconds. The app shows them, an alert added from the terminal
 * is checked, and no later save of the app's own copy writes over them.
 */
export function useExternalProfileChanges({
  enabled,
  dataDir,
  dispatch,
  stateRef,
  pluginRegistry,
  tickerRepository,
  lookEveryMs = TICKER_ROWS_LOOK_MS,
}: {
  enabled: boolean;
  dataDir: string;
  dispatch: Dispatch<AppAction>;
  stateRef: { current: AppState };
  pluginRegistry: Pick<PluginRegistry, "events">;
  tickerRepository: TickerRowsPort;
  /** How often the ticker rows are looked at; tests look sooner. */
  lookEveryMs?: number;
}): void {
  useEffect(() => {
    if (!enabled) return;
    return watchExternalConfigChanges(dataDir, (change) => {
      const current = stateRef.current.config;
      const next = change.apply(current);
      if (next === current) return;
      dispatch({ type: "SET_CONFIG", config: next });
      pluginRegistry.events.emit("config:changed", { config: next });
    });
  }, [dataDir, dispatch, enabled, pluginRegistry, stateRef]);

  useEffect(() => {
    const changesElsewhere = tickerRepository.changesElsewhere?.bind(tickerRepository);
    const takeDeleted = tickerRepository.takeRowsDeletedElsewhere?.bind(tickerRepository);
    if (!enabled || !changesElsewhere) return;
    let stopped = false;
    // The database's version and its rows as last read. Without the repository's own account of the rows deleted
    // elsewhere, a row gone from the last read's is one; the app's own commits move no version, so that misses a
    // row the app added since.
    let taken: number | null = null;
    let stored: Set<string> | null = null;
    let reading = false;
    const look = async () => {
      reading = true;
      try {
        const version = await changesElsewhere();
        // The app's own writes still on their way would read as someone else's: wait for them.
        if (stopped || version === null || (stored && version === taken) || hasPendingTickerWrites(tickerRepository)) return;
        const rows = await tickerRepository.loadAllTickers();
        const present = new Set(rows.map((row) => row.metadata.ticker));
        const deleted = takeDeleted ? await takeDeleted() : [...stored ?? []].filter((symbol) => !present.has(symbol));
        if (stopped) return;
        // The first look is the rows as the app starts with them; only rows deleted since are taken in then.
        takeStoredTickerRows(stored ? rows : [], deleted, tickerRepository, stateRef, dispatch);
        stored = present;
        taken = version;
      } finally {
        reading = false;
      }
    };
    const lookNow = () => {
      if (!reading) look().catch(logFailure("app.external-profile-changes", "Reading ticker rows another program wrote failed"));
    };
    lookNow();
    const timer = setInterval(lookNow, lookEveryMs);
    (timer as { unref?: () => void }).unref?.();
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [dispatch, enabled, lookEveryMs, stateRef, tickerRepository]);
}

/**
 * Replaces the app's copy of each row the database holds differently, and
 * drops each row another program deleted (`deleted`), so no later save of
 * the app's copy brings it back. Rows only the app holds stay, and so does
 * one the app is saving: its save folds the other program's change in.
 */
function takeStoredTickerRows(
  rows: readonly TickerRecord[],
  deleted: readonly string[],
  tickerRepository: AppTickerRepositoryPort,
  stateRef: { current: AppState },
  dispatch: Dispatch<AppAction>,
): void {
  const current = stateRef.current.tickers;
  let next: Map<string, TickerRecord> | null = null;
  for (const row of rows) {
    const symbol = row.metadata.ticker;
    if (hasPendingTickerWrite(tickerRepository, symbol)) continue;
    const held = current.get(symbol);
    if (held && serializeJson(held.metadata) === serializeJson(row.metadata)) continue;
    next ??= new Map(current);
    next.set(symbol, row);
  }
  for (const symbol of deleted) {
    if (!current.has(symbol)) continue;
    next ??= new Map(current);
    next.delete(symbol);
  }
  if (next) dispatch({ type: "SET_TICKERS", tickers: next });
}
