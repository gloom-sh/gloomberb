import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { act } from "react";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { MarketDataCoordinator, setSharedMarketDataCoordinator } from "../../../market-data/coordinator";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { KellySizerHarness, createFinancials, createSizerConfig, createTicker } from "./test-support";
import { createTestHeadlessArgs, createTestHeadlessContext } from "../../../test-support/headless";
import type { PricePoint } from "../../../types/financials";
import { kellyHeadless } from "./headless";
import { formatPct } from "./view";

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

  test("sizes in fractions without a bankroll and reads a dash for the money", async () => {
    await renderPane({ paneState: { bankrollOverride: 0, currentValueOverride: 0 } });
    await flushFrame();

    const frame = tui.frame();
    expect(frame).toMatch(/Full Kelly\s+4\d\d\.\d%/);
    expect(frame).toMatch(/Clipped\s+8\.00%/);
    expect(frame).toMatch(/Target val\s+—\s+Set a bankroll/);
    expect(frame).toMatch(/Add \/ trim\s+—/);
    expect(frame).toMatch(/Risk\s+—\s+0\.72%/);
    expect(frame).not.toContain("$0.00");
  });

  test("labels the target marker with the cap that set it", async () => {
    // Defaults: the loss cap would allow 11.1%, the 8% name cap is the one that binds.
    await renderPane();
    await flushFrame();

    const frame = tui.frame();
    expect(frame).toContain("name cap");
    expect(frame).not.toContain("loss cap");
  });

  test("toggles sensitivity with s", async () => {
    await renderPane();
    await flushFrame();

    await tui.emitKeypress({ name: "s", sequence: "s" });
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

  test("History reads the window and numbers the KELLY report reads, and without dated closes both read the trailing range", async () => {
    // 6 Nov 2026: five years run November 2021 to October 2026, measured from October 2021's close.
    const now = Date.parse("2026-11-06T03:00:00Z");
    setSystemTime(new Date(now));
    const weekdays: PricePoint[] = [];
    for (let time = Date.UTC(2021, 9, 1); time < now - 43_200_000; time += 86_400_000) {
      const date = new Date(time);
      // Up 2% a month, and down 3.1% every third month.
      const month = (date.getUTCFullYear() - 2021) * 12 + date.getUTCMonth();
      if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6) weekdays.push({ date, close: 100 * 1.02 ** month * (month % 3 === 2 ? 0.95 : 1) });
    }
    const trailing = weekdays.filter((point) => point.date >= new Date("2021-11-06"));
    const sources = (dated: boolean) => ({
      getDetailedPriceHistory: async (_symbol: string, _exchange: string, start: Date, end: Date) => {
        if (!dated) throw new Error("No dated history");
        return weekdays.filter((point) => point.date >= start && point.date < end);
      },
      getPriceHistoryForResolution: async () => trailing,
      getPriceHistory: async () => trailing,
    });
    const report = (dated: boolean) => kellyHeadless.load(
      createTestHeadlessArgs({ symbols: ["AAPL"], options: { years: 5 } }),
      createTestHeadlessContext({ resolveInstrument: async () => ({ symbol: "AAPL", exchange: "" }),
        marketData: createTestDataProvider(sources(dated)) }),
    );
    try {
      for (const [dated, window] of [[true, "2021-10-29 to 2026-10-30, 60 monthly returns"],
        [false, "2021-11-30 to 2026-10-30, 59 monthly returns"]] as const) {
        const result = await report(dated);
        expect(result.sections![0]!.entries!.find((entry) => entry.key === "window")!.formatted).toBe(window);
        const fullKelly = result.sections![1]!.rows!.find((row) => row.id === "full")!.fraction as number;
        const { wins, periods } = result.metadata!.inputs as { wins: number; periods: number };
        setSharedMarketDataCoordinator(new MarketDataCoordinator(createTestDataProvider(sources(dated))));
        await renderPane({ paneState: { mode: "history" } });
        const [range, count] = window.split(", ");
        const frame = await tui.waitForFrameToContain(count!);
        expect(frame).toContain(range!);
        expect(frame).toContain(`${wins}/${periods}`);
        // The same Full Kelly as the report, to the pane's one decimal.
        expect(frame).toMatch(new RegExp(`Full Kelly\\s+${formatPct(fullKelly, 1).replace(".", "\\.")}`));
        tui.destroy();
        setSharedMarketDataCoordinator(null);
      }
    } finally {
      setSystemTime();
    }
  });

  test("focuses ticker search with slash", async () => {
    await renderPane();
    await flushFrame();

    await tui.emitKeypress({ name: "/", sequence: "/" });
    await flushFrame();

    const frame = tui.frame();
    expect(frame).toContain("/ AAPL");
  });
});
