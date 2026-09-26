import { afterEach, describe, expect, test } from "bun:test";
import { act, useState } from "react";
import { PaneFooterProvider } from "../../../components/layout/pane/footer";
import { testRender } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState, type AppAction, type AppState } from "../../../state/app/context";
import { createTestPaneConfig, TestPaneProvider } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { createDefaultConfig } from "../../../types/config";
import type { CdsActivity, CdsSpreadHistory, CdsSpreadHistoryLoader } from "./client";
import { normalizeCdsTrades } from "./model";
import { CdsPane } from "./pane";

let setup: Awaited<ReturnType<typeof testRender>> | undefined;

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

const loadActivity = async () => ACTIVITY;

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
      await setup!.renderOnce();
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
    setup = await testRender(<Harness />, { width: 92, height });
  });
  await settle();
}

afterEach(async () => {
  if (setup) {
    await act(async () => setup?.renderer.destroy());
    setup = undefined;
  }
});

describe("CdsPane", () => {
  test("groups market activity by issuer, keeping the newest available spread", async () => {
    await renderPane();
    const frame = setup!.captureCharFrame();

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
      setup!.mockInput.pressEnter();
      await setup!.renderOnce();
    });
    await settle();

    const frame = setup!.captureCharFrame();
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
    const frame = setup!.captureCharFrame();
    const lines = frame.split("\n");
    const tableHeader = lines.findIndex((line) => line.includes("TIME UTC"));

    // The resolved company name drives the history, with no second search.
    expect(requested).toEqual(["Oracle Corporation"]);
    expect(frame).toContain("235bp");
    expect(frame).toContain("2026-09-25");
    // A month earlier the level was 222bp.
    expect(frame).toContain("+13bp");
    expect(frame).toContain("181 to 235bp");
    // Axis labels in basis points, and the chart sits between figures and table.
    expect(lines.slice(0, tableHeader).some((line) => /\d+bp\s*$/.test(line.trimEnd()))).toBe(true);
    expect(tableHeader).toBeGreaterThanOrEqual(8);
  });

  test("keeps figures but drops the chart in a short pane", async () => {
    await renderPane({ symbol: "ORCL", height: 12, activity: { ...ACTIVITY, issuer: "Oracle Corporation" } });
    const lines = setup!.captureCharFrame().split("\n");
    const tableHeader = lines.findIndex((line) => line.includes("TIME UTC"));
    expect(lines.join("\n")).toContain("235bp");
    expect(tableHeader).toBeLessThanOrEqual(3);
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
    const frame = setup!.captureCharFrame();
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
      setup!.mockInput.pressEnter();
      await setup!.renderOnce();
    });
    await settle();
    expect(requested).toEqual(["Oracle Corporation"]);
    const frame = setup!.captureCharFrame();
    expect(frame).toContain("5Y spread");
    // The detail title already names the issuer; the figures do not repeat it.
    expect(frame.split("Oracle Corporation").length - 1).toBe(1);
  });
});
