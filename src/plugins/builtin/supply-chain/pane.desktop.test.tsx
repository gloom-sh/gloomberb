/** @jsxImportSource react */
import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { setCloudApiFetchTransport } from "../../../api-client";
import { WebDataTable } from "../../../renderers/dom/data-table";
import { createDomTestHarness } from "../../../renderers/dom/test-utils";
import { WebDialogHostProvider } from "../../../renderers/dom/dialog-host";
import { WebInputHostProvider } from "../../../renderers/dom/input-host";
import { createInitialState } from "../../../state/app/context";
import { createTestPaneConfig, createTestTicker, TestPaneProvider } from "../../../test-support/pane";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { UiHostProvider, useRendererHost, useUiHost } from "../../../ui";
import { supplyChainCache } from "./client";
import { SupplyChainPane } from "./pane";
import { entity, supplyPayload, supplyRow } from "./test-fixture";

const desktop = createDomTestHarness();
/** happy-dom has no layout, so give the table body a viewport tall enough for every row. */
for (const property of ["offsetHeight", "clientHeight"]) {
  Object.defineProperty(desktop.window.HTMLElement.prototype, property, { configurable: true, value: 18 * 50 });
}
afterEach(() => { setCloudApiFetchTransport(null); supplyChainCache.reset(); });

function Pane() {
  const ui = useUiHost();
  const renderer = useRendererHost();
  const id = "supply-chain:desktop";
  const state = createInitialState(createTestPaneConfig("/tmp/gloomberb-splc-dom-test", {
    paneId: "supply-chain", instanceId: id, binding: { kind: "fixed", symbol: "FOCUS" }, settings: { tab: "table", view: "says" },
  }));
  state.tickers.set("FOCUS", createTestTicker("FOCUS", "Focus Company"));
  return <UiHostProvider ui={{ ...ui, DataTable: WebDataTable }} renderer={renderer}>
    <WebInputHostProvider><WebDialogHostProvider>
      <TestPaneProvider state={state} paneId={id} pluginId="ticker-research" runtime={createTestPluginRuntime()}>
        <SupplyChainPane paneId={id} paneType="supply-chain" width={170} height={40} focused />
      </TestPaneProvider>
    </WebDialogHostProvider></WebInputHostProvider>
  </UiHostProvider>;
}

test("a short table's selected row reads under its last row, after the locked preview, with no band of empty rows between", async () => {
  supplyChainCache.attach(new MemoryPluginPersistence());
  const undisclosed = (id: string, name: string) => supplyRow(id, { counterparty: { ...entity(id), name, anonymous: true, ticker: null } });
  const data = supplyPayload({ says: [undisclosed("c1", "Undisclosed customer (Revenue Customer 1)"), undisclosed("c2", "Undisclosed customer (Revenue Customer 2)")],
    access: "preview", lockedRows: 5, truncated: true, previewRowsPerRole: 3, totalRows: 7 });
  data.counts.says.customer = 7;
  setCloudApiFetchTransport(async () => Response.json(data));
  const container = await desktop.render(<Pane />);
  await act(async () => { for (let turn = 0; turn < 20; turn++) await new Promise((resolve) => setTimeout(resolve, 0)); });
  const after = container.querySelector('[data-gloom-role="data-table-body-after"]');
  expect(after).not.toBeNull();
  // The words sit in the space the table keeps after its rows, beside the upgrade, not after it as a band of their own.
  expect(after!.querySelector('[data-gloom-role="supply-selected-disclosure"]')).not.toBeNull();
  expect(after!.textContent).toContain("Upgrade to see every relationship");
  // Its height is its own words', not the rows a terminal would leave it.
  expect((after!.querySelector('[data-gloom-role="supply-selected-disclosure"]') as HTMLElement).style.height).toBe("");
  // Each undisclosed customer keeps the number that tells it apart, in an element of its own the cut never reaches.
  const ends = [...container.querySelectorAll('[data-gloom-role="data-table-row"] span')].map((span) => span.textContent).filter((text) => text === " 1" || text === " 2");
  expect(ends).toEqual([" 1", " 2"]);
});
