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
    await tui.render(
      <AppContext value={createStaticAppStore(state)}>
        <TickerBadgeList symbols={["NFLX"]} width={width} />
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
});
