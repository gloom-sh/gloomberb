import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { MarketDataCoordinator, setSharedMarketDataCoordinator } from "../../../market-data/coordinator";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { KellySizerHarness, createFinancials, createSizerConfig, createTicker } from "./test-support";

const tui = createOpenTuiTestHarness();

async function renderPane(props?: Parameters<typeof KellySizerHarness>[0]) {
  await act(async () => {
    await tui.render(<KellySizerHarness {...props} />, { width: 100, height: 30 });
    await Promise.resolve();
    await tui.setup().renderOnce();
  });
}

async function flushFrame() {
  await act(async () => {
    await tui.setup().renderOnce();
  });
}

beforeEach(() => {
  setSharedMarketDataCoordinator(null);
});

afterEach(() => {
  setSharedMarketDataCoordinator(null);
});

describe("KellySizerPane", () => {
  test("prefills shared caps from plugin config", async () => {
    const config = {
      ...createSizerConfig(),
      pluginConfig: {
        portfolio: {
          "commonAssumptions:v1": {
            kellyFraction: 0.5,
            maxLossFraction: 0.02,
            maxNameFraction: 0.1,
          },
        },
      },
    };

    await renderPane({ config, paneState: { mode: "scenario" } });
    await flushFrame();

    const frame = tui.frame();
    expect(frame).toContain("Scenario");
    expect(frame).toMatch(/Kelly\s+50\.0\s+%/);
    expect(frame).toMatch(/Loss cap\s+2\.00\s+%/);
    expect(frame).toMatch(/Name cap\s+10\.0\s+%/);
  });

  test("keeps shared caps scoped to pane state after seeding", async () => {
    const config = {
      ...createSizerConfig(),
      pluginConfig: {
        portfolio: {
          "commonAssumptions:v1": {
            kellyFraction: 0.5,
            maxLossFraction: 0.02,
            maxNameFraction: 0.1,
          },
        },
      },
    };

    await renderPane({
      config,
      paneState: {
        mode: "scenario",
        "commonAssumptions:v1": {
          kellyFraction: 0.3,
          maxLossFraction: 0.015,
          maxNameFraction: 0.07,
        },
      },
    });
    await flushFrame();

    const frame = tui.frame();
    expect(frame).toContain("Scenario");
    expect(frame).toMatch(/Kelly\s+30\.0\s+%/);
    expect(frame).toMatch(/Loss cap\s+1\.50\s+%/);
    expect(frame).toMatch(/Name cap\s+7\.00\s+%/);
    expect(frame).not.toMatch(/Kelly\s+50\.0\s+%/);
  });

  test("converts foreign quote current value to base currency", async () => {
    const ticker = createTicker({
      symbol: "SIVE",
      currency: "SEK",
      positions: [{
        portfolio: "main",
        shares: 100,
        avgCost: 50,
        currency: "SEK",
        broker: "ibkr",
        brokerInstanceId: "ibkr-flex",
        brokerAccountId: "DU12345",
        marketValue: 10_000,
        unrealizedPnl: 5_000,
      }],
    });
    const financials = createFinancials({ symbol: "SIVE", price: 100, currency: "SEK" });
    setSharedMarketDataCoordinator(new MarketDataCoordinator(createTestDataProvider({
      getExchangeRate: async (currency) => (currency === "SEK" ? 0.1 : 1),
    })));

    await renderPane({ config: createSizerConfig("SIVE"), ticker, financials });
    await flushFrame();

    const frame = await tui.waitForFrameToContain("Current  1000");
    expect(frame).toContain("SIVE");
    expect(frame).toContain("Main Portfolio");
    expect(frame).toMatch(/Current\s+1000\s+USD/);
    expect(frame).not.toMatch(/Current\s+10000\s+USD/);
  });

  test("toggles sensitivity with s", async () => {
    await renderPane();
    await flushFrame();

    await act(async () => {
      (tui.setup().renderer.keyInput as any).emit("keypress", {
        name: "s",
        sequence: "s",
        ctrl: false,
        meta: false,
        shift: false,
      });
      await tui.setup().renderOnce();
    });
    await flushFrame();

    const frame = tui.frame();
    expect(frame).toMatch(/WIN P\s+UPSIDE 18\.0%\s+UPSIDE 24\.0%\s+UPSIDE 30\.0%/);
    expect(frame).toMatch(/57\.0%\s+8\.00%/);
    expect(frame).not.toContain("Expected log growth");
  });

  test("the keyboard edits every cell and lets go of Tab past the first one", async () => {
    await renderPane();
    await flushFrame();
    const press = (event: { name: string; sequence: string; shift?: boolean }) =>
      tui.emitKeypress(event, { trackPropagation: true, afterCommit: true });
    const settleFocus = () => act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      await tui.setup().renderOnce();
    });

    // e starts at Bankroll, which is not a sizing assumption and was out of reach.
    await press({ name: "e", sequence: "e" });
    await settleFocus();
    await act(async () => {
      await tui.setup().mockInput.typeText("5000");
      await tui.setup().renderOnce();
    });
    await press({ name: "tab", sequence: "\t" });
    await settleFocus();
    await press({ name: "escape", sequence: "\u001B" });
    expect(tui.frame()).toMatch(/Bankroll\s+5000\s+USD/);

    // e resumes at Current; Shift+Tab walks back and then out of the cells.
    await press({ name: "e", sequence: "e" });
    await settleFocus();
    await press({ name: "tab", sequence: "\t", shift: true });
    await press({ name: "tab", sequence: "\t", shift: true });
    await press({ name: "s", sequence: "s" });
    expect(tui.frame()).toContain("Sensitivity");
  });

  test("focuses ticker search with slash", async () => {
    await renderPane();
    await flushFrame();

    await act(async () => {
      (tui.setup().renderer.keyInput as any).emit("keypress", {
        name: "/",
        sequence: "/",
        ctrl: false,
        meta: false,
        shift: false,
      });
      await tui.setup().renderOnce();
    });
    await flushFrame();

    const frame = tui.frame();
    expect(frame).toContain("/ AAPL");
  });
});
