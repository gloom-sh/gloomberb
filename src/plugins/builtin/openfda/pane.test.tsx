import { afterEach, expect, test } from "bun:test";
import { act, useCallback, useMemo, useState } from "react";
import { createOpenTuiTestHarness, settleFrame } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState, type AppAction, type AppState } from "../../../state/app/context";
import { createTestDataProvider, createTestQuote } from "../../../test-support/data-provider";
import { createTestPaneConfig, TestPaneProvider } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { setHttpFetchTransport } from "../../../utils/http-transport";
import { OpenFdaPane } from "./pane";
import { OPENFDA_PANE_ID, OPENFDA_PLUGIN_ID } from "./types";

const tui = createOpenTuiTestHarness();
const PANE = "fda:test";

afterEach(() => setHttpFetchTransport(null));

const VACCINE_REPORT = {
  safetyreportid: "30000001",
  receivedate: "20260620",
  serious: "1",
  patient: {
    reaction: [{ reactionmeddrapt: "Headache" }],
    drug: [{ medicinalproduct: "ASTRAZENECA COVID-19 VACCINE", drugcharacterization: "1" }],
  },
};

const asked: string[] = [];
const provider = createTestDataProvider({
  getQuote: async (symbol: string) => {
    asked.push(symbol);
    if (symbol === "CAT") return createTestQuote({ symbol, name: "Caterpillar Inc.", instrumentType: "EQUITY" });
    if (symbol !== "AZN") throw new Error(`No quote for ${symbol}`);
    return createTestQuote({ symbol, name: "AstraZeneca PLC", instrumentType: "EQUITY" });
  },
});

const runtime = createTestPluginRuntime({ getMarketData: () => provider });

function Harness({ query }: { query: string }) {
  // The search the pane runs is pane state, so the harness keeps it as the app does.
  const [paneState, setPaneState] = useState<AppState["paneState"]>({});
  const base = useMemo(() => createInitialState(createTestPaneConfig("/tmp/gloom-openfda-pane-unused", {
    paneId: OPENFDA_PANE_ID, instanceId: PANE, binding: { kind: "none" }, settings: { query },
  })), [query]);
  const state = useMemo(() => ({ ...base, paneState }), [base, paneState]);
  const dispatch = useCallback((action: AppAction) => setPaneState((current) => appReducer({ ...base, paneState: current }, action).paneState), [base]);
  return (
    <TestPaneProvider state={state} dispatch={dispatch} paneId={PANE} pluginId={OPENFDA_PLUGIN_ID} runtime={runtime}>
      <OpenFdaPane paneId={PANE} paneType={OPENFDA_PANE_ID} focused width={110} height={10} />
    </TestPaneProvider>
  );
}

// FDA records name the firm and its products, never a symbol: `FDA AZN` matched nothing.
test("a ticker that matches nothing is searched as its company's name; a term that still finds nothing says what to try", async () => {
  const searched: string[] = [];
  setHttpFetchTransport(async (url) => {
    const search = new URL(url).searchParams.get("search") ?? "";
    searched.push(search);
    return /AstraZeneca/i.test(search)
      ? new Response(JSON.stringify({ meta: { results: { skip: 0, limit: 50, total: 1 } }, results: [VACCINE_REPORT] }), { status: 200 })
      : new Response(JSON.stringify({ error: { code: "NOT_FOUND" } }), { status: 404 });
  });
  await act(async () => { await tui.render(<Harness query="AZN" />, { width: 110, height: 10 }); });
  await settleFrame(tui.setup(), 12);
  expect(tui.frame()).toContain("ASTRAZENECA COVID-19 VACCINE");
  expect(searched.map((search) => /AstraZeneca/.test(search) ? "AstraZeneca" : /AZN/.test(search) ? "AZN" : search)).toEqual(["AZN", "AstraZeneca"]);

  // A word in lower case is a search, never a ticker: `cat` is not Caterpillar, and the search box keeps it.
  searched.length = 0;
  await act(async () => { await tui.render(<Harness query="cat" />, { width: 110, height: 10 }); });
  await settleFrame(tui.setup(), 12);
  expect(searched).toHaveLength(1);
  expect(tui.frame()).toContain("No drug reports match cat.");
  expect(asked).not.toContain("CAT");

  // No company trades as ZZZZ: the empty table points to what the search reads, not to a key.
  await act(async () => { await tui.render(<Harness query="ZZZZ" />, { width: 110, height: 10 }); });
  await settleFrame(tui.setup(), 12);
  expect(tui.frame()).toContain("No drug reports match ZZZZ.");
  expect(tui.frame()).toContain("Try the drug's brand or generic name");
  expect(tui.frame()).not.toContain("Press /");
});
