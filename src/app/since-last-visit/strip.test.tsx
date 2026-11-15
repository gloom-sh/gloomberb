import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, useEffect, useState } from "react";
import { AppPersistence } from "../../data/app-persistence";
import { setConfigStoreHost, type ConfigStoreHost } from "../../data/config/store";
import type { QueryEntry } from "../../market-data/result-types";
import type { InstrumentRef } from "../../market-data/request-types";
import { createOpenTuiTestHarness } from "../../renderers/opentui/test-utils";
import { AppProvider, useAppDispatch, useAppGetState, type AppState } from "../../state/app/context";
import { flushPendingPersistence } from "../../state/persist-scheduler";
import { createTestQuote } from "../../test-support/data-provider";
import { createTempDbPath, removeTempDbFiles } from "../../test-support/temp-db";
import { createTestTicker } from "../../test-support/ticker";
import { createDefaultConfig, type AppConfig } from "../../types/config";
import type { Quote } from "../../types/financials";
import type { AppNotificationRequest } from "../../types/plugin";
import type { TickerRecord } from "../../types/ticker";
import type { UsageCountsPayload } from "../../api-client";
import {
  flushUsageCounts,
  installUsageCounter,
  resetUsageCountsForTests,
  subscribeFunctionOpens,
} from "../../telemetry/usage-counts";
import { pressSinceLastVisitKey } from "./keys";
import type { VisitBaseline } from "./model";
import { SinceLastVisitStrip } from "./strip";
import { useSinceLastVisit, type VisitAccountSource } from "./use-since-last-visit";
import { createVisitBaselineStore } from "./visit-tracker";

const tui = createOpenTuiTestHarness({ width: 110, height: 3 });

/** Monday 14:00 New York: NASDAQ in its regular session. */
const NOW = Date.parse("2026-09-14T18:00:00Z");
const HOUR = 3_600_000;
const LEAD = "Since your last visit";
const NVDA_KEY = "NVDA|NASDAQ|||";
const AAPL_KEY = "AAPL|NASDAQ|||";
const MSFT_KEY = "MSFT|NASDAQ|||";

let now = NOW;
const realNow = Date.now;
let saved: AppConfig[] = [];
let notices: AppNotificationRequest[] = [];
const persistences: AppPersistence[] = [];

const recordingHost = {
  saveConfig: async (config: AppConfig) => {
    saved.push(config);
  },
} as unknown as ConfigStoreHost;

function quote(symbol: string, price: number, overrides: Partial<Quote> = {}): Quote {
  return createTestQuote({
    symbol, price, lastUpdated: now - 60_000,
    exchangeName: "NASDAQ", listingExchangeName: "NASDAQ", marketState: "REGULAR",
    ...overrides,
  });
}

function entry(data: Quote | null): QueryEntry<Quote> {
  return { phase: data ? "ready" : "error", data, lastGoodData: data, source: null, fetchedAt: now, staleAt: null, error: null, attempts: [] };
}

/** The quote coordinator, as far as the strip uses it: batches it can hold open, and a change feed. */
function fakeMarketData(quotes: Map<string, Quote>) {
  const batches: Array<PromiseWithResolvers<QueryEntry<Quote>[]> & { symbols: string[] }> = [];
  const listeners = new Set<() => void>();
  return {
    batches,
    quotes,
    getQuoteEntry: (instrument: InstrumentRef) => entry(quotes.get(instrument.symbol) ?? null),
    loadQuotesBatch: (instruments: InstrumentRef[]) => {
      const batch = Object.assign(Promise.withResolvers<QueryEntry<Quote>[]>(), { symbols: instruments.map((item) => item.symbol) });
      batches.push(batch);
      return batch.promise;
    },
    subscribeKeys: (_keys: readonly string[], listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

function account(id: string | null) {
  let current = id;
  const listeners = new Set<() => void>();
  const source: VisitAccountSource & { switchTo(next: string | null): void } = {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    currentId: () => current,
    switchTo: (next) => {
      current = next;
      for (const listener of listeners) listener();
    },
  };
  return source;
}

function openProfile(path: string): AppPersistence {
  const persistence = new AppPersistence(path);
  persistences.push(persistence);
  return persistence;
}

function seed(path: string, baseline: VisitBaseline): void {
  createVisitBaselineStore(openProfile(path).pluginState).save(baseline);
}

function lastVisit(scope = "local", seenAt = NOW - 3 * HOUR): VisitBaseline {
  const at = seenAt - 60_000;
  const price = (symbol: string, value: number) => ({ symbol, price: value, currency: "USD", basis: "per-unit", venue: "NASDAQ", at });
  return {
    scope,
    seenAt,
    observations: { [NVDA_KEY]: price("NVDA", 100), [AAPL_KEY]: price("AAPL", 200), [MSFT_KEY]: price("MSFT", 300) },
  };
}

const TICKERS = new Map<string, TickerRecord>([
  ["NVDA", createTestTicker("NVDA", "NVIDIA", { portfolios: ["main"] })],
  ["AAPL", createTestTicker("AAPL", "Apple", { watchlists: ["watchlist"] })],
  ["MSFT", createTestTicker("MSFT", "Microsoft", { watchlists: ["watchlist"] })],
]);

interface Launch {
  getState: () => AppState;
  dispatch: ReturnType<typeof useAppDispatch>;
  /** Setup or the sign-in gate in front of the workspace (false), or not. */
  setActive: (active: boolean) => void;
}

async function launch({
  path,
  marketData,
  accountSource = account(null),
  config: configOverrides = {},
}: {
  path: string;
  marketData: ReturnType<typeof fakeMarketData>;
  accountSource?: VisitAccountSource;
  config?: Partial<AppConfig>;
}): Promise<Launch> {
  const persistence = openProfile(path);
  const handle = {} as Launch;
  function Workspace() {
    const dispatch = useAppDispatch();
    handle.getState = useAppGetState();
    handle.dispatch = dispatch;
    const [active, setActive] = useState(true);
    handle.setActive = setActive;
    useEffect(() => {
      dispatch({ type: "SET_TICKERS", tickers: new Map(TICKERS) });
      dispatch({ type: "SET_INITIALIZED" });
    }, [dispatch]);
    const strip = useSinceLastVisit({
      active,
      marketData,
      pluginState: persistence.pluginState,
      notify: (request) => notices.push(request),
      account: accountSource,
    });
    return strip.recap ? <SinceLastVisitStrip strip={strip} /> : null;
  }
  const config: AppConfig = { ...createDefaultConfig("/tmp/gloomberb-since-last-visit"), onboardingComplete: true, ...configOverrides };
  await tui.render(<AppProvider config={config}><Workspace /></AppProvider>);
  await tui.renderFrames(3);
  return handle;
}

async function answer(marketData: ReturnType<typeof fakeMarketData>, index = 0): Promise<void> {
  await act(async () => {
    marketData.batches[index]!.resolve([]);
    await Promise.resolve();
  });
  await tui.renderFrames(2);
}

describe("SinceLastVisitStrip", () => {
  beforeEach(() => {
    now = NOW;
    Date.now = () => now;
    saved = [];
    notices = [];
    setConfigStoreHost(recordingHost);
  });

  afterEach(async () => {
    await tui.destroy();
    await flushPendingPersistence();
    Date.now = realNow;
    setConfigStoreHost(null);
    resetUsageCountsForTests();
    for (const persistence of persistences.splice(0)) persistence.close();
    removeTempDbFiles();
  });

  test("a returning user sees what moved since, once the return's quotes land; stale and missing prices say nothing", async () => {
    const path = createTempDbPath("since-last-visit");
    seed(path, lastVisit());
    const marketData = fakeMarketData(new Map([
      ["NVDA", quote("NVDA", 110)],
      // Yesterday's print in today's session is not a current price.
      ["AAPL", quote("AAPL", 150, { lastUpdated: NOW - 24 * HOUR })],
    ]));
    await launch({ path, marketData });

    // Nothing while the quotes load: no empty or loading strip.
    expect(marketData.batches.map((batch) => batch.symbols)).toEqual([["NVDA", "AAPL", "MSFT"]]);
    expect(tui.frame()).not.toContain("Since");

    await answer(marketData);
    const frame = await tui.waitForFrameToContain(LEAD);
    expect(frame).toContain("NVDA +10.0%");
    expect(frame).not.toContain("AAPL");
    expect(frame).not.toContain("MSFT");
    expect(frame).not.toMatch(/[^\d][+-]?0\.0%/);
  });

  test("a first visit shows nothing and loads nothing of its own", async () => {
    const marketData = fakeMarketData(new Map([["NVDA", quote("NVDA", 110)]]));
    await launch({ path: createTempDbPath("since-last-visit"), marketData });
    await tui.renderFrames(3);
    expect(marketData.batches).toHaveLength(0);
    expect(tui.frame()).not.toContain("Since");
  });

  test("a return answered after the account changed is dropped, and no account reads another's last visit", async () => {
    const path = createTempDbPath("since-last-visit");
    seed(path, lastVisit("account:a"));
    const accountSource = account("a");
    const marketData = fakeMarketData(new Map([["NVDA", quote("NVDA", 110)]]));
    await launch({ path, marketData, accountSource });
    expect(marketData.batches).toHaveLength(1);

    await act(async () => {
      accountSource.switchTo("b");
    });
    await answer(marketData);
    await tui.renderFrames(3);
    expect(tui.frame()).not.toContain("Since");
    // B has no last visit here; A's was read once and is still A's, untouched.
    expect(marketData.batches).toHaveLength(1);
    expect(createVisitBaselineStore(openProfile(path).pluginState).load("account:a")).toEqual(lastVisit("account:a"));
  });

  test("showing counts as on screen at launch, never as an open, and not at all with usage counts off", async () => {
    for (const enabled of [true, false]) {
      const sent: UsageCountsPayload[] = [];
      installUsageCounter({
        surface: "terminal",
        isEnabled: () => enabled,
        getInstallId: () => "0f1e2d3c-4b5a-4968-8776-655443322110",
        send: async (payload) => {
          sent.push(payload);
        },
      });
      let opens = 0;
      const stopListening = subscribeFunctionOpens(() => {
        opens += 1;
      });
      const path = createTempDbPath("since-last-visit");
      seed(path, lastVisit());
      const marketData = fakeMarketData(new Map([["NVDA", quote("NVDA", 110)]]));
      await launch({ path, marketData });
      await answer(marketData);
      await tui.waitForFrameToContain(LEAD);
      await flushUsageCounts({ timeoutMs: 500 });
      stopListening();

      // A strip showing itself is not the user opening a function: the One Tap prompt and the like never hear of it.
      expect(opens).toBe(0);
      expect(sent.flatMap((payload) => payload.counts)).toEqual(enabled ? [{ fn: "LASTVISIT", opened: 0, restored: 1 }] : []);
      await tui.destroy();
      resetUsageCountsForTests();
    }
  });

  test("setup or the sign-in gate in front of the workspace takes the strip and its keys away until it closes", async () => {
    const path = createTempDbPath("since-last-visit");
    seed(path, lastVisit());
    const marketData = fakeMarketData(new Map([["NVDA", quote("NVDA", 110)]]));
    const app = await launch({ path, marketData });
    await answer(marketData);
    await tui.waitForFrameToContain(LEAD);

    // Run Setup Again opens in front of it.
    await act(async () => app.setActive(false));
    await tui.waitForFrameToExclude(LEAD);
    expect(pressSinceLastVisitKey("open")).toBe(false);

    await act(async () => app.setActive(true));
    await tui.waitForFrameToContain(LEAD);
    await act(async () => {
      expect(pressSinceLastVisitKey("dismiss")).toBe(true);
    });
  });

  test("Hide puts it away for the session, and a relaunch soon after compares with this visit", async () => {
    const path = createTempDbPath("since-last-visit");
    seed(path, lastVisit());
    const marketData = fakeMarketData(new Map([["NVDA", quote("NVDA", 110)]]));
    await launch({ path, marketData });
    await answer(marketData);
    await tui.waitForFrameToContain(LEAD);

    await act(async () => {
      expect(pressSinceLastVisitKey("dismiss")).toBe(true);
    });
    await tui.waitForFrameToExclude(LEAD);
    expect(pressSinceLastVisitKey("dismiss")).toBe(false);
    expect(saved).toHaveLength(0);

    await tui.destroy();
    now = NOW + 10 * 60_000;
    const relaunch = fakeMarketData(new Map([["NVDA", quote("NVDA", 120)]]));
    await launch({ path, marketData: relaunch });
    await tui.renderFrames(3);
    expect(relaunch.batches).toHaveLength(0);
    expect(tui.frame()).not.toContain("Since");
  });

  test("Turn off puts it away for good, can be undone, and the setting turns it on again", async () => {
    const path = createTempDbPath("since-last-visit");
    seed(path, lastVisit());
    const marketData = fakeMarketData(new Map([["NVDA", quote("NVDA", 110)]]));
    const app = await launch({ path, marketData });
    await answer(marketData);
    await tui.waitForFrameToContain(LEAD);

    await tui.clickFrameText("Turn off");
    await tui.waitForFrameToExclude(LEAD);
    expect(app.getState().config.sinceLastVisit).toBe(false);
    await flushPendingPersistence();
    expect(saved.at(-1)?.sinceLastVisit).toBe(false);
    expect(createVisitBaselineStore(openProfile(path).pluginState).load("local")).toBeNull();

    // The toast's Undo brings this session's strip back.
    const undo = notices.at(-1)?.action;
    expect(undo?.label).toBe("Undo");
    await act(async () => undo!.onClick());
    await tui.waitForFrameToContain(LEAD);
    await tui.clickFrameText("Turn off");
    await tui.waitForFrameToExclude(LEAD);
    await flushPendingPersistence();

    // Off survives a restart, even with a last visit to compare with.
    await tui.destroy();
    seed(path, lastVisit());
    const offLaunch = fakeMarketData(new Map([["NVDA", quote("NVDA", 110)]]));
    const relaunched = await launch({ path, marketData: offLaunch, config: { sinceLastVisit: saved.at(-1)?.sinceLastVisit } });
    await tui.renderFrames(3);
    expect(offLaunch.batches).toHaveLength(0);
    expect(tui.frame()).not.toContain("Since");

    // Since Last Visit in the command bar turns it on: this visit is kept, and the next return names its moves.
    await act(async () => {
      const { sinceLastVisit: _off, ...config } = relaunched.getState().config;
      relaunched.dispatch({ type: "SET_CONFIG", config });
    });
    await tui.renderFrames(3);
    expect(tui.frame()).not.toContain("Since");
    await tui.destroy();
    await flushPendingPersistence();

    // Later the same session day, over an hour on.
    now = NOW + 90 * 60_000;
    const nextReturn = fakeMarketData(new Map([["NVDA", quote("NVDA", 99)]]));
    await launch({ path, marketData: nextReturn });
    await answer(nextReturn);
    expect(await tui.waitForFrameToContain(LEAD)).toContain("NVDA -10.0%");
  });
});
