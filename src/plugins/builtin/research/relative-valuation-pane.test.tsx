import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { Box } from "../../../ui";
import { PaneFooterBar, PaneFooterProvider } from "../../../components/layout/pane/footer";
import { testRender } from "../../../renderers/opentui/test-utils";
import { createInitialState } from "../../../state/app/context";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { TestPaneProvider, createTestPaneConfig } from "../../../test-support/pane";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { MarketDataCoordinator, setSharedMarketDataCoordinator } from "../../../market-data/coordinator";
import { exportPaneTable } from "../../../state/pane-table-export-registry";
import { takeSavedTextFile } from "../../../renderers/opentui/test-utils";
import { RelativeValuationPane } from "./relative-valuation-pane";

let setup: Awaited<ReturnType<typeof testRender>> | undefined;
const paneId = "relative-valuation:test";
function Harness({ width }: { width: number }) {
  const config = createTestPaneConfig("/tmp/gloom-relative-valuation-test", {
    instanceId: paneId, paneId: "relative-valuation-pane", settings: { symbols: ["PLD", "FRESH", "MISSING"] },
  });
  const state = createInitialState(config);
  return <TestPaneProvider state={state} paneId={paneId} pluginId="ticker-research" runtime={createTestPluginRuntime()}>
    <PaneFooterProvider>{(footer) => <Box width={width} height={16} flexDirection="column">
      <Box width={width} height={15}><RelativeValuationPane paneId={paneId} paneType="relative-valuation-pane" focused width={width} height={15} /></Box>
      <PaneFooterBar footer={footer} focused width={width} />
    </Box>}</PaneFooterProvider>
  </TestPaneProvider>;
}
async function settle() {
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); await setup!.renderOnce(); });
}
afterEach(async () => {
  if (setup) await act(async () => { setup!.renderer.destroy(); });
  setup = undefined;
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
  await act(async () => { setup = await testRender(<Harness width={120} />, { width: 120, height: 16 }); });
  await settle();
  const frame = setup!.captureCharFrame();
  if (process.env.RV_AUDIT_EVIDENCE) await Bun.write(`${process.env.RV_AUDIT_EVIDENCE}/stale-ui.txt`, frame);
  expect(frame).toContain("Stale quotes: PLD");
  expect(frame).toContain("MISSING: source unavailable");
  expect(frame).toContain("PLD");
  expect(frame).toContain("$200.00");
  expect(frame).not.toContain("$135.75");
  await exportPaneTable(paneId, "rv-stale.csv");
  const csv = takeSavedTextFile()!.text;
  if (process.env.RV_AUDIT_EVIDENCE) await Bun.write(`${process.env.RV_AUDIT_EVIDENCE}/stale-ui.csv`, csv);
  expect(csv).toContain("PLD,'-,'-,—,30.2");
  stale = false;
  await act(async () => { setup!.mockInput.pressKey("r"); });
  await settle();
  const recovered = setup!.captureCharFrame();
  expect(recovered).toContain("$135.75");
  expect(recovered).not.toContain("Stale quotes:");
  expect(recovered).toContain("MISSING: source unavailable");
  if (process.env.RV_AUDIT_EVIDENCE) await Bun.write(`${process.env.RV_AUDIT_EVIDENCE}/recovered-ui.txt`, recovered);
});
