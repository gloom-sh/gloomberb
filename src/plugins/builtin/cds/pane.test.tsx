import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { PaneFooterProvider } from "../../../components/layout/pane/footer";
import { testRender } from "../../../renderers/opentui/test-utils";
import { AppContext, createInitialState, PaneInstanceProvider } from "../../../state/app/context";
import { createDefaultConfig } from "../../../types/config";
import type { CdsActivity } from "./client";
import { normalizeCdsTrades } from "./model";
import { CdsPane } from "./pane";

let setup: Awaited<ReturnType<typeof testRender>> | undefined;

const ACTIVITY: CdsActivity = {
  source: "DTCC PPD",
  asOf: "2026-08-25T15:00:00Z",
  trades: normalizeCdsTrades([
    trade("1", "Oracle Corporation", "2026-08-25T10:00:00Z", { reportedSpread: 0.9, spreadNotation: "Percentage" }),
    trade("2", "Oracle Corporation", "2026-08-25T12:00:00Z", { reportedSpread: null }),
    trade("3", "Ford Motor Company", "2026-08-25T11:00:00Z", { reportedSpread: 250, spreadNotation: "BPS" }),
  ]),
};

function trade(
  id: string,
  issuerName: string,
  eventTimestamp: string,
  overrides: { reportedSpread: number | null; spreadNotation?: string | null },
) {
  return {
    disseminationId: id,
    originalDisseminationId: null,
    actionType: "NEWT",
    eventTimestamp,
    executionTimestamp: null,
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
    fixedRate: 1,
    reportedSpread: overrides.reportedSpread,
    spreadNotation: overrides.spreadNotation ?? null,
    upfrontAmount: null,
    upfrontCurrency: null,
  };
}

const loadActivity = async () => ACTIVITY;

async function settle() {
  for (let index = 0; index < 6; index += 1) {
    await act(async () => {
      await Promise.resolve();
      await setup!.renderOnce();
    });
  }
}

async function renderPane() {
  const state = createInitialState(createDefaultConfig("/tmp/gloomberb-cds-test"));
  await act(async () => {
    setup = await testRender(
    <AppContext value={{ state, dispatch: () => {} }}>
      <PaneInstanceProvider paneId="cds:market">
        <PaneFooterProvider>
          {() => (
            <CdsPane
              paneId="cds:market"
              paneType="cds"
              focused
              width={92}
              height={16}
              loadActivity={loadActivity}
            />
          )}
        </PaneFooterProvider>
      </PaneInstanceProvider>
    </AppContext>,
      { width: 92, height: 16 },
    );
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

    // Most active first, and the 250bp report stays 250bp while the percent one becomes 90bp.
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
});
