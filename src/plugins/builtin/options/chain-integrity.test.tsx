import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { marketDataCliCommands } from "../../../cli/commands/market";
import { DEFAULT_CLI_OPTIONS } from "../../../cli/options";
import { serializeCliResult } from "../../../cli/result";
import type { PaneFooterSegment } from "../../../components/layout/pane/footer";
import { MarketDataCoordinator, setSharedMarketDataCoordinator } from "../../../market-data/coordinator";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { loadYahooOptionsChain } from "../../../sources/yahoo-finance/options";
import { createInitialState } from "../../../state/app/context";
import { createTestCliContext } from "../../../test-support/cli-context";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { TestPaneFrame, createTestPaneConfig, createTestTicker } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import type { OptionsChain } from "../../../types/financials";
import type { PaneTemplateCreateOptions } from "../../../types/plugin";
import { draftFromParams, type OptionCalcDraft } from "../options-calculator/model";
import { createOptionsControls } from "./test-fixture";
import { OptionsView } from "./view";

const EXPIRY = Date.UTC(2028, 0, 21) / 1000;
const NOW = Date.UTC(2026, 8, 17, 16);
const PANE = "options:chain-followup";
const tui = createOpenTuiTestHarness();
let coordinator: MarketDataCoordinator | undefined;
const realNow = Date.now;

afterEach(() => {
  coordinator?.destroy();
  coordinator = undefined;
  setSharedMarketDataCoordinator(null);
  Date.now = realNow;
});

function strikeRowY(strike: number): number {
  return tui.frame().split("\n").findIndex((line) => new RegExp(`\\s${strike}\\s`).test(line));
}

// Selection follows a throttled cursor, so each key waits it out before settling.
const { settle, key, capture: captureLaunch } = createOptionsControls(() => tui.setup(), { keyHoldMs: 180 });

async function fixture(strikes: number[], activity: "full" | "missing" | "zero" = "full", width = 120) {
  Date.now = () => NOW;
  let rows = strikes;
  let callsAvailable = true;
  let failure = false;
  let contractPrefix = "AAPL";
  const launches: OptionCalcDraft[] = [];
  const scenarios: PaneTemplateCreateOptions[] = [];
  let footerParts: PaneFooterSegment["parts"] = [];
  const raw = (strike: number, side: "C" | "P") => ({
    contractSymbol: `${contractPrefix}280121${side}${String(Math.round(strike * 1000)).padStart(8, "0")}`,
    strike,
    currency: "USD",
    lastPrice: 8,
    bid: 9,
    ask: 11,
    impliedVolatility: 0.25,
    volume: activity === "missing" && side === "P" ? null : activity === "zero" && side === "P" ? 0 : 10,
    openInterest: activity === "missing" && side === "C" ? undefined : activity === "zero" && side === "P" ? 0 : 20,
    change: 0,
    percentChange: 0,
    inTheMoney: side === "P",
    expiration: EXPIRY,
    lastTradeDate: NOW / 1000 - 86400,
  });
  const provider = createTestDataProvider({
    getOptionsChain: async (symbol, exchange, expirationDate) => loadYahooOptionsChain({
      ticker: symbol,
      exchange: exchange ?? "",
      expirationDate,
      fetchJsonWithCrumb: async <T,>(): Promise<T> => {
        if (failure) throw new Error("Chain source outage");
        const options = [{ calls: callsAvailable ? rows.map((s) => raw(s, "C")) : [], puts: rows.map((s) => raw(s, "P")) }];
        return { optionChain: { result: [{ underlyingSymbol: symbol, expirationDates: [EXPIRY], options }] } } as T;
      },
    }),
  });
  coordinator = new MarketDataCoordinator(provider);
  setSharedMarketDataCoordinator(coordinator);
  const ticker = createTestTicker("AAPL", "Apple", { assetCategory: "STK" });
  const config = createTestPaneConfig("/tmp/gloomberb-option-chain-test", {
    instanceId: PANE,
    paneId: "options",
    settings: { optionColumnIds: ["bid", "ask", "volume", "openInterest", "iv"] },
    binding: { kind: "fixed", symbol: "AAPL" },
  });
  const state = createInitialState(config);
  state.focusedPaneId = PANE;
  state.tickers = new Map([["AAPL", ticker]]);
  state.financials = new Map([["AAPL", {
    quote: { symbol: "AAPL", price: strikes[0]!, currency: "USD", change: 0, changePercent: 0, lastUpdated: NOW, stale: false },
    annualStatements: [],
    quarterlyStatements: [],
    priceHistory: [],
  }]]);
  const runtime = createTestPluginRuntime({
    createPaneFromTemplate: (id, options) => {
      if (id === "options-scenario-pane") scenarios.push(options!);
      else launches.push(draftFromParams(options?.values));
    },
  });
  await act(async () => {
    await tui.render(
      <TestPaneFrame state={state} paneId={PANE} pluginId="ticker-research" runtime={runtime} width={width} height={22} footerKeys>
        {(body, footer) => {
          footerParts = footer.info.flatMap((segment) => segment.parts);
          return <OptionsView {...body} focused />;
        }}
      </TestPaneFrame>,
      { width, height: 22 },
    );
  });
  await settle();

  async function capture() {
    const { launch, csv, frame } = await captureLaunch(PANE, "options.csv", launches);
    return { launch: launch ?? null, csv, frame, footerParts };
  }

  async function refresh(next: number[]) {
    rows = next;
    await act(async () => {
      await coordinator!.loadOptions({ instrument: { symbol: "AAPL", exchange: "NASDAQ" }, expirationDate: EXPIRY }, { forceRefresh: true });
    });
    await settle();
  }

  async function cli() {
    const run = createTestCliContext({ dataProvider: provider, destroy() {} });
    await marketDataCliCommands.find((command) => command.name === "options")!
      .execute(["AAPL", "--expiration", String(EXPIRY)], run.context);
    const { result, options } = run.printed[0]!;
    return {
      data: result.data as OptionsChain,
      rows: (options?.rows?.(result.data) ?? []) as Record<string, unknown>[],
      text: serializeCliResult(result, { ...DEFAULT_CLI_OPTIONS, format: "text" }, options),
    };
  }

  async function scenario() {
    const count = scenarios.length;
    await key("a");
    return scenarios.length > count ? scenarios.at(-1)! : null;
  }

  return {
    key,
    capture,
    refresh,
    cli,
    scenario,
    replaceSymbols: () => { contractPrefix = "AAPL1"; },
    setCalls: (value: boolean) => { callsAvailable = value; },
    setFailure: (value: boolean) => { failure = value; },
  };
}

test.each([48, 80, 120])("keeps the selected strike through insertion, removal and recovery at %i columns", async (width) => {
  const f = await fixture([100, 101, 102], "full", width);
  await act(async () => {
    await tui.setup().mockMouse.click(8, strikeRowY(101));
  });
  await settle();
  const picked = await f.capture();
  expect(picked.launch!.strike).toBe(101);
  await f.refresh([99, 100, 101, 102]);
  const inserted = await f.capture();
  expect(inserted.launch!.marketReference!.contractSymbol).toBe(picked.launch!.marketReference!.contractSymbol);
  expect(inserted.launch).toMatchObject({ side: "call", strike: 101, marketPrice: 10, marketPriceSource: "mid" });
  await f.refresh([99, 100, 102]);
  expect((await f.capture()).launch).toBeNull();
  await f.refresh([99, 100, 101, 102]);
  const recovered = await f.capture();
  expect(recovered.launch!.marketReference!.contractSymbol).toBe(picked.launch!.marketReference!.contractSymbol);
});

test("preserves call identity across partial chains, and permits an explicit put selection", async () => {
  const f = await fixture([100]);
  await act(async () => {
    await tui.setup().mockMouse.click(8, strikeRowY(100));
  });
  await settle();
  expect((await f.capture()).launch!.side).toBe("call");

  f.setCalls(false);
  await f.refresh([100]);
  const removed = await f.capture();
  expect(removed.launch).toBeNull();
  expect(await f.scenario()).toBeNull();
  expect(removed.frame).toContain("Selected 100 call unavailable");

  await act(async () => {
    await tui.setup().mockMouse.click(69, strikeRowY(100));
  });
  await settle();
  expect((await f.capture()).launch!.side).toBe("put");
  const scenario = (await f.scenario())!;
  expect(scenario.symbol).toBe("AAPL:NASDAQ");
  expect(JSON.parse(scenario.values!.seedLeg!)).toMatchObject({
    side: "put",
    strike: 100,
    expiration: EXPIRY,
    quantity: 1,
    price: 10,
    volatility: expect.closeTo(0.2774, 4),
    multiplier: 100,
  });
  expect(scenario.values!.asOf).toBe(new Date(NOW).toISOString());

  f.setCalls(true);
  await f.refresh([100]);
  expect((await f.capture()).launch!.side).toBe("put");
});

test("x picks the other contract at the cursor, and moving keeps that side", async () => {
  const f = await fixture([100, 101, 102]);
  await f.key("x");
  expect((await f.capture()).launch).toMatchObject({ side: "put", strike: 100 });
  await f.key("down");
  expect((await f.capture()).launch).toMatchObject({ side: "put", strike: 101 });
  await f.key("x");
  expect((await f.capture()).launch).toMatchObject({ side: "call", strike: 101 });
});

test("keyboard choice and transient failure retain the same contract through recovery", async () => {
  const f = await fixture([100, 101, 102]);
  await f.key("enter");
  await f.key("down");
  const picked = await f.capture();
  expect(picked.launch!.strike).toBe(101);

  f.setFailure(true);
  await f.refresh([99, 100, 101, 102]);
  const failed = await f.capture();
  expect(failed.launch!.marketReference!.contractSymbol).toBe(picked.launch!.marketReference!.contractSymbol);
  // The full warning survives even when footer actions leave room for only a shortened preview.
  expect(failed.footerParts.some((part) => part.tone === "warning" && part.text.includes("Chain source outage"))).toBe(true);

  f.setFailure(false);
  await f.refresh([99, 100, 101, 102]);
  const recovered = await f.capture();
  expect(recovered.launch!.marketReference!.contractSymbol).toBe(picked.launch!.marketReference!.contractSymbol);
});

test("keeps distinct fractional strike identity in table, CSV, seed and existing CLI", async () => {
  const f = await fixture([100.125, 100.126]);
  const result = await f.capture();
  expect(result.launch!.strike).toBe(100.125);
  expect(result.csv).toContain("100.125");
  expect(result.csv).toContain("100.126");
  expect(result.frame).toContain("100.125");
  const cli = await f.cli();
  expect(cli.rows.map((row) => row.strike)).toEqual([100.125, 100.126, 100.125, 100.126]);
  expect(cli.text).toContain("100.126");
});

test("preserves missing activity through source, summaries, CSV and CLI", async () => {
  const f = await fixture([100], "missing");
  const result = await f.capture();
  const cli = await f.cli();
  expect(cli.data.calls[0]!.openInterest).toBeUndefined();
  expect(cli.data.puts[0]!.volume).toBeUndefined();
  expect(result.frame).toMatch(/Volume\s+\S+/);
  expect(result.frame).toMatch(/P\/C vol\s+--/);
  expect(result.frame).toMatch(/P\/C OI\s+--/);
  expect(result.csv).toContain(",10,,");
  expect(cli.rows[0]!.volume).toBe(10);
  expect(cli.rows[1]!.openInterest).toBe(20);
  expect(cli.text).not.toContain("NaN");
});

test("preserves known zero activity and zero put/call ratios", async () => {
  const f = await fixture([100], "zero");
  const result = await f.capture();
  const cli = await f.cli();
  expect(cli.data.puts[0]).toMatchObject({ volume: 0, openInterest: 0 });
  expect(result.frame).toMatch(/Volume\s+10\s/);
  expect(result.frame).toMatch(/P\/C vol\s+0\.00/);
  expect(result.frame).toMatch(/P\/C OI\s+0\.00/);
  expect(result.csv).toContain(",0,");
  expect(cli.rows[1]!.volume).toBe(0);
});

test("a different source contract at the same strike cannot replace the selected quote reference", async () => {
  const f = await fixture([100]);
  await act(async () => {
    await tui.setup().mockMouse.click(8, strikeRowY(100));
  });
  await settle();
  const selected = await f.capture();
  expect(selected.launch!.marketReference!.contractSymbol).toBe("AAPL280121C00100000");

  f.replaceSymbols();
  await f.refresh([100]);
  const replaced = await f.capture();
  expect(replaced.launch).toBeNull();
  expect(replaced.frame).not.toContain("AAPL1280121C00100000");
  expect(replaced.frame).toContain("Selected 100 call unavailable");
});
