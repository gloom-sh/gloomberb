/** @jsxImportSource react */
import { expect, test } from "bun:test";
import { createDomUiHost } from "../../renderers/dom/dom-ui-host";
import { WebInputHostProvider } from "../../renderers/dom/input-host";
import { createDomTestHarness } from "../../renderers/dom/test-utils";
import { UiHostProvider, useRendererHost, useUiHost } from "../../ui";
import { act, useState, type ReactNode } from "react";
import { createInitialState } from "../../state/app/context";
import { TestPaneProvider } from "../../test-support/pane";
import { createTestPluginRuntime } from "../../test-support/plugin-runtime";
import { createDefaultConfig } from "../../types/config";
import { staticSeries } from "../chart/static/series";
import { DataTableView } from "../data-table/view";
import type { DataTableColumn } from "../ui";
import { formatBpAxis } from "./axis";
import { ChartTableHeader, useChartTableLayout, type ChartTableHeaderProps } from "./header";
import { beginLiveResize } from "../../ui/live-resize";
import { RESIZE_SETTLE_MS } from "../../ui/resize-settle";

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

test("the header holds its band and summary through a live resize while its chart width follows", async () => {
  let resize: (size: { width: number; height: number }) => void = () => {};
  function Harness() {
    const [size, setSize] = useState({ width: 90, height: 26 });
    resize = setSize;
    const props: ChartTableHeaderProps = { ...size, tableRows: 60,
      figures: [
        { label: "5Y spread", value: "235bp", detail: "2026-09-25" },
        { label: "1M", value: "+13bp" },
        { label: "Range", value: "34 to 235bp", detail: "since 2025-02-24" },
      ],
      chart: { minRows: 6, strip: null, render: ({ width, height }) => <div data-chart-width={width} data-chart-height={height} /> },
    };
    const layout = useChartTableLayout(props);
    return <div data-band-mode={layout.mode}><ChartTableHeader {...props} /></div>;
  }
  const container = await render(<Harness />);
  const summaryRows = () => container.querySelectorAll('[data-gloom-role="stat-grid-row"]').length;
  expect(summaryRows()).toBe(2);
  const end = beginLiveResize();
  try {
    await act(async () => resize({ width: 40, height: 10 }));
    await act(() => new Promise((resolve) => setTimeout(resolve, RESIZE_SETTLE_MS * 2)));
    expect(container.querySelector('[data-band-mode="full"]')).toBeTruthy();
    expect(summaryRows()).toBe(2);
    expect(container.querySelector('[data-chart-width="40"][data-chart-height="10"]')).toBeTruthy();
  } finally {
    end();
  }
  await act(() => new Promise((resolve) => setTimeout(resolve, RESIZE_SETTLE_MS * 2 + 20)));
  expect(container.querySelector('[data-band-mode="none"]')).toBeTruthy();
  expect(container.querySelector('[data-chart-width]')).toBeNull();
  expect(summaryRows()).toBe(1);
});
