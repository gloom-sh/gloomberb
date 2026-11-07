import { describe, expect, test } from "bun:test";
import { act } from "react";
import type { ResolvedSeries } from "../../../time-series/types";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { createTestResolvedSeries, createTestSeriesPoint as point } from "../../../test-support/time-series";
import { CompositeChart } from "./composite-chart";
import type { CompositeChartEvent } from "./types";

const tui = createOpenTuiTestHarness();
const day = (date: string) => Date.parse(`${date}T00:00:00Z`);

function candles(): ResolvedSeries {
  const closes = [100, 104, 108, 112, 116, 112, 108, 104, 100, 96, 92, 88];
  return createTestResolvedSeries({
    id: "price", label: "USDJPY", color: "#00ff66", unit: "JPY", unitGroup: "currency", nativeFrequency: "daily",
    style: "candles", axis: "left", panelId: "main", interpolation: "none",
    points: closes.map((close, index) => ({
      ...point(`2026-07-${String(index + 20).padStart(2, "0")}`, close),
      open: close - 2, high: close + 3, low: close - 3, close,
    })),
  });
}

async function frame(events: readonly CompositeChartEvent[]): Promise<string> {
  await tui.render(
    <CompositeChart width={48} height={12} series={[candles()]} panels={[{ id: "main" }]} events={events} />,
    { width: 50, height: 14 },
  );
  await act(async () => {
    await tui.setup().renderOnce();
    await tui.setup().renderOnce();
  });
  return tui.frame();
}

describe("CompositeChart events", () => {
  test("an event in view is a guide under the marks, captioned below the axis; one outside the view takes no row", async () => {
    const shown = await frame([
      { id: "dated", time: day("2026-07-24"), label: "MoF ¥11.7tn" },
      { id: "undated", time: day("2026-07-30"), label: "MoF ¥15.4tn 30 Jul–26 Aug", dotted: true },
    ]);
    const rows = shown.split("\n");
    // Both captions share the row under the axis; the one the row has no room left for ends in an ellipsis.
    expect(rows.some((row) => row.includes("MoF ¥11.7tn MoF ¥15.4tn 30 Jul–…"))).toBe(true);
    // The dotted guide fills the blank cells of its column and leaves its own day's candle drawn.
    const column = rows.find((row) => row.includes("┊"))!.indexOf("┊");
    const cells = rows.map((row) => row[column]);
    expect(cells.filter((cell) => cell === "┊").length).toBeGreaterThan(3);
    expect(cells).toContain("█");
    // An event before the first bar draws nothing and gives the plot its row back.
    expect(await frame([{ id: "outside", time: day("2026-05-06"), label: "MoF ¥11.7tn" }])).toBe(await frame([]));
  });
});
