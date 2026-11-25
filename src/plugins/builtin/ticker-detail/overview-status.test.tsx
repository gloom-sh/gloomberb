import { expect, setSystemTime, spyOn, test } from "bun:test";
import { act } from "react";
import { apiClient } from "../../../api-client";
import { marketDataCliCommands } from "../../../cli/commands/market";
import { createOpenTuiTestHarness, settleFrame } from "../../../renderers/opentui/test-utils";
import { AppContext, createInitialState } from "../../../state/app/context";
import { createStaticAppStore } from "../../../test-support/app-store";
import { createDefaultConfig } from "../../../types/config";
import { createTestTicker } from "../../../test-support/ticker";
import { createTestDataProvider, createTestFinancials, createTestQuote } from "../../../test-support/data-provider";
import { createTestCliContext } from "../../../test-support/cli-context";
import { TestPaneFrame } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import type { TickerSnapshotState } from "../../../market-data/hooks";
import { OverviewTab } from "./overview-tab";

const config = createDefaultConfig("/tmp/gloom-overview-status-test-unused");
const ticker = createTestTicker("AMGN", "Amgen Inc.", { exchange: "NASDAQ", currency: "USD" });
const tui = createOpenTuiTestHarness();

async function show(snapshot: TickerSnapshotState) {
  await act(async () => {
    await tui.render(
      <AppContext value={createStaticAppStore(createInitialState(config))}>
        <OverviewTab ticker={ticker} financials={null} width={100} snapshot={snapshot} />
      </AppContext>,
      { width: 100, height: 12 },
    );
  });
  await settleFrame(tui.setup(), 5);
  return tui.frame();
}

// The tab stood empty for a round trip on every new ticker, and for good when the network was down.
test("an overview with nothing in yet says it is loading, then why it could not, with a retry", async () => {
  let retried = 0;
  const retry = async () => { retried += 1; };

  expect(await show({ loading: true, error: null, retry })).toContain("Loading overview...");

  const failed = await show({ loading: false, error: "Gloom couldn't reach its data service", retry });
  expect(failed).toContain("Overview unavailable.");
  expect(failed).toContain("Gloom couldn't reach its data service");
  const row = failed.split("\n").findIndex((line) => line.includes("Retry"));
  expect(row).toBeGreaterThanOrEqual(0);
  await act(async () => {
    await tui.setup().mockMouse.click(failed.split("\n")[row]!.indexOf("Retry") + 1, row);
    await settleFrame(tui.setup(), 2);
  });
  expect(retried).toBe(1);
  await tui.destroy();
});

test("a quarter-only runway leaves no history warning on an overview without a runway stat", async () => {
  const financials = createTestFinancials({
    quote: createTestQuote({ symbol: ticker.metadata.ticker }),
    annualStatements: [],
    quarterlyStatements: [{ date: "2026-06-30", cashAndCashEquivalents: 120, operatingCashFlow: -30 }],
  });
  const overview = createOpenTuiTestHarness();
  let notes: readonly string[] = [];
  try {
    await act(async () => {
      await overview.render(
        <TestPaneFrame state={createInitialState(config)} paneId="overview" pluginId="ticker-research"
          runtime={createTestPluginRuntime()} width={100} height={30}>
          {(body, footer) => {
            notes = footer.info.flatMap((info) => info.notes ?? []);
            return <OverviewTab {...body} focused ticker={ticker} financials={financials} />;
          }}
        </TestPaneFrame>,
        { width: 100, height: 30 },
      );
    });
    await settleFrame(overview.setup(), 5);
    expect(overview.frame()).not.toContain("Runway");
    expect(notes.join(" ")).not.toMatch(/runway|quarters/i);
  } finally {
    await overview.destroy();
  }
});

test("Overview and valuation use the same dated FX close for a withdrawn EV on a USD receipt", async () => {
  setSystemTime(new Date("2026-11-25T17:29:00Z"));
  const receipt = createTestTicker("BABA", "Alibaba ADR", { exchange: "NYSE", currency: "USD" });
  const quote = createTestQuote({ symbol: "BABA", price: 100, listingExchangeName: "NYSE", instrumentType: "EQUITY" });
  const financials = createTestFinancials({ quote, financialCurrency: "CNY",
    fundamentals: { marketCap: 50e9, marketCapCurrency: "USD", sharesOutstanding: 500e6, unavailableFields: ["enterpriseValue"] },
    quarterlyStatements: [{ date: "2026-09-30", currency: "CNY", totalDebt: 70e9, cashAndCashEquivalents: 14e9 }],
  });
  const history = spyOn(apiClient, "getCloudHistory").mockResolvedValue({ status: "success", data: [
    { date: "2026-09-30", close: 7 }, { date: "2026-10-01", close: 8 },
  ] });
  const overview = createOpenTuiTestHarness();
  try {
    const cli = createTestCliContext({ dataProvider: createTestDataProvider({ getTickerFinancials: async () => financials,
      getQuote: async () => quote }), fxHistory: { getCloudHistory: apiClient.getCloudHistory } });
    await marketDataCliCommands.find((command) => command.name === "valuation")!.execute(["BABA:NYSE"], cli.context);
    const { result, options } = cli.printed[0]!;
    const report = options!.text!(result.data);
    const value = report.match(/^Enterprise Value\s+(.+)$/m)?.[1];
    expect(value).toBe("58B USD");
    expect(report).toContain("the 2026-09-30 close");
    history.mockClear();

    await act(async () => {
      await overview.render(<TestPaneFrame state={createInitialState(config)} paneId="overview" pluginId="ticker-research"
        runtime={createTestPluginRuntime()} width={116} height={50}>
        {(body) => <OverviewTab {...body} focused ticker={receipt} financials={financials} />}
      </TestPaneFrame>, { width: 116, height: 50 });
    });
    const frame = await overview.waitForFrameToContain(value!);
    expect(frame).toMatch(/\bEV\s+58B USD/);
    expect(history).toHaveBeenCalledWith("CNY=X", expect.any(String), expect.objectContaining({ endDate: "2026-10-01" }));
  } finally {
    await overview.destroy();
    history.mockRestore();
    setSystemTime();
  }
});

test("a wide Overview tile labels a served, lease-inclusive EV as computed", async () => {
  const financials = createTestFinancials({ quote: createTestQuote({ symbol: ticker.metadata.ticker }), fundamentals: {
    marketCap: 100e9, marketCapCurrency: "USD", enterpriseValue: 125e9,
    enterpriseValueCheck: { status: "differs", currency: "USD", source: 110e9, computed: 125e9,
      marketCap: 100e9, totalDebt: 20e9, leases: 10e9, cash: 5e9, balanceSheetDate: "2026-09-30" },
  } });
  const overview = createOpenTuiTestHarness();
  try {
    await act(async () => {
      await overview.render(<TestPaneFrame state={createInitialState(config)} paneId="overview" pluginId="ticker-research"
        runtime={createTestPluginRuntime()} width={224} height={50}>
        {(body) => <OverviewTab {...body} focused ticker={ticker} financials={financials} />}
      </TestPaneFrame>, { width: 224, height: 50 });
    });
    const frame = await overview.waitForFrameToContain("125B USD");
    expect(frame).toMatch(/\bEV +125B USD +computed\b/);
  } finally {
    await overview.destroy();
  }
});

test.each([true, false])("IAG Overview and valuation agree when a withdrawn EV has a valid bridge (%s)", async (hasBridge) => {
  setSystemTime(new Date("2026-11-25T20:05:00Z"));
  const listing = createTestTicker("IAG:LSE", "International Consolidated Airlines Group", { exchange: "LSE", currency: "GBP" });
  const quote = createTestQuote({ symbol: "IAG", currency: "GBP", listingExchangeName: "LSE", price: 4.11 });
  const financials = createTestFinancials({ quote, financialCurrency: "EUR", fundamentals: {
    marketCap: 18.87e9, marketCapCurrency: "GBP", unavailableFields: ["enterpriseValue"],
    enterpriseValueCheck: { status: "withdrawn", currency: "GBP", source: 20.67e9, marketCap: 18.86e9,
      ...(hasBridge ? { computed: 22.91e9, totalDebt: 5.99e9, leases: 5.95e9, cash: 7.9e9,
        balanceSheetDate: "2026-06-30", fx: { from: "EUR", rate: 0.86135 } }
        : { reason: "The source EV was not checked against the balance sheet" }) },
  } });
  const overview = createOpenTuiTestHarness();
  let notes: string[] = [];
  try {
    const cli = createTestCliContext({ dataProvider: createTestDataProvider({ getTickerFinancials: async () => financials,
      getQuote: async () => quote }) });
    await marketDataCliCommands.find((command) => command.name === "valuation")!.execute(["IAG:LSE"], cli.context);
    const { result, options } = cli.printed[0]!;
    const report = options!.text!(result.data);
    await act(async () => {
      await overview.render(<TestPaneFrame state={createInitialState(config)} paneId="overview" pluginId="ticker-research"
        runtime={createTestPluginRuntime()} width={224} height={50}>
        {(body, footer) => {
          notes = footer.info.flatMap((info) => info.notes ?? []);
          return <OverviewTab {...body} focused ticker={listing} financials={financials} />;
        }}
      </TestPaneFrame>, { width: 224, height: 50 });
    });
    await settleFrame(overview.setup(), 5);
    if (hasBridge) {
      expect(overview.frame()).toMatch(/\bEV\s+22\.92B GBP\s+computed/);
      expect(report).toMatch(/^Enterprise Value\s+22\.92B GBP$/m);
      const bridgeNote = notes.find((note) => note.startsWith("EV 22.92B GBP"))!;
      expect(bridgeNote).toContain("+ leases 5.95B");
      expect(bridgeNote).toContain("balance sheet 2026-06-30, EUR/GBP 0.86135 at its date's close");
      expect(report).toContain(bridgeNote);
      expect(notes.join(" ")).not.toContain("EV unavailable");
    } else {
      expect(report).toMatch(/^Enterprise Value\s+unavailable$/m);
      expect(overview.frame()).not.toMatch(/\bEV\s+\d/);
      expect(notes.join(" ")).toContain("EV unavailable");
    }
  } finally {
    await overview.destroy();
    setSystemTime();
  }
});
