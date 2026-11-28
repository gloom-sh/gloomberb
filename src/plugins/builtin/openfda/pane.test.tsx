import { afterEach, expect, test } from "bun:test";
import { act, useCallback, useMemo, useState } from "react";
import { createOpenTuiTestHarness, settleFrame } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState, type AppAction, type AppState } from "../../../state/app/context";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { createProviderMiss } from "../../../sources/provider-errors";
import { createTestPaneConfig, TestPaneProvider } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { setHttpFetchTransport } from "../../../utils/http-transport";
import { OpenFdaPane } from "./pane";
import { OPENFDA_PANE_ID, OPENFDA_PLUGIN_ID, type OpenFdaDataset } from "./types";

const tui = createOpenTuiTestHarness();
const PANE = "fda:test";

afterEach(() => setHttpFetchTransport(null));

// What the router says when no listing trades under a symbol: neither search below names a ticker.
const provider = createTestDataProvider({
  getQuote: async (symbol: string) => { throw createProviderMiss(`Not a ticker: ${symbol}.`, undefined, { notFound: true }); },
});

const runtime = createTestPluginRuntime({ getMarketData: () => provider });

function Harness({ query, dataset }: { query: string; dataset?: OpenFdaDataset }) {
  // The search the pane runs is pane state, so the harness keeps it as the app does.
  const [paneState, setPaneState] = useState<AppState["paneState"]>({});
  const base = useMemo(() => createInitialState(createTestPaneConfig("/tmp/gloom-openfda-pane-unused", {
    paneId: OPENFDA_PANE_ID, instanceId: PANE, binding: { kind: "none" }, settings: { query, dataset },
  })), [query, dataset]);
  const state = useMemo(() => ({ ...base, paneState }), [base, paneState]);
  const dispatch = useCallback((action: AppAction) => setPaneState((current) => appReducer({ ...base, paneState: current }, action).paneState), [base]);
  return (
    <TestPaneProvider state={state} dispatch={dispatch} paneId={PANE} pluginId={OPENFDA_PLUGIN_ID} runtime={runtime}>
      <OpenFdaPane paneId={PANE} paneType={OPENFDA_PANE_ID} focused width={110} height={10} />
    </TestPaneProvider>
  );
}

test.each([["device", "/device/event.json", "device reports"], ["recall", "/drug/enforcement.json", "drug recalls"]] as const)(
  "FDA's rendered %s selection reads the matching dataset, including an empty response", async (dataset, path, label) => {
    const requested: string[] = [];
    setHttpFetchTransport(async (url) => {
      requested.push(new URL(url).pathname);
      return Response.json({ error: { code: "NOT_FOUND" } }, { status: 404 });
    });
    await act(async () => { await tui.render(<Harness query="coherent" dataset={dataset} />, { width: 110, height: 10 }); });
    await settleFrame(tui.setup(), 12);
    expect(requested).toEqual([path]);
    expect(tui.frame()).toContain(`No ${label} match coherent.`);
  },
);

// Every report is of the drug the search names: the title and Labeler line say it, so the terminal draws no Drug column.
test("every report of the searched drug leaves the Drug column out of the terminal view", async () => {
  const ozempic = (id: number, reaction: string) => ({ safetyreportid: `3100000${id}`, receivedate: "20260620", serious: "1", patient: {
    reaction: [{ reactionmeddrapt: reaction }], drug: [{ medicinalproduct: "OZEMPIC", drugcharacterization: "1", openfda: { manufacturer_name: ["Novo Nordisk A/S"] } }] } });
  setHttpFetchTransport(async () => Response.json({ meta: { results: { skip: 0, limit: 50, total: 2 } }, results: [ozempic(1, "Nausea"), ozempic(2, "Vomiting")] }));
  await act(async () => { await tui.render(<Harness query="ozempic" />, { width: 110, height: 10 }); });
  await settleFrame(tui.setup(), 12);
  expect(tui.frame()).toContain("Nausea");
  expect(tui.frame()).not.toContain("DRUG");
  expect(tui.frame()).not.toContain("OZEMPIC");
});
