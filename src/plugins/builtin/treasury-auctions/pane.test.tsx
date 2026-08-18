import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "../../../renderers/opentui/test-utils";
import { AppContext, createInitialState, PaneInstanceProvider } from "../../../state/app/context";
import { createDefaultConfig } from "../../../types/config";
import type { PluginPersistence } from "../../../types/plugin";
import {
  attachTreasuryAuctionsPersistence,
  resetTreasuryAuctionsPersistence,
} from "./cache";
import { TreasuryAuctionsPane } from "./pane";
import type { TreasuryAuction } from "./types";

function auction(overrides: Partial<TreasuryAuction> & { secType: string; securityTerm: string }): TreasuryAuction {
  return {
    id: `${overrides.secType}|${overrides.auctionDate ?? "2026-08-12"}|${overrides.securityTerm}`,
    auctionDate: "2026-08-12",
    highInvestmentRate: null,
    highYield: null,
    avgMedYield: null,
    highPrice: null,
    lowPrice: null,
    avgMedPrice: null,
    bidToCoverRatio: null,
    competitiveAccepted: null,
    indirectAccepted: null,
    primaryDealerAccepted: null,
    totalAccepted: null,
    offeringAmount: null,
    ...overrides,
  };
}

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
    indirectAccepted: 48_000_000_000,
    totalAccepted: 98_725_863_900,
  }),
  auction({
    secType: "Note",
    securityTerm: "10-Year",
    auctionDate: "2026-08-12",
    highYield: 4.683,
    bidToCoverRatio: 2.53,
    indirectAccepted: 32_087_936_000,
    primaryDealerAccepted: 3_597_810_000,
    totalAccepted: 52_623_557_100,
  }),
];

/** Fresh cache so the pane renders without touching the Treasury endpoint. */
function seedCache(): void {
  attachTreasuryAuctionsPersistence({
    getResource: () => ({ value: AUCTIONS, fetchedAt: Date.now(), stale: false }),
    setResource: () => ({ value: AUCTIONS, fetchedAt: Date.now(), stale: false }),
  } as unknown as PluginPersistence);
}

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined;

afterEach(async () => {
  resetTreasuryAuctionsPersistence();
  if (!testSetup) return;
  await act(async () => {
    testSetup!.renderer.destroy();
  });
  testSetup = undefined;
});

function Harness() {
  const state = createInitialState(createDefaultConfig("/tmp/gloomberb-auctions-pane-test"));
  return (
    <AppContext value={{ state, dispatch: () => {} }}>
      <PaneInstanceProvider paneId="treasury-auctions">
        <TreasuryAuctionsPane
          paneId="treasury-auctions"
          paneType="treasury-auctions"
          focused
          width={92}
          height={20}
        />
      </PaneInstanceProvider>
    </AppContext>
  );
}

async function renderSettled() {
  await act(async () => {
    await testSetup!.renderOnce();
    await testSetup!.renderOnce();
  });
}

async function emitKeypress(event: { name?: string; sequence?: string }) {
  await act(async () => {
    testSetup!.renderer.keyInput.emit("keypress", {
      ctrl: false,
      meta: false,
      option: false,
      shift: false,
      eventType: "press",
      repeated: false,
      defaultPrevented: false,
      propagationStopped: false,
      preventDefault: () => {},
      stopPropagation: () => {},
      ...event,
    } as never);
    await testSetup!.renderOnce();
  });
}

describe("TreasuryAuctionsPane", () => {
  test("renders auction metrics and marks announced auctions as pending", async () => {
    seedCache();
    testSetup = await testRender(<Harness />, { width: 92, height: 20 });
    await renderSettled();

    const frame = testSetup.captureCharFrame();
    expect(frame).toContain("13-Week");
    expect(frame).toContain("3.802%");
    expect(frame).toContain("2.86");
    // Indirect share is derived, not reported.
    expect(frame).toContain("48.6%");
    // The 20-Year is announced but has no published results yet.
    expect(frame).toContain("pending");
  });

  test("opens a detail view for the selected auction", async () => {
    seedCache();
    testSetup = await testRender(<Harness />, { width: 92, height: 20 });
    await renderSettled();

    await emitKeypress({ name: "down", sequence: "\u001B[B" });
    await emitKeypress({ name: "enter", sequence: "\r" });
    await renderSettled();

    const detail = testSetup.captureCharFrame();
    expect(detail).toContain("Bill 13-Week");
    expect(detail).toContain("Bid-to-cover");
    expect(detail).toContain("Total accepted");
  });

  test("the filter key narrows the board to one security group", async () => {
    seedCache();
    testSetup = await testRender(<Harness />, { width: 92, height: 20 });
    await renderSettled();

    // all -> bills
    await emitKeypress({ name: "f", sequence: "f" });
    await renderSettled();

    const bills = testSetup.captureCharFrame();
    expect(bills).toContain("13-Week");
    expect(bills).not.toContain("10-Year");
  });
});
