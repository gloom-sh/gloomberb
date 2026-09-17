import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "../../../renderers/opentui/test-utils";
import { setSharedMarketDataCoordinator } from "../../../market-data/coordinator";
import { setSharedRegistryForTests, type PluginRegistry } from "../../../plugins/registry";
import { resetInlineTickerFailures } from "../../../state/hooks/inline-ticker-failures";
import { AppContext, createInitialState } from "../../../state/app/context";
import { createDefaultConfig } from "../../../types/config";
import { TickerBadgeList } from "./list";

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined;

function createState() {
  const state = createInitialState(createDefaultConfig("/tmp/gloomberb-badge-list-test"));
  state.tickers.set("NFLX", {
    metadata: {
      ticker: "NFLX",
      exchange: "NASDAQ",
      currency: "USD",
      name: "Netflix",
      portfolios: [],
      watchlists: [],
      positions: [],
      broker_contracts: [],
      custom: {},
      tags: [],
    },
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

async function renderList(width: number) {
  const state = createState();
  setSharedRegistryForTests({ pinTicker: () => {} } as unknown as PluginRegistry);
  await act(async () => {
    testSetup = await testRender(
      <AppContext value={{ state, dispatch: () => {} }}>
        <TickerBadgeList symbols={["NFLX"]} width={width} />
      </AppContext>,
      { width: width + 4, height: 1 },
    );
  });
  await act(async () => {
    await testSetup!.renderOnce();
  });
  return testSetup!.captureCharFrame();
}

afterEach(async () => {
  if (testSetup) {
    await act(async () => {
      testSetup!.renderer.destroy();
    });
  }
  testSetup = undefined;
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
});
