import { useEffect, type Dispatch } from "react";
import { watchExternalConfigChanges } from "../../data/config/store";
import { serializeJson } from "../../data/sqlite/json";
import { hasPendingTickerWrite, hasPendingTickerWrites } from "../../data/ticker-writes";
import type { AppTickerRepositoryPort } from "../../core/app-service-ports";
import type { PluginRegistry } from "../../plugins/registry";
import type { AppAction, AppState } from "../../state/app/context";
import { logFailure } from "../../utils/log-failure";

/** How often the ticker rows are looked at for another program's write: a cheap question to SQLite. */
const TICKER_ROWS_LOOK_MS = 2_000;

type TickerRowsPort = AppTickerRepositoryPort & {
  /** Changes when another program commits to the database; absent where the rows live elsewhere. */
  changesElsewhere?(): number | null;
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
}: {
  enabled: boolean;
  dataDir: string;
  dispatch: Dispatch<AppAction>;
  stateRef: { current: AppState };
  pluginRegistry: PluginRegistry;
  tickerRepository: TickerRowsPort;
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
    let taken = changesElsewhere();
    let reading = false;
    const look = async () => {
      const version = changesElsewhere();
      // The app's own writes still on their way would read as someone else's: wait for them.
      if (version === null || version === taken || hasPendingTickerWrites(tickerRepository)) return;
      reading = true;
      try {
        await takeStoredTickerRows(tickerRepository, stateRef, dispatch);
        taken = version;
      } finally {
        reading = false;
      }
    };
    const timer = setInterval(() => {
      if (!reading) look().catch(logFailure("app.external-profile-changes", "Reading ticker rows another program wrote failed"));
    }, TICKER_ROWS_LOOK_MS);
    (timer as { unref?: () => void }).unref?.();
    return () => clearInterval(timer);
  }, [dispatch, enabled, stateRef, tickerRepository]);
}

/**
 * Replaces the app's copy of each row the database holds differently. Rows
 * only the app holds stay, and so does one the app is saving: its save folds
 * the other program's change in.
 */
async function takeStoredTickerRows(
  tickerRepository: AppTickerRepositoryPort,
  stateRef: { current: AppState },
  dispatch: Dispatch<AppAction>,
): Promise<void> {
  const rows = await tickerRepository.loadAllTickers();
  const current = stateRef.current.tickers;
  let next: Map<string, (typeof rows)[number]> | null = null;
  for (const row of rows) {
    const symbol = row.metadata.ticker;
    if (hasPendingTickerWrite(tickerRepository, symbol)) continue;
    const held = current.get(symbol);
    if (held && serializeJson(held.metadata) === serializeJson(row.metadata)) continue;
    next ??= new Map(current);
    next.set(symbol, row);
  }
  if (next) dispatch({ type: "SET_TICKERS", tickers: next });
}
