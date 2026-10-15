import { describe, expect, test } from "bun:test";
import { act, useReducer, useState } from "react";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { AppContext, PaneInstanceProvider, appReducer, createInitialState } from "../../../state/app/context";
import { createStaticAppStore } from "../../../test-support/app-store";
import { createTestResolvedSeries, createTestSeriesPoint } from "../../../test-support/time-series";
import { createDefaultConfig } from "../../../types/config";
import { Box } from "../../../ui";
import { QueryBar } from "../../ui/query-bar";
import { CompositeChart } from "../composite";

const tui = createOpenTuiTestHarness({ width: 90, height: 20 });

const RANGES = ["1W", "1M", "3M"].map((range, index) => ({ label: range, value: range, hint: String(index + 1) }));
const WINDOW = {
  start: new Date("2025-01-01T00:00:00.000Z"),
  end: new Date("2025-01-20T00:00:00.000Z"),
};
const SERIES = createTestResolvedSeries({
  id: "price",
  label: "ACME Price",
  color: "#00ff66",
  unit: "USD",
  unitGroup: "currency",
  nativeFrequency: "daily",
  style: "line",
  axis: "left",
  panelId: "main",
  points: Array.from({ length: 20 }, (_, index) => createTestSeriesPoint(
    new Date(Date.UTC(2025, 0, 1 + index)).toISOString().slice(0, 10),
    100 + index,
  )),
});

interface Recorded {
  viewports: Array<{ start: string; end: string } | null>;
  interactions: string[];
  picked: string[];
}

/** A range strip over a chart, the way a pane with a range control builds them. */
function Pane({ record }: { record: Recorded }) {
  const [state, dispatch] = useReducer(appReducer, createInitialState(createDefaultConfig("/tmp/gloom-view-reset")));
  const [range, setRange] = useState("1M");
  return (
    <AppContext value={createStaticAppStore(state, dispatch)}>
      <PaneInstanceProvider paneId="view-reset:test">
        <Box flexDirection="column" width={90} height={20}>
          <QueryBar
            width={90}
            filters={[{
              id: "range",
              label: "Range",
              inline: true,
              chartRange: true,
              value: range,
              options: RANGES,
              onChange: (next: string) => {
                record.picked.push(next);
                setRange(next);
              },
            }]}
          />
          <CompositeChart
            width={90}
            height={18}
            focused
            series={[SERIES]}
            panels={[{ id: "main" }]}
            viewport={WINDOW}
            viewportResetKey={range}
            onViewportChange={(next, interaction) => {
              record.interactions.push(interaction);
              record.viewports.push(next ? { start: next.start.toISOString(), end: next.end.toISOString() } : null);
            }}
          />
        </Box>
      </PaneInstanceProvider>
    </AppContext>
  );
}

async function mount(): Promise<Recorded> {
  const record: Recorded = { viewports: [], interactions: [], picked: [] };
  await tui.render(<Pane record={record} />, { width: 90, height: 20 });
  await act(async () => tui.setup().renderOnce());
  return record;
}

/** Zooms in with the keyboard: the view is no longer the range's, and the chart tells its owner. */
async function zoomChart(record: Recorded): Promise<void> {
  await tui.emitKeypress({ name: "=", sequence: "+", shift: true }, { trackPropagation: true });
  await act(async () => tui.setup().renderOnce());
  expect(record.interactions.at(-1)).toBe("zoom");
  expect(record.viewports.at(-1)).not.toBeNull();
}

describe("choosing the selected chart range again", () => {
  test("returns a zoomed view to its range, as 0 does", async () => {
    const record = await mount();
    await zoomChart(record);

    await tui.clickFrameText("2:1M");
    await act(async () => tui.setup().renderOnce());

    expect(record.viewports.at(-1)).toBeNull();
    expect(record.interactions.at(-1)).toBe("reset");
    // The selected range is not a change of range.
    expect(record.picked).toEqual([]);
  });

  test("leaves a view that was not moved alone", async () => {
    const record = await mount();

    await tui.clickFrameText("2:1M");
    await tui.clickFrameText("2:1M");

    expect(record.viewports).toEqual([]);
    expect(record.picked).toEqual([]);
  });

  test("a different range is an ordinary change of range", async () => {
    const record = await mount();
    await zoomChart(record);
    const moved = record.viewports.length;

    await tui.clickFrameText("3:3M");
    await act(async () => tui.setup().renderOnce());

    expect(record.picked).toEqual(["3M"]);
    // The owner's new range reset the view through the chart's reset key, not through the selected range.
    expect(record.viewports.length).toBe(moved + 1);
  });
});
