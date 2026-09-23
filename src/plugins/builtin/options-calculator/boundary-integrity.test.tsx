import { afterEach, expect, test } from "bun:test";
import { act, useReducer } from "react";
import { writeFileSync } from "node:fs";

const source = process.env.OPTIONS_SOURCE ?? new URL("../../../../", import.meta.url).pathname.replace(/\/$/, "");
const out = process.env.OPTIONS_OUT;
const { testRender, emitKeypress } = await import(`${source}/src/renderers/opentui/test-utils.tsx`);
const { AppContext, PaneInstanceProvider, appReducer, createInitialState } = await import(`${source}/src/state/app/context`);
const { createTestPaneConfig } = await import(`${source}/src/test-support/pane.tsx`);
const { PaneFooterProvider, PaneFooterBar } = await import(`${source}/src/components/layout/pane/footer`);
const { Box } = await import(`${source}/src/ui`);
const { OptionsCalculatorPane } = await import(`${source}/src/plugins/builtin/options-calculator/pane.tsx`);
const paneId = "options-boundary:test";
let setup: any;
let observedState: any;
let footer: any;

afterEach(async () => {
  if (setup) await act(async () => setup.renderer.destroy());
  setup = undefined;
});

async function mount(params: Record<string, string>) {
  const config = createTestPaneConfig("/tmp/options-boundary", {
    instanceId: paneId, paneId: "options-calculator", binding: { kind: "none" }, params,
  });
  const initial = createInitialState(config);
  initial.focusedPaneId = paneId;
  function Harness() {
    const [state, dispatch] = useReducer(appReducer, initial);
    observedState = state;
    return <AppContext value={{ state, dispatch }}><PaneInstanceProvider paneId={paneId}>
      <PaneFooterProvider>{(current: any) => {
        footer = current;
        return <Box width={90} height={19} flexDirection="column">
          <OptionsCalculatorPane paneId={paneId} paneType="options-calculator" focused width={90} height={18}/>
          <PaneFooterBar footer={current} focused width={90}/>
        </Box>;
      }}</PaneFooterProvider>
    </PaneInstanceProvider></AppContext>;
  }
  setup = await testRender(<Harness/>, { width: 90, height: 19 });
  for (let i = 0; i < 4; i++) await act(async () => setup.renderOnce());
}

function capture(name: string) {
  const frame = setup.captureCharFrame();
  if (out) {
    writeFileSync(`${out}/${name}.txt`, frame);
    writeFileSync(`${out}/${name}.json`, JSON.stringify({ source, footer, state: observedState.paneState[paneId] }, null, 2));
  }
  return frame;
}

for (const side of ["call", "put"] as const) {
  for (const offset of [0, 0.000001]) {
    test(`${side} IV keeps an exact model boundary separate from unresolved nearby prices`, async () => {
      await mount({ side, spot: side === "call" ? "150" : "50", strike: "100", days: "1", rate: "0", volatility: "0", marketPrice: String(50 + offset) });
      const frame = capture(`${side}-${offset ? "near-bound" : "exact-bound"}`);
      expect(frame).toContain("Model");
      if (offset === 0) {
        expect(frame).toMatch(/Implied IV\s+0\.00%/);
        expect(footer.info).toEqual([]);
      } else {
        expect(frame).toMatch(/Implied IV\s+--/);
        expect(frame).toContain("too close to a model bound");
      }
    });
  }
}

test("a positive time value retains the ordinary IV solution", async () => {
  await mount({ side: "call", spot: "100", strike: "100", days: "365", rate: "0.05", volatility: "0.2", marketPrice: "10.4506" });
  const frame = capture("identifiable");
  expect(frame).toMatch(/Implied IV\s+20\.00%/);
  expect(frame).toContain("per unit");
});

test("the model maximum stays unavailable when the numerical price curve saturates", async () => {
  // Numerical-domain boundary, not a claim that this duration is a listed LEAPS contract.
  await mount({ spot: "100", strike: "100", days: "36500", rate: "0", marketPrice: "100" });
  const frame = capture("model-maximum");
  expect(frame).toMatch(/Implied IV\s+--/);
  expect(frame).toContain("no finite IV at the model maximum");
});

for (const entry of [
  { field: "spot", tabs: 1, input: "217.987" },
  { field: "daysToExpiry", tabs: 3, input: "0.000347" },
]) {
  test(`keyboard submission retains the actual ${entry.field} input`, async () => {
    await mount({});
    // e edits the first field; Tab walks on from there.
    await emitKeypress(setup, { name: "e", sequence: "e" });
    for (let i = 1; i < entry.tabs; i++) await emitKeypress(setup, { name: "tab", sequence: "\t" });
    await act(async () => { await setup.mockInput.typeText(entry.input); setup.mockInput.pressEnter(); await setup.renderOnce(); });
    await act(async () => setup.renderOnce());
    const frame = capture(`edit-${entry.field}`);
    expect(observedState.paneState[paneId].draft[entry.field]).toBe(Number(entry.input));
    expect(frame).toContain(entry.input);
  });
}

test("mouse rate editing preserves entered negative percentage precision", async () => {
  await mount({ days: "1095" });
  const lines = setup.captureCharFrame().split("\n");
  const y = lines.findIndex((line: string) => line.includes("Rate"));
  const x = lines[y].indexOf("Rate");
  await act(async () => { await setup.mockMouse.click(x + 1, y); await setup.renderOnce(); });
  await act(async () => { await setup.mockInput.typeText("-1.235"); setup.mockInput.pressEnter(); await setup.renderOnce(); });
  const frame = capture("mouse-negative-rate");
  expect(frame).toContain("-1.235");
  expect(observedState.paneState[paneId].draft.rate).toBeCloseTo(-0.01235, 10);
});
