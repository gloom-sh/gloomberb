import { afterEach, describe, expect, test } from "bun:test";
import { act, useState } from "react";
import { testRender } from "../../renderers/opentui/test-utils";
import { createInitialState } from "../../state/app/context";
import { TestPaneProvider } from "../../test-support/pane";
import { createTestPluginRuntime } from "../../test-support/plugin-runtime";
import { createDefaultConfig } from "../../types/config";
import { useChartTableSelection, type ChartTableSelection } from "./selection";

interface Row { id: string; date: string }
const ROWS: Row[] = ["2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24"].map((date) => ({ id: date, date }));
const day = (date: string) => new Date(`${date}T00:00:00Z`);

let setup: Awaited<ReturnType<typeof testRender>> | undefined;
afterEach(async () => {
  if (setup) {
    await act(async () => setup?.renderer.destroy());
    setup = undefined;
  }
});

async function mount(rows: Row[] = ROWS, initial = "2026-09-24", undated: ReadonlySet<string> = new Set()) {
  const state = { link: null as ChartTableSelection | null, selected: "" as string, select: (_id: string) => {} };
  function Harness() {
    const [selected, setSelected] = useState(initial);
    state.selected = selected;
    state.select = setSelected;
    state.link = useChartTableSelection({
      rows, getId: (row) => row.id, getDate: (row) => undated.has(row.id) ? null : day(row.date),
      selectedId: selected, onSelect: setSelected, focused: true,
    });
    return null;
  }
  const app = createInitialState(createDefaultConfig("/tmp/gloom-chart-table-selection"));
  await act(async () => {
    setup = await testRender(
      <TestPaneProvider state={app} dispatch={() => {}} paneId="chart-table" pluginId="chart-table" runtime={createTestPluginRuntime()}>
        <Harness />
      </TestPaneProvider>,
      { width: 20, height: 4 },
    );
  });
  return state;
}

describe("useChartTableSelection", () => {
  test("a click with no hover before it selects the point it lands on", async () => {
    const state = await mount();
    await act(async () => {
      state.link!.onActivate();
      state.link!.onCursorDateChange(day("2026-09-22"));
    });
    expect(state.selected).toBe("2026-09-22");
  });

  test("a resting pointer stops overriding the cursor once the keys move the selection", async () => {
    const state = await mount();
    await act(async () => { state.link!.onCursorDateChange(day("2026-09-21")); });
    expect(state.link!.cursorDate?.toISOString().slice(0, 10)).toBe("2026-09-21");
    await act(async () => { state.select("2026-09-23"); });
    expect(state.link!.cursorDate?.toISOString().slice(0, 10)).toBe("2026-09-23");
    // The pointer moving again previews the point under it.
    await act(async () => { state.link!.onCursorDateChange(day("2026-09-22")); });
    expect(state.link!.cursorDate?.toISOString().slice(0, 10)).toBe("2026-09-22");
  });

  test("Left and Right step through time whatever order the table is in", async () => {
    const state = await mount();
    await act(async () => { setup!.mockInput.pressArrow("left"); await setup!.renderOnce(); });
    expect(state.selected).toBe("2026-09-23");
    await act(async () => { setup!.mockInput.pressArrow("right"); await setup!.renderOnce(); });
    expect(state.selected).toBe("2026-09-24");
  });

  test("from a row with no point, the arrows step to the nearest row that has one", async () => {
    // Newest first, with the two oldest rows off the chart.
    const rows = [...ROWS].reverse();
    const state = await mount(rows, "2026-09-21", new Set(["2026-09-21", "2026-09-22"]));
    await act(async () => { setup!.mockInput.pressArrow("left"); await setup!.renderOnce(); });
    expect(state.selected).toBe("2026-09-21");
    await act(async () => { setup!.mockInput.pressArrow("right"); await setup!.renderOnce(); });
    expect(state.selected).toBe("2026-09-23");
  });
});
