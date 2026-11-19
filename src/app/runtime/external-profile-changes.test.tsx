import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { appReducer, createInitialState } from "../../core/state/app/state";
import { AppPersistence } from "../../data/app-persistence";
import { initDataDir } from "../../data/config/store";
import { TickerRepository } from "../../data/ticker-repository";
import { createOpenTuiTestHarness } from "../../renderers/opentui/test-utils";
import type { AppAction, AppState } from "../../state/app/context";
import { createTestTicker } from "../../test-support/ticker";
import { createDefaultConfig } from "../../types/config";
import type { TickerRecord } from "../../types/ticker";
import { useExternalProfileChanges } from "./external-profile-changes";

const tui = createOpenTuiTestHarness();
const tempDirs: string[] = [];
const originalHome = process.env.GLOOMBERB_HOME;

afterEach(async () => {
  if (originalHome === undefined) delete process.env.GLOOMBERB_HOME;
  else process.env.GLOOMBERB_HOME = originalHome;
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** The app's state and its dispatch, as the hook sees them, with the actions it dispatched and the events it emitted. */
function appStore(state: AppState) {
  const stateRef = { current: state };
  const actions: AppAction[] = [];
  const emitted: string[] = [];
  return {
    stateRef,
    actions,
    emitted,
    dispatch: (action: AppAction) => {
      actions.push(action);
      stateRef.current = appReducer(stateRef.current, action);
    },
    pluginRegistry: { events: { emit: (event: string) => { emitted.push(event); } } } as never,
  };
}

/** The ticker rows another program writes beside the app, and the database version that says it did. */
function sharedRows(rows: TickerRecord[], { async = false } = {}) {
  const stored = new Map(rows.map((row) => [row.metadata.ticker, row]));
  let version = 1;
  return {
    stored,
    commitElsewhere: () => { version += 1; },
    repository: {
      changesElsewhere: async ? async () => version : () => version,
      loadAllTickers: async () => [...stored.values()],
      loadTicker: async (symbol: string) => stored.get(symbol) ?? null,
      saveTicker: async () => {},
      createTicker: async (metadata: TickerRecord["metadata"]) => ({ metadata }),
      deleteTicker: async () => {},
    },
  };
}

async function waitFor(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const startedAt = Date.now();
  while (!check()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("Timed out waiting for the app to take the change in.");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function Harness(props: Parameters<typeof useExternalProfileChanges>[0]) {
  useExternalProfileChanges(props);
  return <text>app</text>;
}

describe("useExternalProfileChanges", () => {
  test("rows another program changed or deleted are taken in, and a row only the app holds stays", async () => {
    for (const async of [false, true]) {
      const aapl = createTestTicker("AAPL", "Apple", { watchlists: ["watchlist"] });
      const z74 = createTestTicker("Z74", "Singtel", { exchange: "SGX", watchlists: ["watchlist"] });
      const local = createTestTicker("LOCAL", "Not saved yet");
      const shared = sharedRows([aapl, z74], { async });
      const store = appStore({ ...createInitialState(createDefaultConfig(":memory:")), tickers: new Map([["AAPL", aapl], ["Z74", z74], ["LOCAL", local]]) });
      await tui.render(<Harness enabled dataDir=":memory:" dispatch={store.dispatch} stateRef={store.stateRef}
        pluginRegistry={store.pluginRegistry} tickerRepository={shared.repository} lookEveryMs={20} />);
      // The rows as the app first reads them, before anything changes.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(store.actions).toEqual([]);

      // Another program adds AAPL to a list and deletes Z74 (the desktop app removing a broker profile's rows).
      shared.stored.set("AAPL", createTestTicker("AAPL", "Apple", { watchlists: ["watchlist", "cli"] }));
      shared.stored.delete("Z74");
      shared.commitElsewhere();
      await waitFor(() => !store.stateRef.current.tickers.has("Z74"));
      const tickers = store.stateRef.current.tickers;
      expect(tickers.get("AAPL")!.metadata.watchlists).toEqual(["watchlist", "cli"]);
      expect(tickers.has("LOCAL")).toBe(true);
      tui.destroy();
    }
  });

  // The app's own commits move no `data_version` of its own: a row it added since its last look was never in the
  // rows that look read, and another program deleting it must still be taken in, or the app's next save of what
  // it holds writes it back.
  test("a row the app added since its last look that another program deletes is dropped, and the app's next save leaves it deleted", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gloomberb-external-rows-"));
    tempDirs.push(dir);
    const path = join(dir, "profile.db");
    const app = new AppPersistence(path, { interactive: true });
    const desktop = new AppPersistence(path);
    try {
      const repository = new TickerRepository(app.tickers);
      const aapl = createTestTicker("AAPL", "Apple", { watchlists: ["watchlist"] });
      await repository.saveTicker(aapl);
      const store = appStore({ ...createInitialState(createDefaultConfig(":memory:")), tickers: new Map([["AAPL", aapl]]) });
      await tui.render(<Harness enabled dataDir=":memory:" dispatch={store.dispatch} stateRef={store.stateRef}
        pluginRegistry={store.pluginRegistry} tickerRepository={repository} lookEveryMs={20} />);
      await new Promise((resolve) => setTimeout(resolve, 100));

      // The app adds Z74, and the looks after it see no change.
      const z74 = createTestTicker("Z74", "Singtel", { exchange: "SGX", watchlists: ["watchlist"] });
      await repository.saveTicker(z74);
      store.dispatch({ type: "UPDATE_TICKER", ticker: z74 });
      await new Promise((resolve) => setTimeout(resolve, 100));

      // The desktop app, open on the same profile, deletes it.
      const other = new TickerRepository(desktop.tickers);
      await other.loadAllTickers();
      await other.deleteTicker("Z74");
      await waitFor(() => !store.stateRef.current.tickers.has("Z74"));

      // The app's next save of what it holds, an edit of AAPL among it, leaves Z74 deleted.
      const edited = { metadata: { ...aapl.metadata, tags: ["core"] } };
      store.dispatch({ type: "UPDATE_TICKER", ticker: edited });
      await repository.saveTickers([...store.stateRef.current.tickers.values()]);
      expect(await other.loadTicker("Z74")).toBeNull();
      expect((await other.loadTicker("AAPL"))!.metadata.tags).toEqual(["core"]);
    } finally {
      tui.destroy();
      desktop.close();
      app.close();
    }
  });

  test("a config another program writes is taken into the app's state and announced to plugins", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "gloomberb-external-config-"));
    tempDirs.push(dataDir);
    process.env.GLOOMBERB_HOME = dataDir;
    const config = await initDataDir(dataDir);
    const store = appStore(createInitialState(config));
    await tui.render(<Harness enabled dataDir={dataDir} dispatch={store.dispatch} stateRef={store.stateRef}
      pluginRegistry={store.pluginRegistry} tickerRepository={sharedRows([]).repository} lookEveryMs={20} />);
    // Let the watch start before the other program writes.
    await new Promise((resolve) => setTimeout(resolve, 100));

    // `gloom alerts add Z74 above 4.20` beside the app.
    const path = join(dataDir, "config.json");
    const saved = JSON.parse(await readFile(path, "utf-8")) as Record<string, unknown>;
    const alerts = JSON.stringify([{ id: "from-cli", symbol: "Z74", condition: "above", targetPrice: 4.2, status: "active", createdAt: 1 }]);
    await writeFile(path, JSON.stringify({ ...saved, pluginConfig: { alerts: { alerts } } }, null, 2));

    await waitFor(() => store.stateRef.current.config.pluginConfig.alerts?.alerts === alerts);
    expect(store.actions.map((action) => action.type)).toContain("SET_CONFIG");
    expect(store.emitted).toContain("config:changed");
  });

  test("turned off, it reads and dispatches nothing", async () => {
    const shared = sharedRows([createTestTicker("AAPL", "Apple")]);
    let reads = 0;
    const repository = { ...shared.repository, loadAllTickers: async () => { reads += 1; return [...shared.stored.values()]; } };
    const store = appStore(createInitialState(createDefaultConfig(":memory:")));
    await tui.render(<Harness enabled={false} dataDir=":memory:" dispatch={store.dispatch} stateRef={store.stateRef}
      pluginRegistry={store.pluginRegistry} tickerRepository={repository} lookEveryMs={20} />);
    shared.stored.clear();
    shared.commitElsewhere();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(reads).toBe(0);
    expect(store.actions).toEqual([]);
  });
});
