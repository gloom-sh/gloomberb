import { afterAll, beforeAll, expect, setSystemTime, spyOn, test } from "bun:test";
import { act } from "react";
import { apiClient } from "../../../api-client";
import type { EarningsCalendarPayload, EarningsCalendarQuery, EarningsCalendarReport } from "../../../api-client/earnings";
import type { CombinedPaneFooter } from "../../../components/layout/pane/footer";
import { createOpenTuiTestHarness, settleFrame } from "../../../renderers/opentui/test-utils";
import { createInitialState } from "../../../state/app/context";
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
