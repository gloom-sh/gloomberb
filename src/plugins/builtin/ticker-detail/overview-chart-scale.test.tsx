import { expect, test } from "bun:test";
import { act, useReducer } from "react";
import { createOpenTuiTestHarness, settleFrame } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState } from "../../../state/app/context";
import { findPaneInstance, TICKER_RESEARCH_PANE_ID, type AppConfig } from "../../../types/config";
import type { TickerFinancials } from "../../../types/financials";
import type { ContextMenuActionItem, ContextMenuItem } from "../../../types/context-menu";
import { captureConfigSaves } from "../../../test-support/config-store";
import { flushPendingPersistence } from "../../../state/persist-scheduler";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { TestPaneFrame, createTestPaneConfig, createTestTicker } from "../../../test-support/pane";
import { OVERVIEW_CHART_SCALE_SETTING } from "./overview/chart-scale";
import { OverviewResearchTab } from "./overview/pane";

const PANE_ID = "ticker-detail:scale";
const tui = createOpenTuiTestHarness({ width: 90, height: 30 });
const saved = captureConfigSaves();

/** Weekly closes stepping from `first` to `last`. */
function history(first: number, last: number): TickerFinancials {
  const weeks = 60;
  return {
    annualStatements: [],
    quarterlyStatements: [],
    priceHistory: Array.from({ length: weeks }, (_, index) => {
      const close = first + ((last - first) * index) / (weeks - 1);
      return { date: new Date(Date.UTC(2020, 0, 6 + index * 7)), open: close, high: close, low: close, close, volume: 1_000 };
    }),
  };
}

let menu: ContextMenuItem[] = [];
let config: AppConfig | null = null;

function Harness({ financials }: { financials: TickerFinancials }) {
  const initial = createInitialState(createTestPaneConfig("/tmp/gloom-overview-scale-unused", {
    instanceId: PANE_ID, paneId: TICKER_RESEARCH_PANE_ID, binding: { kind: "fixed", symbol: "GROW" },
  }));
  initial.tickers = new Map([["GROW", createTestTicker("GROW", "Grow Co")]]);
  initial.financials = new Map([["GROW", financials]]);
  const [state, dispatch] = useReducer(appReducer, initial);
  config = state.config;
  const provider = createTestDataProvider({ getTickerFinancials: async () => financials });
  return (
    <TestPaneFrame state={state} dispatch={dispatch} paneId={PANE_ID} pluginId="ticker-research"
      runtime={createTestPluginRuntime({ getMarketData: () => provider })} width={90} height={30}>
      {(body, footer) => {
        menu = footer.menu;
        return <OverviewResearchTab {...body} focused onCapture={() => {}} />;
      }}
    </TestPaneFrame>
  );
}

function logScaleItem(): ContextMenuActionItem | undefined {
  return menu.find((item): item is ContextMenuActionItem => item.type !== "divider" && item.type !== "role" && item.label === "Log Scale");
}

async function mount(financials: TickerFinancials) {
  await act(async () => {
    await tui.render(<Harness financials={financials} />, { width: 90, height: 30 });
  });
  await settleFrame(tui.setup(), 6);
}

async function switchScale() {
  await act(async () => {
    await logScaleItem()!.onSelect!();
  });
  await settleFrame(tui.setup(), 4);
}

/** The value axis's lowest label: $0 on a linear price axis, above it on a log one. */
const axisFloor = () => [...tui.frame().matchAll(/\$(\d[\d.,]*)\s*$/gm)].at(-1)?.[1];
const storedChoice = () => findPaneInstance(config!.layout, PANE_ID)?.settings?.[OVERVIEW_CHART_SCALE_SETTING];

test("the pane menu's Log Scale follows the history's range, and the pane remembers a switch until it is switched back", async () => {
  // From $1 to $100: log until switched off, which the pane keeps and saves.
  await mount(history(1, 100));
  expect(logScaleItem()?.checked).toBe(true);
  expect(axisFloor()).not.toBe("0");
  await switchScale();
  expect(logScaleItem()?.checked).toBe(false);
  expect(axisFloor()).toBe("0");
  expect(storedChoice()).toBe("linear");
  await flushPendingPersistence();
  expect(findPaneInstance(saved.at(-1)!.layout, PANE_ID)?.settings?.[OVERVIEW_CHART_SCALE_SETTING]).toBe("linear");
  // Back on, it is what the history called for: auto again.
  await switchScale();
  expect(logScaleItem()?.checked).toBe(true);
  expect(storedChoice()).toBe("auto");

  // From $80 to $120: linear until switched on.
  await mount(history(80, 120));
  expect(logScaleItem()?.checked).toBe(false);
  await switchScale();
  expect(logScaleItem()?.checked).toBe(true);
  expect(storedChoice()).toBe("log");
});
