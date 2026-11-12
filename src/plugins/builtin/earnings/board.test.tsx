import { afterAll, beforeAll, expect, setSystemTime, spyOn, test } from "bun:test";
import { act, useReducer } from "react";
import { apiClient } from "../../../api-client";
import type { EarningsCalendarPayload, EarningsCalendarQuery, EarningsCalendarReport } from "../../../api-client/earnings";
import type { CombinedPaneFooter } from "../../../components/layout/pane/footer";
import { createOpenTuiTestHarness, settleFrame } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState, type AppState } from "../../../state/app/context";
import { TestPaneFrame, createTestPaneConfig } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { setSharedRegistryForTests } from "../../registry/shared";
import { EarningsBoard } from "./board";
import { resetEarningsCloudCaches } from "./client";

const tui = createOpenTuiTestHarness();
const PANE = "earnings-calendar:test";
const runtime = createTestPluginRuntime();
const MARKET: string[] = [];
let footer: CombinedPaneFooter;

const entry = (symbol: string, date: string): EarningsCalendarReport => ({
  symbol, name: `${symbol} Inc.`, date, timing: "bmo", timingSource: "filing", reportedAt: null, fiscalPeriod: "2026-09",
  marketCap: 10e9, epsEstimate: 1, epsActual: null, epsAnalysts: null, revenueEstimate: null, revenueAnalysts: null,
  implied: null, realized: null, averageMove: null, averageReports: 0,
});

const calendarRequests = spyOn(apiClient, "getCloudEarningsCalendar").mockImplementation(
  async (query: EarningsCalendarQuery): Promise<EarningsCalendarPayload> => ({
    asOf: "2026-10-14T15:00:00Z", from: query.from, to: query.to, reports: [entry("JPM", "2026-10-14"), entry("NFLX", "2026-10-15")],
  }),
);
beforeAll(() => {
  resetEarningsCloudCaches();
  setSystemTime(new Date("2026-10-14T15:00:00Z"));
  setSharedRegistryForTests({ commands: new Map([["set-event-alert", {}]]) } as never);
});
afterAll(() => {
  resetEarningsCloudCaches();
  setSystemTime();
  setSharedRegistryForTests(undefined);
  calendarRequests.mockRestore();
});

test("the terminal keeps ERN's table and footer: no calendar, even from a layout that asks for it, and no results alert key", async () => {
  // A layout saved on the desktop with the calendar open.
  const state = createInitialState(createTestPaneConfig("/tmp/gloomberb-ern-board-tui-test", {
    paneId: "earnings-calendar", instanceId: PANE, settings: { view: "calendar" },
  }));
  state.focusedPaneId = PANE;
  await act(async () => {
    await tui.render(
      <TestPaneFrame state={state} paneId={PANE} pluginId="earnings" runtime={runtime} width={100} height={16}>
        {(body, value) => {
          footer = value;
          return <EarningsBoard focused scopedSymbols={MARKET} {...body} />;
        }}
      </TestPaneFrame>,
      { width: 100, height: 16 },
    );
  });
  await settleFrame(tui.setup(), 8);
  const frame = tui.frame();
  expect(frame).toContain("JPM");
  expect(frame).toContain("NFLX");
  expect(frame).not.toContain("Calendar");
  expect(frame).not.toContain("otify");
  expect(footer.hints.map((hint) => hint.id)).toEqual(["catalysts", "ticker", "estimates", "calls", "analysts"]);
});

/** The board with the app's reducer, so the row it selects stays selected. */
function LiveBoard({ initial, runtime: live, highlight, onFooter }: {
  initial: AppState;
  runtime: ReturnType<typeof createTestPluginRuntime>;
  highlight: string;
  onFooter: (footer: CombinedPaneFooter) => void;
}) {
  const [state, dispatch] = useReducer(appReducer, initial);
  return (
    <TestPaneFrame state={state} dispatch={dispatch} paneId={state.focusedPaneId!} pluginId="earnings" runtime={live} width={150} height={12}>
      {(body, value) => {
        onFooter(value);
        return <EarningsBoard focused scopedSymbols={MARKET} highlight={highlight} {...body} />;
      }}
    </TestPaneFrame>
  );
}

test("EVTS 0700.HK: the market board reads the listings abroad, lands on Tencent's row below the US companies, and says its currency", async () => {
  resetEarningsCloudCaches();
  const asked: EarningsCalendarQuery[] = [];
  // The footer's [t]icker opens the selected row's company.
  const opened: string[] = [];
  const recording = createTestPluginRuntime({ navigateTicker: (symbol: string) => { opened.push(symbol); } });
  let boardFooter: CombinedPaneFooter | null = null;
  // Twenty US companies larger than Tencent that day, then Tencent: off screen until the board lands on it.
  const us = Array.from({ length: 20 }, (_, index) => ({ ...entry(`US${index + 10}`, "2026-10-15"), marketCap: (900 - index) * 1e9 }));
  const tencent: EarningsCalendarReport = {
    ...entry("0700:HKEX", "2026-10-15"), name: "Tencent Holdings Limited", timing: null, timingSource: null, marketCap: 459.65e9,
    epsEstimate: 7.21, epsAnalysts: 12, revenueEstimate: 210.24e9, dateStatus: "confirmed", currency: "CNY", listings: ["0700:HKEX"],
  };
  calendarRequests.mockImplementation(async (query: EarningsCalendarQuery) => {
    asked.push(query);
    return { asOf: "2026-10-14T15:00:00Z", from: query.from, to: query.to, reports: query.markets === "all" ? [...us, tencent] : us };
  });
  try {
    const instance = `${PANE}:evts`;
    const state = createInitialState(createTestPaneConfig("/tmp/gloomberb-evts-abroad-tui-test", { paneId: "earnings-calendar", instanceId: instance }));
    state.focusedPaneId = instance;
    await act(async () => {
      await tui.render(
        <LiveBoard initial={state} runtime={recording} highlight="0700.HK" onFooter={(value) => { boardFooter = value; }} />,
        { width: 150, height: 12 },
      );
    });
    await settleFrame(tui.setup(), 8);
    const frame = tui.frame();
    // Read with the listings abroad, Tencent's listing named so the day's cut keeps it.
    expect(asked.at(-1)).toMatchObject({ markets: "all", symbols: expect.arrayContaining(["0700:HKEX"]) });
    // Its row, last by size, is the one selected: 0700.HK as typed is the board's 0700:HKEX.
    act(() => (boardFooter as CombinedPaneFooter | null)?.hints.find((hint) => hint.id === "ticker")?.onPress?.());
    expect(opened).toEqual(["0700:HKEX"]);
    // Scrolled to it, below twenty larger US companies.
    expect(frame).toContain("0700:HKEX");
    expect(frame).not.toContain("US10 ");
    // A board with a listing abroad's report says each report's currency, and that the cap is in dollars.
    expect(frame).toContain("CCY");
    expect(frame).toContain("CNY");
  } finally {
    calendarRequests.mockImplementation(async (query: EarningsCalendarQuery) => ({
      asOf: "2026-10-14T15:00:00Z", from: query.from, to: query.to, reports: [entry("JPM", "2026-10-14"), entry("NFLX", "2026-10-15")],
    }));
    resetEarningsCloudCaches();
  }
});
