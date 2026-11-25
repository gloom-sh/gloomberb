import { afterAll, beforeAll, expect, setSystemTime, spyOn, test } from "bun:test";
import { act, useReducer } from "react";
import { apiClient, type AuthUser } from "../../../api-client";
import type { EarningsCalendarPayload, EarningsCalendarQuery, EarningsCalendarReport } from "../../../api-client/earnings";
import { MemoryResourceStore } from "../../../data/memory-resource-store";
import { setSavedCopyStore } from "../../../data/pane-saved-copies";
import type { CombinedPaneFooter } from "../../../components/layout/pane/footer";
import { createOpenTuiTestHarness, settleFrame, takeSavedTextFile } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState, type AppState } from "../../../state/app/context";
import { exportPaneTable } from "../../../state/pane-table-export-registry";
import { TestPaneFrame, createTestPaneConfig } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import { setSharedRegistryForTests } from "../../registry/shared";
import { EarningsBoard } from "./board";
import { boardRangeDays } from "./calendar-model";
import { attachEarningsCloudCaches, loadEarningsBoard, resetEarningsCloudCaches } from "./client";

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

const defaultCalendar = async (query: EarningsCalendarQuery): Promise<EarningsCalendarPayload> => ({
  asOf: "2026-10-14T15:00:00Z", from: query.from, to: query.to, reports: [entry("JPM", "2026-10-14"), entry("NFLX", "2026-10-15")],
});
const calendarRequests = spyOn(apiClient, "getCloudEarningsCalendar").mockImplementation(defaultCalendar);
const historyRequests = spyOn(apiClient, "getCloudEarningsHistory").mockImplementation(async (symbol) => ({ asOf: "2026-10-14T15:00:00Z", symbol, name: null, reports: [] }));
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
  historyRequests.mockRestore();
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

test.each(["downgrade", "account switch", "sign-out"] as const)("the earnings board clears old reports on %s, even if the new read fails", async (transition) => {
  resetEarningsCloudCaches();
  attachEarningsCloudCaches(new MemoryPluginPersistence());
  let user: AuthUser | null = { id: "earnings-test", emailVerified: true, plan: "pro" } as AuthUser;
  const listeners = new Set<() => void>();
  const userSpy = spyOn(apiClient, "getCurrentUser").mockImplementation(() => user);
  const subscription = spyOn(apiClient, "subscribeCurrentUser").mockImplementation((listener) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  });
  const nextRead = Promise.withResolvers<EarningsCalendarPayload>();
  const requested = Promise.withResolvers<void>();
  calendarRequests.mockImplementation((query) => {
    if (user?.id === "earnings-test" && user.plan === "pro") return defaultCalendar(query);
    requested.resolve();
    return nextRead.promise;
  });
  try {
    const state = createInitialState(createTestPaneConfig("earnings-test", { paneId: "earnings-calendar", instanceId: PANE }));
    await tui.render(<TestPaneFrame state={state} paneId={PANE} pluginId="earnings" runtime={runtime} width={100} height={16}>
      {(body) => <EarningsBoard focused scopedSymbols={MARKET} {...body} />}
    </TestPaneFrame>, { width: 100, height: 16 });
    await tui.waitForFrameToContain("JPM");
    await act(async () => {
      user = transition === "downgrade" ? { ...user!, plan: "free" }
        : transition === "account switch" ? { ...user!, id: "other-earnings-test" } : null;
      for (const listener of listeners) listener();
    });
    await requested.promise;
    await act(async () => { await tui.setup().renderOnce(); });
    expect(tui.frame()).not.toContain("JPM");
    await act(async () => { nextRead.reject(new Error("Offline")); });
    const failed = await tui.waitForFrameToContain("Offline");
    expect(failed).not.toContain("JPM");
  } finally {
    await tui.destroy();
    subscription.mockRestore();
    userSpy.mockRestore();
    calendarRequests.mockImplementation(defaultCalendar);
    resetEarningsCloudCaches();
  }
});

test("EVTS restores the board on its first frame while the highlighted report refresh is pending", async () => {
  const previous = setSavedCopyStore(new MemoryResourceStore());
  const now = Date.parse("2026-10-14T15:00:00Z");
  const state = createInitialState(createTestPaneConfig("earnings-test", { paneId: "earnings-calendar", instanceId: PANE }));
  const board = () => <TestPaneFrame state={state} paneId={PANE} pluginId="earnings" runtime={runtime} width={100} height={16}>
    {(body, value) => {
      footer = value;
      return <EarningsBoard focused scopedSymbols={MARKET} highlight="AAPL" {...body} />;
    }}
  </TestPaneFrame>;
  const held = Promise.withResolvers<Awaited<ReturnType<typeof apiClient.getCloudEarningsHistory>>>();
  const before = historyRequests.getMockImplementation();
  try {
    resetEarningsCloudCaches();
    await tui.render(board(), { width: 100, height: 16 });
    await tui.waitForFrameToContain("JPM");
    await tui.destroy();
    resetEarningsCloudCaches();
    historyRequests.mockReturnValue(held.promise);
    setSystemTime(now + 60_000);
    await tui.render(board(), { width: 100, height: 16 });
    await tui.setup().renderOnce();
    expect(tui.frame()).toContain("JPM");
    expect(footer.info.some((segment) => segment.savedCopyAt === now)).toBe(true);
  } finally {
    await tui.destroy();
    if (before) historyRequests.mockImplementation(before);
    setSystemTime(now);
    resetEarningsCloudCaches();
    setSavedCopyStore(previous);
  }
});

test("the earnings board dates a restored calendar by when it was fetched", async () => {
  const store = new MemoryPluginPersistence();
  const now = Date.parse("2026-10-14T15:00:00Z");
  const fetchedAt = now - 60_000;
  resetEarningsCloudCaches();
  attachEarningsCloudCaches(store);
  const fresh = Promise.withResolvers<EarningsCalendarPayload>();
  try {
    setSystemTime(fetchedAt);
    const days = boardRangeDays("", "2026-10-14");
    const query = { from: days[0]!.from, to: days.at(-1)!.to, perDay: 200, symbols: [], markets: "all" } as const;
    await loadEarningsBoard(query, true);
    resetEarningsCloudCaches();
    attachEarningsCloudCaches(store);
    setSystemTime(now);
    calendarRequests.mockReturnValue(fresh.promise);
    const state = createInitialState(createTestPaneConfig("earnings-test", { paneId: "earnings-calendar", instanceId: PANE }));
    await tui.render(<TestPaneFrame state={state} paneId={PANE} pluginId="earnings" runtime={runtime} width={100} height={16}>
      {(body, value) => {
        footer = value;
        return <EarningsBoard focused scopedSymbols={MARKET} {...body} />;
      }}
    </TestPaneFrame>, { width: 100, height: 16 });
    await tui.waitForFrameToContain("JPM");
    expect(footer.info.find((segment) => segment.savedCopyAt != null)?.savedCopyAt).toBe(fetchedAt);
    const live = await defaultCalendar(query);
    await act(async () => { fresh.resolve({ ...live, reports: [entry("LIVE", "2026-10-14")] }); });
    await tui.waitForFrameToContain("LIVE");
    expect(footer.info.some((segment) => segment.savedCopyAt != null)).toBe(false);
  } finally {
    await tui.destroy();
    setSystemTime(now);
    calendarRequests.mockImplementation(defaultCalendar);
    resetEarningsCloudCaches();
  }
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

test("EVTS on a small company's past report day: moves no report in view has leave, and a report out shows its move across it", async () => {
  resetEarningsCloudCaches();
  // Yesterday's board, largest first: twenty with options, enough reports to average and both closes in,
  // then ten small caps with none of the three, the last of them the company asked for.
  const priced = Array.from({ length: 20 }, (_, index) => ({
    ...entry(`BIG${index + 10}`, "2026-10-13"), marketCap: (900 - index) * 1e9, dateStatus: "reported" as const, epsActual: 1.2,
    implied: { move: 0.052, straddle: 5.2, spot: 100, strike: 100, expiry: "2026-10-17", session: "2026-10-12", method: "quote-mid" as const, final: true, at: "2026-10-12T20:00:00Z" },
    realized: { move: 0.031, baseSession: "2026-10-12", baseClose: 100, afterSession: "2026-10-13", afterClose: 103.1 },
    averageMove: 0.044, averageReports: 8,
  }));
  const small = Array.from({ length: 10 }, (_, index) => ({
    ...entry(`SM${index + 10}`, "2026-10-13"), timing: null, timingSource: null, marketCap: (90 - index) * 1e6, dateStatus: "reported" as const, epsActual: -0.04,
  }));
  calendarRequests.mockImplementation(async (query: EarningsCalendarQuery) => ({
    asOf: "2026-10-14T15:00:00Z", from: query.from, to: query.to, reports: [...priced, ...small],
  }));
  // EVTS SM19 opens on SM19's report day, yesterday's.
  historyRequests.mockImplementation(async (symbol) => ({
    asOf: "2026-10-14T15:00:00Z", symbol, name: null, reports: [{ ...small.at(-1)!, revenueActual: null }],
  }));
  try {
    const instance = `${PANE}:moves`;
    const state = createInitialState(createTestPaneConfig("/tmp/gloomberb-evts-moves-tui-test", { paneId: "earnings-calendar", instanceId: instance }));
    state.focusedPaneId = instance;
    await act(async () => {
      await tui.render(<LiveBoard initial={state} runtime={runtime} highlight="SM19" onFooter={() => {}} />, { width: 150, height: 12 });
    });
    await tui.waitForFrameToContain("SM19", 40);
    const smallCaps = await tui.waitForFrameToExclude("IMPLIED", 40);
    expect(smallCaps).not.toContain("BIG");
    expect(smallCaps).not.toMatch(/\bMOVE\b/);
    await act(async () => { await tui.emitKeypress({ name: "home" }); });
    await tui.waitForFrameToContain("BIG10", 40);
    const priced = await tui.waitForFrameToContain("IMPLIED", 40);
    expect(priced).toMatch(/IMPLIED\s+MOVE\s+AVG MOVE/);
    expect(priced.split("\n").find((line) => line.includes("BIG10"))).toMatch(/±5\.2%\s+\+3\.1%\s+4\.4%/);
  } finally {
    calendarRequests.mockImplementation(async (query: EarningsCalendarQuery) => ({
      asOf: "2026-10-14T15:00:00Z", from: query.from, to: query.to, reports: [entry("JPM", "2026-10-14"), entry("NFLX", "2026-10-15")],
    }));
    historyRequests.mockImplementation(async (symbol) => ({ asOf: "2026-10-14T15:00:00Z", symbol, name: null, reports: [] }));
    resetEarningsCloudCaches();
  }
});

test("EVTS 0700.HK: the market board reads the listings abroad, lands on Tencent's row below the US companies, says its currency, and exports bare figures with each row's currency", async () => {
  resetEarningsCloudCaches();
  const asked: EarningsCalendarQuery[] = [];
  // The footer's [t]icker opens the selected row's company.
  const opened: string[] = [];
  const recording = createTestPluginRuntime({ navigateTicker: (symbol: string) => { opened.push(symbol); } });
  let boardFooter: CombinedPaneFooter | null = null;
  // Twenty US companies larger than Tencent that day, then Tencent: off screen until the board lands on it.
  const us = Array.from({ length: 20 }, (_, index) => ({ ...entry(`US${index + 10}`, "2026-10-15"), marketCap: (900 - index) * 1e9, revenueEstimate: 1.2e9 }));
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
    // A listing abroad's report says its currency after its figures, and the cap that it is in dollars.
    expect(frame).not.toContain("CCY");
    expect(frame).toMatch(/\d CNY/);
    expect(frame).toContain("MKT CAP $");
    // The export keeps numbers down each figure's column, whatever currency a row shows, and names each row's.
    await exportPaneTable(instance, "evts.csv");
    const [header, ...lines] = takeSavedTextFile()!.text.trim().split("\n").map((line) => line.split(","));
    const exported = (ticker: string) => {
      const line = lines.find((cells) => cells[header!.indexOf("TICKER")] === ticker);
      return ["EPS EST", "SALES EST", "CCY"].map((label) => line?.[header!.indexOf(label)]);
    };
    expect(exported("US10")).toEqual(["1", "1200000000", "USD"]);
    expect(exported("0700:HKEX")).toEqual(["7.21", "210240000000", "CNY"]);
  } finally {
    calendarRequests.mockImplementation(async (query: EarningsCalendarQuery) => ({
      asOf: "2026-10-14T15:00:00Z", from: query.from, to: query.to, reports: [entry("JPM", "2026-10-14"), entry("NFLX", "2026-10-15")],
    }));
    resetEarningsCloudCaches();
  }
});

test("reports to come and reports out are two views, each with its own columns; EVTS on a report out opens on Reported", async () => {
  resetEarningsCloudCaches();
  const jpm = { ...entry("JPM", "2026-10-14"), dateStatus: "reported" as const, epsActual: 1.2, epsActualSource: "calendar" as const, epsBasis: "adjusted" as const };
  const nflx = { ...entry("NFLX", "2026-10-15"), dateStatus: "confirmed" as const, epsAnalysts: 30 };
  calendarRequests.mockImplementation(async (query: EarningsCalendarQuery) => ({ asOf: "2026-10-14T15:00:00Z", from: query.from, to: query.to, reports: [jpm, nflx] }));
  try {
    const instance = `${PANE}:kinds`;
    const state = createInitialState(createTestPaneConfig("/tmp/gloomberb-ern-kinds-tui-test", { paneId: "earnings-calendar", instanceId: instance }));
    state.focusedPaneId = instance;
    await act(async () => {
      await tui.render(<LiveBoard initial={state} runtime={runtime} highlight="JPM" onFooter={() => {}} />, { width: 150, height: 12 });
    });
    const reported = await tui.waitForFrameToContain("EPS ACT", 40);
    expect(reported).toMatch(/Upcoming\s+Reported/);
    expect(reported).toContain("JPM");
    expect(reported).not.toContain("NFLX");
    expect(reported).not.toContain("STATUS");
    await tui.clickFrameText("Upcoming");
    const upcoming = await tui.waitForFrameToContain("NFLX", 40);
    expect(upcoming).not.toContain("JPM ");
    // Nothing out yet: no actual, surprise or move to wait on, and no `pending` in their place.
    expect(upcoming).not.toMatch(/EPS ACT|EPS SURP|\bMOVE\b|pending/);
    expect(upcoming).toMatch(/STATUS/);
    // A layout's or shot's `kind` setting opens on that view, though a report is to come.
    const set = createInitialState(createTestPaneConfig("/tmp/gloomberb-ern-kinds-tui-test", {
      paneId: "earnings-calendar", instanceId: `${instance}:set`, settings: { kind: "reported" } }));
    set.focusedPaneId = `${instance}:set`;
    await act(async () => {
      await tui.render(<LiveBoard initial={set} runtime={runtime} highlight="" onFooter={() => {}} />, { width: 150, height: 12 });
    });
    const opened = await tui.waitForFrameToContain("EPS ACT", 40);
    expect(opened).toContain("JPM");
    expect(opened).not.toContain("NFLX");
    // `shot EVTS JPM --kind upcoming`: the named view wins over the one JPM's report, already out, is in.
    const named = createInitialState(createTestPaneConfig("/tmp/gloomberb-ern-kinds-tui-test", {
      paneId: "earnings-calendar", instanceId: `${instance}:named`, settings: { kind: "upcoming" } }));
    named.focusedPaneId = `${instance}:named`;
    await act(async () => {
      await tui.render(<LiveBoard initial={named} runtime={runtime} highlight="JPM" onFooter={() => {}} />, { width: 150, height: 12 });
    });
    const upcomingNamed = await tui.waitForFrameToContain("NFLX", 40);
    await settleFrame(tui.setup(), 8);
    expect(tui.frame()).toMatch(/STATUS/);
    expect(tui.frame()).not.toContain("EPS ACT");
    expect(upcomingNamed).not.toContain("JPM ");
  } finally {
    calendarRequests.mockImplementation(defaultCalendar);
    resetEarningsCloudCaches();
  }
});
