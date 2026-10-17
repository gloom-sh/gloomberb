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
  insiderSignalChipGroups,
  insiderSignalChips,
  insiderSignalChipsFit,
  insiderSignalChipsText,
  formatInsiderStakeChange,
  insiderSignalsCoverageNotice,
  insiderSignalsQueryFrom,
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
function Harness({ width, height }: { width: number; height: number }) {
  const config = createTestPaneConfig(join(tmpdir(), "gloom-insider-signals-test"), { instanceId: PANE_ID, paneId: "insider", title: "Insider Activity" });
  const [current, dispatch] = useReducer(appReducer, config, (initialConfig) => {
    const initial = createInitialState(initialConfig);
    initial.tickers = new Map(ROWS.map((row) => [row.ticker, createTestTicker(row.ticker, row.company)]));
    initial.focusedPaneId = PANE_ID;
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
});

test("ranks companies with the reasons; Enter opens one here and Esc comes back to the same row", async () => {
  await mount(async (window) => payload(window));
  let frame = tui.frame();
  expect(frame).toMatch(/NWBI\s+Northwind Biologics Inc\s+78\s+3 insiders, \$1\.2M in 14 days · CFO raised stake 56%/);
  expect(frame).toMatch(/CTSO\s+Contoso Energy Corp\s+72\s+CEO's 4th buy in 90 days, 4\.9x usual size/);
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

test("a narrow pane keeps the reasons and drops the company, then the counts", () => {
  const ids = (width: number) => buildInsiderSignalColumns(width, ROWS).map((column) => column.id);
  expect(ids(110)).toEqual(["ticker", "company", "score", "why", "insiders", "value", "lastBuy"]);
  expect(ids(80)).toEqual(["ticker", "score", "why", "insiders", "value", "lastBuy"]);
  expect(ids(60)).toEqual(["ticker", "score", "why", "value"]);
  expect(buildInsiderSignalColumns(60, ROWS).find((column) => column.id === "why")!.width).toBeGreaterThanOrEqual(24);
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
      { ...CEO, value: 496_000, buys: 1, lastBuy: "2026-10-01", shares: 40_000, stakeChangePct: 12, newPosition: false, exited: false },
      { ...CFO, value: 354_000, buys: 1, lastBuy: "2026-10-09", shares: 30_000, stakeChangePct: 56, newPosition: false, exited: false },
      { ...DIRECTOR, value: 302_500, buys: 1, lastBuy: "2026-10-14", shares: 25_000, stakeChangePct: null, newPosition: true, exited: false },
    ],
  },
  {
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
  buyers: [{ ...DIRECTOR, value: 4_200_000, buys: 2, lastBuy: "2026-10-13", shares: 80_000, stakeChangePct: -100, newPosition: false, exited: true }],
}];
async function sided(window: number, params: CloudInsiderSignalsParams): Promise<InsiderSignalsPayload> {
  const side = params.side ?? "buy";
  return { ...payload(window, side === "sell" ? SELLING : BUYING), side, marketCaps: "unavailable" };
}

test("why reads as chips' facts: the insiders together first, then each one's role and what they did; dollars stay in their column", () => {
  const text = (row: InsiderSignalRow, side: "buy" | "sell" = "buy") => insiderSignalChipsText(insiderSignalChips(row, side)!);
  expect(text(BUYING[0]!)).toBe("3 insiders · CFO +56%");
  expect(text(BUYING[1]!)).toBe("CEO 4th buy 4.9x usual");
  expect(text(BUYING[2]!)).toBe("Director NEW");
  expect(text(SELLING[0]!, "sell")).toBe("Director EXITED");
  // The cluster leads, whatever its rank, and an insider's facts stay together after their strongest one.
  expect(text({
    ...BUYING[0]!,
    whySignals: [
      { kind: "stake", value: 58, text: "+58%", insider: DIRECTOR },
      { kind: "cluster", value: 2, text: "2 insiders", insider: null },
      { kind: "repeat", value: 2, text: "2nd buy", insider: DIRECTOR },
    ],
  })).toBe("2 insiders · Director +58% 2nd buy");
  // Several insiders without a cluster open with how many; two are named, the detail strip lists the rest.
  expect(text({
    ...BUYING[0]!,
    whySignals: [
      { kind: "stake", value: -18, text: "-18%", insider: CFO },
      { kind: "repeat", value: 2, text: "2nd sale", insider: DIRECTOR },
      { kind: "exited", value: 1, text: "EXITED", insider: CEO },
    ],
  }, "sell")).toBe("3 insiders · CFO -18% · Director 2nd sale");
  // An insider who traded both ways, and a raise above +300% as the holding's multiple, even from a server that says the percent.
  expect(text({
    ...BUYING[1]!,
    whySignals: [
      { kind: "stake", value: 500, text: "+500%", insider: CEO },
      { kind: "both", value: 1, text: "both ways", insider: CEO },
    ],
  })).toBe("CEO 6x stake both ways");
  expect(insiderSignalChips({ ...BUYING[1]!, whySignals: [{ kind: "both", value: 1, text: "both ways", insider: CEO }] }, "sell")![1]).toMatchObject({ tone: "neutral" });
  // A row whose only reason is its dollars names who traded.
  expect(text({ ...BUYING[1]!, whySignals: [{ kind: "size", value: 610_000, text: "$610k", insider: CEO }] })).toBe("CEO");
  expect(text({ ...BUYING[0]!, whySignals: [{ kind: "size", value: 1_152_500, text: "$1.2M", insider: null }] })).toBe("3 insiders");
  // Tones: the side's colour for facts, solid for NEW and EXITED, the accent for a cluster, neutral roles.
  expect(insiderSignalChips(BUYING[0]!, "buy")!.map((chip) => [chip.label, chip.tone, chip.variant])).toEqual([
    ["3 insiders", "accent", "subtle"], ["CFO", "neutral", "subtle"], ["+56%", "positive", "subtle"],
  ]);
  expect(insiderSignalChips(SELLING[0]!, "sell")!.map((chip) => [chip.label, chip.tone, chip.variant])).toEqual([
    ["Director", "neutral", "subtle"], ["EXITED", "negative", "solid"],
  ]);
  // A server without them: the reasons.
  expect(insiderSignalChips(ROWS[0]!, "buy")).toBeNull();
  // A narrow column shows the chips that fit whole, and no role without a fact.
  const chips = insiderSignalChips({
    ...BUYING[0]!,
    whySignals: [
      { kind: "cluster", value: 3, text: "3 insiders", insider: null },
      { kind: "stake", value: 58, text: "+58%", insider: DIRECTOR },
      { kind: "repeat", value: 2, text: "2nd buy", insider: DIRECTOR },
    ],
  }, "buy")!;
  const labels = (width: number) => insiderSignalChipsFit(chips, width).map((chip) => chip.label);
  // "3 insiders" takes 12 cells, then "Director" 12 (two apart: another group), "+58%" 7 and "2nd buy" 10 (one apart).
  expect(labels(41)).toEqual(["3 insiders", "Director", "+58%", "2nd buy"]);
  expect(labels(40)).toEqual(["3 insiders", "Director", "+58%"]);
  expect(labels(31)).toEqual(["3 insiders", "Director", "+58%"]);
  expect(labels(30)).toEqual(["3 insiders"]);
  expect(labels(11)).toEqual([]);
  expect(insiderSignalChipGroups(chips).map((group) => group.map((chip) => chip.label))).toEqual([["3 insiders"], ["Director", "+58%", "2nd buy"]]);
  // A holding's change: a decimal under 1%, the multiple above +300%, nothing said without balances.
  const buyer = SELLING[0]!.buyers[0]!;
  expect([-100, -38.6, -0.36, 0, null, 300, 350, 500, 2415, 70_821.5].map((stakeChangePct) => formatInsiderStakeChange({ ...buyer, exited: false, stakeChangePct })))
    .toEqual(["-100%", "-39%", "-0.4%", "--", "--", "+300%", "4.5x", "6x", "25x", "709x"]);
  expect(formatInsiderStakeChange(buyer)).toBe("EXITED");
});

test("Buying and Selling switch in the query bar, with the side's own words, and the selected company's insiders under the table", async () => {
  await mount(sided, 140, 24);
  let frame = tui.frame();
  expect(frame).toMatch(/NWBI\s+Northwind Biologics Inc\s+78\s+3 insiders · CFO \+56%/);
  expect(frame).toMatch(/BUYERS\s+BOUGHT\s+LAST BUY/i);
  // The first company is selected: its insiders, what each bought and did to their holding.
  expect(frame).toMatch(/NWBI\s+Role\s+Bought\s+Last\s+Stake/);
  expect(frame).toMatch(/Ana Rivera\s+CEO\s+\$496k\s+10\/1\/26\s+\+12%/);
  expect(frame).toMatch(/Ben Okafor\s+Director\s+\$302\.5k\s+10\/14\/26\s+NEW/);

  await tui.clickFrameText("Selling");
  await settle();
  expect(asked.at(-1)).toEqual({ side: "sell", window: 30, limit: 100 });
  frame = tui.frame();
  expect(frame).toMatch(/TRNT\s+Tailspin Toys Inc\s+61\s+Director EXITED/);
  expect(frame).toMatch(/SELLERS\s+SOLD\s+LAST SALE/i);
  expect(frame).toMatch(/Ben Okafor\s+Director\s+\$4\.2M\s+10\/13\/26\s+EXITED/);
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

test("a short pane leaves the insiders out and keeps the rows", async () => {
  await mount(sided, 140, 14);
  expect(tui.frame()).toContain("Northwind Biologics");
  expect(tui.frame()).not.toMatch(/Role\s+Bought\s+Last\s+Stake/);
});
