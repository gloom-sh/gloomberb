import { afterEach, describe, expect, test } from "bun:test";
import { act, useState } from "react";
import { testRender } from "../../renderers/opentui/test-utils";
import { createInitialState } from "../../state/app/context";
import { TestPaneProvider } from "../../test-support/pane";
import { createTestPluginRuntime } from "../../test-support/plugin-runtime";
import { createDefaultConfig } from "../../types/config";
import { DataTableView } from "../data-table/view";
import { staticSeries } from "../chart/static/series";
import type { DataTableColumn } from "../ui";
import type { StatItem } from "../ui/stat-grid";
import { formatBpAxis } from "./axis";
import { ChartTableHeader, type ChartTableChart } from "./header";
import { useChartTableSelection } from "./selection";

interface Row { id: string; date: string; value: number }

const DAYS = Array.from({ length: 120 }, (_, index) => {
  const date = new Date(Date.UTC(2026, 4, 1) + index * 86_400_000).toISOString().slice(0, 10);
  return { id: date, date, value: 150 + index * 0.7 + (index % 5) };
});
const ROWS: Row[] = [...DAYS].reverse();
const COLUMNS: DataTableColumn[] = [
  { id: "date", label: "DATE", width: 12, align: "left" },
  { id: "value", label: "SPREAD", width: 10, align: "right" },
];
const FIGURES: StatItem[] = [
  { id: "level", label: "5Y spread", value: `${ROWS[0]!.value.toFixed(1)}bp`, detail: ROWS[0]!.date },
  { id: "range", label: "Range", value: "150 to 237bp" },
];
const formatBp = (value: number) => `${value.toFixed(1)}bp`;

let setup: Awaited<ReturnType<typeof testRender>> | undefined;
afterEach(async () => {
  if (setup) {
    await act(async () => setup?.renderer.destroy());
    setup = undefined;
  }
});

function Pane({ width, height, rows = ROWS, chart }: {
  width: number;
  height: number;
  rows?: Row[];
  chart?: Partial<ChartTableChart> | null;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const effectiveId = selectedId ?? rows[0]?.id ?? null;
  const link = useChartTableSelection({
    rows, getId: (row) => row.id, getDate: (row) => new Date(row.date), selectedId: effectiveId, onSelect: setSelectedId, focused: true,
  });
  const series = [staticSeries(DAYS.map((day) => ({ date: new Date(day.date), observedAt: new Date(day.date), value: day.value })), {
    id: "spread", label: "5Y spread", color: "#22c55e", calendarSpaced: true,
  })];
  return (
    <DataTableView<Row, DataTableColumn>
      focused
      rootWidth={width}
      rootHeight={height}
      rootBefore={<ChartTableHeader width={width} height={height} tableRows={rows.length} figures={FIGURES}
        chart={chart === null ? null : { series, formatValue: formatBp, formatAxisValue: formatBpAxis, ...link, ...chart }} />}
      columns={COLUMNS}
      items={rows}
      getItemKey={(row) => row.id}
      selection={{ kind: "id", selectedId: effectiveId, getId: (row) => row.id, onChange: (id) => setSelectedId(id) }}
      renderCell={(row, column) => ({ text: column.id === "date" ? row.date : formatBp(row.value) })}
    />
  );
}

async function render(node: React.ReactNode, width: number, height: number) {
  const state = createInitialState(createDefaultConfig("/tmp/gloom-chart-table-test"));
  const wrapped = (
    <TestPaneProvider state={state} dispatch={() => {}} paneId="chart-table" pluginId="chart-table" runtime={createTestPluginRuntime()}>
      {node}
    </TestPaneProvider>
  );
  await act(async () => { setup = await testRender(wrapped, { width, height }); });
  for (let index = 0; index < 4; index += 1) {
    await act(async () => { await Promise.resolve(); await setup!.renderOnce(); });
  }
  return setup!.captureCharFrame().split("\n");
}

const headerRow = (lines: string[]) => lines.findIndex((line) => line.includes("DATE"));

describe("ChartTableHeader", () => {
  test("names the series in the legend and leaves the table the rest", async () => {
    const lines = await render(<Pane width={80} height={24} />, 80, 24);
    expect(lines.some((line) => line.includes("● 5Y spread"))).toBe(true);
    // Figures, then 40% of the rest for the chart, then the table to the bottom.
    expect(headerRow(lines)).toBeGreaterThan(8);
    expect(lines[lines.length - (lines.at(-1) === "" ? 2 : 1)]).toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  test("becomes a one-row strip that repeats nothing the figures say, then gives the rows back", async () => {
    let lines = await render(<Pane width={60} height={10} />, 60, 10);
    expect(headerRow(lines)).toBe(2);
    expect(lines[1]).toContain("●");
    expect(lines[1]).not.toContain("5Y spread");
    await act(async () => setup?.renderer.destroy());
    setup = undefined;
    lines = await render(<Pane width={60} height={6} />, 60, 6);
    expect(headerRow(lines)).toBe(1);
  });

  test("gives a short table's spare rows to the chart instead of a blank band", async () => {
    const lines = await render(<Pane width={80} height={30} rows={ROWS.slice(0, 5)} />, 80, 30);
    expect(headerRow(lines)).toBe(30 - 6);
    expect(lines[lines.length - (lines.at(-1) === "" ? 2 : 1)]).toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  test("holds the band while the history loads", async () => {
    const lines = await render(<Pane width={80} height={24} chart={{ series: [], loading: true }} />, 80, 24);
    expect(lines.some((line) => line.includes("Loading history"))).toBe(true);
    expect(headerRow(lines)).toBeGreaterThan(8);
  });

  test("without a chart the table follows the figures", async () => {
    const lines = await render(<Pane width={80} height={24} chart={null} />, 80, 24);
    expect(headerRow(lines)).toBe(1);
  });

  test("Left moves the selection back in time and the cursor with it", async () => {
    await render(<Pane width={80} height={24} />, 80, 24);
    const legend = () => setup!.captureCharFrame().split("\n").find((line) => line.includes("● 5Y spread")) ?? "";
    const before = legend();
    for (let index = 0; index < 3; index += 1) {
      await act(async () => { setup!.mockInput.pressArrow("left"); await setup!.renderOnce(); });
    }
    await act(async () => { await Promise.resolve(); await setup!.renderOnce(); });
    expect(legend()).not.toBe(before);
    expect(legend()).toContain(formatBp(ROWS[3]!.value));
  });
});
