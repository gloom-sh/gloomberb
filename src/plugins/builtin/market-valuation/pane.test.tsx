import { Box } from "../../../ui";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, useReducer } from "react";
import { PaneFooterProvider, PaneFooterBar } from "../../../components/layout/pane/footer";
import {
  attachValuationPersistence,
  hydrateValuationSeries,
  resetValuationPersistence,
} from "./cache";
import { testRender } from "../../../renderers/opentui/test-utils";
import {
  AppContext, appReducer,
  createInitialState,
  PaneInstanceProvider,
} from "../../../state/app/context";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import { cloneLayout, createDefaultConfig } from "../../../types/config";
import { MarketValuationPane, shouldPersistSelection } from "./pane";

let setup: Awaited<ReturnType<typeof testRender>> | undefined;

function obs(values: Array<[string, number]>) {
  return values.map(([date, value]) => ({ date, value }));
}

/** Synthetic cache includes the legacy index-points input; Z.1 is 38.0T / 40.0T. */
const LEGS: Array<[string, Array<{ date: string; value: number }>]> = [
  ["W5000", obs([
    ["2024-01-02", 60_000],
    ["2025-01-02", 68_000],
    ["2026-06-15", 76_200],
  ])],
  ["GDP", obs([
    ["2024-01-01", 28_000],
    ["2025-01-01", 30_000],
    ["2026-04-01", 32_500],
  ])],
  ["M2SL", obs([
    ["2024-01-01", 21_000],
    ["2025-01-01", 22_000],
    ["2026-07-01", 23_200],
  ])],
  ["NCBEILQ027S", obs([
    ["2024-01-01", 30_000_000],
    ["2025-01-01", 35_000_000],
    ["2026-01-01", 38_000_000],
  ])],
  ["TNWMVBSNNCB", obs([
    ["2024-01-01", 38_000_000],
    ["2025-01-01", 39_200_000],
    ["2026-01-01", 40_000_000],
  ])],
  ["BOGZ1FL153064486Q", obs([
    ["2024-01-01", 38.0],
    ["2025-01-01", 42.0],
    ["2026-01-01", 45.8],
  ])],
  ["BOGZ1FL663067003Q", obs([
    ["2024-01-01", 600_000],
    ["2025-01-01", 620_000],
    ["2026-01-01", 650_000],
  ])],
  ["CPROFIT", obs([["2024-01-01", 3_400], ["2025-01-01", 4_200], ["2026-01-01", 4_800]])],
  ["SHILLER_CAPE", obs([
    ["2024-01-01", 33.2],
    ["2025-01-01", 38.1],
    ["2026-08-01", 41.2],
  ])],
  ["SHILLER_ECY", obs([
    ["2024-01-01", 0.021],
    ["2025-01-01", 0.013],
    ["2026-08-01", 0.0097],
  ])],
  ["SHILLER_DIVIDEND", obs([
    ["2024-01-01", 70],
    ["2025-01-01", 76],
    ["2026-08-01", 83],
  ])],
  ["SHILLER_PRICE", obs([
    ["2024-01-01", 4800],
    ["2025-01-01", 6000],
    ["2026-08-01", 7600],
  ])],
];

async function settle() {
  await act(async () => {
    for (let index = 0; index < 8; index += 1) {
      await Promise.resolve();
      await setup!.renderOnce();
    }
  });
  for (let index = 0; index < 3; index += 1) {
    await act(async () => {
      await Promise.resolve();
      await setup!.renderOnce();
    });
  }
}

const TEST_PANE_ID = "valuation:test";

async function renderPane(settings: Record<string, unknown> = {}, width = 128, height = 40) {
  const layout = {
    dockRoot: { kind: "pane" as const, instanceId: TEST_PANE_ID },
    instances: [{ instanceId: TEST_PANE_ID, paneId: "market-valuation", settings }],
    floating: [],
    detached: [],
  };
  const state = createInitialState({
    ...createDefaultConfig("/tmp/gloomberb-valuation-test"),
    layout,
    layouts: [{ name: "Default", layout: cloneLayout(layout) }],
  });
  state.focusedPaneId = TEST_PANE_ID;
  function Harness() {
    const [current, dispatch] = useReducer(appReducer, state);
    return <AppContext value={{ state: current, dispatch }}>
      <PaneInstanceProvider paneId={TEST_PANE_ID}>
        <PaneFooterProvider>{footer => <Box width={width} height={height + 1} flexDirection="column">
          <Box height={height}><MarketValuationPane paneId={TEST_PANE_ID} paneType="market-valuation" focused width={width} height={height}/></Box>
          <PaneFooterBar footer={footer} focused width={width}/>
        </Box>}</PaneFooterProvider>
      </PaneInstanceProvider>
    </AppContext>;
  }
  setup = await testRender(<Harness/>, { width, height: height + 1 });
  await settle();
  return setup.captureCharFrame();
}

beforeEach(() => {
  resetValuationPersistence();
  attachValuationPersistence(new MemoryPluginPersistence());
  hydrateValuationSeries(LEGS);
});

afterEach(async () => {
  if (setup) {
    await act(async () => setup?.renderer.destroy());
    setup = undefined;
  }
  resetValuationPersistence();
});


describe("MarketValuationPane", () => {
  test("retired index-point ratios stay unavailable beside valid monetary and direct measures", async () => {
    const frame = await renderPane();
    // A percent, a bare multiple, and two yields all sit in one VALUE column.
    for (const label of ["Buffett", "CAPE", "Tobin Q", "Equity alloc", "Div yield", "Cap / M2"]) {
      expect(frame).toContain(label);
    }
    expect(frame).not.toContain("234%");
    expect(frame).toMatch(/Buffett\s+--\s+Unavailable/);
    expect(frame).toContain("41.2");
    expect(frame).toContain("0.95");
    expect(frame).not.toContain("329%");
    expect(frame).toMatch(/Cap \/ profits\s+--\s+Unavailable/);
    expect(frame).toMatch(/Cap \/ M2\s+--\s+Unavailable/);
    expect(frame).toContain("index points; dollar market capitalization is unavailable");
  });

  test("detail follows the selected indicator without repeating the row", async () => {
    const frame = await renderPane({ indicator: "tobins-q" });
    expect(frame).toContain("Equities");
    expect(frame).toContain("Net worth");
    expect(frame).toContain("equities = net worth");
    expect(frame).not.toContain("Mkt cap");
    // The row above already names the indicator and its zone.
    expect(frame).not.toContain("Fair Valued");
  });

  test("a direct indicator shows no dollar levels row", async () => {
    const frame = await renderPane({ indicator: "shiller-cape" });
    expect(frame).toContain("ten-year mean real earnings");
    expect(frame).not.toContain("Mkt cap");
    expect(frame).not.toContain("Equities");
  });

  test("draws the mean apart from the reference line", async () => {
    const frame = await renderPane({ indicator: "tobins-q" });
    expect(frame).toContain("equities = net worth");
    expect(frame).toContain("mean");
  });
});

describe("shouldPersistSelection", () => {
  const knownIds = ["buffett", "shiller-cape", "tobins-q"];

  test("keeps the setting when a filter moved the rows under a pending commit", () => {
    // The row the keyboard commit resolves to is real, but the user never chose it.
    expect(shouldPersistSelection({
      id: "tobins-q",
      reason: "keyboard",
      selectionOnScreen: false,
      knownIds,
    })).toBe(false);
  });

  test("honours an explicit click even while the selection is filtered away", () => {
    expect(shouldPersistSelection({
      id: "shiller-cape",
      reason: "pointer",
      selectionOnScreen: false,
      knownIds,
    })).toBe(true);
  });

  test("accepts ordinary keyboard movement", () => {
    expect(shouldPersistSelection({
      id: "shiller-cape",
      reason: "keyboard",
      selectionOnScreen: true,
      knownIds,
    })).toBe(true);
  });

  test("never persists an indicator that is not in the registry", () => {
    expect(shouldPersistSelection({
      id: "nonsense",
      reason: "pointer",
      selectionOnScreen: true,
      knownIds,
    })).toBe(false);
  });
});


test("unavailable rows remain selectable alongside usable indicators", async () => {
  await renderPane({ indicator: "buffett" }, 80);
  const lines = setup!.captureCharFrame().split("\n");
  const y = lines.findIndex((line) => /CAPE\s+41.2/.test(line));
  expect(y).toBeGreaterThan(0);
  await act(async () => { await setup!.mockMouse.click(3, y); });
  await settle();
  expect(setup!.captureCharFrame()).not.toContain("Buffett Indicator unavailable");
  expect(setup!.captureCharFrame()).toContain("ten-year mean real earnings");
  await act(async () => {
    await setup!.mockInput.pressArrow("up");
    await new Promise((resolve) => setTimeout(resolve, 250));
  });
  await settle();
  expect(setup!.captureCharFrame()).toContain("Buffett Indicator unavailable");
});

test("a short stacked pane scrolls to monetary basis, extrema dates and source", async () => {
  await renderPane({ indicator: "tobins-q" }, 48, 25);
  for (let i = 0; i < 10; i += 1) {
    await act(async () => { await setup!.mockMouse.scroll(47, 20, "down"); });
  }
  await settle();
  const frame = setup!.captureCharFrame();
  expect(frame).toContain("38.0T");
  expect(frame).toContain("40.0T");
  expect(frame).toContain("Net worth as of 2026Q1");
  expect(frame).toContain("2024-01-01");
  expect(frame).toContain("2026-01-01");
  expect(frame).toContain("Tobin's q, Wikipedia");
});
