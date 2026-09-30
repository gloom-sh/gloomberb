import { describe, expect, test } from "bun:test";
import { act, useState } from "react";
import { PaneFooterProvider } from "../../../components/layout/pane/footer";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState, type AppAction, type AppState } from "../../../state/app/context";
import { createTestPaneConfig, TestPaneProvider } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { createDefaultConfig } from "../../../types/config";
import type { CdsActivity, CdsSpreadHistory, CdsSpreadHistoryLoader } from "./client";
import { normalizeCdsTrades } from "./model";
import { CdsPane } from "./pane";

const tui = createOpenTuiTestHarness();

const ACTIVITY: CdsActivity = {
  source: "DTCC PPD",
  asOf: "2026-08-25T15:00:00Z",
  // Market-wide: nothing was resolved because nothing was asked for.
  issuer: null,
  trades: normalizeCdsTrades([
    trade("1", "Oracle Corporation", "2026-08-25T10:00:00Z", { reportedSpread: 0.009, spreadNotation: "3" }),
    trade("2", "Oracle Corporation", "2026-08-25T12:00:00Z", { reportedSpread: null }),
    trade("3", "Ford Motor Company", "2026-08-25T11:00:00Z", { reportedSpread: 250, spreadNotation: "4" }),
  ]),
};

function trade(
  id: string,
  issuerName: string,
  executionTimestamp: string,
  overrides: { reportedSpread: number | null; spreadNotation?: string | null },
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
    upfrontAmount: null,
    upfrontCurrency: null,
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
};

async function settle() {
  for (let index = 0; index < 6; index += 1) {
    await act(async () => {
      await Promise.resolve();
      await tui.setup().renderOnce();
    });
  }
}

async function renderPane(options: {
  symbol?: string;
  height?: number;
  loadHistory?: CdsSpreadHistoryLoader;
  activity?: CdsActivity;
} = {}) {
  const { symbol, height = 16, loadHistory = async () => HISTORY, activity = ACTIVITY } = options;
  const paneId = symbol ? `cds:${symbol}` : "cds:market";
  const state = createInitialState(symbol
    ? createTestPaneConfig("/tmp/gloomberb-cds-test", {
      instanceId: paneId, paneId: "cds", binding: { kind: "fixed", symbol },
    })
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
          {() => (
            <CdsPane
              paneId={paneId}
              paneType="cds"
              focused
              width={92}
              height={height}
              loadActivity={async () => activity}
              loadHistory={loadHistory}
            />
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
  test("groups market activity by issuer, keeping the newest available spread", async () => {
    await renderPane();
    const frame = tui.frame();

    // Most active first: numeric notation 4 stays 250bp; decimal notation 3 becomes 90bp.
    const oracle = frame.indexOf("Oracle Corporation");
    const ford = frame.indexOf("Ford Motor Company");
    expect(oracle).toBeGreaterThanOrEqual(0);
    expect(ford).toBeGreaterThan(oracle);
    expect(frame).toContain("90bp");
    expect(frame).toContain("250bp");
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
    // A month back is the Jun 2031 contract; the roll to Dec is not a move.
    expect(frame).not.toContain("1M");
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
    expect(lines.filter((line) => /\d{2}\/\d{2} \d{2}:\d{2}/.test(line))).toHaveLength(3);
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
