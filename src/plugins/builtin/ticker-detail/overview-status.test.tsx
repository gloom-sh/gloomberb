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
