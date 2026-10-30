import { afterEach, beforeEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { act } from "react";
import { apiClient } from "../../../api-client";
import { ApiRequestError } from "../../../api-client/errors";
import type { FuturesContractTermsPayload } from "../../../api-client/futures-curve";
import { createOpenTuiTestHarness, type TestKeyEvent } from "../../../renderers/opentui/test-utils";
import { createInitialState } from "../../../state/app/context";
import { createDefaultConfig } from "../../../types/config";
import type { QuoteBatchResult } from "../../../types/data-provider";
import type { PinTickerOptions } from "../../../types/plugin";
import type { PluginRuntimeAccess } from "../../runtime";
import { futuresModule } from "./index";
import { TestPaneFrame, TestPaneProvider } from "../../../test-support/pane";
import type { Quote } from "../../../types/financials";
import { resetFuturesBoardTerms } from "./use-board-terms";
import { resetFrontContractReturns } from "./use-front-returns";
import { createRemoteUiRegistry, RemoteUiRegistryProvider } from "../../../remote/semantic-tree";
import { renderedReportFailure } from "../../../cli/pane-functions/report-notices";

const FuturesPane = futuresModule.panes![0]!.component as (props: {
  paneId: string;
  paneType: string;
  focused: boolean;
  width: number;
  height: number;
}) => React.ReactNode;

const tui = createOpenTuiTestHarness();
const pinned: Array<{ symbol: string; options?: PinTickerOptions }> = [];

/** Contract terms as the server sends them on 2026-10-19: CL=F on December from its roll date while November trades until the 20th. */
const contractTerms: Record<string, FuturesContractTermsPayload> = {
  "CL=F": { symbol: "CL=F", root: "CL", name: "WTI Crude Oil", contract: "CLZ26", contractSymbol: "CLZ26.NYM", deliveryMonth: "2026-12",
    spec: { unit: "USD / barrel", size: "1,000 barrels", pointValue: 1000, tick: 0.01, tickValue: 10, settlement: "physical" },
    lastTrade: "2026-11-20", firstNotice: null, inDelivery: false, settlement: { price: 93.17, date: "2026-10-13" },
    nearest: { contract: "CLX26", contractSymbol: "CLX26.NYM", deliveryMonth: "2026-11", lastTrade: "2026-10-20" },
    roll: { label: "1 day before last trade", date: "2026-11-19" },
    mostActive: { contract: "CLZ26", contractSymbol: "CLZ26.NYM", deliveryMonth: "2026-12", volume: 304_249, date: "2026-10-16" } },
};
let termsSpy: { mockRestore(): void } | null = null;

beforeEach(() => {
  termsSpy = spyOn(apiClient, "getCloudFuturesContract").mockImplementation(async (symbol: string) => {
    const terms = contractTerms[symbol];
    // As the server answers a root it has no terms for.
    if (!terms) throw new ApiRequestError("Not a futures symbol with known contract terms", 404);
    return terms;
  });
});

afterEach(() => {
  setSystemTime();
  pinned.length = 0;
  termsSpy?.mockRestore();
  resetFuturesBoardTerms();
  resetFrontContractReturns();
});

function makeRuntime(quoteError?: string, quoteOverrides: Partial<Quote> = {}): PluginRuntimeAccess {
  const marketData = quoteError ? {
    getQuote: async () => { throw new Error(quoteError); },
    getQuotesBatch: async (targets: Array<{ symbol: string }>): Promise<QuoteBatchResult[]> => (
      targets.map((target) => ({ target: { symbol: target.symbol, exchange: "" }, quote: null, error: new Error(quoteError) })) as QuoteBatchResult[]
    ),
  } : {
    // Returns columns on a wide board read each row's history; none here.
    getPriceHistory: async () => [],
    getQuote: async (symbol: string) => ({
      symbol,
      price: 100,
      change: 1,
      changePercent: 1,
      marketState: "REGULAR" as const,
      lastUpdated: Date.now(),
      ...quoteOverrides,
    }),
    getQuotesBatch: async (targets: Array<{ symbol: string }>): Promise<QuoteBatchResult[]> => (
      targets.map((target) => ({
        target: { symbol: target.symbol, exchange: "" },
        quote: {
          symbol: target.symbol,
          price: 100,
          change: 1,
          changePercent: 1,
          marketState: "REGULAR" as const,
          lastUpdated: Date.now(),
          ...quoteOverrides,
        },
      })) as QuoteBatchResult[]
    ),
  };

  return {
    getMarketData: () => marketData as never,
    getCapability: () => null,
    getBrokerAdapter: () => null,
    connectBrokerInstance: async () => {},
    updateBrokerInstance: async () => {},
    syncBrokerInstance: async () => {},
    removeBrokerInstance: async () => {},
    pinTicker: (symbol: string, options?: PinTickerOptions) => {
      pinned.push({ symbol, options });
    },
    navigateTicker: () => {},
    selectTicker: () => {},
    switchTab: () => {},
    switchPanel: () => {},
    openCommandBar: () => {},
    showPane: () => {},
    createPaneFromTemplate: () => {},
    hidePane: () => {},
    openPaneSettings: () => {},
    openPluginCommandWorkflow: () => {},
    notify: () => {},
    subscribeResumeState: () => () => {},
    getResumeState: () => null,
    setResumeState: () => {},
    deleteResumeState: () => {},
    getConfigState: () => null,
    setConfigState: async () => {},
    setConfigStates: async () => {},
    deleteConfigState: async () => {},
    getConfigStateKeys: () => [],
  } as unknown as PluginRuntimeAccess;
}

function Harness({ quoteError, width = 80, height = 24 }: { quoteError?: string; width?: number; height?: number }) {
  const state = createInitialState(createDefaultConfig("/tmp/gloomberb-futures-pane-test"));
  return (
    <TestPaneProvider state={state} paneId="futures" runtime={makeRuntime(quoteError)} pluginId="market-overview">
      <FuturesPane paneId="futures" paneType="futures" focused width={width} height={height} />
    </TestPaneProvider>
  );
}

const renderSettled = () => tui.renderFrames(2);

const emitKeypress = (event: TestKeyEvent) => tui.emitKeypress(event);

describe("FuturesPane", () => {
  test("collapses and expands a sector from the keyboard", async () => {
    await tui.render(<Harness />, { width: 80, height: 24 });
    await renderSettled();

    // Selection starts on the first contract, so step up onto its header.
    expect(tui.frame()).toContain("E-Mini S&P 500");
    expect(tui.frame()).toContain("▾ Equity Index");

    await emitKeypress({ name: "up", sequence: "\u001B[A" });
    await emitKeypress({ name: "enter", sequence: "\r" });
    await renderSettled();
    const collapsed = tui.frame();
    expect(collapsed).toContain("▸ Equity Index");
    expect(collapsed).not.toContain("E-Mini S&P 500");
    // Other sectors keep their contracts.
    expect(collapsed).toContain("S&P Energy");

    await emitKeypress({ name: "enter", sequence: "\r" });
    await renderSettled();
    expect(tui.frame()).toContain("E-Mini S&P 500");
  });

  test("clicking a sector header collapses it, and clicking again expands it", async () => {
    await tui.render(<Harness />, { width: 80, height: 24 });
    await renderSettled();

    const headerRow = () => tui.frame()
      .split("\n")
      .findIndex((line) => line.includes("Equity Index"));
    const row = headerRow();
    expect(row).toBeGreaterThanOrEqual(0);

    await act(async () => {
      await tui.setup().mockMouse.click(4, row);
      await tui.setup().renderOnce();
    });
    await renderSettled();

    const collapsed = tui.frame();
    expect(collapsed).toContain("▸ Equity Index");
    expect(collapsed).not.toContain("E-Mini S&P 500");
    // A header click must not also open the pinned-ticker pane.
    expect(pinned).toEqual([]);

    await act(async () => {
      await tui.setup().mockMouse.click(4, headerRow());
      await tui.setup().renderOnce();
    });
    await renderSettled();

    expect(tui.frame()).toContain("E-Mini S&P 500");
    expect(pinned).toEqual([]);
  });

  test("a search shows matches inside a collapsed sector", async () => {
    await tui.render(<Harness />, { width: 80, height: 24 });
    await renderSettled();

    // Collapse Equity Index from its header, then search for one of its rows.
    await emitKeypress({ name: "up", sequence: "\u001B[A" });
    await emitKeypress({ name: "enter", sequence: "\r" });
    await renderSettled();
    expect(tui.frame()).not.toContain("E-Mini Dow");

    await emitKeypress({ name: "/", sequence: "/" });
    for (const character of "dow") {
      await emitKeypress({ name: character, sequence: character });
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      await tui.setup().renderOnce();
    });
    await renderSettled();

    const searching = tui.frame();
    expect(searching).toContain("E-Mini Dow");
    expect(searching).toContain("▾ Equity Index");
  });

  test("opens the selected contract in ticker research", async () => {
    await tui.render(<Harness />, { width: 80, height: 24 });
    await renderSettled();

    await emitKeypress({ name: "enter", sequence: "\r" });
    await renderSettled();

    expect(pinned).toHaveLength(1);
    expect(pinned[0]!.symbol).toBe("ES=F");
    expect(pinned[0]!.options).toMatchObject({ floating: true });
  });

  test("a board where no quote arrived says so instead of drawing dashes", async () => {
    await tui.render(<Harness quoteError="Quotes are offline" />, { width: 80, height: 24 });
    await renderSettled();
    await renderSettled();

    const frame = tui.frame();
    expect(frame).toContain("Futures quotes unavailable.");
    expect(frame).toContain("Quotes are offline");
    expect(frame).toContain("Retry");
    expect(frame).not.toContain("E-Mini S&P 500");
  });

  test("a row names the month its symbol rolled past and the unit its price counts, as quote does", async () => {
    // Tall enough to reach the energy rows below the equity groups.
    await tui.render(<Harness width={190} height={64} />, { width: 190, height: 64 });
    await renderSettled();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      await tui.setup().renderOnce();
    });
    await renderSettled();
    const crude = tui.frame().split("\n").find((line) => line.includes("WTI Crude Oil"));
    expect(crude).toContain("WTI Crude Oil Dec 2026, rolled (Nov expires 20 Oct)");
    expect(crude).toContain("USD / barrel");
    // A root the server has no terms for keeps its catalog name, and its catalog unit where there is one.
    const ttf = tui.frame().split("\n").find((line) => line.includes("Dutch TTF Gas"));
    expect(ttf).toContain("EUR / MWh");
    expect(ttf).not.toContain("rolled");
    // A narrow board keeps the month the quote prices and the unit, and drops the note it has no room for.
    await tui.render(<Harness height={64} />, { width: 80, height: 64 });
    await renderSettled();
    const narrow = tui.frame().split("\n").find((line) => line.includes("WTI Crude Oil"));
    expect(narrow).toContain("WTI Crude Oil Dec 2026");
    expect(narrow).toContain("USD / barrel");
  });

  test("over the weekend every row reads closed, not the open its Friday tick stamped", async () => {
    // Sunday 05:35 UTC: CME reopens at 22:00 UTC. Gloom Cloud still served Friday's last tick, stale, reading REGULAR.
    setSystemTime(new Date("2026-10-25T05:35:00Z"));
    const stale: Partial<Quote> = { stale: true, lastUpdated: Date.parse("2026-10-23T21:00:00Z"), listingExchangeName: "CME", exchangeName: "CME" };
    const state = createInitialState(createDefaultConfig("/tmp/gloomberb-futures-pane-test"));
    await tui.render(
      <TestPaneFrame state={state} paneId="futures" runtime={makeRuntime(undefined, stale)} pluginId="market-overview" width={120} height={30}>
        {(body) => <FuturesPane paneId="futures" paneType="futures" focused width={body.width} height={body.height} />}
      </TestPaneFrame>,
      { width: 120, height: 30 },
    );
    await renderSettled();
    await renderSettled();

    const frame = tui.frame();
    const contract = frame.split("\n").find((line) => line.includes("E-Mini S&P 500"));
    expect(contract).toContain("CLOSED");
    expect(frame).not.toContain("OPEN");
  });

  test("search narrows the board to matching contracts", async () => {
    await tui.render(<Harness />, { width: 80, height: 24 });
    await renderSettled();

    await emitKeypress({ name: "/", sequence: "/" });
    await renderSettled();
    for (const character of "gold") {
      await emitKeypress({ name: character, sequence: character });
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      await tui.setup().renderOnce();
    });
    await renderSettled();

    const filtered = tui.frame();
    expect(filtered).toContain("Gold");
    expect(filtered).not.toContain("E-Mini S&P 500");
  });

  /** `fn FUT urea` printed every tab and header cell, then the board's "No matching contracts. Clear search." */
  test("a search no contract matches fails the report with what to type instead; natgas finds natural gas", async () => {
    const search = async (query: string) => {
      const registry = createRemoteUiRegistry();
      await tui.render(<RemoteUiRegistryProvider registry={registry}><Harness /></RemoteUiRegistryProvider>, { width: 80, height: 24 });
      await renderSettled();
      await emitKeypress({ name: "/", sequence: "/" });
      await renderSettled();
      for (const character of query) await emitKeypress({ name: character, sequence: character });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 150));
        await tui.setup().renderOnce();
      });
      await renderSettled();
      return { frame: tui.frame(), failure: renderedReportFailure(registry.snapshot()) };
    };
    expect((await search("urea")).failure).toEqual({
      message: 'No futures contract matches "urea".',
      details: "Try a code such as NG, CL or GC, or a name such as natural gas or gold: gloom fn FUT NG. Other boards: gloom fn FUT --tab inventories, positioning or crops.",
    });
    const natgas = await search("natgas");
    expect(natgas.failure).toBeNull();
    expect(natgas.frame).toContain("Natural Gas");
  });
});
