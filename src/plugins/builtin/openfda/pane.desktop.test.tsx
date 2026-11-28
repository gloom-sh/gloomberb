/** @jsxImportSource react */
import { afterEach, expect, test } from "bun:test";
import { act, useCallback, useMemo, useState } from "react";
import { readRenderedTableRows } from "../../../cli/rendered-table-rows";
import { WebDialogHostProvider } from "../../../renderers/dom/dialog-host";
import { createDomUiHost } from "../../../renderers/dom/dom-ui-host";
import { WebInputHostProvider } from "../../../renderers/dom/input-host";
import { createDomTestHarness } from "../../../renderers/dom/test-utils";
import { appReducer, createInitialState, type AppAction, type AppState } from "../../../state/app/context";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { createTestPaneConfig, TestPaneProvider } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { noopRendererHost } from "../../../test-support/renderer-host";
import { UiHostProvider } from "../../../ui";
import { setHttpFetchTransport } from "../../../utils/http-transport";
import { OpenFdaPane } from "./pane";
import { OPENFDA_PANE_ID, OPENFDA_PLUGIN_ID } from "./types";

const dom = createDomTestHarness({ withUi: false });
// The page lays rows out in a body tall enough for them; happy-dom measures none.
for (const property of ["offsetHeight", "clientHeight"]) {
  Object.defineProperty(dom.window.HTMLElement.prototype, property, { configurable: true, value: 18 * 20 });
}
/** The table reader as the capture's page runs it: from its source text, with nothing of this module in reach. */
const readInPage = new Function(`return (${readRenderedTableRows.toString()})`)() as typeof readRenderedTableRows;
const PANE = "fda:desktop:test";
const runtime = createTestPluginRuntime({ getMarketData: () => createTestDataProvider({}) });

afterEach(() => setHttpFetchTransport(null));

// Invented reports, each of the drug the search names.
const report = (id: number, reaction: string) => ({
  safetyreportid: `3100000${id}`,
  receivedate: `2026062${id}`,
  serious: "1",
  patient: {
    reaction: [{ reactionmeddrapt: reaction }],
    drug: [{ medicinalproduct: "OZEMPIC", drugcharacterization: "1", openfda: { manufacturer_name: ["Novo Nordisk A/S"] } }],
  },
});

function Pane() {
  const [paneState, setPaneState] = useState<AppState["paneState"]>({});
  const base = useMemo(() => createInitialState(createTestPaneConfig("/tmp/gloom-openfda-desktop-unused", {
    paneId: OPENFDA_PANE_ID, instanceId: PANE, binding: { kind: "none" }, settings: { query: "ozempic" },
  })), []);
  const state = useMemo(() => ({ ...base, paneState }), [base, paneState]);
  const dispatch = useCallback((action: AppAction) => setPaneState((current) => appReducer({ ...base, paneState: current }, action).paneState), [base]);
  return (
    <UiHostProvider ui={createDomUiHost("linux")} renderer={noopRendererHost}>
      <WebInputHostProvider>
        <WebDialogHostProvider>
          <TestPaneProvider state={state} dispatch={dispatch} paneId={PANE} pluginId={OPENFDA_PLUGIN_ID} runtime={runtime}>
            <OpenFdaPane paneId={PANE} paneType={OPENFDA_PANE_ID} focused width={110} height={12} />
          </TestPaneProvider>
        </WebDialogHostProvider>
      </WebInputHostProvider>
    </UiHostProvider>
  );
}

// `FDA ozempic` where every report is of OZEMPIC itself: the view leaves the Drug column out (the search box names the
// drug), and a capture of the drawn rows, which has no search box, still reads each row's drug.
test("every report of the searched drug: the view draws no Drug column, and a capture of its rows reads the drug on each", async () => {
  setHttpFetchTransport(async () => Response.json({
    meta: { last_updated: "2026-07-30", results: { skip: 0, limit: 50, total: 3 } },
    results: [report(1, "Nausea"), report(2, "Vomiting"), report(3, "Pancreatitis")],
  }));
  const container = await dom.render(<Pane />);
  const rowsDrawn = () => container.querySelectorAll('[data-gloom-role="data-table-row"]').length;
  for (let i = 0; i < 100 && rowsDrawn() < 3; i++) await act(async () => { await Bun.sleep(20); });
  const table = container.querySelector('[data-gloom-role="data-table"]')!;
  const headers = [...table.querySelectorAll('[data-gloom-role="data-table-header-cell"]')].map((cell) => cell.textContent?.trim());
  expect(headers).not.toContain("Drug");
  expect([...table.querySelectorAll('[data-gloom-role="data-table-cell"]')].map((cell) => cell.textContent)).not.toContain("OZEMPIC");
  const read = readInPage(table, 0, [], () => true);
  expect(read.rows).toHaveLength(3);
  for (const row of read.rows) {
    const drug = row.cells.find((cell) => cell.columnId === "product");
    expect(drug).toEqual({ columnId: "product", columnLabel: "Drug", text: "OZEMPIC" });
  }
  // The reaction stays in its drawn place, after the drug: the drug goes back at the index it would take.
  expect(read.rows[0]!.cells.map((cell) => cell.columnLabel).indexOf("Drug")).toBeLessThan(
    read.rows[0]!.cells.findIndex((cell) => cell.text === "Nausea"));
});
