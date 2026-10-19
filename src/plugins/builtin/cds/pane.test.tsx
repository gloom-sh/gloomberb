import { describe, expect, test } from "bun:test";
import { act, useState } from "react";
import { PaneFooterBar, PaneFooterProvider } from "../../../components/layout/pane/footer";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState, type AppAction, type AppState } from "../../../state/app/context";
import { createTestPaneConfig, TestPaneProvider } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { createDefaultConfig } from "../../../types/config";
import { Box } from "../../../ui";
import type { CdsActivity, CdsSpreadHistory, CdsSpreadHistoryLoader, CdsSpreadLevelsLoader } from "./client";
import { normalizeCdsTrades } from "./model";
import { CdsPane } from "./pane";

const tui = createOpenTuiTestHarness();

const ACTIVITY: CdsActivity = {
  source: "DTCC PPD",
  asOf: "2026-08-25T15:00:00Z",
  // Market-wide: nothing was resolved because nothing was asked for.
  query: null,
  issuer: null,
  days: 5,
  trades: normalizeCdsTrades([
    trade("1", "Oracle Corporation", "2026-08-25T10:00:00Z", { reportedSpread: 0.009, spreadNotation: "3" }),
    // DTCC disseminates "Oracle Corporation" with no direction on the upfront.
    trade("2", "Oracle Corporation", "2026-08-25T12:00:00Z", { reportedSpread: null, upfrontAmount: 762_500 }),
    trade("3", "Ford Motor Company", "2026-08-25T11:00:00Z", { reportedSpread: 250, spreadNotation: "4" }),
  ]),
};

function trade(
  id: string,
  issuerName: string,
  executionTimestamp: string,
  overrides: { reportedSpread: number | null; spreadNotation?: string | null; upfrontAmount?: number },
) {
  return {
    disseminationId: id,
    originalDisseminationId: null,
    actionType: "NEWT",
    eventTimestamp: executionTimestamp,
    executionTimestamp,
    effectiveDate: null,
    expirationDate: null,
    maturityDate: "2031-06-20",
    issuerName,
    underlierId: null,
    underlierIdSource: null,
    upi: null,
    upiFisn: null,
    upiUnderlierName: null,
    notionalAmount: 5_000_000,
    notionalCapped: true,
    notionalCurrency: "USD",
    // Raw DTCC decimal: 0.01 renders as a 100bp coupon.
    fixedRate: 0.01,
    reportedSpread: overrides.reportedSpread,
    spreadNotation: overrides.spreadNotation ?? null,
    upfrontAmount: overrides.upfrontAmount ?? null,
    upfrontCurrency: overrides.upfrontAmount == null ? null : "USD",
  };
}

// Oracle's on-the-run 5Y from the DTCC tape, rolling to the Dec 2031 contract on Sep 21.
const HISTORY: CdsSpreadHistory = {
  issuer: "Oracle Corporation",
  points: [
    ["2026-07-24", 214.6, "2031-06-20"],
    ["2026-08-12", 198, "2031-06-20"],
    ["2026-08-24", 222, "2031-06-20"],
    ["2026-09-11", 181, "2031-06-20"],
    ["2026-09-21", 208, "2031-12-20"],
    ["2026-09-25", 235, "2031-12-20"],
  ].map(([date, spreadBp, maturity]) => ({
    date: date as string, spreadBp: spreadBp as number, prints: 10, reported: 4, maturity: maturity as string,
  })),
  // The server's moves: the month back is the Jun 2031 contract, chained through the roll.
  change1W: 27,
  change1M: 75.4,
  noLevelReason: null,
};

const NO_LINE: CdsSpreadHistory = { issuer: null, points: [], change1W: null, change1M: null, noLevelReason: null };

async function settle() {
  for (let index = 0; index < 6; index += 1) {
    await act(async () => {
      await Promise.resolve();
      await tui.setup().renderOnce();
    });
  }
}

// Each issuer's latest 5Y level, as the list reads them in one request.
const LEVELS: CdsSpreadLevelsLoader = async () => new Map([
  ["oracle", { spreadBp: 235, date: "2026-08-25", change1wBp: 28.1, change1mBp: 75.4 }],
  ["ford motor", { spreadBp: 157, date: "2026-08-24", change1wBp: -0.04, change1mBp: null }],
]);

async function renderPane(options: {
  symbol?: string;
  height?: number;
  loadHistory?: CdsSpreadHistoryLoader;
  loadLevels?: CdsSpreadLevelsLoader;
  activity?: CdsActivity;
  /** Draw the footer bar under the pane, which then gets one row less. */
  footer?: boolean;
  /** The pane's `sort` setting, as `CDS --sort` sets it. */
  sort?: string;
} = {}) {
  const {
    symbol, height = 16, loadHistory = async () => HISTORY, loadLevels = LEVELS, activity = ACTIVITY, footer = false, sort,
  } = options;
  const paneId = symbol ? `cds:${symbol}` : "cds:market";
  const state = createInitialState(symbol
    ? createTestPaneConfig("/tmp/gloomberb-cds-test", {
      instanceId: paneId, paneId: "cds", binding: { kind: "fixed", symbol },
    })
    : sort
      ? createTestPaneConfig("/tmp/gloomberb-cds-test", { instanceId: paneId, paneId: "cds", binding: { kind: "none" }, settings: { sort } })
      : createDefaultConfig("/tmp/gloomberb-cds-test"));
  const runtime = createTestPluginRuntime();
  function Harness() {
    // Selection and the open issuer are pane state, so the harness needs a reducer.
    const [paneState, setPaneState] = useState<AppState["paneState"]>({});
    state.paneState = paneState;
    const dispatch = (action: AppAction) => setPaneState(appReducer(state, action).paneState);
    return (
      <TestPaneProvider state={state} dispatch={dispatch} paneId={paneId} pluginId="macro" runtime={runtime}>
        <PaneFooterProvider>
          {(footerState) => (
            <Box width={92} height={height} flexDirection="column">
              <CdsPane
                paneId={paneId}
                paneType="cds"
                focused
                width={92}
                height={footer ? height - 1 : height}
                loadActivity={async () => activity}
                loadHistory={loadHistory}
                loadLevels={loadLevels}
              />
              {footer ? <PaneFooterBar footer={footerState} focused width={92} /> : null}
            </Box>
          )}
        </PaneFooterProvider>
      </TestPaneProvider>
    );
  }
  await act(async () => {
    await tui.render(<Harness />, { width: 92, height });
  });
  await settle();
}

describe("CdsPane", () => {
  test("lists issuers with their 5Y level, and dates the view by its last trade as fn and shot do", async () => {
    let requests = 0;
    await renderPane({
      footer: true,
      loadLevels: async () => {
        requests += 1;
        return LEVELS();
      },
    });
    const frame = tui.frame();

    // Most active first, each with its 5Y level rather than whatever spread a trade reported.
    const oracle = frame.indexOf("Oracle Corporation");
    const ford = frame.indexOf("Ford Motor Company");
    expect(oracle).toBeGreaterThanOrEqual(0);
    expect(ford).toBeGreaterThan(oracle);
    // One request for the whole list.
    expect(requests).toBe(1);
    expect(frame).toMatch(/5Y SPREAD\s+1W\s+1M/);
    // The moves as the index board prints them; one that rounds to 0.0 reads 0.0bp, none reads --.
    expect(frame).toMatch(/Oracle Corporation\s+2\s+2026-08-25 12:00\s+235bp\s+\+28\.1bp\s+\+75\.4bp/);
    expect(frame).toMatch(/Ford Motor Company\s+1\s+2026-08-25 11:00\s+157bp\s+0\.0bp\s+--/);
    // The last trade, never the fetch time, with its age in days.
    expect(frame).toMatch(/Source: DTCC · last trade 2026-08-25 · lag \d+ days/);
    expect(frame).not.toContain("as of");
  });

  test("still lists issuers, without their 5Y level, when the levels request fails", async () => {
    await renderPane({
      footer: true,
      loadLevels: async () => {
        throw new Error("offline");
      },
    });
    const frame = tui.frame();
    expect(frame).toMatch(/Oracle Corporation\s+2\s+2026-08-25 12:00\s+--\s+--\s+--/);
    expect(frame).toMatch(/Ford Motor Company\s+1\s+2026-08-25 11:00\s+--\s+--\s+--/);
    // The failure is the footer's data warning, not an empty list.
    expect(frame).toContain("⚠");
  });

  test("names the window and the entity a ticker became when it has no trades", async () => {
    await renderPane({
      symbol: "CHTR",
      height: 12,
      activity: { ...ACTIVITY, query: "CHTR", issuer: "CCO Holdings, LLC", trades: [] },
      loadHistory: async () => NO_LINE,
    });
    expect(tui.frame()).toContain("No CDS trades for CCO Holdings, LLC (CHTR) in the last 5 days.");
  });

  test("opens on the order `CDS --sort` set", async () => {
    const levels: CdsSpreadLevelsLoader = async () => new Map([
      ["oracle", { spreadBp: 235, date: "2026-08-25", change1wBp: -12, change1mBp: 75.4 }],
      ["ford motor", { spreadBp: 157, date: "2026-08-24", change1wBp: 3, change1mBp: null }],
    ]);
    // Ford trades less than Oracle but moved wider on the week, so 1W puts it first.
    await renderPane({ sort: "1w", loadLevels: levels });
    let frame = tui.frame();
    expect(frame.indexOf("Ford Motor Company")).toBeLessThan(frame.indexOf("Oracle Corporation"));
    // On 1M Ford has no move and goes last.
    await renderPane({ sort: "1m", loadLevels: levels });
    frame = tui.frame();
    expect(frame.indexOf("Oracle Corporation")).toBeLessThan(frame.indexOf("Ford Motor Company"));
  });

  test("says in the chart's place why a name has no level", async () => {
    await renderPane({
      symbol: "BARC",
      height: 20,
      activity: { ...ACTIVITY, query: "BARC", issuer: "Barclays PLC" },
      loadHistory: async () => ({ ...NO_LINE, issuer: "Barclays PLC", noLevelReason: "upfront-side-unknown" }),
    });
    const frame = tui.frame();
    expect(frame).toContain("5Y level not derivable: DTCC prints carry upfront without payer side");
    expect(frame).toContain("5M+");
  });

  test("opens the selected issuer's trades and shows -- for an unreported spread", async () => {
    await renderPane();
    await act(async () => {
      tui.setup().mockInput.pressEnter();
      await tui.setup().renderOnce();
    });
    await settle();

    const frame = tui.frame();
    expect(frame).toContain("NOTIONAL");
    // Capped notional keeps its "+", and the coupon is shown instead of an implied spread.
    expect(frame).toContain("5M+");
    expect(frame).toContain("100bp");
    expect(frame).toContain("--");
    expect(frame).not.toContain("Ford Motor Company");
    // ISO times, and an upfront with no side: unsigned, under an absolute header.
    expect(frame).toContain("2026-08-25 12:00");
    expect(frame).toContain("ABS UPFRONT");
    expect(frame).toContain("762.5k USD");
    expect(frame).not.toContain("+762.5k");
  });

  test("charts a bound issuer's 5Y spread above its trades", async () => {
    const requested: string[] = [];
    await renderPane({
      symbol: "ORCL",
      height: 26,
      activity: { ...ACTIVITY, issuer: "Oracle Corporation" },
      loadHistory: async (issuer) => {
        requested.push(issuer);
        return HISTORY;
      },
    });
    const frame = tui.frame();
    const lines = frame.split("\n");
    const tableHeader = lines.findIndex((line) => line.includes("TIME UTC"));

    // The resolved company name drives the history, with no second search.
    expect(requested).toEqual(["Oracle Corporation"]);
    expect(frame).toContain("235bp");
    expect(frame).toContain("2026-09-25");
    // A month back is the Jun 2031 contract: the move chains through the roll, as the index board's does.
    expect(frame).toMatch(/1W\s+\+27\.0bp/);
    expect(frame).toMatch(/1M\s+\+75\.4bp/);
    expect(frame).toContain("181 to 235bp");
    // Axis labels in basis points, and the chart sits between figures and table.
    expect(lines.slice(0, tableHeader).some((line) => /\d+bp\s*$/.test(line.trimEnd()))).toBe(true);
    expect(tableHeader).toBeGreaterThanOrEqual(8);
  });

  test("fits the chart into a short pane's spare rows, then gives way to a strip", async () => {
    // Three trades need four rows, so a 12-row pane still has six for the chart.
    await renderPane({ symbol: "ORCL", height: 12, activity: { ...ACTIVITY, issuer: "Oracle Corporation" } });
    let lines = tui.frame().split("\n");
    expect(lines.findIndex((line) => line.includes("TIME UTC"))).toBe(12 - 4);
    expect(lines.some((line) => line.includes("● 5Y spread"))).toBe(true);
    // Nine rows: the figures, then a compact chart in the rows the three trades leave.
    await renderPane({ symbol: "ORCL", height: 9, activity: { ...ACTIVITY, issuer: "Oracle Corporation" } });
    lines = tui.frame().split("\n");
    expect(lines[0]).toContain("235bp");
    expect(lines.some((line) => line.includes("● 5Y spread"))).toBe(true);
    expect(lines.findIndex((line) => line.includes("TIME UTC"))).toBe(9 - 4);
    // Seven rows: too short for any chart, so a one-row strip, then every trade.
    await renderPane({ symbol: "ORCL", height: 7, activity: { ...ACTIVITY, issuer: "Oracle Corporation" } });
    lines = tui.frame().split("\n");
    const tableHeader = lines.findIndex((line) => line.includes("TIME UTC"));
    expect(lines[tableHeader - 1]).toContain("●");
    expect(lines.filter((line) => /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(line))).toHaveLength(3);
  });

  test("still lists trades when the history request fails", async () => {
    await renderPane({
      symbol: "ORCL",
      height: 26,
      activity: { ...ACTIVITY, issuer: "Oracle Corporation" },
      loadHistory: async () => {
        throw new Error("offline");
      },
    });
    const frame = tui.frame();
    expect(frame).toContain("Oracle Corporation");
    expect(frame).toContain("5M+");
    expect(frame).not.toContain("5Y spread");
  });

  test("loads an issuer's history only once its trades are opened", async () => {
    const requested: string[] = [];
    await renderPane({
      height: 26,
      loadHistory: async (issuer) => {
        requested.push(issuer);
        return HISTORY;
      },
    });
    expect(requested).toEqual([]);
    await act(async () => {
      tui.setup().mockInput.pressEnter();
      await tui.setup().renderOnce();
    });
    await settle();
    expect(requested).toEqual(["Oracle Corporation"]);
    const frame = tui.frame();
    expect(frame).toContain("5Y spread");
    // The detail title already names the issuer; the figures do not repeat it.
    expect(frame.split("Oracle Corporation").length - 1).toBe(1);
  });
});
