import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { act, useState } from "react";
import { apiClient } from "../../../api-client";
import { PaneWrapper } from "../../../components/layout/pane";
import { PaneFooterProvider, type CombinedPaneFooter } from "../../../components/layout/pane/footer";
import { setSharedMarketDataCoordinator } from "../../../market-data/coordinator";
import { testRender } from "../../../renderers/opentui/test-utils";
import { createInitialState, type AppState } from "../../../state/app/context";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { TestPaneProvider, createTestPaneConfig, createTestTicker } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { TICKER_RESEARCH_PANE_ID } from "../../../types/config";
import type { Quote, TickerFinancials } from "../../../types/financials";
import { TickerResearchPane } from "./pane";

const paneId = "research:status";
const asOf = Date.parse("2026-09-11T08:08:00Z");
const now = Date.parse("2026-09-12T02:00:00Z");
let setup: Awaited<ReturnType<typeof testRender>> | undefined;
let update: (change: (state: AppState) => AppState) => void;
let footer: CombinedPaneFooter;

afterEach(async () => {
  if (setup) await act(async () => { setup!.renderer.destroy(); });
  setup = undefined;
  mock.restore();
  setSharedMarketDataCoordinator(null);
});

const quote = (symbol = "9988", stale = true): Quote => ({
  symbol, price: 107.5, currency: "HKD", change: 0.6, changePercent: 0.56,
  listingExchangeName: "HKEX", marketState: "CLOSED", dataSource: "delayed", lastUpdated: asOf, stale,
});
const financials = (value: Quote): TickerFinancials => ({
  quote: value, annualStatements: [{ date: "2026-03-31", currency: "CNY", totalRevenue: 1e12 }],
  quarterlyStatements: [], priceHistory: [],
});

async function frame() {
  for (let i = 0; i < 3; i++) await act(async () => { await setup!.renderOnce(); });
  return setup!.captureCharFrame();
}

async function render(plan: "free" | "pro", width: number) {
  spyOn(Date, "now").mockReturnValue(now);
  spyOn(apiClient, "getCurrentUser").mockReturnValue({ id: "local-status-test", emailVerified: true, plan } as any);
  spyOn(apiClient, "recordResearchActivity").mockResolvedValue(undefined as any);
  setSharedMarketDataCoordinator(null);
  const config = createTestPaneConfig("/unused/status-test", {
    instanceId: paneId, paneId: TICKER_RESEARCH_PANE_ID, binding: { kind: "fixed", symbol: "9988" },
    settings: { liveStreaming: false },
  });
  const initial = createInitialState(config);
  for (const symbol of ["9988", "1211"]) {
    initial.tickers.set(symbol, createTestTicker(symbol, symbol, { exchange: "HKEX", currency: "HKD" }));
    initial.financials.set(symbol, financials(quote(symbol, symbol === "9988")));
  }
  initial.paneState[paneId] = { activeTabId: "overview" };
  function Harness() {
    const [state, setState] = useState(initial);
    update = setState;
    return <TestPaneProvider state={state} paneId={paneId} pluginId="ticker-research"
      runtime={createTestPluginRuntime({ getMarketData: () => createTestDataProvider() })}>
      <PaneFooterProvider>{(value) => {
        footer = value;
        return <PaneWrapper title="Research" focused width={width} height={30} footer={value}>
          <TickerResearchPane paneId={paneId} paneType={TICKER_RESEARCH_PANE_ID} focused width={width} height={28} />
        </PaneWrapper>;
      }}</PaneFooterProvider>
    </TestPaneProvider>;
  }
  setup = await testRender(<Harness />, { width, height: 30 });
  return frame();
}

async function replaceQuote(value: Quote) {
  await act(async () => { update((state) => ({ ...state, financials: new Map(state.financials).set("9988", financials(value)) })); });
  return frame();
}

for (const plan of ["free", "pro"] as const) for (const width of [48, 80, 120]) {
  test(`parent footer exposes stale quote and clears after recovery and ticker change: ${plan}/${width}`, async () => {
    const stale = await render(plan, width);
    expect(stale).toContain("HK$107.5");
    expect(stale).toContain("Stale quote");
    expect(footer.info.filter((segment) => segment.parts.some((part) => part.text.includes("Stale quote")))).toHaveLength(1);
    if (plan === "pro" || width >= 80) expect(stale).toContain("2026-09-11 08:08Z");
    expect(stale.match(/try Pro live/g)?.length ?? 0).toBe(plan === "free" ? 1 : 0);
    if (plan === "free") expect(footer.info.find((segment) => segment.id === "ticker-research-access")?.onPress).toBeFunction();

    expect(await replaceQuote(quote("9988", false))).not.toContain("Stale quote");
    expect(await replaceQuote(quote())).toContain("Stale quote");
    await act(async () => { update((state) => ({ ...state, config: { ...state.config, layout: { ...state.config.layout,
      instances: state.config.layout.instances.map((instance) => ({ ...instance, binding: { kind: "fixed", symbol: "1211" } })),
    } } })); });
    const switched = await frame();
    expect(switched).toContain("1211");
    expect(switched).not.toContain("Stale quote");
    expect(switched).not.toContain("2026-09-11 08:08Z");
  });
}

test("unknown source timestamps do not become fabricated dates and nonquote tabs retain their own status", async () => {
  await render("pro", 80);
  for (const lastUpdated of [NaN, Infinity, 0, -1, 9e15]) {
    const result = await replaceQuote({ ...quote(), lastUpdated });
    expect(result).toContain("Stale quote");
    expect(result).not.toContain("Invalid Date");
    expect(result).not.toContain("1970-");
    expect(footer.info.find((segment) => segment.id === "ticker-research-stale")?.parts).toHaveLength(1);
  }
  await act(async () => { update((state) => ({ ...state, paneState: { ...state.paneState, [paneId]: { activeTabId: "financials" } } })); });
  const financial = await frame();
  expect(financial).not.toContain("Stale quote");
  expect(footer.info.some((segment) => segment.id === "ticker-research-stale")).toBe(false);
});
