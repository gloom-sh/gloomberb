import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { emitKeypress, testRender } from "../../../renderers/opentui/test-utils";
import { AppContext, createInitialState } from "../../../state/app/context";
import { createDefaultConfig } from "../../../types/config";
import { CurveSurface } from "./curve-surface";
import type { CurveSeries } from "./model";

let setup: Awaited<ReturnType<typeof testRender>> | undefined;
afterEach(async () => {
  if (setup) await act(async () => { setup!.renderer.destroy(); });
  setup = undefined;
});

const series: CurveSeries[] = [{ id: "current", label: "Today", asOf: "2026-09-21", points: [
  { id: "oct", label: "Oct", x: 10, value: 4.25 },
  { id: "nov", label: "Nov", x: 20, value: null },
  { id: "dec", label: "Dec", x: 40, value: 3.75 },
] }];

async function frame() {
  await act(async () => { await setup!.renderOnce(); await setup!.renderOnce(); });
}

test("short curve panes fall back to the shared table and permit selection of missing nodes", async () => {
  const selections: string[] = [];
  const state = createInitialState(createDefaultConfig("/tmp/gloom-curve-test"));
  await act(async () => { setup = await testRender(<AppContext value={{ state, dispatch: () => {} }}>
    <CurveSurface series={series} width={60} height={7} focused onSelectedPointChange={(id) => selections.push(id)} />
  </AppContext>, { width: 60, height: 7 }); });
  await frame();
  expect(setup!.captureCharFrame()).toContain("Oct");
  expect(setup!.captureCharFrame()).toContain("4.25");
  expect(setup!.captureCharFrame()).toContain("3.75");
  await emitKeypress(setup!, { name: "down" });
  await frame();
  expect(selections.at(-1)).toBe("nov");
  expect(setup!.captureCharFrame()).toMatch(/Nov\s+--/);
});

test("chart keyboard cursor uses stable point ids and keeps unavailable values unavailable", async () => {
  const selections: string[] = [];
  await act(async () => { setup = await testRender(<CurveSurface series={series} width={60} height={15} focused
    onSelectedPointChange={(id) => selections.push(id)} />, { width: 60, height: 15 }); });
  await frame();
  await emitKeypress(setup!, { name: "right" });
  await emitKeypress(setup!, { name: "right" });
  await frame();
  expect(selections).toEqual(["oct", "nov"]);
  expect(setup!.captureCharFrame()).toContain("Nov · Today --");
});
