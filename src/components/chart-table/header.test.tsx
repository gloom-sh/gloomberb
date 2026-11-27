import { describe, expect, test } from "bun:test";
import { act, useState } from "react";
import { createOpenTuiTestHarness } from "../../renderers/opentui/test-utils";
import { createInitialState } from "../../state/app/context";
import { usePinnedTabTime } from "../../state/app/tab-cursor";
import { TestPaneFrame, TestPaneProvider } from "../../test-support/pane";
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

const tui = createOpenTuiTestHarness();
function Pane({ width, height, rows = ROWS, chart, onSelected }: {
  width: number;
  height: number;
  rows?: Row[];
  chart?: Partial<ChartTableChart> | null;
  onSelected?: (id: string | null) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const effectiveId = selectedId ?? rows[0]?.id ?? null;
  onSelected?.(effectiveId);
  const link = useChartTableSelection({
    rows, getId: (row) => row.id, getDate: (row) => new Date(row.date), selectedId: effectiveId, onSelect: setSelectedId, focused: true,
  });
  const series = [staticSeries(DAYS.map((day) => ({ date: new Date(day.date), observedAt: new Date(day.date), value: day.value })), {
    id: "spread", label: "5Y spread", color: "#22c55e", calendarSpaced: true,
  })];
  return (
    <DataTableView<Row, DataTableColumn>
      focused
      sortColumnId={null} sortDirection="desc" emptyStateTitle="No spreads"
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
  await act(async () => { await tui.render(wrapped, { width, height }); });
  for (let index = 0; index < 4; index += 1) {
    await act(async () => { await Promise.resolve(); await tui.setup().renderOnce(); });
  }
  return tui.frame().split("\n");
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
    await tui.destroy();
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

  test("a single observation does not open a chart band by default", async () => {
    const date = new Date(ROWS[0]!.date);
    const series = [staticSeries([{ date, observedAt: date, value: 150 }], { id: "spread", color: "#22c55e" })];
    const lines = await render(<Pane width={80} height={24} chart={{ series }} />, 80, 24);
    expect(headerRow(lines)).toBe(1);
  });

  test("Left moves the selection back in time and the cursor with it", async () => {
    await render(<Pane width={80} height={24} />, 80, 24);
    const legend = () => tui.frame().split("\n").find((line) => line.includes("● 5Y spread")) ?? "";
    const before = legend();
    for (let index = 0; index < 3; index += 1) {
      await act(async () => { tui.setup().mockInput.pressArrow("left"); await tui.setup().renderOnce(); });
    }
    await act(async () => { await Promise.resolve(); await tui.setup().renderOnce(); });
    expect(legend()).not.toBe(before);
    expect(legend()).toContain(formatBp(ROWS[3]!.value));
  });

  // A chart over a table (SIV) pins the tab's crosshair from the pane, as a
  // chart pane does, though the chart never takes the pane's focus.
  test("p pins the crosshair at the selected row, Left moves the pin a bar and the selection with it, and Esc lifts it", async () => {
    let selected: string | null = null;
    let pinnedDay: string | null = null;
    function PinnedDay() {
      const at = usePinnedTabTime();
      pinnedDay = at === null ? null : new Date(at).toISOString().slice(0, 10);
      return null;
    }
    const state = createInitialState(createDefaultConfig("/tmp/gloom-chart-table-pin"));
    await act(async () => {
      await tui.render(
        <TestPaneFrame state={state} dispatch={() => {}} paneId="chart-table" pluginId="chart-table" runtime={createTestPluginRuntime()}
          width={80} height={25} footerKeys>
          {(body) => <><PinnedDay /><Pane width={body.width} height={body.height} onSelected={(id) => { selected = id; }} /></>}
        </TestPaneFrame>,
        { width: 80, height: 25 },
      );
    });
    const settle = async () => {
      for (let index = 0; index < 3; index += 1) await act(async () => { await Promise.resolve(); await tui.setup().renderOnce(); });
    };
    const footer = () => tui.frame().split("\n").filter((line) => line.trim() !== "").at(-1) ?? "";
    await settle();
    expect(footer()).toContain("[p]in");

    await tui.emitKeypress({ name: "p", sequence: "p" }, { frames: 2, afterCommit: true });
    await settle();
    expect(footer()).toContain("[p] unpin");
    expect([pinnedDay, selected]).toEqual([ROWS[0]!.date, ROWS[0]!.id]);

    await act(async () => { tui.setup().mockInput.pressArrow("left"); await tui.setup().renderOnce(); });
    await settle();
    expect([pinnedDay, selected]).toEqual([ROWS[1]!.date, ROWS[1]!.id]);

    await tui.emitKeypress({ name: "escape", sequence: "\u001b" }, { frames: 2, afterCommit: true });
    await settle();
    expect(footer()).toContain("[p]in");
    expect(footer()).not.toContain("unpin");
    expect([pinnedDay, selected]).toEqual([null, ROWS[1]!.id]);
  });
});
