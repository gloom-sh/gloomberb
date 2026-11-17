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
    if (!enabled || !changesElsewhere) return;
    let stopped = false;
    // The database's version and its rows as last read: a row gone from them since was deleted elsewhere.
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
        if (stopped) return;
        if (stored) takeStoredTickerRows(rows, stored, tickerRepository, stateRef, dispatch);
        stored = new Set(rows.map((row) => row.metadata.ticker));
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
 * drops each row another program deleted since the last read (`before`), so
 * no later save of the app's copy brings it back. Rows only the app holds
 * stay, and so does one the app is saving: its save folds the other
 * program's change in.
 */
function takeStoredTickerRows(
  rows: readonly TickerRecord[],
  before: ReadonlySet<string>,
  tickerRepository: AppTickerRepositoryPort,
  stateRef: { current: AppState },
  dispatch: Dispatch<AppAction>,
): void {
  const current = stateRef.current.tickers;
  let next: Map<string, TickerRecord> | null = null;
  const present = new Set<string>();
  for (const row of rows) {
    const symbol = row.metadata.ticker;
    present.add(symbol);
    if (hasPendingTickerWrite(tickerRepository, symbol)) continue;
    const held = current.get(symbol);
    if (held && serializeJson(held.metadata) === serializeJson(row.metadata)) continue;
    next ??= new Map(current);
    next.set(symbol, row);
  }
  for (const symbol of before) {
    if (present.has(symbol) || !current.has(symbol) || hasPendingTickerWrite(tickerRepository, symbol)) continue;
    next ??= new Map(current);
    next.delete(symbol);
  }
  if (next) dispatch({ type: "SET_TICKERS", tickers: next });
}
