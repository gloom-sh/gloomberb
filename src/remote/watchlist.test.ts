import { describe, expect, test } from "bun:test";
import type { Dispatch } from "react";
import { appReducer, createInitialState, type AppAction } from "../core/state/app/state";
import type { PluginRegistry } from "../plugins/registry";
import { createTestDataProvider } from "../test-support/data-provider";
import { createTestTicker } from "../test-support/ticker";
import { createDefaultConfig } from "../types/config";
import type { InstrumentSearchResult } from "../types/instrument";
import type { TickerRecord } from "../types/ticker";
import { createAppRemoteController } from "./controller";
import type { RemoteChangePrompt, RemoteControlResponse } from "./types";

const MSFT_LISTING: InstrumentSearchResult = {
  providerId: "test-provider",
  symbol: "MSFT",
  name: "Microsoft Corporation",
  exchange: "NASDAQ",
  currency: "USD",
  type: "EQUITY",
};

function harness(options: {
  tickers?: TickerRecord[];
  answer?: boolean | "never";
  withoutDialog?: boolean;
  search?: InstrumentSearchResult[];
} = {}) {
  const config = {
    ...createDefaultConfig("/nonexistent/gloom-watchlist-test"),
    onboardingComplete: true,
    watchlists: [
      { id: "tech", name: "Tech" },
      { id: "semis", name: "Semis" },
      { id: "team:t1:desk", name: "Desk", teamId: "t1" },
    ],
    portfolios: [
      { id: "main", name: "Main", currency: "USD" },
      { id: "broker:ibkr:U1", name: "IBKR", currency: "USD", brokerId: "ibkr", brokerInstanceId: "ibkr" },
    ],
  };
  let state = createInitialState(config);
  const dispatch: Dispatch<AppAction> = (action) => {
    state = appReducer(state, action);
  };
  const saved = new Map<string, TickerRecord>();
  for (const ticker of options.tickers ?? []) {
    saved.set(ticker.metadata.ticker, ticker);
    dispatch({ type: "UPDATE_TICKER", ticker });
  }
  const tickerRepository = {
    loadAllTickers: async () => [...saved.values()],
    loadTicker: async (symbol: string) => saved.get(symbol) ?? null,
    saveTicker: async (ticker: TickerRecord) => {
      saved.set(ticker.metadata.ticker, ticker);
    },
    createTicker: async (metadata: TickerRecord["metadata"]) => {
      const ticker = { metadata };
      saved.set(metadata.ticker, ticker);
      return ticker;
    },
    deleteTicker: async (symbol: string) => {
      saved.delete(symbol);
    },
  };
  const prompts: RemoteChangePrompt[] = [];
  const registry = {
    marketData: createTestDataProvider({ search: async () => options.search ?? [MSFT_LISTING] }),
    tickerRepository,
    events: { emit: () => {} },
  } as unknown as PluginRegistry;
  const controller = createAppRemoteController({
    dispatch,
    getState: () => state,
    pluginRegistry: registry,
    uiRegistry: null,
    ...(options.withoutDialog ? {} : {
      confirmChange: (prompt: RemoteChangePrompt, signal?: AbortSignal) => {
        prompts.push(prompt);
        if (options.answer === "never") {
          return new Promise<boolean>((resolve) => {
            if (signal?.aborted) resolve(false);
            signal?.addEventListener("abort", () => resolve(false));
          });
        }
        return Promise.resolve(options.answer ?? true);
      },
    }),
  });
  return {
    prompts,
    saved,
    watchlistsOf: (symbol: string) => state.tickers.get(symbol)?.metadata.watchlists ?? null,
    call: (operation: string, input: Record<string, unknown>, extra: { dryRun?: boolean; confirmed?: string; signal?: AbortSignal } = {}) => (
      controller.handle(
        { type: "call", operation, input, ...(extra.dryRun ? { dryRun: true } : {}), include: [] },
        { ...(extra.confirmed ? { confirmed: extra.confirmed } : {}), ...(extra.signal ? { signal: extra.signal } : {}) },
      )
    ),
  };
}

function data(response: RemoteControlResponse): Record<string, unknown> {
  if (!response.ok) throw new Error(`expected ok, got ${response.error.message}`);
  return response.data as Record<string, unknown>;
}

function error(response: RemoteControlResponse): string {
  if (response.ok) throw new Error("expected a refusal");
  return response.error.message;
}

describe("watchlist.add and watchlist.remove", () => {
  test("adds a listing it found only after the person approves the change it names", async () => {
    const h = harness();
    const result = data(await h.call("watchlist.add", { symbol: "msft", watchlist: "Tech" }));

    expect(h.prompts).toEqual([{
      title: "Add MSFT to Tech?",
      lines: [
        { label: "Watchlist", value: "Tech" },
        { label: "Ticker", value: "MSFT" },
        { label: "Exchange", value: "NASDAQ" },
        { label: "Name", value: "Microsoft Corporation" },
      ],
      confirmLabel: "Add",
      destructive: false,
    }]);
    expect(result).toMatchObject({ changed: true, outcome: "added", message: "Added MSFT (NASDAQ) to Tech." });
    expect(h.saved.get("MSFT")?.metadata.watchlists).toEqual(["tech"]);
    expect(h.watchlistsOf("MSFT")).toEqual(["tech"]);
  });

  test("writes nothing when the person declines", async () => {
    const h = harness({ tickers: [createTestTicker("MSFT", "Microsoft Corporation")], answer: false });
    const result = data(await h.call("watchlist.add", { symbol: "MSFT", watchlist: "tech" }));

    expect(result).toMatchObject({ changed: false, outcome: "declined" });
    expect(h.watchlistsOf("MSFT")).toEqual([]);
  });

  test("answers a listing already on the list without asking", async () => {
    const h = harness({ tickers: [createTestTicker("MSFT", "Microsoft Corporation", { watchlists: ["tech"] })] });
    const result = data(await h.call("watchlist.add", { symbol: "MSFT", watchlist: "Tech" }));

    expect(h.prompts).toHaveLength(0);
    expect(result).toMatchObject({ changed: false, outcome: "already-listed", message: "MSFT (NASDAQ) is already on Tech; nothing changed." });
  });

  test("removes after approval, and says so when the ticker is not on the list", async () => {
    const h = harness({ tickers: [createTestTicker("MSFT", "Microsoft Corporation", { watchlists: ["tech", "semis"] })] });
    const removed = data(await h.call("watchlist.remove", { symbol: "MSFT", watchlist: "semis" }));

    expect(h.prompts[0]).toMatchObject({ title: "Remove MSFT from Semis?", confirmLabel: "Remove", destructive: true });
    expect(removed).toMatchObject({ changed: true, outcome: "removed", message: "Removed MSFT (NASDAQ) from Semis." });
    expect(h.watchlistsOf("MSFT")).toEqual(["tech"]);

    const again = data(await h.call("watchlist.remove", { symbol: "MSFT", watchlist: "semis" }));
    expect(again).toMatchObject({ changed: false, outcome: "not-listed" });
    expect(h.prompts).toHaveLength(1);
  });

  test("refuses team watchlists, portfolios and lists that do not exist, without asking", async () => {
    const h = harness({ tickers: [createTestTicker("MSFT")] });

    expect(error(await h.call("watchlist.add", { symbol: "MSFT", watchlist: "Desk" }))).toContain("is a team watchlist");
    expect(error(await h.call("watchlist.remove", { symbol: "MSFT", watchlist: "team:t1:desk" }))).toContain("is a team watchlist");
    expect(error(await h.call("watchlist.add", { symbol: "MSFT", watchlist: "IBKR" }))).toContain("is a broker portfolio");
    expect(error(await h.call("watchlist.add", { symbol: "MSFT", watchlist: "main" }))).toContain("is a portfolio, not a watchlist");
    expect(error(await h.call("watchlist.add", { symbol: "MSFT", watchlist: "Growth" }))).toContain("\"Tech\" (id tech)");
    expect(h.prompts).toHaveLength(0);
    expect(h.watchlistsOf("MSFT")).toEqual([]);
  });

  test("an unnamed list is the default one, the first personal watchlist, and the question names it", async () => {
    const h = harness({ tickers: [createTestTicker("MSFT")] });
    const result = data(await h.call("watchlist.add", { symbol: "MSFT" }));

    expect(h.prompts[0]?.title).toBe("Add MSFT to Tech?");
    expect(result).toMatchObject({ outcome: "added", watchlist: { id: "tech", name: "Tech" } });
  });

  test("a dry run resolves the change without asking or writing, and its key skips the second question", async () => {
    const h = harness();
    const plan = data(await h.call("watchlist.add", { symbol: "MSFT", watchlist: "tech" }, { dryRun: true }));

    expect(plan).toMatchObject({ dryRun: true, changes: true, summary: "Add MSFT (NASDAQ) to Tech", confirmKey: "add|tech|MSFT:XNAS" });
    expect(h.prompts).toHaveLength(0);
    expect(h.saved.size).toBe(0);

    const result = data(await h.call("watchlist.add", { symbol: "MSFT", watchlist: "tech" }, { confirmed: String(plan.confirmKey) }));
    expect(result).toMatchObject({ outcome: "added" });
    expect(h.prompts).toHaveLength(0);
  });

  test("asks anyway when the approved key is for another change, or comes inside the request", async () => {
    const h = harness({ tickers: [createTestTicker("MSFT")] });
    const plan = data(await h.call("watchlist.add", { symbol: "MSFT", watchlist: "tech" }, { dryRun: true }));

    await h.call("watchlist.add", { symbol: "MSFT", watchlist: "semis" }, { confirmed: String(plan.confirmKey) });
    // The local endpoint only has the request: a key in the input approves nothing.
    await h.call("watchlist.remove", { symbol: "MSFT", watchlist: "semis", confirmed: "remove|semis|MSFT" });
    expect(h.prompts.map(({ title }) => title)).toEqual(["Add MSFT to Semis?", "Remove MSFT from Semis?"]);
  });

  test("a caller that gives up closes the question as declined", async () => {
    const h = harness({ tickers: [createTestTicker("MSFT")], answer: "never" });
    const abort = new AbortController();
    const pending = h.call("watchlist.add", { symbol: "MSFT", watchlist: "tech" }, { signal: abort.signal });
    while (h.prompts.length === 0) await Bun.sleep(1);
    abort.abort();

    expect(data(await pending)).toMatchObject({ outcome: "declined" });
    expect(h.watchlistsOf("MSFT")).toEqual([]);
  });

  test("refuses to write where it cannot ask", async () => {
    const h = harness({ tickers: [createTestTicker("MSFT")], withoutDialog: true });

    expect(error(await h.call("watchlist.add", { symbol: "MSFT", watchlist: "tech" }))).toContain("cannot ask for confirmation");
    expect(h.watchlistsOf("MSFT")).toEqual([]);
  });

  test("asks for the exchange when the symbol has several listings", async () => {
    const h = harness({
      search: [
        { ...MSFT_LISTING, symbol: "SAN", name: "Banco Santander", exchange: "BME", currency: "EUR" },
        { ...MSFT_LISTING, symbol: "SAN", name: "Banco Santander ADR", exchange: "NYSE" },
      ],
    });

    expect(error(await h.call("watchlist.add", { symbol: "SAN", watchlist: "tech" }))).toContain("Pass exchange");
    expect(h.prompts).toHaveLength(0);
  });
});
