/** @jsxImportSource react */
import { expect, test } from "bun:test";
import { createDomUiHost } from "../../renderers/electrobun/view/dom-ui-host";
import { WebInputHostProvider } from "../../renderers/electrobun/view/input-host";
import { createDomTestHarness } from "../../renderers/electrobun/view/test-utils";
import { UiHostProvider, useRendererHost, useUiHost } from "../../ui";
import type { ReactNode } from "react";
import { createInitialState } from "../../state/app/context";
import { TestPaneProvider } from "../../test-support/pane";
import { createTestPluginRuntime } from "../../test-support/plugin-runtime";
import { createDefaultConfig } from "../../types/config";
import { staticSeries } from "../chart/static/series";
import { DataTableView } from "../data-table/view";
import type { DataTableColumn } from "../ui";
import { formatBpAxis } from "./axis";
import { ChartTableHeader } from "./header";

const { render } = createDomTestHarness({ capabilities: { nativePaneChrome: true } });

function DesktopTable({ children }: { children: ReactNode }) {
  const ui = useUiHost();
  const renderer = useRendererHost();
  const desktop = createDomUiHost();
  return <UiHostProvider ui={{ ...desktop, capabilities: { ...desktop.capabilities, ...ui.capabilities, nativePaneChrome: true } }} renderer={renderer}>
    <WebInputHostProvider>{children}</WebInputHostProvider>
  </UiHostProvider>;
}

interface Row { id: string; value: number }
const ROWS: Row[] = Array.from({ length: 60 }, (_, index) => ({
  id: new Date(Date.UTC(2026, 6, 1) + index * 86_400_000).toISOString().slice(0, 10),
  value: 180 + index,
}));
const COLUMNS: DataTableColumn[] = [
  { id: "id", label: "DATE", width: 12, align: "left" },
  { id: "value", label: "SPREAD", width: 10, align: "right" },
];

test("on the desktop the figures and chart sit above a table that fills the rest", async () => {
  const series = [staticSeries(ROWS.map((row) => ({ date: new Date(row.id), observedAt: new Date(row.id), value: row.value })), {
    id: "spread", label: "5Y spread", color: "#22c55e", calendarSpaced: true,
  })];
  const state = createInitialState(createDefaultConfig("/tmp/gloom-chart-table-desktop"));
  const container = await render(<DesktopTable>
    <TestPaneProvider state={state} dispatch={() => {}} paneId="chart-table" pluginId="chart-table" runtime={createTestPluginRuntime()}>
      <DataTableView<Row, DataTableColumn>
        focused
        rootWidth={80}
        rootHeight={24}
        rootBefore={<ChartTableHeader width={80} height={24} tableRows={ROWS.length}
          figures={[{ id: "level", label: "5Y spread", value: "239bp" }]}
          chart={{ series, formatValue: (value) => `${value}bp`, formatAxisValue: formatBpAxis }} />}
        columns={COLUMNS}
        items={ROWS}
        getItemKey={(row) => row.id}
        selection={{ kind: "none" }}
        renderCell={(row, column) => ({ text: column.id === "id" ? row.id : `${row.value}bp` })}
      />
    </TestPaneProvider>
  </DesktopTable>);
  const grid = container.querySelector('[data-gloom-role="stat-grid"]');
  const chart = container.querySelector('[data-gloom-role="composite-chart"]');
  expect(grid).toBeTruthy();
  expect(chart).toBeTruthy();
  // The figures come before the chart, and the chart before the table's header.
  expect(grid!.compareDocumentPosition(chart!) & 4).toBeTruthy();
  expect(container.textContent).toContain("5Y spread");
  expect(container.textContent).toContain("DATE");
});
