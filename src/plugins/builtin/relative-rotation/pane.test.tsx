import { expect, test } from "bun:test";
import { act, useState } from "react";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState } from "../../../state/app/context";
import { TestPaneFrame, createTestPaneConfig } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { publishedWeekClose } from "../analytics/sharpe-cadence";
import { rotationCache } from "./client";
import {
  buildRotation,
  rotationId,
  rotationInstruments,
  sectorRotationInstruments,
  type RotationHistory,
  type RotationInstrument,
  type RotationPayload,
} from "./model";
import { RelativeRotationPane } from "./pane";

const DAY = 86_400_000;
const benchmark = rotationInstruments("SPY:NYSEARCA")[0]!;
const sectors = sectorRotationInstruments();

function history(instrument: RotationInstrument, ratio: (week: number) => number): RotationHistory {
  return {
    instrument, currency: "USD", asOf: null, stale: false, error: null,
    points: Array.from({ length: 90 }, (_, week) => ({
      date: publishedWeekClose(new Date(Date.parse("2025-01-03") + week * 7 * DAY).toISOString().slice(0, 10), "ARCA")!,
      close: ratio(week) * 100,
    })),
  };
}

// Each sector rotates around the benchmark at its own phase, so the trails
// spread through all four quadrants like a real board.
const payload: RotationPayload = buildRotation(
  history(benchmark, () => 1),
  sectors.map((instrument, index) => history(instrument, (week) => 1 + 0.06 * Math.sin(week / 5 + index * 0.6))),
  6,
  new Date("2026-09-22T12:00:00Z"),
);

const tui = createOpenTuiTestHarness();

async function settle() {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); await tui.setup().renderOnce(); });
  }
}

async function render(width: number, height: number): Promise<string[]> {
  // The pane loads through the cache, so a fresh entry keeps the test off the network.
  await rotationCache.load(`${rotationId(benchmark)}|${sectors.map(rotationId).join(",")}|6`, async () => payload);
  const initial = createInitialState(createTestPaneConfig("/tmp/gloom-rrg-test", { instanceId: "rrg", paneId: "relative-rotation" }));
  initial.focusedPaneId = "rrg";
  const runtime = createTestPluginRuntime();
  // The pane title and the selection go through the reducer.
  function Harness() {
    const [state, setState] = useState(initial);
    return <TestPaneFrame state={state} dispatch={(action) => setState((current) => appReducer(current, action))}
      paneId="rrg" pluginId="relative-rotation" runtime={runtime} width={width} height={height}>
      {(body) => <RelativeRotationPane paneId="rrg" paneType="relative-rotation" focused {...body} />}
    </TestPaneFrame>;
  }
  await act(async () => { await tui.render(<Harness />, { width, height }); });
  await settle();
  return tui.frame().split("\n");
}

const tableHeader = (lines: string[]) => lines.findIndex((line) => line.includes("ETF") && line.includes("QUADRANT"));

test("the scatter names every trail head and draws 100/100 as box lines", async () => {
  const lines = await render(100, 35);
  const header = tableHeader(lines);
  expect(header).toBeGreaterThan(10);
  const chart = lines.slice(0, header).join("\n");
  for (const row of payload.rows) expect(chart).toContain(row.symbol);
  // The crosshair is lines, not dots a trail could be mistaken for.
  expect(chart).toContain("─");
  expect(chart).toContain("│");
  // The momentum gutter names the crosshair's row, and the axes are named in the table's words.
  const crosshairRow = lines.slice(0, header).find((line) => (line.match(/─/g) ?? []).length > 20)!;
  expect(crosshairRow).toMatch(/100\.0\s*$/);
  expect(lines[header - 1]).toContain("Strength →");
  expect(chart).toContain("Momentum");
  // Every sector's row stays in the table under it.
  for (const row of payload.rows) expect(lines.slice(header).join("\n")).toContain(row.symbol);
});

test("the first row is selected by default, so the cursor reads it; moving the selection moves it", async () => {
  const lines = await render(100, 35);
  const header = tableHeader(lines);
  const [first, second] = [...payload.rows].sort((left, right) => left.symbol.localeCompare(right.symbol));
  // The cursor's strength sits on the axis row and its momentum in the gutter.
  expect(lines[header - 1]).toContain(first!.strength!.toFixed(2));
  expect(lines.slice(0, header).some((line) => line.trimEnd().endsWith(first!.momentum!.toFixed(1)))).toBe(true);
  await tui.emitKeypress({ name: "down" });
  await settle();
  const moved = tui.frame().split("\n");
  expect(moved[header - 1]).toContain(second!.strength!.toFixed(2));
  expect(moved[header - 1]).not.toContain(first!.strength!.toFixed(2));
});

test("a short pane keeps the table's rows and drops the scatter", async () => {
  const lines = await render(40, 10);
  expect(lines.join("\n")).not.toContain("Strength →");
  expect(lines[0]).toContain("ETF");
  // The header and at least four sectors before the footer.
  expect(lines.slice(1, 8).filter((line) => /^\s*XL[A-Z]+\s/.test(line)).length).toBeGreaterThanOrEqual(4);
});
