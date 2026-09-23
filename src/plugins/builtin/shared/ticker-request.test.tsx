import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { ApiRequestError } from "../../../api-client/errors";
import { PaneFooterBar, PaneFooterProvider } from "../../../components/layout/pane/footer";
import { emitKeypress, testRender } from "../../../renderers/opentui/test-utils";
import { createInitialState } from "../../../state/app/context";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { TestPaneProvider, createTestPaneConfig, createTestTicker } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { Box } from "../../../ui";
import { AnalystResearchView } from "../research/analyst-pane";
import { CorporateActionsView } from "../research/corporate-actions-pane";
import { HistoricalPricesPane } from "../ticker-detail/data-panes/historical-prices";

type Pane = "analyst-research" | "earnings-estimates" | "corporate-actions" | "historical-prices";
let setup: Awaited<ReturnType<typeof testRender>> | undefined;

afterEach(async () => {
  if (setup) await act(async () => { setup!.renderer.destroy(); });
  setup = undefined;
});

async function settle() {
  for (let i = 0; i < 4; i++) await act(async () => { await Bun.sleep(1); await setup!.renderOnce(); });
}

function view() { return setup!.captureCharFrame(); }

async function mount(pane: Pane, width: number, state: { failure: Error | null; revision: number }) {
  const fail = () => { if (state.failure) throw state.failure; };
  const requests: boolean[] = [];
  const provider = createTestDataProvider({
    getAnalystResearch: async (_symbol, _exchange, context) => {
      if (pane !== "corporate-actions") { requests.push(context?.cacheMode === "refresh"); fail(); }
      return { symbol: "GROW", currency: "USD", recommendations: [],
        ratings: [{ date: "2026-08-01", firm: state.revision ? "Recovered Research" : "Original Research", currentPriceTarget: 120 }],
        earningsEstimates: [{ date: "2026-09-30", period: "current_quarter", currency: "USD", average: state.revision ? 15.67 : 12.34 }],
        revenueEstimates: [],
      };
    },
    getCorporateActions: async (_symbol, _exchange, context) => {
      if (pane === "corporate-actions") { requests.push(context?.cacheMode === "refresh"); fail(); }
      return { symbol: "GROW", currency: "USD", dividends: [], splits: [],
        earnings: [{ date: state.revision ? "2026-06-30" : "2026-03-31", dateType: "fiscal-period-end" as const, epsActual: 2.34, currency: "USD" }],
      };
    },
    getPriceHistory: async (_symbol, _exchange, _range, context) => {
      requests.push(context?.cacheMode === "refresh"); fail();
      return [{ date: new Date(state.revision ? "2026-09-02T00:00:00Z" : "2026-09-01T00:00:00Z"), close: 52.5 }];
    },
  });
  const paneId = pane + ":GROW";
  const config = createTestPaneConfig("/tmp/gloom-research-refresh-test", {
    instanceId: paneId, paneId: pane, binding: { kind: "fixed", symbol: "GROW" },
  });
  const app = createInitialState(config);
  app.focusedPaneId = paneId;
  app.tickers = new Map([["GROW", createTestTicker("GROW", "Growth fixture", { exchange: "ASX", currency: "USD" })]]);
  const runtime = createTestPluginRuntime({ getMarketData: () => provider });
  const content = pane === "analyst-research"
    ? <AnalystResearchView focused width={width} height={23} />
    : pane === "historical-prices"
      ? <HistoricalPricesPane focused width={width} height={23} paneId={paneId} paneType={pane} />
      : <CorporateActionsView focused width={width} height={23} variant={pane} footerPaneId={pane} />;
  await act(async () => {
    setup = await testRender(<TestPaneProvider state={app} paneId={paneId} pluginId="ticker-research" runtime={runtime}>
      <PaneFooterProvider>{(footer) => <Box width={width} height={24} flexDirection="column">
        <Box width={width} height={23}>{content}</Box>
        <PaneFooterBar footer={footer} focused width={width} />
      </Box>}</PaneFooterProvider>
    </TestPaneProvider>, { width, height: 24 });
  });
  await settle();
  return requests;
}

const cases: [Pane, number, string, string][] = [
  ["analyst-research", 80, "Original Research", "Recovered Research"],
  ["earnings-estimates", 80, "12.34", "15.67"],
  ["earnings-estimates", 48, "12.34", "15.67"],
  ["earnings-estimates", 120, "12.34", "15.67"],
  ["corporate-actions", 80, "2026-03-31", "2026-06-30"],
  ["historical-prices", 80, "2026-09-01", "2026-09-02"],
];

test.each(cases)("%s at %i keeps known research through a transient refresh failure", async (pane, width, original, recovered) => {
  const state = { failure: null as Error | null, revision: 0 };
  const requests = await mount(pane, width, state);
  expect(view()).toContain(original);
  state.failure = new ApiRequestError("Research source timed out", 503);
  await emitKeypress(setup!, { name: "r" });
  await settle();
  const failedRefresh = view();
  expect(failedRefresh).toContain(original);
  expect(failedRefresh).toContain("Research source timed out");
  state.failure = null;
  state.revision = 1;
  await emitKeypress(setup!, { name: "r" });
  await settle();
  const recoveredRefresh = view();
  expect(recoveredRefresh).toContain(recovered);
  expect(recoveredRefresh).not.toContain("Research source timed out");
  state.failure = new ApiRequestError("Research access denied", 403);
  await emitKeypress(setup!, { name: "r" });
  await settle();
  const deniedRefresh = view();
  expect(deniedRefresh).not.toContain(recovered);
  expect(deniedRefresh).toContain("Research access denied");
  expect(requests).toEqual([false, true, true, true]);
});

test.each([
  new ApiRequestError("Research requires sign-in", 401),
  new ApiRequestError("Research subscription required", 402),
  new Error("Gloom Cloud requires signup and email verification"),
])("an access rejection discards the prior successful research response", async (denial) => {
  const state = { failure: null as Error | null, revision: 0 };
  await mount("analyst-research", 80, state);
  expect(view()).toContain("Original Research");
  state.failure = denial;
  await emitKeypress(setup!, { name: "r" });
  await settle();
  const denied = view();
  expect(denied).not.toContain("Original Research");
  expect(denied).toContain(denial instanceof ApiRequestError ? denial.message : "Sign in to");
});

test("a refresh failure without a message cannot leave retained data looking current", async () => {
  const state = { failure: null as Error | null, revision: 0 };
  await mount("analyst-research", 80, state);
  state.failure = new Error("");
  await emitKeypress(setup!, { name: "r" });
  await settle();
  const failed = view();
  expect(failed).toContain("Original Research");
  expect(failed).toContain("Request failed");
});
