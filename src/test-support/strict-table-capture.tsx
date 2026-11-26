/** @jsxImportSource react */
import type { ReactNode } from "react";
import type { DesktopPaneShotPayload, DesktopPaneShotRenderResult } from "../cli/desktop-pane-shot";
import type { ResolvedPaneFunction } from "../cli/pane-functions/resolver";
import { assessPaneScreenshot } from "../cli/pane-functions/screenshot-assessment";
import { readRenderedTableRows } from "../cli/rendered-table-rows";
import { DataTableView } from "../components/data-table/view";
import type { DataTableCell, DataTableColumn } from "../components/ui";
import { createRemoteUiRegistry, RemoteUiRegistryProvider, type RemoteUiRegistry } from "../remote/semantic-tree";
import { WebDataTable } from "../renderers/dom/data-table";
import { WebInputHostProvider } from "../renderers/dom/input-host";
import { AppContext, createInitialState } from "../state/app/context";
import { createDefaultConfig } from "../types/config";
import { UiHostProvider, useRendererHost, useUiHost } from "../ui";
import { createStaticAppStore } from "./app-store";

/** The table reader as the capture's page runs it: from its source text, with nothing of this module in reach. */
const readInPage = new Function(`return (${readRenderedTableRows.toString()})`)() as typeof readRenderedTableRows;

/** A pane of rows, as `shot` resolves one: its tables are read for a column blank in every row. */
const DATA_PANE = {
  token: "TEST", label: "Test", description: "", pane: { id: "strict-table-test", name: "Test" },
  instance: { instanceId: "strict-table-test", paneId: "strict-table-test" }, createOptions: undefined, optionSettings: {}, options: {},
  capability: { id: "strict-table-test-pane", botSafe: false, outputKind: "rendered-view", reportReadiness: "live-dom", screenshotReadiness: "live-dom", options: [] },
} as unknown as ResolvedPaneFunction;

/**
 * What `shot --strict` makes of the tables drawn under `container`: their rows
 * read off the DOM the way the capture's page reads them (each cell's text and
 * its may-be-blank mark, each column by the table's own node), then assessed.
 */
export function assessDrawnTables(container: HTMLElement, registry: RemoteUiRegistry) {
  const semanticUi = registry.snapshot();
  const tables = semanticUi.filter((node) => node.role === "table");
  const rows = [...container.querySelectorAll('[data-gloom-role="data-table"]')].flatMap((table, tableIndex) => {
    const columns = tables[tableIndex]?.metadata?.columns;
    return readInPage(table, tableIndex, Array.isArray(columns) ? columns : [], () => true).rows;
  });
  return assessPaneScreenshot(DATA_PANE, { financials: [] } as unknown as DesktopPaneShotPayload, {
    visibleText: container.textContent ?? "", rows, truncated: false, truncationReasons: [], loadingStateDetected: false,
    errorStateDetected: false, errorStateMarkers: [], emptyStateDetected: false, emptyStateMarkers: [], visibleKeyValues: [], semanticUi,
  } as DesktopPaneShotRenderResult, "", "/tmp/strict-table-test.png");
}

/**
 * Draws a pane's rows in the kit's table on the desktop renderer and reads
 * the result as a strict capture does. `render` is a DOM test harness's.
 */
export async function captureStrictTable<T, C extends DataTableColumn>(
  render: (node: ReactNode) => Promise<HTMLElement>,
  columns: C[],
  items: T[],
  renderCell: (item: T, column: C) => DataTableCell,
) {
  const registry = createRemoteUiRegistry();
  const state = createInitialState(createDefaultConfig("/tmp/gloom-strict-table-test"));
  function Table() {
    const ui = useUiHost();
    const renderer = useRendererHost();
    return (
      <RemoteUiRegistryProvider registry={registry}>
        <UiHostProvider ui={{ ...ui, DataTable: WebDataTable }} renderer={renderer}>
          <WebInputHostProvider>
            <AppContext value={createStaticAppStore(state)}>
              <DataTableView<T, C>
                selection={{ kind: "none" }}
                columns={columns}
                items={items}
                sortColumnId={null}
                sortDirection="asc"
                getItemKey={(_item, index) => `row-${index}`}
                renderCell={renderCell}
                emptyStateTitle="No rows"
                virtualize={false}
              />
            </AppContext>
          </WebInputHostProvider>
        </UiHostProvider>
      </RemoteUiRegistryProvider>
    );
  }
  return assessDrawnTables(await render(<Table />), registry);
}
