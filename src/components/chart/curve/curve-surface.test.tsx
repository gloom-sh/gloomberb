import { expect, test } from "bun:test";
import { act } from "react";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { AppContext, createInitialState } from "../../../state/app/context";
import { createStaticAppStore } from "../../../test-support/app-store";
import { createDefaultConfig } from "../../../types/config";
import { CurveSurface } from "./curve-surface";
import type { CurveSeries } from "./model";

const tui = createOpenTuiTestHarness();

const series: CurveSeries[] = [{ id: "current", label: "Today", asOf: "2026-09-21", points: [
  { id: "oct", label: "Oct", x: 10, value: 4.25 },
  { id: "nov", label: "Nov", x: 20, value: null },
  { id: "dec", label: "Dec", x: 40, value: 3.75 },
] }];

const tenors: CurveSeries[] = [
  { id: "yield", label: "Yield", points: [
    { id: "3m", label: "3M", x: 0.25, value: 4.2 },
    { id: "2y", label: "2Y", x: 2, value: 3.9 },
    { id: "10y", label: "10Y", x: 10, value: 4.3 },
    { id: "30y", label: "30Y", x: 30, value: 4.6 },
  ] },
  { id: "1w", label: "1W", role: "ghost", points: [
    { id: "3m", label: "3M", x: 0.25, value: 4.25 },
    { id: "2y", label: "2Y", x: 2, value: 4.6 },
    { id: "10y", label: "10Y", x: 10, value: 4.4 },
    { id: "30y", label: "30Y", x: 30, value: 4.5 },
  ] },
  { id: "fed", label: "Fed funds", role: "reference", points: [
    { id: "lo", label: "", x: 0.25, value: 4.1 },
    { id: "hi", label: "", x: 30, value: 4.1 },
  ] },
];

async function frame() {
  await act(async () => { await tui.setup().renderOnce(); await tui.setup().renderOnce(); });
}

const lines = () => tui.frame().replace(/\n+$/, "").split("\n");

test("short curve panes fall back to the shared table and permit selection of missing nodes", async () => {
  const selections: string[] = [];
  const state = createInitialState(createDefaultConfig("/tmp/gloom-curve-test"));
  await act(async () => { await tui.render(<AppContext value={createStaticAppStore(state)}>
    <CurveSurface series={series} width={60} height={6} focused onSelectedPointChange={(id) => selections.push(id)} />
  </AppContext>, { width: 60, height: 6 }); });
  await frame();
  expect(tui.frame()).toContain("Oct");
  expect(tui.frame()).toContain("4.25");
  expect(tui.frame()).toContain("3.75");
  await tui.emitKeypress({ name: "down" });
  await frame();
  expect(selections.at(-1)).toBe("nov");
  expect(tui.frame()).toMatch(/Nov\s+--/);
});

test("chart keyboard cursor uses stable point ids and keeps unavailable values unavailable", async () => {
  const selections: string[] = [];
  await act(async () => { await tui.render(<CurveSurface series={series} width={60} height={15} focused
    onSelectedPointChange={(id) => selections.push(id)} />, { width: 60, height: 15 }); });
  await frame();
  // Before any cursor the readout row reads the curve's last point, not a blank band.
  expect(lines().at(-1)).toContain("Dec 3.75");
  await tui.emitKeypress({ name: "right" });
  await tui.emitKeypress({ name: "right" });
  // j and k move tables, never the curve.
  await tui.emitKeypress({ name: "j" });
  await frame();
  expect(selections).toEqual(["oct", "nov"]);
  expect(lines().at(-1)).toContain("Nov --");
});

test("a chart-only surface without room draws nothing rather than a second table", async () => {
  const selections: string[] = [];
  await act(async () => { await tui.render(<CurveSurface series={series} width={60} height={6} focused display="chart"
    onSelectedPointChange={(id) => selections.push(id)} />, { width: 60, height: 6 }); });
  await frame();
  expect(tui.frame().trim()).toBe("");
  await tui.emitKeypress({ name: "right" });
  await frame();
  expect(selections).toEqual([]);
});

test("a caption leads the legend, look-backs read as changes and a reference is never read out", async () => {
  await act(async () => { await tui.render(<CurveSurface series={tenors} width={70} height={14} display="chart"
    caption="Yield % by maturity" xScale="log" selectedPointId="2y" formatValue={(value) => `${value.toFixed(2)}%`}
    formatChange={(change) => `${change > 0 ? "+" : ""}${Math.round(change * 100)}bp`} />, { width: 70, height: 14 }); });
  await frame();
  const [legend, ...rest] = lines();
  expect(legend).toMatch(/^ Yield % by maturity {3}● Yield {3}● 1W ago {3}● Fed funds/);
  expect(rest.at(-1)!.trim()).toBe("2Y 3.90%  1W ago -70bp");
  // The badge names the row the cursor is on, never a raw maturity in years.
  const axis = rest.at(-2)!;
  expect(axis).toContain("2Y");
  expect(axis).not.toMatch(/\d\.\d/);
});

test("with one series the caption stands alone", async () => {
  await act(async () => { await tui.render(<CurveSurface series={tenors.slice(0, 1)} width={70} height={10} display="chart"
    caption="Yield % by maturity" xScale="log" />, { width: 70, height: 10 }); });
  await frame();
  expect(lines()[0]!.trim()).toBe("Yield % by maturity");
});

test("the readout keeps the row and its value when the look-backs do not fit", async () => {
  await act(async () => { await tui.render(<CurveSurface series={tenors} width={26} height={10} display="chart"
    caption="Yield %" selectedPointId="10y" formatValue={(value) => `${value.toFixed(2)}%`} />, { width: 26, height: 10 }); });
  await frame();
  expect(lines().at(-1)!.trim()).toBe("10Y 4.30%  1W ago -0.10%");
  await act(async () => { await tui.render(<CurveSurface series={tenors} width={24} height={10} display="chart"
    caption="Yield %" selectedPointId="10y" formatValue={(value) => `${value.toFixed(2)}%`} />, { width: 24, height: 10 }); });
  await frame();
  expect(lines().at(-1)!.trim()).toBe("10Y 4.30%");
});

test("hovering snaps to the nearest row and a click selects it", async () => {
  const selections: string[] = [];
  await act(async () => { await tui.render(<CurveSurface series={tenors} width={70} height={14} display="chart"
    caption="Yield % by maturity" xScale="even" selectedPointId="3m" onSelectedPointChange={(id) => selections.push(id)} />,
  { width: 70, height: 14 }); });
  await frame();
  expect(lines().at(-1)).toContain("3M 4.20");
  // Even spacing puts 10Y two thirds of the way across; a few cells short of it still reads 10Y.
  const plotRow = 4;
  const x = Math.round((70 - 6) * 2 / 3) - 3;
  await act(async () => { await tui.setup().mockMouse.moveTo(x, plotRow); });
  await frame();
  expect(lines().at(-1)).toContain("10Y 4.30");
  expect(lines().at(-2)).toContain("10Y");
  expect(selections).toEqual([]);
  await act(async () => { await tui.setup().mockMouse.click(x, plotRow); });
  await frame();
  expect(selections).toEqual(["10y"]);
  // A press with no hover before it still selects the row under the pointer.
  await act(async () => { await tui.setup().mockMouse.emitMouseEvent("down", 62, plotRow); });
  await frame();
  expect(selections).toEqual(["10y", "30y"]);
});
