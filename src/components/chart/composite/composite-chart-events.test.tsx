import { describe, expect, test } from "bun:test";
import { act } from "react";
import type { ResolvedSeries } from "../../../time-series/types";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { createTestResolvedSeries, createTestSeriesPoint as point } from "../../../test-support/time-series";
import { CompositeChart } from "./composite-chart";
import { layoutEventCaptions, type EventCaptionAnchor } from "./event-captions";
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

async function frame(events: readonly CompositeChartEvent[]): Promise<string[]> {
  await tui.render(
    <CompositeChart width={48} height={12} series={[candles()]} panels={[{ id: "main" }]} events={events} />,
    { width: 50, height: 14 },
  );
  await act(async () => {
    await tui.setup().renderOnce();
    await tui.setup().renderOnce();
  });
  return tui.frame().split("\n");
}

const DATED: CompositeChartEvent = { id: "dated", time: day("2026-07-24"), captions: ["MoF ¥11.7tn yen bought", "¥11.7tn yen bought", "¥11.7tn"] };
const UNDATED: CompositeChartEvent = {
  id: "undated", time: day("2026-07-28"), endTime: day("2026-07-30"), dotted: true,
  captions: ["MoF ¥15.4tn 28–30 Jul, pair not yet published", "¥15.4tn 28–30 Jul, pair not yet published", "¥15.4tn 28–30 Jul"],
};

describe("CompositeChart events", () => {
  test("a guide is drawn in its own glyph under the marks, clear of the day's high and low; a period is dotted at each end", async () => {
    const frameRows = await frame([DATED, UNDATED]);
    // The plot: under the legend and the toolbar, above the time axis.
    const rows = frameRows.slice(2, frameRows.findIndex((row) => row.includes("Jul 20 2026")));
    const column = rows.find((row) => row.includes("╎"))!.indexOf("╎");
    const cells = rows.map((row) => row[column]);
    expect(cells.filter((cell) => cell === "╎").length).toBeGreaterThan(2);
    // The day's candle is drawn whole, and the cell just past its high or low stays blank.
    const marks = cells.flatMap((cell, index) => cell === "█" || cell === "│" ? [index] : []);
    expect(marks.length).toBeGreaterThan(0);
    for (const index of marks) expect([cells[index - 1], cells[index + 1]]).not.toContain("╎");
    expect(cells[marks.at(-1)! + 1]).toBe(" ");
    // The period's first and last days each get a dotted guide.
    const dotted = new Set(rows.flatMap((row) => [...row].flatMap((cell, index) => cell === "┆" ? [index] : [])));
    expect(dotted.size).toBe(2);
  });

  test("the captions' row stays while the chart has events, so panning one out of view does not move the plot", async () => {
    const shown = await frame([DATED]);
    const outside = await frame([{ ...DATED, time: day("2026-05-06") }]);
    const axisRow = (rows: string[]) => rows.findIndex((row) => /\b(Jul|20|27)\b/.test(row) && !row.includes("MoF"));
    expect(shown.some((row) => row.includes("MoF ¥11.7tn yen bought"))).toBe(true);
    expect(axisRow(outside)).toBe(axisRow(shown));
    expect(outside.join("\n")).not.toContain("MoF");
    expect(outside.join("\n")).not.toContain("╎");
  });
});

/** Where interventions fall on USDJPY's chart at 60 and 120 columns (plot 50 and 110 wide), over 1Y and 5Y. */
const anchor = (id: string, from: number, captions: string[], to = from): EventCaptionAnchor => ({ event: { id, time: from, captions }, from, to });
const dated = (id: string, column: number, amount: string) => anchor(id, column, [`MoF ${amount} yen bought`, `${amount} yen bought`, amount]);
const undated = (from: number, to: number) => anchor("jul-2026", from, [
  "MoF ¥15.4tn 30 Jul–26 Aug, pair not yet published", "¥15.4tn 30 Jul–26 Aug, pair not yet published", "¥15.4tn 30 Jul–26 Aug",
], to);
const merge = (events: readonly CompositeChartEvent[]) => [`MoF ×${events.length}`];

/** Each caption covers its guides or ends within two cells of one. */
function nearItsGuides(anchors: readonly EventCaptionAnchor[], placements: ReturnType<typeof layoutEventCaptions>): boolean {
  return placements.every(({ id, left, text }) => {
    const own = anchors.filter((entry) => id.split("+").includes(entry.event.id));
    return own.some((entry) => entry.to >= left - 2 && entry.from <= left + text.length + 1);
  });
}

describe("event captions", () => {
  test("at 60 columns the newest keeps its dates, the older shortens first, and none is moved off its guide", () => {
    const anchors = [dated("apr-2026", 24, "¥11.7tn"), undated(36, 40)];
    const placed = layoutEventCaptions(anchors, 50, merge);
    expect(placed.map(({ text }) => text)).toEqual(["MoF ¥11.7tn yen bought", "¥15.4tn 30 Jul–26 Aug"]);
    expect(nearItsGuides(anchors, placed)).toBe(true);
    expect(placed[0]!.left + placed[0]!.text.length).toBeLessThan(placed[1]!.left);
  });

  test("five years at 60 columns: neighbours share a caption, or without a way to merge the older is left out; never stacked off its guide", () => {
    const anchors = [
      dated("sep-2022", 14, "¥2.8tn"), dated("oct-2022", 15, "¥6.3tn"), dated("apr-2024", 31, "¥9.8tn"), dated("jul-2024", 33, "¥5.5tn"),
      dated("apr-2026", 46, "¥11.7tn"), undated(48, 49),
    ];
    const placed = layoutEventCaptions(anchors, 50, merge);
    expect(placed.map(({ id }) => id)).toEqual(["sep-2022+oct-2022", "apr-2024", "jul-2024", "apr-2026+jul-2026"]);
    expect(nearItsGuides(anchors, placed)).toBe(true);
    const alone = layoutEventCaptions(anchors, 50);
    expect(alone.map(({ id }) => id)).toEqual(["oct-2022", "jul-2026"]);
    expect(nearItsGuides(anchors, alone)).toBe(true);
  });

  test("at 120 columns each caption keeps as much as its room allows", () => {
    const anchors = [dated("apr-2024", 62, "¥9.8tn"), dated("jul-2024", 67, "¥5.5tn"), dated("apr-2026", 88, "¥11.7tn")];
    const placed = layoutEventCaptions(anchors, 110, merge);
    expect(placed.map(({ text }) => text)).toEqual(["MoF ¥9.8tn yen bought", "¥5.5tn", "MoF ¥11.7tn yen bought"]);
    expect(nearItsGuides(anchors, placed)).toBe(true);
  });
});
