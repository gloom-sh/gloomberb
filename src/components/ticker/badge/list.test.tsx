import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { setSharedMarketDataCoordinator } from "../../../market-data/coordinator";
import { setSharedRegistryForTests, type PluginRegistry } from "../../../plugins/registry";
import { resetInlineTickerFailures } from "../../../state/hooks/inline-ticker-failures";
import { AppContext, createInitialState } from "../../../state/app/context";
import { createStaticAppStore } from "../../../test-support/app-store";
import { createDefaultConfig } from "../../../types/config";
import { TickerBadgeList } from "./list";
import { createTestTicker } from "../../../test-support/ticker";

const tui = createOpenTuiTestHarness();

function createState() {
  const state = createInitialState(createDefaultConfig("/tmp/gloomberb-badge-list-test"));
  state.tickers.set("NFLX", createTestTicker("NFLX", "Netflix", { broker_contracts: [] }));
  state.tickers.set("TSLA", createTestTicker("TSLA", "Tesla", { broker_contracts: [] }));
  state.financials.set("TSLA", {
    annualStatements: [],
    quarterlyStatements: [],
    priceHistory: [],
    quote: { symbol: "TSLA", price: 250, currency: "USD", change: -12.5, changePercent: -5, lastUpdated: Date.now() },
  });
  state.financials.set("NFLX", {
    annualStatements: [],
    quarterlyStatements: [],
    priceHistory: [],
    quote: {
      symbol: "NFLX",
      price: 1234.5,
      currency: "USD",
      change: 15.1,
      changePercent: 1.24,
      lastUpdated: Date.now(),
    },
  });
  return state;
}

async function renderList(width: number, symbols: string[] = ["NFLX"]) {
  const state = createState();
  setSharedRegistryForTests({ pinTicker: () => {} } as unknown as PluginRegistry);
  await act(async () => {
    await tui.render(
      <AppContext value={createStaticAppStore(state)}>
        <TickerBadgeList symbols={symbols} width={width} />
      </AppContext>,
      { width: width + 4, height: 1 },
    );
  });
  await act(async () => {
    await tui.setup().renderOnce();
  });
  return tui.frame();
}

afterEach(() => {
  resetInlineTickerFailures();
  setSharedMarketDataCoordinator(null);
  setSharedRegistryForTests(undefined);
});

describe("TickerBadgeList", () => {
  test("spends the spare columns of a cell on the day's change", async () => {
    expect(await renderList(14)).toContain("NFLX +1.2%");
  });

  test("keeps the symbol whole when the change would not fit", async () => {
    const frame = await renderList(9);
    expect(frame).toContain("NFLX");
    expect(frame).not.toContain("+1.2");
  });

  test("hovering a chip shows its price without moving the chips after it", async () => {
    const resting = (await renderList(30, ["NFLX", "TSLA"])).split("\n")[0]!;
    expect(resting).toContain("NFLX +1.2%");
    expect(resting).toContain("TSLA -5.0%");

    await act(async () => {
      await tui.setup().mockMouse.moveTo(resting.indexOf("NFLX") + 1, 0);
      await tui.setup().renderOnce();
    });
    await tui.setup().renderOnce();
    const hovered = tui.frame().split("\n")[0]!;

    expect(hovered).toContain("$1,234.50");
    expect(hovered).not.toContain("NFLX");
    expect(hovered.indexOf("TSLA -5.0%")).toBe(resting.indexOf("TSLA -5.0%"));
  });

  test("a symbol the source names a listing for opens that listing, and one it names none for prints as plain text", async () => {
    const opened: string[] = [];
    const state = createState();
    state.tickers.set("2330:TWSE", createTestTicker("2330", "TSMC", { exchange: "TWSE", broker_contracts: [] }));
    state.financials.set("2330:TWSE", {
      annualStatements: [],
      quarterlyStatements: [],
      priceHistory: [],
      quote: { symbol: "2330", price: 2330, currency: "TWD", change: -40, changePercent: -1.7, lastUpdated: Date.now() },
    });
    setSharedRegistryForTests({ pinTicker: (symbol: string) => { opened.push(symbol); } } as unknown as PluginRegistry);
    await act(async () => {
      await tui.render(
        <AppContext value={createStaticAppStore(state)}>
          <TickerBadgeList symbols={["NFLX", "2330", "981"]} width={40} listings={{ "2330": "2330:TWSE", "981": null }} />
        </AppContext>,
        { width: 44, height: 1 },
      );
    });
    await act(async () => { await tui.setup().renderOnce(); });
    const line = tui.frame().split("\n")[0]!;
    // The listing is priced like the others: its chip spends spare columns on the day's change.
    expect(line).toContain("NFLX +1.2%");
    expect(line).toContain("2330 -1.7%");
    for (const symbol of ["NFLX", "2330", "981"]) {
      await act(async () => { await tui.setup().mockMouse.click(line.indexOf(symbol) + 1, 0); await tui.setup().renderOnce(); });
    }
    expect(opened).toEqual(["NFLX", "2330:TWSE"]);
  });
});
