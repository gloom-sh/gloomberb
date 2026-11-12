import { afterEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { act, useState } from "react";
import { createOpenTuiTestHarness, type TestKeyEvent } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState, type AppAction, type AppState } from "../../../state/app/context";
import { createTestPaneConfig, TestPaneFrame, TestPaneProvider } from "../../../test-support/pane";
import { outage } from "../../../test-support/outage";
import { setHttpFetchTransport } from "../../../utils/http-transport";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import type { PaneInstanceConfig } from "../../../types/config";
import type { PaneTemplateContext, PluginPersistence } from "../../../types/plugin";
import { apiClient } from "../../../api-client";
import { retargetPaneInstance } from "../../../components/command-bar/workflow/pane-reuse";
import { FIXED_INCOME_PANE_ID } from "../fixed-income/model";
import { resetAuctionCurvesForTests } from "./after";
import { treasuryAuctionsModule } from "./index";
import {
  attachTreasuryAuctionsPersistence,
  CACHE_SCHEMA_VERSION,
  DIRECT_CACHE_SCHEMA_VERSION,
  resetTreasuryAuctionsPersistence,
} from "./cache";
import { TreasuryAuctionsPane } from "./pane";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import { auction, RECORDED_NOW, recordedFiscalData, recordedTreasuryDirect } from "./test-fixture";
import type { TreasuryAuction } from "./types";
import type { HkTendersPayload } from "../../../api-client/hk-tenders";
import hkRecording from "./fixtures/hk-tenders-20261108.json";

const AUCTIONS: TreasuryAuction[] = [
  auction({
    secType: "Bond",
    securityTerm: "20-Year",
    auctionDate: "2026-08-19",
    offeringAmount: 16_000_000_000,
  }),
  auction({
    secType: "Bill",
    securityTerm: "13-Week",
    auctionDate: "2026-08-17",
    highInvestmentRate: 3.802,
    bidToCoverRatio: 2.86,
    competitiveAccepted: 80_000_000_000,
    indirectAccepted: 48_000_000_000,
    totalAccepted: 98_725_863_900,
  }),
  auction({
    secType: "Note",
    securityTerm: "10-Year",
    auctionDate: "2026-08-12",
    highYield: 4.683,
    avgMedYield: 4.63,
    bidToCoverRatio: 2.53,
    competitiveAccepted: 41_821_613_600,
    indirectAccepted: 32_087_936_000,
    directAccepted: 6_135_867_600,
    primaryDealerAccepted: 3_597_810_000,
    totalAccepted: 52_623_557_100,
  }),
];

/** Fresh cache so the pane renders without touching the Treasury endpoint. */
function seedCache(): void {
  const record = { value: AUCTIONS, fetchedAt: Date.now(), stale: false,
    staleAt: Date.now() + 60_000, expiresAt: Date.now() + 60_000 };
  attachTreasuryAuctionsPersistence({
    getResource: () => record,
    setResource: () => record,
  } as unknown as PluginPersistence);
}

const tui = createOpenTuiTestHarness();

afterEach(() => {
  resetTreasuryAuctionsPersistence();
  resetAuctionCurvesForTests();
  setHttpFetchTransport(null);
  setSystemTime();
});

const PANE_INSTANCE_ID = "treasury-auctions:test";
const paneRuntime = createTestPluginRuntime();

/** Runs `AUCT <arg>` from the command bar into the harness's pane; set while a harness is mounted. */
let runCommand: (arg: string) => void = () => {};

/** What `AUCT <arg>` makes of the pane `current`: its template's instance, merged into the open one as the command bar does. */
function commandInstance(arg: string, current: PaneInstanceConfig): PaneInstanceConfig {
  const template = treasuryAuctionsModule.paneTemplates!.find((entry) => entry.shortcut?.prefix === "AUCT")!;
  const context = { layout: { instances: [current] } } as unknown as PaneTemplateContext;
  const spec = template.createInstance!(context, { arg });
  if (!spec || spec instanceof Promise) throw new Error("AUCT made no pane");
  return retargetPaneInstance(current, spec) ?? current;
}

function Harness({ height = 20, width = 92, command }: { height?: number; width?: number; command?: string }) {
  // The filter tab and the open auction are pane state, so the harness needs a
  // reducer; filtering dispatches both in the same batch.
  const [paneState, setPaneState] = useState<AppState["paneState"]>({});
  // With a command the pane is the fixed-income workspace's auctions tab, which reads what the command asks.
  const [instance, setInstance] = useState<PaneInstanceConfig>(() => {
    const blank: PaneInstanceConfig = { paneId: command == null ? "treasury-auctions" : FIXED_INCOME_PANE_ID, instanceId: PANE_INSTANCE_ID };
    return command == null ? blank : commandInstance(command, blank);
  });
  runCommand = (arg) => setInstance((current) => commandInstance(arg, current));
  const state = createInitialState(createTestPaneConfig("/tmp/gloomberb-auctions-pane-test", instance));
  state.paneState = paneState;
  const dispatch = (action: AppAction) => setPaneState(
    (current) => appReducer({ ...state, paneState: current }, action).paneState,
  );
  return (
    <TestPaneProvider
      state={state}
      dispatch={dispatch}
      paneId={PANE_INSTANCE_ID}
      pluginId="macro"
      runtime={paneRuntime}
    >
      <TreasuryAuctionsPane
        paneId="treasury-auctions"
        paneType="treasury-auctions"
        focused
        width={width}
        height={height}
      />
    </TestPaneProvider>
  );
}

async function renderSettled() {
  await act(async () => {
    await tui.setup().renderOnce();
    await tui.setup().renderOnce();
  });
}

const emitKeypress = (event: TestKeyEvent) => tui.emitKeypress(event);

describe("TreasuryAuctionsPane", () => {
  test("renders auction metrics, and an announced auction's Rate as Pending", async () => {
    seedCache();
    await tui.render(<Harness />, { width: 92, height: 20 });
    await renderSettled();

    const frame = tui.frame();
    expect(frame).toContain("13-Week");
    expect(frame).toContain("3.802%");
    expect(frame).toContain("2.86");
    // Indirect share is derived, not reported.
    expect(frame).toContain("60.0%");
    // The 10-Year stops out 5.3bp above its median; direct and dealer shares sit beside indirect.
    expect(frame).toContain("5.3bp");
    expect(frame).toContain("14.7%");
    expect(frame).toContain("8.6%");
    // The 20-Year is announced but unpublished: its Rate says so, as its detail does, and its other figures read "—".
    const announced = frame.split("\n").find((line) => line.includes("20-Year"));
    expect(announced).toMatch(/20-Year\s+Pending\s+—/);
  });

  // Fiscal Data's board had stopped at 22 Oct with the week of 19 Oct still without results.
  test("an auction Fiscal Data has no results for reads its results from TreasuryDirect, and the announced ones show", async () => {
    setSystemTime(new Date(RECORDED_NOW));
    const persistence = new MemoryPluginPersistence();
    persistence.seedResource("treasury-auctions", "recent:120", recordedFiscalData(), { sourceKey: "treasury-fiscal-data", schemaVersion: CACHE_SCHEMA_VERSION });
    persistence.seedResource("treasury-auctions", "direct:60", recordedTreasuryDirect(), { sourceKey: "treasury-direct", schemaVersion: DIRECT_CACHE_SCHEMA_VERSION });
    attachTreasuryAuctionsPersistence(persistence);
    // Wide enough for every column, the terms in full.
    await tui.render(<Harness height={60} width={120} />, { width: 120, height: 60 });
    await renderSettled();

    const lines = tui.frame().split("\n");
    const row = (date: string, term: string) => lines.find((line) => line.includes(date) && line.includes(term));
    // Fiscal Data's 22 Oct 5-year TIPS had no results: it reads its real yield, stop-out and bid-to-cover now, and the bond of the 21st its yield.
    expect(row("Oct 22", "5-Year")).toMatch(/TIPS\s+5-Year\s+2\.367%\s+6\.7bp\s+2\.41/);
    expect(row("Oct 21", "19-Year 10-Month")).toMatch(/Bond\s+19-Year 10-Month\s+5\.469%/);
    // The auctions after it, through 5 Nov, are on the board; the ones announced for the next week read Pending.
    expect(row("Nov 5", "4-Week")).toMatch(/Bill\s+4-Week\s+3\.9\d\d%/);
    expect(row("Nov 12", "30-Year")).toMatch(/Bond\s+30-Year\s+Pending/);
    expect(row("Nov 9", "3-Year")).toMatch(/Note\s+3-Year\s+Pending/);
    expect(lines.filter((line) => line.includes("Pending"))).toHaveLength(6);
  });

  test("opens a detail view for the selected auction", async () => {
    seedCache();
    await tui.render(<Harness />, { width: 92, height: 20 });
    await renderSettled();

    await emitKeypress({ name: "down", sequence: "\u001B[B" });
    await emitKeypress({ name: "enter", sequence: "\r" });
    await renderSettled();

    const detail = tui.frame();
    expect(detail).toContain("Bill 13-Week");
    expect(detail).toContain("Bid-to-cover");
    expect(detail).toContain("Total accepted");
  });

  // The saved board said "saved copy from" after the pane's loading and error status, and over a refusal too.
  test("a board a failed refresh left leads the footer with when it was saved; a refusal is the error", async () => {
    const savedAt = Date.now() - 2 * 86_400_000;
    const record = { value: AUCTIONS, fetchedAt: savedAt, stale: true, staleAt: savedAt + 60_000, expiresAt: savedAt + 60_000 };
    attachTreasuryAuctionsPersistence({ getResource: () => record, setResource: () => record } as unknown as PluginPersistence);
    const state = createInitialState(createTestPaneConfig("/tmp/gloomberb-auctions-pane-test", {
      paneId: "treasury-auctions", instanceId: PANE_INSTANCE_ID,
    }));
    const pane = () => (
      <TestPaneFrame state={state} paneId={PANE_INSTANCE_ID} pluginId="macro" runtime={paneRuntime} width={92} height={20}>
        {(body) => <TreasuryAuctionsPane paneId="treasury-auctions" paneType="treasury-auctions" focused {...body} />}
      </TestPaneFrame>
    );
    const footer = () => tui.frame().replace(/\n+$/, "").split("\n").at(-1)!.replace(/^└\s*|┘$/g, "").trim();
    const settle = async () => {
      for (let index = 0; index < 6; index += 1) {
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); await tui.setup().renderOnce(); });
      }
    };

    setHttpFetchTransport(async () => { throw outage(); });
    await tui.render(pane(), { width: 92, height: 20 });
    await settle();
    expect(tui.frame()).toContain("13-Week");
    expect(footer()).toMatch(/^saved copy from \S+ \d+ \d\d:\d\d +\S/);

    setHttpFetchTransport(async () => new Response("not found", { status: 404 }));
    await tui.render(pane(), { width: 92, height: 20 });
    await settle();
    expect(tui.frame()).toContain("Treasury Fiscal Data request failed (404)");
    expect(tui.frame()).not.toContain("saved copy");
  });
});

/** 30 monthly 7-year notes, the last on 28 Oct 2026: each listed one has its 24 before it, and the last bid best. */
const SEVENS = Array.from({ length: 30 }, (_, index) => {
  const auctionDate = new Date(Date.UTC(2024, 4 + index, 28)).toISOString().slice(0, 10);
  const last = index === 29;
  return auction({
    secType: "Note", securityTerm: "7-Year", auctionDate, highYield: 4 + index / 100, avgMedYield: 3.99 + index / 100,
    bidToCoverRatio: last ? 2.9 : 2.4 + (index % 5) / 20, competitiveAccepted: 40e9, indirectAccepted: (last ? 30 : 25 + index % 4) * 1e9,
    primaryDealerAccepted: (last ? 3 : 6 + index % 3) * 1e9, totalAccepted: 44e9,
  });
}).reverse();

/** The 7-year CMT on each weekday from May 2024: it rises faster each day, so a later auction's move after it is larger. */
function sevenYearCurve() {
  const points: Array<{ date: string; value: number }> = [];
  for (let day = Date.UTC(2024, 4, 1), session = 0; day <= Date.UTC(2026, 10, 6); day += 86_400_000) {
    const weekday = new Date(day).getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    points.push({ date: new Date(day).toISOString().slice(0, 10), value: 4 + session * session / 100_000 });
    session += 1;
  }
  return points;
}

describe("TreasuryAuctionsPane after view", () => {
  const seedSevens = (extra: TreasuryAuction[] = []) => {
    const record = { value: [...extra, ...SEVENS], fetchedAt: Date.now(), stale: false, staleAt: Date.now() + 60_000, expiresAt: Date.now() + 60_000 };
    attachTreasuryAuctionsPersistence({ getResource: () => record, setResource: () => record } as unknown as PluginPersistence);
  };
  // A row's date, after the cursor bar the focused table draws beside the selected row; with its year when the rows span two.
  const ROW_DATE = /^[\s▌▀]*([A-Z][a-z]{2} \d+|\d{4}-\d{2}-\d{2})\s/;
  const rowDates = () => tui.frame().split("\n").filter((line) => line.includes("7-Year")).flatMap((line) => line.match(ROW_DATE)?.[1] ?? []);
  /** Waits, up to about two seconds, for the frame to pass `done`: the yield moves arrive after the board. */
  const until = async (done: () => boolean) => {
    for (let attempt = 0; attempt < 80 && !done(); attempt += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        await tui.setup().renderOnce();
      });
    }
  };
  /** The listed dates once they read `dates`. */
  const listedDates = async (dates: string[]) => {
    await until(() => rowDates().join() === dates.join());
    return rowDates();
  };
  const newestRow = () => tui.frame().split("\n").find((line) => line.includes("Oct 28")) ?? "";

  test("the View control shows the after columns, [ and ] sort by them, and the detail reads the percentiles and the yield's moves", async () => {
    // Wide enough for every after column but the CUSIP.
    setSystemTime(new Date("2026-11-07T12:00:00Z"));
    seedSevens();
    const reads: string[] = [];
    spyOn(apiClient, "getCloudCurveHistory").mockImplementation(async (curve, tenor, from) => {
      reads.push(`${curve}:${tenor}:${from}`);
      return { curve: { id: curve }, tenor, points: sevenYearCurve(), checkedAt: null } as never;
    });
    await tui.render(<Harness height={32} width={150} />, { width: 150, height: 32 });
    await renderSettled();
    expect(tui.frame()).not.toContain("B/C PCTL");

    await tui.clickFrameText("After");
    await until(() => tui.frame().includes("B/C PCTL"));
    expect(rowDates()).toEqual(["Oct 28", "Sep 28", "Aug 28", "Jul 28"]);
    // The last auction stopped out 1.0bp over its median like every one before it, bid best of its 25 and took the most indirect
    // (75.0%) and the least dealer; its yield rose 1bp the next session.
    expect(tui.frame()).toMatch(/RATE\s+VS MED\s+MED PCTL\s+B\/C\s+B\/C PCTL\s+INDIRECT\s+IND PCTL\s+DLR PCTL\s+\+1D BP\s+\+5D BP\s+\+20D BP/);
    const percentiles = /7-Year\s+4\.290%\s+1\.0bp\s+50\s+2\.90\s+100\s+75\.0%\s+100\s+0\s+\+1\s/;
    await until(() => percentiles.test(newestRow()));
    expect(newestRow()).toMatch(percentiles);
    expect(reads).toEqual(["us:7Y:2026-07-10"]);

    // [ steps back over the after columns too: date ascending, CUSIP both ways, then +20D largest first, the newest blank last.
    for (let press = 0; press < 4; press += 1) await emitKeypress({ name: "[", sequence: "[" });
    expect(await listedDates(["Sep 28", "Aug 28", "Jul 28", "Oct 28"])).toEqual(["Sep 28", "Aug 28", "Jul 28", "Oct 28"]);

    await emitKeypress({ name: "enter", sequence: "\r" });
    await renderSettled();
    // The newest stays selected: the best bid of its 25, a 1bp rise the next session, and 20 sessions not in yet.
    const detail = tui.frame();
    expect(detail).toMatch(/B\/C percentile\s+100\s/);
    expect(detail).toMatch(/Dealer percentile\s+0\s/);
    expect(detail).toMatch(/7Y yield \+1d\s+\+1bp/);
    expect(detail).toMatch(/7Y yield \+20d\s+—/);

    // Results has no +20D column: the sort goes back to newest first.
    await emitKeypress({ name: "escape", sequence: "\u001B" });
    await renderSettled();
    await tui.clickFrameText("Results");
    await until(() => !tui.frame().includes("B/C PCTL"));
    // (The stub answers every window with the whole board, which Results lists: two years of it, so the dates carry theirs.)
    expect(rowDates().slice(0, 4)).toEqual(["2026-10-28", "2026-09-28", "2026-08-28", "2026-07-28"]);
  });

  // The footer read "[/]search [f]ilter [{}]view": `v` did nothing and `}` left for Cash & Debt; only a click reached After.
  test("v turns the table between Results and After and m between the US and Hong Kong, both in the footer with the sort keys", async () => {
    setSystemTime(new Date("2026-11-07T12:00:00Z"));
    seedSevens();
    spyOn(apiClient, "getCloudCurveHistory").mockImplementation(async (curve, tenor) => (
      { curve: { id: curve }, tenor, points: sevenYearCurve(), checkedAt: null } as never));
    spyOn(apiClient, "getCloudHkTenders").mockImplementation(async () => structuredClone(hkRecording) as HkTendersPayload);
    function Framed() {
      const [paneState, setPaneState] = useState<AppState["paneState"]>({});
      const state = createInitialState(createTestPaneConfig("/tmp/gloomberb-auctions-pane-test", {
        paneId: "treasury-auctions", instanceId: PANE_INSTANCE_ID,
      }));
      state.paneState = paneState;
      const dispatch = (action: AppAction) => setPaneState((current) => appReducer({ ...state, paneState: current }, action).paneState);
      return (
        <TestPaneFrame state={state} dispatch={dispatch} paneId={PANE_INSTANCE_ID} pluginId="macro" runtime={paneRuntime}
          width={150} height={20} footerKeys>
          {(body) => <TreasuryAuctionsPane paneId="treasury-auctions" paneType="treasury-auctions" focused {...body} />}
        </TestPaneFrame>
      );
    }
    const footer = () => tui.frame().replace(/\n+$/, "").split("\n").at(-1)!;
    await tui.render(<Framed />, { width: 150, height: 20 });
    await renderSettled();
    await until(() => tui.frame().includes("7-Year"));
    expect(footer()).toMatch(/\[v\] after\s+\[m\] HK\s+\[\[\]\]sort/);
    expect(tui.frame()).not.toContain("B/C PCTL");

    await emitKeypress({ name: "v", sequence: "v" });
    await until(() => tui.frame().includes("B/C PCTL"));
    expect(tui.frame()).toContain("MED PCTL");
    expect(footer()).toMatch(/\[v\] results/);
    await emitKeypress({ name: "v", sequence: "v" });
    await until(() => !tui.frame().includes("B/C PCTL"));
    expect(footer()).toMatch(/\[v\] after/);

    await emitKeypress({ name: "m", sequence: "m" });
    await until(() => tui.frame().includes("03GB2807001"));
    expect(footer()).toMatch(/\[m\] US\s+\[\[\]\]sort/);
    await emitKeypress({ name: "m", sequence: "m" });
    await until(() => tui.frame().includes("7-Year"));
    expect(tui.frame()).not.toContain("03GB2807001");
  });

  test("a second command into an open pane shows what it asks, not what the first one left", async () => {
    setSystemTime(new Date("2026-11-07T12:00:00Z"));
    seedSevens([auction({ secType: "Bill", securityTerm: "13-Week", auctionDate: "2026-11-02", highInvestmentRate: 3.9, highDiscountRate: 3.8 })]);
    spyOn(apiClient, "getCloudCurveHistory").mockImplementation(async (curve, tenor) => (
      { curve: { id: curve }, tenor, points: sevenYearCurve(), checkedAt: null } as never));
    await tui.render(<Harness height={24} width={150} command="7Y --view after --sort 20d --filter note" />, { width: 150, height: 24 });
    await renderSettled();
    await until(() => tui.frame().includes("B/C PCTL"));
    expect(await listedDates(["Sep 28", "Aug 28", "Jul 28", "Oct 28"])).toEqual(["Sep 28", "Aug 28", "Jul 28", "Oct 28"]);

    // A plain `AUCT` was opening on the after view, sorted by +20D, on the Notes tab: no bill, oldest moves first.
    await act(async () => runCommand(""));
    await renderSettled();
    await until(() => !tui.frame().includes("B/C PCTL"));
    const rows = tui.frame().split("\n").filter((line) => ROW_DATE.test(line));
    expect(rows[0]).toMatch(/2026-11-02\s+Bill\s+13-Week\s+3\.900%/);
    expect(rows.slice(1, 4).map((line) => line.match(ROW_DATE)?.[1])).toEqual(["2026-10-28", "2026-09-28", "2026-08-28"]);
  });
});

describe("TreasuryAuctionsPane Hong Kong", () => {
  test("AUCT HK opens Hong Kong's tenders; the group and Enter work on them, and the Market choice goes back to US", async () => {
    setSystemTime(new Date("2026-11-08T02:00:00Z"));
    seedCache();
    const asked: string[] = [];
    spyOn(apiClient, "getCloudHkTenders").mockImplementation(async (from) => {
      asked.push(from);
      return structuredClone(hkRecording) as HkTendersPayload;
    });
    const settle = async (done: () => boolean) => {
      for (let attempt = 0; attempt < 40 && !done(); attempt += 1) {
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 25));
          await tui.setup().renderOnce();
        });
      }
    };
    const row = (text: string) => tui.frame().split("\n").find((line) => line.includes(text)) ?? "";
    await tui.render(<Harness height={24} command="HK" />, { width: 92, height: 24 });
    await settle(() => tui.frame().includes("03GB2807001"));
    expect(row("Oct 28")).toMatch(/Oct 28\s+EFB\s+3-Month\s+2\.827%\s+2\.46\s+≈HK\$65\.7B/);
    // A re-opening of a 3-year bond maturing in July 2028: what it had left.
    expect(row("03GB2807001")).toMatch(/Oct\s+HKGB\s+1-Year 9-Month\s+1\.401%\s+9\.93\s+RMB750M\s+03GB2807001/);
    expect(tui.frame()).toMatch(/RATE\s+B\/C\s+SIZE\s+ISSUE/);
    expect(asked).toEqual(["2026-07-11"]);

    await tui.clickFrameText("Bonds");
    await settle(() => !tui.frame().includes("Oct 28"));
    expect(tui.frame()).not.toContain("3-Month");
    await emitKeypress({ name: "enter", sequence: "\r" });
    await settle(() => tui.frame().includes("Bid-to-cover"));
    expect(tui.frame()).toContain("Government Bond (RMB) 1-Year 9-Month");
    expect(tui.frame()).toContain("re-opening of a 3-Year issue");
    expect(tui.frame()).toMatch(/Average yield\s+1\.401%/);
    expect(tui.frame()).toContain("Source: HKMA");
    await emitKeypress({ name: "escape", sequence: "\u001B" });
    await settle(() => !tui.frame().includes("Bid-to-cover"));

    await tui.clickFrameText("All");
    await tui.clickFrameText("US");
    await settle(() => tui.frame().includes("13-Week"));
    expect(tui.frame()).toContain("13-Week");
    expect(tui.frame()).not.toContain("03GB2807001");
  });
});
