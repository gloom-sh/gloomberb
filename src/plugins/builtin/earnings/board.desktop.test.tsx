/** @jsxImportSource react */
import { afterAll, beforeAll, beforeEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { act, useCallback, useMemo, useState } from "react";
import { apiClient } from "../../../api-client";
import type { EarningsCalendarPayload, EarningsCalendarQuery, EarningsCalendarReport } from "../../../api-client/earnings";
import { PaneFooterProvider, type CombinedPaneFooter } from "../../../components/layout/pane/footer";
import { createDomUiHost } from "../../../renderers/dom/dom-ui-host";
import { WebDialogHostProvider } from "../../../renderers/dom/dialog-host";
import { WebInputHostProvider } from "../../../renderers/dom/input-host";
import { createDomTestHarness } from "../../../renderers/dom/test-utils";
import { appReducer, createInitialState, type AppAction, type AppState } from "../../../state/app/context";
import { TestPaneProvider, createTestPaneConfig, createTestTicker } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { UiHostProvider, useRendererHost } from "../../../ui";
import { setSharedRegistryForTests } from "../../registry/shared";
import { fundMembersCache } from "../members/client";
import { board as ivv, member } from "../members/test-fixture";
import { EarningsBoard } from "./board";
import { resetEarningsCloudCaches } from "./client";

const dom = createDomTestHarness();
const PANE = "earnings-calendar:test";
const runtime = createTestPluginRuntime();
/** The market board; one array, as a new one each render reads the board again. */
const MARKET: string[] = [];
let footer: CombinedPaneFooter;
let dispatch: (action: AppAction) => void;

/** happy-dom has no layout, so give the table body a viewport tall enough for every row. */
for (const property of ["offsetHeight", "clientHeight"]) {
  Object.defineProperty(dom.window.HTMLElement.prototype, property, { configurable: true, value: 18 * 60 });
}

const entry = (symbol: string, date: string, fields: Partial<EarningsCalendarReport> = {}): EarningsCalendarReport => ({
  symbol, name: `${symbol} Inc.`, date, timing: "bmo", timingSource: "filing", reportedAt: null, fiscalPeriod: "2026-09",
  marketCap: 10e9, epsEstimate: 1, epsActual: null, epsAnalysts: null, revenueEstimate: null, revenueAnalysts: null,
  implied: null, realized: null, averageMove: null, averageReports: 0, ...fields,
});

// Wed Oct 14 2026: the table reads today to Friday, the calendar Monday to Friday.
const WEEK: EarningsCalendarReport[] = [
  entry("JPM", "2026-10-14", { marketCap: 700e9 }),
  entry("NFLX", "2026-10-15", { timing: "amc", marketCap: 400e9 }),
  // Twelve before Friday's open: 80 cells draw two a row for five rows, so nine and a "+3 more" slot.
  ...["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L"].map((symbol, index) => entry(symbol, "2026-10-16", { marketCap: (90 - index) * 1e9 })),
];
let nextWeek: Promise<EarningsCalendarReport[]> = Promise.resolve([]);

const calendarRequests = spyOn(apiClient, "getCloudEarningsCalendar");
// The S&P 500's holdings, two of them in Information Technology.
const holdingsRequests = spyOn(apiClient, "getFundMembers").mockImplementation(async () => ({
  ...ivv,
  members: [
    { ...member("MSFT", 0.4, 0.06), sector: "Information Technology" },
    { ...member("JPM", 0.1, 0.03), sector: "Financials" },
    { ...member("NVDA", 1.2, 0.08), sector: "Information Technology" },
  ],
}));
beforeAll(() => {
  setSystemTime(new Date("2026-10-14T15:00:00Z"));
  setSharedRegistryForTests({ commands: new Map([["set-event-alert", {}]]) } as never);
});
afterAll(() => {
  setSystemTime();
  setSharedRegistryForTests(undefined);
  calendarRequests.mockRestore();
  holdingsRequests.mockRestore();
  resetEarningsCloudCaches();
  fundMembersCache.reset();
});
// The board reads through the shared calendar cache; each test starts from the server.
beforeEach(() => {
  resetEarningsCloudCaches();
  serve();
});

function serve() {
  calendarRequests.mockImplementation(async (query: EarningsCalendarQuery): Promise<EarningsCalendarPayload> => {
    const reports = query.from >= "2026-10-19" ? await nextWeek : WEEK;
    // Named companies alone, unless the market's are asked for too.
    const named = query.perDay === 0 ? new Set(query.symbols) : null;
    return {
      asOf: "2026-10-14T15:00:00Z", from: query.from, to: query.to,
      reports: reports.filter((report) => report.date >= query.from && report.date <= query.to && (!named || named.has(report.symbol))),
    };
  });
}

function Harness() {
  const [paneState, setPaneState] = useState<AppState["paneState"]>({});
  const state = useMemo(() => {
    const next = createInitialState(createTestPaneConfig("/tmp/gloomberb-ern-board-test", { paneId: "earnings-calendar", instanceId: PANE }));
    next.paneState = paneState;
    next.focusedPaneId = PANE;
    next.tickers = new Map([
      ["NFLX", createTestTicker("NFLX", "Netflix", { watchlists: ["watchlist"] })],
      ["JPM", createTestTicker("JPM", "JPMorgan", { portfolios: ["main"] })],
    ]);
    return next;
  }, [paneState]);
  dispatch = useCallback((action: AppAction) => setPaneState((current) => appReducer({ ...state, paneState: current }, action).paneState), [state]);
  // The desktop's own host, so the query bar is the one the app draws.
  const ui = useMemo(() => createDomUiHost("linux"), []);
  return (
    <UiHostProvider ui={ui} renderer={useRendererHost()}>
      <WebInputHostProvider>
        <WebDialogHostProvider>
        <TestPaneProvider state={state} dispatch={dispatch} paneId={PANE} pluginId="earnings" runtime={runtime}>
          <PaneFooterProvider>{(value) => {
            footer = value;
            return <EarningsBoard focused scopedSymbols={MARKET} width={80} height={40} />;
          }}</PaneFooterProvider>
        </TestPaneProvider>
        </WebDialogHostProvider>
      </WebInputHostProvider>
    </UiHostProvider>
  );
}

const settle = () => act(async () => { await Bun.sleep(20); });
const tiles = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>("[data-gloom-role=earnings-calendar-report]")];
const selectedTile = (root: HTMLElement) => tiles(root).find((tile) => tile.dataset.selected === "true")?.dataset.symbol;
const rowKeys = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>("[data-gloom-role=data-table-row]")].map((row) => row.dataset.gloomRowKey);
const mouseDown = (element: Element, detail = 1) => act(async () => {
  element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, detail }));
});
/** The view switch's option, by its label. */
const viewOption = (root: HTMLElement, label: string) => [...root.querySelectorAll<HTMLElement>(".gloom-qb-view button")]
  .find((button) => button.textContent === label)!;
const pick = (element: HTMLElement) => act(async () => { element.click(); });
const setWeek = (week: number) => act(async () => {
  dispatch({ type: "UPDATE_PLUGIN_PANE_STATE", paneId: PANE, pluginId: "earnings", key: "range", value: String(week) });
});

test("the table and the calendar share the cursor, and +N more opens its group in the calendar", async () => {
  const root = await dom.render(<Harness />);
  await settle();
  expect(rowKeys(root)).toContain("NFLX:2026-10-15");
  await mouseDown(root.querySelector("[data-gloom-row-key='NFLX:2026-10-15']")!);

  await pick(viewOption(root, "Calendar"));
  await settle();
  expect(rowKeys(root)).toEqual([]);
  expect(selectedTile(root)).toBe("NFLX");
  // The desktop's footer offers the results alert for the company under the cursor.
  expect(footer.hints.map((hint) => hint.id)).toContain("alert");

  const friday = () => root.querySelector<HTMLElement>("[data-gloom-role=earnings-calendar-day][data-date='2026-10-16']")!;
  expect(tiles(friday()).map((tile) => tile.dataset.symbol)).toEqual(["A", "B", "C", "D", "E", "F", "G", "H", "I"]);
  await mouseDown(friday().querySelector("[data-gloom-role=earnings-calendar-more]")!);
  // The whole group, in the calendar, the cursor on the first company the slot counted.
  expect(tiles(friday()).map((tile) => tile.dataset.symbol)).toEqual(["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L"]);
  expect(friday().querySelector("[data-gloom-role=earnings-calendar-more]")).toBeNull();
  expect(selectedTile(root)).toBe("J");

  // Back in the table, the same company is selected.
  await pick(viewOption(root, "Table"));
  await settle();
  expect(root.querySelector("[data-gloom-row-key='J:2026-10-16']")?.getAttribute("data-selected")).toBe("true");
});

test("another week shows no reports of its own until it is read, and its failure rather than an empty week", async () => {
  const pending = Promise.withResolvers<EarningsCalendarReport[]>();
  nextWeek = pending.promise;
  const root = await dom.render(<Harness />);
  await settle();
  await pick(viewOption(root, "Calendar"));
  await settle();
  expect(tiles(root).length).toBeGreaterThan(0);

  await setWeek(1);
  await settle();
  expect(tiles(root)).toEqual([]);
  expect(root.textContent).not.toContain("No reports on the calendar");
  expect(root.querySelector("[data-gloom-status=loading]")).not.toBeNull();

  await act(async () => { pending.reject(new Error("UPSTREAM_ERROR")); });
  await settle();
  expect(root.textContent).not.toContain("No reports on the calendar");
  expect(root.querySelector("[data-gloom-status=error]")).not.toBeNull();
  // The view switch is still there, to go back to the table.
  expect(viewOption(root, "Table")).toBeDefined();

  // A week that is read and empty says so.
  nextWeek = Promise.resolve([]);
  await setWeek(2);
  await settle();
  expect(root.textContent).toContain("No reports on the calendar in the week of Oct 26.");
});

test("the Names filter lists Mine, each portfolio and watchlist and the sector funds, and reads only the chosen one's companies", async () => {
  const root = await dom.render(<Harness />);
  await settle();
  const trigger = () => [...root.querySelectorAll<HTMLElement>("button.gloom-qb-chip")]
    .find((chip) => chip.querySelector(".gloom-qb-label")?.textContent === "Names")!;
  const menuItems = () => [...document.querySelectorAll<HTMLElement>("[data-gloom-role=menu] .gloom-menu-item")];
  await act(async () => { trigger().click(); });
  expect(menuItems().map((item) => item.querySelector(".gloom-menu-text")?.textContent).slice(0, 6))
    .toEqual(["All", "Mine", "Main Portfolio", "Watchlist", "Technology (XLK)", "Healthcare (XLV)"]);
  await act(async () => { trigger().click(); });
  const lastSymbols = () => calendarRequests.mock.calls.at(-1)![0].symbols;
  const choose = async (label: string) => {
    await act(async () => { trigger().click(); });
    const item = menuItems().find((entry) => entry.querySelector(".gloom-menu-text")?.textContent === label)!;
    await act(async () => { item.click(); });
    await settle();
  };

  await choose("Watchlist");
  expect(lastSymbols()).toEqual(["NFLX"]);
  expect(rowKeys(root)).toEqual(["NFLX:2026-10-15"]);

  // A sector fund's companies are the S&P 500's holdings in its sector, largest first.
  await choose("Technology (XLK)");
  expect(holdingsRequests).toHaveBeenCalledWith("IVV");
  expect(lastSymbols()).toEqual(["NVDA", "MSFT"]);

  await choose("Mine");
  expect([...lastSymbols()!].sort()).toEqual(["JPM", "NFLX"]);
});
