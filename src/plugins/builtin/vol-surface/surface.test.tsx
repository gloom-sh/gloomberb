import { expect, test } from "bun:test";
import { act } from "react";
import { Text } from "../../../ui";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { createInitialState } from "../../../state/app/context";
import { createTestPaneConfig, TestPaneProvider } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { SURFACE_3D_DELTAS } from "./model";
import { DEFAULT_SURFACE3D_CAMERA } from "../../../components/chart/surface3d/model";
import { VolatilitySurface, type VolatilitySurfaceProps } from "./surface";

const tui = createOpenTuiTestHarness();

/** Invented IV levels: a smile, higher in the wings, over `rows` expiries. */
function grid(rows: number, quoted = rows): VolatilitySurfaceProps["grid"] {
  const tenors = Array.from({ length: rows }, (_, index) => 0.1 + index * 0.25);
  return { axis: "delta", tenors, moneyness: [...SURFACE_3D_DELTAS],
    volatilities: tenors.map((_, row) => SURFACE_3D_DELTAS.map((delta) => row < quoted ? 0.3 + Math.abs(delta) * 0.2 : null)) };
}

const PANE_ID = "vol-surface:grid-test";

async function show(props: Partial<VolatilitySurfaceProps>) {
  const state = createInitialState(createTestPaneConfig("/tmp/gloom-vol-surface-grid-test", { instanceId: PANE_ID, paneId: "vol-surface" }));
  await act(async () => {
    await tui.render(<TestPaneProvider state={state} paneId={PANE_ID} pluginId="ticker-research" runtime={createTestPluginRuntime()}>
      <VolatilitySurface grid={grid(1)} camera={DEFAULT_SURFACE3D_CAMERA} onCameraChange={() => {}} selected={null}
        onSelect={() => {}} width={120} height={14} meshAvailable fallback={<Text>TABLE FALLBACK</Text>} {...props} />
    </TestPaneProvider>, { width: 120, height: 14 });
  });
  await act(async () => { await tui.setup().renderOnce(); });
  return tui.frame();
}

test("one lone expiry draws a grid with the reason, not an empty box", async () => {
  const frame = await show({ grid: grid(18, 1) });
  expect(frame).toContain("Usable quotes for 1 of 18 expiries");
  expect(frame).toContain("10P");
  expect(frame).toContain("ATM");
  expect(frame).toContain("30.0");
  expect(frame).not.toContain("TABLE FALLBACK");
});

test("a sheet with nothing to draw waits while quotes load and says so when none arrive", async () => {
  expect(await show({ grid: grid(3, 0), loading: true })).toContain("Loading volatility surface...");
  const empty = await show({ grid: grid(18, 0) });
  expect(empty).toContain("No volatility to draw");
  expect(empty).toContain("None of the 18 expiries has a usable quote.");
});

test("two neighbouring expiries are a surface; a host without a mesh keeps its table", async () => {
  const frame = await show({ grid: grid(2), loading: true });
  expect(frame).toContain("TABLE FALLBACK");
  expect(frame).not.toContain("Loading volatility surface");
  expect(await show({ grid: grid(1), meshAvailable: false })).toContain("TABLE FALLBACK");
});
