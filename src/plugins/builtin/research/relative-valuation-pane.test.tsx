import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { Box } from "../../../ui";
import { PaneFooterBar, PaneFooterProvider } from "../../../components/layout/pane/footer";
import { createOpenTuiTestHarness, takeSavedTextFile } from "../../../renderers/opentui/test-utils";
import { createInitialState } from "../../../state/app/context";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { TestPaneProvider, createTestPaneConfig } from "../../../test-support/pane";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { MarketDataCoordinator, setSharedMarketDataCoordinator } from "../../../market-data/coordinator";
import { exportPaneTable } from "../../../state/pane-table-export-registry";
import { createRemoteUiRegistry, RemoteUiRegistryProvider, type RemoteUiRegistry } from "../../../remote/semantic-tree";
import { RelativeValuationPane } from "./relative-valuation-pane";

const tui = createOpenTuiTestHarness();
const paneId = "relative-valuation:test";
function Harness({ width, symbols = ["PLD", "FRESH", "MISSING"], registry = createRemoteUiRegistry() }: { width: number; symbols?: string[]; registry?: RemoteUiRegistry }) {
  const config = createTestPaneConfig("/tmp/gloom-relative-valuation-test", {
    instanceId: paneId, paneId: "relative-valuation-pane", settings: { symbols },
  });
  const state = createInitialState(config);
  return <RemoteUiRegistryProvider registry={registry}><TestPaneProvider state={state} paneId={paneId} pluginId="ticker-research" runtime={createTestPluginRuntime()}>
    <PaneFooterProvider>{(footer) => <Box width={width} height={16} flexDirection="column">
      <Box width={width} height={15}><RelativeValuationPane paneId={paneId} paneType="relative-valuation-pane" focused width={width} height={15} /></Box>
      <PaneFooterBar footer={footer} focused width={width} />
    </Box>}</PaneFooterProvider>
  </TestPaneProvider></RemoteUiRegistryProvider>;
}
async function settle() {
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); await tui.setup().renderOnce(); });
}
afterEach(() => {
  setSharedMarketDataCoordinator(null);
});
test("stale peer remains inspectable with contextual failure, excluded quote values and healthy peers intact", async () => {
  let stale = true;
  setSharedMarketDataCoordinator(new MarketDataCoordinator(createTestDataProvider({ getTickerFinancials: async (symbol) => {
    if (symbol === "MISSING") throw new Error("source unavailable");
    return { annualStatements: [], quarterlyStatements: [], priceHistory: [],
      quote: { symbol, price: symbol === "PLD" ? 135.75 : 200, change: 1, changePercent: 1, currency: "USD", lastUpdated: 1789167600002,
        stale: symbol === "PLD" && stale, marketCap: 1000 },
      fundamentals: { trailingPE: 30.2, operatingMargin: .4, financialCurrency: "USD" },
    };
  } })));
  await act(async () => { await tui.render(<Harness width={120} />, { width: 120, height: 16 }); });
  await settle();
  const frame = tui.frame();
  expect(frame).toContain("Stale quotes: PLD");
  expect(frame).toContain("MISSING: source unavailable");
  expect(frame).toContain("PLD");
  expect(frame).toContain("$200.00");
  expect(frame).not.toContain("$135.75");
  await exportPaneTable(paneId, "rv-stale.csv");
  const csv = takeSavedTextFile()!.text;
  expect(csv).toContain("PLD,,,,30.2");
  stale = false;
  await act(async () => { tui.setup().mockInput.pressKey("r"); });
  await settle();
  const recovered = tui.frame();
  expect(recovered).toContain("$135.75");
  expect(recovered).not.toContain("Stale quotes:");
  expect(recovered).toContain("MISSING: source unavailable");
});

test("stale fundamentals retain their disclosure and export provenance with a fresh quote, then clear on refresh", async () => {
  let stale = true;
  setSharedMarketDataCoordinator(new MarketDataCoordinator(createTestDataProvider({ getTickerFinancials: async (symbol) => ({
    annualStatements: [], quarterlyStatements: [], priceHistory: [],
    quote: { symbol, price: 135.75, change: 1, changePercent: 1, currency: "USD", lastUpdated: 1789567200000, stale: false, marketCap: 131e9 },
    fundamentals: { trailingPE: 30.2, financialCurrency: "USD", source: "gloom", fetchedAt: "2026-09-11T23:52:16.139Z", stale: symbol === "PLD" && stale },
  }) })));
  await tui.render(<Harness width={120} />, { width: 120, height: 16 });
  await settle();
  expect(tui.frame()).toContain("$135.75");
  expect(tui.frame()).not.toContain("Fundamentals stale");
  await act(async () => tui.setup().mockInput.pressKey("!"));
  await settle();
  expect(tui.frame()).toContain("PLD: Fundamentals stale");
  await act(async () => tui.setup().mockInput.pressKey("escape"));
  await settle();
  await exportPaneTable(paneId, "rv-stale-fundamentals.csv");
  const csv = takeSavedTextFile()!.text;
  expect(csv).toContain("PLD,Fundamentals retrieved,2026-09-11T23:52:16.139Z,Stale,true");
  expect(csv).not.toContain("gloom");
  expect(csv).toContain("PLD,Fundamentals stale");
  stale = false;
  await act(async () => tui.setup().mockInput.pressKey("r"));
  await settle();
  await act(async () => tui.setup().mockInput.pressKey("!"));
  await settle();
  expect(tui.frame()).not.toContain("Fundamentals stale");
  await exportPaneTable(paneId, "rv-fresh-fundamentals.csv");
  expect(takeSavedTextFile()!.text).toContain("PLD,Fundamentals retrieved,2026-09-11T23:52:16.139Z,Stale,false");
});

test("euro and dollar caps under MCAP USD name the rate in the footer, beside the period the figures run through, and a capture reads both", async () => {
  const quarters = [{ date: "2026-03-31" }, { date: "2026-06-30" }];
  const rateAsOf = new Date(Math.floor(Date.now() / 60_000) * 60_000 - 3_600_000).toISOString();
  setSharedMarketDataCoordinator(new MarketDataCoordinator(createTestDataProvider({
    getExchangeRateSnapshot: async (currency) => ({ fromCurrency: currency, toCurrency: "USD", rate: 1.1612, source: "test",
      asOf: rateAsOf, fetchedAt: new Date().toISOString(), stale: false }),
    getTickerFinancials: async (symbol) => {
      const euro = symbol === "LHA:XETRA";
      return { annualStatements: [{ date: "2025-12-31" }], quarterlyStatements: quarters, priceHistory: [],
        quote: { symbol, price: euro ? 7.05 : 546.97, change: 0, changePercent: 0, currency: euro ? "EUR" : "USD", lastUpdated: Date.now() - 60_000,
          exchangeName: euro ? "XETRA" : "NYSE", dataSource: "delayed" as const, providerId: "gloomberb-cloud", marketCap: euro ? 8.5e9 : 1.14e12 },
        fundamentals: { financialCurrency: euro ? "EUR" : "USD", revenueGrowth: 0.079, operatingMargin: 0.04 } };
    },
  })));
  const registry = createRemoteUiRegistry();
  await act(async () => { await tui.render(<Harness width={160} symbols={["LHA:XETRA", "BRK-B"]} registry={registry} />, { width: 160, height: 16 }); });
  await settle();
  const footer = `MCAP USD at EUR/USD 1.1612 (${rateAsOf.slice(0, 16).replace("T", " ")} UTC) · fundamentals through 2026-06-30, Q REV% for that quarter`;
  expect(tui.frame()).toContain(footer);
  // A capture's status line ends with the same words, after each market's session, from what the pane publishes.
  const published = registry.snapshot().find((node) => node.role === "report-freshness")?.metadata;
  const shorter = "MCAP USD at EUR/USD 1.1612 · fundamentals through 2026-06-30, Q REV% for that quarter";
  expect(published).toMatchObject({ datesEachVenue: true, note: footer, noteVariants: [shorter, "MCAP USD at EUR/USD 1.1612 · fundamentals through 2026-06-30", "MCAP USD at EUR/USD 1.1612"] });
  expect((published?.observations as Array<Record<string, unknown>>).map((row) => row.delayMinutes)).toEqual([15, 15]);
  // A narrow pane keeps the rate and the period, without the rate's time.
  await act(async () => { await tui.render(<Harness width={80} symbols={["LHA:XETRA", "BRK-B"]} />, { width: 80, height: 16 }); });
  await settle();
  expect(tui.frame()).toContain("MCAP USD at EUR/USD 1.1612 · fundamentals through 2026-06-30 ");
});

test("a peer whose trailing quarters are not in yet shows its latest fiscal year's margin, named, and the column widens to fit", async () => {
  setSharedMarketDataCoordinator(new MarketDataCoordinator(createTestDataProvider({ getTickerFinancials: async (symbol) => ({
    annualStatements: symbol === "CCL" ? [{ date: "2025-11-30", totalRevenue: 26.62e9, operatingIncome: 4.48e9 }] : [], quarterlyStatements: [], priceHistory: [],
    quote: { symbol, price: 26, change: 0, changePercent: 0, currency: "USD", lastUpdated: 1789167600002, marketCap: 35e9 },
    fundamentals: { financialCurrency: "USD", ...symbol === "CCL" ? {} : { operatingMargin: 0.2732 } },
  }) })));
  await act(async () => { await tui.render(<Harness width={140} symbols={["CCL", "RCL"]} />, { width: 140, height: 16 }); });
  await settle();
  const frame = tui.frame();
  expect(frame).toContain("16.83% FY25");
  expect(frame).toContain("27.32%");
});
