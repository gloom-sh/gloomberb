import { afterEach, expect, spyOn, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act, useMemo, useReducer } from "react";
import { apiClient } from "../../../api-client";
import { ApiRequestError } from "../../../api-client/errors";
import type { CloudInsiderSignalsParams, InsiderSignalRow, InsiderSignalsPayload } from "../../../api-client/insider-signals";
import { MarketDataCoordinator, setSharedMarketDataCoordinator } from "../../../market-data/coordinator";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState, type AppState } from "../../../state/app/context";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { TestPaneFrame, createTestPaneConfig, createTestTicker } from "../../../test-support/pane";
import { createStatefulTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { findPaneInstance } from "../../../types/config";
import { insiderModule } from "./index";
import { insiderSignalsCache } from "./signals-client";
import {
  buildInsiderSignalColumns,
  formatInsiderStake,
  formatInsiderUsual,
  insiderSignalDetailLines,
  insiderSignalRowFacts,
  insiderSignalSortValue,
  insiderSignalsCoverageNotice,
  insiderSignalsQueryFrom,
  insiderSignalsBarFit,
  type InsiderSignalColumnId,
} from "./signals-model";

const InsiderPane = insiderModule.panes![0]!.component;
const tui = createOpenTuiTestHarness();
const PANE_ID = "insider:signals:test";

// Invented companies and people.
function signalRow(ticker: string, company: string, score: number, reasons: string[], value: number): InsiderSignalRow {
  return {
    ticker, issuerCik: "9900001", company, score, reasons, insiders: reasons[0]!.startsWith("3 insiders") ? 3 : 1, buys: 2, value,
    shares: 10_000, firstBuy: "2026-10-01", lastBuy: "2026-10-14", lastFiled: "2026-10-14",
    signals: { clusterInsiders: 1, repeatBuys: 1, usualRatio: null, stakeIncreasePct: null, newPosition: false },
    buyers: [{ name: "Rivera Ana", role: "CEO", value, buys: 1, lastBuy: "2026-10-14" }],
  };
}
const ROWS = [
  signalRow("NWBI", "Northwind Biologics Inc", 78, ["3 insiders, $1.2M in 14 days", "CFO raised stake 56%"], 1_152_500),
  signalRow("CTSO", "Contoso Energy Corp", 72, ["CEO's 4th buy in 90 days, 4.9x usual size", "CEO bought $610k"], 610_000),
  signalRow("FBKM", "Fabrikam Bancorp", 33, ["Director bought $720k", "Director opened a new position"], 720_000),
];
function payload(window: number, rows = ROWS): InsiderSignalsPayload {
  return { window, through: "2026-10-15", asOf: "2026-10-14", coverage: { from: "2026-08-31", through: "2026-10-14" }, rows };
}

let state: AppState | null = null;
/** Pane state the next mount starts with: the query's parts, as `insider:signals:<part>`. */
let seed: Record<string, unknown> = {};
function Harness({ width, height }: { width: number; height: number }) {
  const config = createTestPaneConfig(join(tmpdir(), "gloom-insider-signals-test"), { instanceId: PANE_ID, paneId: "insider", title: "Insider Activity" });
  const [current, dispatch] = useReducer(appReducer, config, (initialConfig) => {
    const initial = createInitialState(initialConfig);
    initial.tickers = new Map(ROWS.map((row) => [row.ticker, createTestTicker(row.ticker, row.company)]));
    initial.focusedPaneId = PANE_ID;
    initial.paneState[PANE_ID] = { pluginState: { insider: seed } };
    return initial;
  });
  state = current;
  const runtime = useMemo(() => createStatefulTestPluginRuntime(), []);
  return <TestPaneFrame state={current} dispatch={dispatch} paneId={PANE_ID} pluginId="insider" runtime={runtime} width={width} height={height} footerKeys>
    {(body) => <InsiderPane paneId={PANE_ID} paneType="insider" focused {...body} />}
  </TestPaneFrame>;
}
const pane = () => findPaneInstance(state!.config.layout, PANE_ID)!;

async function settle() {
  for (let i = 0; i < 8; i++) await act(async () => { await Bun.sleep(2); await tui.setup().renderOnce(); });
}
async function mount(load: (window: number, params: CloudInsiderSignalsParams) => Promise<InsiderSignalsPayload>, width = 140, height = 20) {
  const windows: number[] = [];
  asked.length = 0;
  spyOn(apiClient, "getCloudSecInsiderSignals").mockImplementation(async (params = {}) => {
    windows.push(params.window ?? 30);
    asked.push(params);
    return load(params.window ?? 30, params);
  });
  // The company opened from the ranking reads its own filings.
  setSharedMarketDataCoordinator(new MarketDataCoordinator(createTestDataProvider({ getSecFilings: async () => [] })));
  await act(async () => { await tui.render(<Harness width={width} height={height} />, { width, height }); });
  await settle();
  return windows;
}
const asked: CloudInsiderSignalsParams[] = [];

afterEach(() => {
  insiderSignalsCache.reset();
  setSharedMarketDataCoordinator(null);
  seed = {};
});

test("ranks companies with the reasons; Enter opens one here and Esc comes back to the same row", async () => {
  await mount(async (window) => payload(window));
  let frame = tui.frame();
  // A server from before the structured facts: the lead's role and how many others, the rest dashes.
  expect(frame).toMatch(/SCORE ▼\s+ROLE\s+NTH\s+VS USUAL\s+STAKE\s+BUYERS\s+BOUGHT\s+LAST BUY/);
  expect(frame).toMatch(/NWBI\s+Northwind Biologics Inc\s+78\s+CEO \+2\s+--\s+--\s+--\s+3\s+\$1\.15M/);
  expect(frame).toMatch(/CTSO\s+Contoso Energy Corp\s+72\s+CEO\s+--\s+--\s+--\s+1\s+\$610k/);
  expect(frame).toContain("as of Oct 14, 2026");
  // Footers follow the conventions: no generic key hints for Enter or Esc.
  expect(frame).not.toContain("[Enter]");

  await tui.emitKeypress({ name: "down", sequence: "\u001b[B" }, { trackPropagation: true });
  await act(async () => { tui.setup().mockInput.pressEnter(); });
  await settle();
  expect(pane().binding).toEqual({ kind: "fixed", symbol: "CTSO" });
  expect(pane().title).toBe("INS CTSO");
  frame = tui.frame();
  expect(frame).not.toContain("Northwind Biologics");

  await tui.emitKeypress({ name: "escape", sequence: "\u001b" }, { frames: 2, trackPropagation: true, afterCommit: true });
  await settle();
  expect(pane().binding).toEqual({ kind: "none" });
  expect(pane().title).toBe("Insider Activity");
  frame = tui.frame();
  expect(frame).toContain("Northwind Biologics");
  // Back lands on the row it opened: Enter opens CTSO again.
  await act(async () => { tui.setup().mockInput.pressEnter(); });
  await settle();
  expect(pane().binding).toEqual({ kind: "fixed", symbol: "CTSO" });
});

test("the window is a query-bar choice and a double click opens a row", async () => {
  const windows = await mount(async (window) => payload(window, window === 7 ? [ROWS[2]!] : ROWS));
  await tui.clickFrameText("7D");
  await settle();
  expect(windows).toEqual([30, 7]);
  expect(tui.frame()).not.toContain("Northwind Biologics");
  await tui.clickFrameText("Fabrikam Bancorp");
  await tui.clickFrameText("Fabrikam Bancorp");
  await settle();
  expect(pane().binding).toEqual({ kind: "fixed", symbol: "FBKM" });
});

test("an empty window, a failure and a refused session each say so in the body", async () => {
  await mount(async (window) => payload(window, []));
  expect(tui.frame()).toContain("No open-market insider buying in the last 30 days.");
  // The query bar stays, so another window is one click away.
  expect(tui.frame()).toContain("90D");

  insiderSignalsCache.reset();
  await mount(async () => { throw new Error("Upstream timed out."); });
  expect(tui.frame()).toContain("Insider activity unavailable.");
  expect(tui.frame()).toContain("Upstream timed out.");

  insiderSignalsCache.reset();
  await mount(async () => { throw new ApiRequestError("Sign in required", 401); });
  expect(tui.frame()).toMatch(/[Ss]ign in/);
  expect(tui.frame()).not.toContain("Sign in required");
});

test("the footer warns when the window reaches past the filings read, or none has been read whole", async () => {
  const notice = (window: number, from: string | null) => insiderSignalsCoverageNotice({ window, through: "2026-10-15", coverage: { from, through: from ? "2026-10-14" : null } });
  expect(notice(30, "2026-08-31")).toBeNull();
  expect(notice(30, "2026-09-16")).toBeNull();
  expect(notice(30, "2026-09-17")).toBe("Form 4 filings are read from Sep 17, 2026, so this window leaves out buying before then.");
  expect(notice(7, "2026-10-01")).toBeNull();
  expect(notice(7, null)).toBe("Form 4 filings are still being read, so this ranking may leave out buying.");

  await mount(async (window) => ({ ...payload(window), coverage: { from: null, through: null } }));
  expect(tui.frame()).toContain("[!] as of Oct 14, 2026");
  insiderSignalsCache.reset();
  await mount(async (window) => payload(window));
  expect(tui.frame()).not.toContain("[!]");
});

test("the footer warns when days in the window were left unread by an outage", async () => {
  const notice = (window: number, from: string, missingDays?: string[]) =>
    insiderSignalsCoverageNotice({ window, through: "2026-10-15", coverage: { from, through: "2026-10-14", missingDays } });
  // Servers that predate the list, and gaps outside the window, say nothing.
  expect(notice(30, "2026-08-31")).toBeNull();
  expect(notice(7, "2026-08-31", ["2026-09-28", "2026-09-29"])).toBeNull();
  expect(notice(30, "2026-08-31", ["2026-09-28"])).toBe("Form 4 filings for Sep 28, 2026 are not read yet, so this ranking may leave out buying.");
  expect(notice(30, "2026-08-31", ["2026-09-28", "2026-09-29"])).toBe("Form 4 filings for 2 days in this window are not read yet, so this ranking may leave out buying.");
  expect(notice(90, "2026-09-17", ["2026-09-28"])).toBe("Form 4 filings are read from Sep 17, 2026, and 1 day since is not read yet, so this ranking may leave out buying.");

  await mount(async (window) => ({ ...payload(window), coverage: { from: "2026-08-31", through: "2026-10-14", missingDays: ["2026-09-28"] } }));
  expect(tui.frame()).toContain("[!] as of Oct 14, 2026");
});

test("a narrow pane drops the size against usual, then the nth trade, then the company and the counts", () => {
  const ids = (width: number, rows = BUYING) => buildInsiderSignalColumns(width, rows).map((column) => column.id);
  const all: InsiderSignalColumnId[] = ["ticker", "company", "score", "role", "nth", "usual", "stake", "insiders", "value", "lastBuy"];
  expect(ids(140)).toEqual(all);
  expect(ids(100)).toEqual(all);
  expect(ids(90)).toEqual(all.filter((id) => id !== "usual"));
  // 80 cells, the terminal's 80 columns and the desktop at 640 px: the company stays, the lead's figures without the history.
  expect(ids(80)).toEqual(["ticker", "company", "score", "role", "stake", "insiders", "value", "lastBuy"]);
  expect(ids(70)).toEqual(["ticker", "score", "role", "stake", "insiders", "value", "lastBuy"]);
  expect(ids(56)).toEqual(["ticker", "score", "role", "stake", "value", "lastBuy"]);
  expect(ids(50)).toEqual(["ticker", "score", "role", "stake", "value"]);
  // Without the company the role takes the room left; with it the company does.
  expect(buildInsiderSignalColumns(70, BUYING).find((column) => column.id === "role")).toMatchObject({ flexGrow: 1 });
  expect(buildInsiderSignalColumns(140, BUYING).find((column) => column.id === "company")).toMatchObject({ flexGrow: 1 });
  // Figures sit right, words left, in the side's words.
  expect(buildInsiderSignalColumns(140, SELLING, { side: "sell" }).map((column) => [column.label, column.align])).toEqual([
    ["Ticker", "left"], ["Company", "left"], ["Score", "right"], ["Role", "left"], ["Nth", "right"], ["Vs Usual", "right"],
    ["Stake", "right"], ["Sellers", "right"], ["Sold", "right"], ["Last Sale", "right"],
  ]);
});

// The same companies as a server with sides and structured signals sends them.
const CEO = { name: "Rivera Ana", role: "CEO" } as const;
const CFO = { name: "Chen Li", role: "CFO" } as const;
const DIRECTOR = { name: "Okafor Ben", role: "Director" } as const;
const BUYING: InsiderSignalRow[] = [
  {
    ...ROWS[0]!,
    insiders: 3,
    whySignals: [
      { kind: "cluster", value: 3, text: "3 insiders", insider: null },
      { kind: "stake", value: 56, text: "+56%", insider: CFO },
    ],
    buyers: [
      { ...CEO, value: 496_000, buys: 1, lastBuy: "2026-10-01", shares: 40_000, stakeChangePct: 12, newPosition: false, exited: false, repeatBuys: 1, usualRatio: 1.4 },
      { ...CFO, value: 354_000, buys: 1, lastBuy: "2026-10-09", shares: 30_000, stakeChangePct: 56, newPosition: false, exited: false, repeatBuys: 3, usualRatio: 2.8 },
      { ...DIRECTOR, value: 302_500, buys: 1, lastBuy: "2026-10-14", shares: 25_000, stakeChangePct: null, newPosition: true, exited: false, repeatBuys: 1, usualRatio: null },
    ],
  },
  {
    // A server from before the buyer's own figures: the CEO's are read from the why facts.
    ...ROWS[1]!,
    whySignals: [
      { kind: "repeat", value: 4, text: "4th buy", insider: CEO },
      { kind: "usual", value: 4.9, text: "4.9x usual", insider: CEO },
      { kind: "size", value: 610_000, text: "$610k", insider: CEO },
    ],
  },
  {
    ...ROWS[2]!,
    whySignals: [
      { kind: "size", value: 720_000, text: "$720k", insider: DIRECTOR },
      { kind: "new", value: 1, text: "NEW", insider: DIRECTOR },
    ],
    buyers: [{ ...DIRECTOR, value: 720_000, buys: 1, lastBuy: "2026-10-14", shares: 50_000, stakeChangePct: null, newPosition: true, exited: false, repeatBuys: 1, usualRatio: null }],
  },
];
const SELLING: InsiderSignalRow[] = [{
  ...ROWS[0]!,
  ticker: "TRNT",
  company: "Tailspin Toys Inc",
  score: 61,
  reasons: ["Director sold entire stake", "sold $4.2M"],
  insiders: 1,
  value: 4_200_000,
  signals: { ...ROWS[0]!.signals, exited: true, stakeChangePct: -100 },
  whySignals: [
    { kind: "exited", value: 1, text: "EXITED", insider: DIRECTOR },
    { kind: "size", value: 4_200_000, text: "$4.2M", insider: DIRECTOR },
  ],
  buyers: [{ ...DIRECTOR, value: 4_200_000, buys: 2, lastBuy: "2026-10-13", shares: 80_000, stakeChangePct: -100, newPosition: false, exited: true, repeatBuys: 2, usualRatio: 140 }],
}, {
  ...ROWS[1]!,
  ticker: "WWIM",
  company: "Wide World Importers",
  score: 40,
  reasons: ["CFO sold $900k"],
  insiders: 2,
  value: 900_000,
  whySignals: [{ kind: "both", value: 1, text: "both ways", insider: CFO }],
  // Bought and sold: counted on the net, so no nth sale or size against usual, and the stake carries the mark.
  buyers: [
    { ...CFO, value: 700_000, buys: 3, lastBuy: "2026-10-12", shares: 20_000, stakeChangePct: -22, newPosition: false, exited: false, twoWay: true, repeatBuys: null, usualRatio: null },
    { ...CEO, value: 200_000, buys: 1, lastBuy: "2026-10-10", shares: 5_000, stakeChangePct: -4, newPosition: false, exited: false, repeatBuys: 1, usualRatio: 0.6 },
  ],
}];
async function sided(window: number, params: CloudInsiderSignalsParams): Promise<InsiderSignalsPayload> {
  const side = params.side ?? "buy";
  return { ...payload(window, side === "sell" ? SELLING : BUYING), side, marketCaps: "unavailable" };
}

test("why reads as columns: the lead insider's role and how many others, their nth trade, size against usual and stake", () => {
  const facts = (row: InsiderSignalRow) => {
    const { role, nth, usual, stake } = insiderSignalRowFacts(row);
    return [role, nth.text, usual.text, stake.text];
  };
  // The insider with the most dollars leads; the others are a count.
  expect(facts(BUYING[0]!)).toEqual(["CEO +2", "1st", "1.4x", "+12%"]);
  // An older server's buyer has no figures: the lead's why facts say them.
  expect(facts(BUYING[1]!)).toEqual(["CEO", "4th", "4.9x", "--"]);
  expect(facts(BUYING[2]!)).toEqual(["Director", "1st", "--", "NEW"]);
  expect(facts(SELLING[0]!)).toEqual(["Director", "2nd", "100x+", "EXITED"]);
  // Traded both ways: no nth sale or size against usual, the stake marked.
  expect(facts(SELLING[1]!)).toEqual(["CFO +1", "--", "--", "-22% \u00b1"]);
  // A server without structured signals or buyer figures: dashes, the role still said.
  expect(facts(ROWS[0]!)).toEqual(["CEO +2", "--", "--", "--"]);
  expect(facts({ ...ROWS[0]!, buyers: [] })).toEqual(["--", "--", "--", "--"]);

  // Tones keep the chips' roles: what the ranking counts in the side's colour, NEW and EXITED strong, a lone or small figure plain.
  const weights = (row: InsiderSignalRow) => {
    const { nth, usual, stake } = insiderSignalRowFacts(row);
    return [nth.weight, usual.weight, stake.weight];
  };
  expect(weights(BUYING[0]!)).toEqual(["plain", "plain", "signal"]);
  expect(weights(BUYING[1]!)).toEqual(["signal", "signal", "none"]);
  expect(weights(SELLING[0]!)).toEqual(["signal", "signal", "strong"]);

  // Figures: a size to a tenth, whole from 10x, capped at 100x+; a holding's change with a decimal under 1% and the multiple above +300%.
  expect([0.04, 0.6, 2, 2.84, 9.96, 12.4, 99.9, 100, 140].map(formatInsiderUsual))
    .toEqual(["<0.1x", "0.6x", "2x", "2.8x", "10x", "12x", "100x", "100x+", "100x+"]);
  expect([-100, -38.6, -0.36, 0, null, 300, 350, 500, 2415, 70_821.5].map((pct) => formatInsiderStake(pct)))
    .toEqual(["-100%", "-39%", "-0.4%", "--", "--", "+300%", "4.5x", "6x", "25x", "709x"]);
  expect(formatInsiderStake("NEW", true)).toBe("NEW \u00b1");

  // The detail strip says the same for each insider, largest first.
  expect(insiderSignalDetailLines(BUYING[0]!).map((line) => [line.name, line.role, line.nth.text, line.usual.text, line.stake.text, line.value]))
    .toEqual([
      ["Ana Rivera", "CEO", "1st", "1.4x", "+12%", "$496k"],
      ["Li Chen", "CFO", "3rd", "2.8x", "+56%", "$354k"],
      ["Ben Okafor", "Director", "1st", "--", "NEW", "$302.5k"],
    ]);
});

test("every column sorts: NEW above any raise, EXITED as a whole stake, the dash last either way, the role by its count", () => {
  const order = (rows: InsiderSignalRow[], column: Parameters<typeof insiderSignalSortValue>[1]) =>
    rows.map((row) => insiderSignalSortValue(row, column));
  expect(order(BUYING, "stake")).toEqual([12, null, Number.MAX_SAFE_INTEGER]);
  expect(order(BUYING, "nth")).toEqual([1, 4, 1]);
  expect(order(BUYING, "usual")).toEqual([1.4, 4.9, null]);
  expect(order(SELLING, "stake")).toEqual([100, 22]);
  const role = (insiders: number) => insiderSignalSortValue({ ...BUYING[0]!, insiders }, "role") as string;
  expect([role(13), role(1), role(3)].sort()).toEqual([role(1), role(3), role(13)]);
});

test("Buying and Selling switch in the query bar, with the side's own words, and the selected company's insiders under the table", async () => {
  await mount(sided, 140, 24);
  let frame = tui.frame();
  expect(frame).toMatch(/NWBI\s+Northwind Biologics Inc\s+78\s+CEO \+2\s+1st\s+1\.4x\s+\+12%\s+3\s+\$1\.15M\s+10\/14\/26/);
  expect(frame).toMatch(/CTSO\s+Contoso Energy Corp\s+72\s+CEO\s+4th\s+4\.9x\s+--\s+1\s+\$610k/);
  expect(frame).toMatch(/FBKM\s+Fabrikam Bancorp\s+33\s+Director\s+1st\s+--\s+NEW\s+1\s+\$720k/);
  // No why column: its facts are the columns.
  expect(frame).not.toMatch(/\bWHY\b/);
  // The first company is selected: its insiders in the table's columns, largest first.
  expect(frame).toMatch(/NWBI\s+Role\s+Nth\s+Vs Usual\s+Stake\s+Bought\s+Last/);
  expect(frame).toMatch(/Ana Rivera\s+CEO\s+1st\s+1\.4x\s+\+12%\s+\$496k\s+10\/1\/26/);
  expect(frame).toMatch(/Li Chen\s+CFO\s+3rd\s+2\.8x\s+\+56%\s+\$354k\s+10\/9\/26/);
  expect(frame).toMatch(/Ben Okafor\s+Director\s+1st\s+--\s+NEW\s+\$302\.5k\s+10\/14\/26/);

  await tui.clickFrameText("Selling");
  await settle();
  expect(asked.at(-1)).toEqual({ side: "sell", window: 30, limit: 100 });
  frame = tui.frame();
  expect(frame).toMatch(/ROLE\s+NTH\s+VS USUAL\s+STAKE\s+SELLERS\s+SOLD\s+LAST SALE/);
  expect(frame).toMatch(/TRNT\s+Tailspin Toys Inc\s+61\s+Director\s+2nd\s+100x\+\s+EXITED\s+1\s+\$4\.2M/);
  // Bought and sold: counted on the net, marked, with no nth sale or size against usual.
  expect(frame).toMatch(/WWIM\s+Wide World Importers\s+40\s+CFO \+1\s+--\s+--\s+-22% \u00b1\s+2\s+\$900k/);
  expect(frame).toMatch(/Ben Okafor\s+Director\s+2nd\s+100x\+\s+EXITED\s+\$4\.2M\s+10\/13\/26/);
  // The position filter says what it does on this side.
  expect(frame).toContain("Exited");
  expect(frame).not.toMatch(/\bNew\b/);
});

test("the filters narrow the request, and an empty answer says it is the filters", async () => {
  await mount(async (window, params) => params.cluster ? { ...(await sided(window, params)), rows: [] } : sided(window, params));
  await tui.clickFrameText("Cluster");
  await settle();
  expect(asked.at(-1)).toEqual({ window: 30, limit: 100, cluster: true });
  expect(tui.frame()).toContain("No insider buying in the last 30 days matches these filters.");
  await tui.clickFrameText("New");
  await settle();
  expect(asked.at(-1)).toEqual({ window: 30, limit: 100, cluster: true, position: "new" });
});

test("a stored query is read part by part, and what does not fit falls back", () => {
  expect(insiderSignalsQueryFrom({})).toEqual({ side: "buy", window: 30, role: "all", minValue: 0, cluster: false, position: false, cap: null });
  expect(insiderSignalsQueryFrom({ side: "sell", window: 90, role: "directors", minValue: 1_000_000, cluster: true, position: true, cap: "mid" }))
    .toEqual({ side: "sell", window: 90, role: "directors", minValue: 1_000_000, cluster: true, position: true, cap: "mid" });
  expect(insiderSignalsQueryFrom({ side: "short", window: 12, role: "ceo", minValue: 5, cluster: "yes", cap: "mega" }))
    .toEqual({ side: "buy", window: 30, role: "all", minValue: 0, cluster: false, position: false, cap: null });
});

test("the cap filter shows only where the server stores market values", async () => {
  await mount(sided);
  expect(tui.frame()).not.toContain("Cap");
  insiderSignalsCache.reset();
  await mount(async (window, params) => ({ ...(await sided(window, params)), marketCaps: "stored" }));
  expect(tui.frame()).toContain("Cap");
});

test("an 80-column terminal keeps the role and stake, without the size against usual or the nth trade", async () => {
  await mount(sided, 80, 24);
  let frame = tui.frame();
  expect(frame).toMatch(/TICKER\s+COMPANY\s+SCORE ▼\s+ROLE\s+STAKE\s+BUYERS\s+BOUGHT\s+LAST BUY/);
  expect(frame).toMatch(/NWBI\s+Northwind Biol…\s+78\s+CEO \+2\s+\+12%\s+3\s+\$1\.15M\s+10\/14\/26/);
  // The detail keeps every column while the names fit.
  expect(frame).toMatch(/Li Chen\s+CFO\s+3rd\s+2\.8x\s+\+56%\s+\$354k\s+10\/9\/26/);
  // The keyboard is as before: the arrows move the selection, the detail follows.
  await tui.emitKeypress({ name: "down", sequence: "\u001b[B" }, { trackPropagation: true });
  await settle();
  frame = tui.frame();
  expect(frame).toMatch(/CTSO\s+Role\s+Nth\s+Vs Usual\s+Stake/);
  expect(frame).toMatch(/Ana Rivera\s+CEO\s+4th\s+4\.9x\s+--\s+\$610k/);
});

test("a short pane leaves the insiders out and keeps the rows", async () => {
  await mount(sided, 140, 14);
  expect(tui.frame()).toContain("Northwind Biologics");
  expect(tui.frame()).not.toMatch(/Role\s+Nth\s+Vs Usual\s+Stake/);
});


test("a side or filter whose read fails says so in the body with Retry, never under another query's rows", async () => {
  let pending: { resolve: (payload: InsiderSignalsPayload) => void; reject: (error: Error) => void } | null = null;
  await mount((window, params) => params.side === "sell" || params.cluster
    ? new Promise<InsiderSignalsPayload>((resolve, reject) => { pending = { resolve, reject }; })
    : sided(window, params), 140, 24);
  await tui.clickFrameText("Selling");
  await settle();
  // While Selling loads, Buying's rows stay on screen.
  expect(tui.frame()).toContain("Northwind Biologics");
  await act(async () => { pending!.reject(new Error("Upstream timed out.")); });
  await settle();
  let frame = tui.frame();
  expect(frame).not.toContain("Northwind Biologics");
  expect(frame).toContain("Insider activity unavailable.");
  expect(frame).toContain("Upstream timed out.");
  expect(frame).toContain("Retry");
  // The bar stays above, on Selling.
  expect(frame).toMatch(/Side\s+Buying\s+Selling/);
  expect(frame).toContain("Exited");

  // Retry loads Selling again with the body's spinner, not Buying's rows.
  await tui.clickFrameText("Retry");
  await settle();
  expect(tui.frame()).not.toContain("Northwind Biologics");
  await act(async () => { pending!.resolve({ ...payload(30, SELLING), side: "sell" }); });
  await settle();
  expect(tui.frame()).toContain("Tailspin Toys");

  // A filter fails the same way, and Buying is one click away.
  await tui.clickFrameText("Buying");
  await settle();
  expect(tui.frame()).toContain("Northwind Biologics");
  await tui.clickFrameText("Cluster");
  await settle();
  await act(async () => { pending!.reject(new Error("Upstream timed out.")); });
  await settle();
  frame = tui.frame();
  expect(frame).not.toContain("Northwind Biologics");
  expect(frame).toContain("Upstream timed out.");
  await tui.clickFrameText("Cluster");
  await settle();
  expect(tui.frame()).toContain("Northwind Biologics");
});

test("New and Exited start off on the other side", async () => {
  await mount(sided, 140, 24);
  await tui.clickFrameText("New");
  await settle();
  expect(asked.at(-1)).toEqual({ window: 30, limit: 100, position: "new" });
  await tui.clickFrameText("Selling");
  await settle();
  expect(asked.at(-1)).toEqual({ side: "sell", window: 30, limit: 100 });
  // Never a read of whole stakes sold on the way.
  expect(asked.some((params) => params.position === "exited")).toBe(false);
  expect(tui.frame()).toContain("[ ] Exited");
  // Cluster is not a side's; it stays.
  await tui.clickFrameText("Cluster");
  await settle();
  await tui.clickFrameText("Buying");
  await settle();
  expect(asked.at(-1)).toEqual({ window: 30, limit: 100, cluster: true });
});

test("the terminal bar folds until every control fits, Cap and clear included, and a checkbox never moves it", async () => {
  const query = insiderSignalsQueryFrom({});
  const fit = (width: number, capShown = false, changes: Record<string, unknown> = {}, desktop = false) =>
    insiderSignalsBarFit(width, insiderSignalsQueryFrom({ ...query, ...changes }), { capShown, desktop });
  expect(fit(140)).toEqual({ side: "full", windowInline: true, only: false });
  expect(fit(100)).toEqual({ side: "full", windowInline: false, only: false });
  expect(fit(88)).toEqual({ side: "short", windowInline: false, only: false });
  expect(fit(80)).toEqual({ side: "short", windowInline: false, only: true });
  expect(fit(80, true)).toEqual({ side: "short", windowInline: false, only: true });
  expect(fit(60, true)).toEqual({ side: "menu", windowInline: false, only: true });
  // Ticking a checkbox, or the other side, measures the same.
  for (const width of [60, 80, 88, 95, 100, 110, 140]) {
    for (const capShown of [false, true]) {
      for (const desktop of [false, true]) {
        expect(fit(width, capShown, { cluster: true, position: true, side: "sell" }, desktop)).toEqual(fit(width, capShown, {}, desktop));
      }
    }
  }
  // The desktop's menus take more room around their words, and its choices show full labels: at 640 px,
  // 80 cells, Side folds with Cap shown; with Cap and Clear after two menus nothing more folds, so the bar scrolls.
  expect(fit(120, true, {}, true)).toEqual({ side: "full", windowInline: true, only: false });
  expect(fit(100, true, {}, true)).toEqual({ side: "full", windowInline: false, only: false });
  expect(fit(80, false, {}, true)).toEqual({ side: "short", windowInline: false, only: true });
  expect(fit(80, true, {}, true)).toEqual({ side: "menu", windowInline: false, only: true });

  // At 80 columns every control shows whole with Cap; after two filters Side folds too, and clear shows.
  const capped = async (window: number, params: CloudInsiderSignalsParams) => ({ ...(await sided(window, params)), marketCaps: "stored" as const });
  const bar = () => tui.frame().split("\n")[0]!.trimEnd();
  await mount(capped, 80, 24);
  expect(bar()).toBe(" Side  Buy  Sell   Window 30D  Role All  Min Any  Only Any  Cap All");
  // Only sets both checkboxes' filters: Cluster, then both.
  const only = async (downs: number) => {
    await tui.clickFrameText("Only");
    await settle();
    for (let i = 0; i < downs; i++) await act(async () => { tui.setup().mockInput.pressArrow("down"); });
    await act(async () => { tui.setup().mockInput.pressEnter(); });
    await settle();
  };
  await only(1);
  expect(asked.at(-1)).toEqual({ window: 30, limit: 100, cluster: true });
  expect(bar()).toBe(" Side  Buy  Sell   Window 30D  Role All  Min Any  Only Cluster  Cap All");
  await only(2);
  expect(asked.at(-1)).toEqual({ window: 30, limit: 100, cluster: true, position: "new" });
  expect(bar()).toContain("Only Both");
  insiderSignalsCache.reset();
  seed = { "insider:signals:role": "officers", "insider:signals:minValue": 1_000_000 };
  await mount(capped, 80, 24);
  expect(bar()).toBe(" Side Buy  Window 30D  Role Officers  Min $1M+  Only Any  Cap All  clear");
  expect(asked.at(-1)).toEqual({ window: 30, limit: 100, role: "officers", minValue: 1_000_000 });
});
