import { afterEach, expect, spyOn, test } from "bun:test";
import { act } from "react";
import { apiClient } from "../../../api-client";
import type { BuybackDay, BuybacksPayload } from "../../../api-client/buybacks";
import { PaneFooterBar, PaneFooterProvider } from "../../../components/layout/pane/footer";
import { createOpenTuiTestHarness, settleFrame } from "../../../renderers/opentui/test-utils";
import { createInitialState } from "../../../state/app/context";
import { TestPaneProvider, createTestPaneConfig, createTestTicker } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { Box } from "../../../ui";
import { buybacksCache } from "./client";
import { BuybacksView } from "./pane";

const tui = createOpenTuiTestHarness();
const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  buybacksCache.reset();
});

const sum = { shares: 0, sharesOnExchange: 0, paidOnExchange: 0, percentOfVolume: 0, days: 0, sessions: 5 };
// Weekdays from 1 Sep 2026; a buy on every third.
const sessions = Array.from({ length: 60 }, (_, index) => new Date(Date.UTC(2026, 8, 1) + index * 86_400_000).toISOString().slice(0, 10))
  .filter((date) => ![0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay())).slice(0, 39);
const bought: BuybackDay[] = sessions.filter((_, index) => index % 3 === 0).map((date) => ({
  date, shares: 238_000, sharesOnExchange: 238_000, paidOnExchange: 100_000_000, currency: "HKD", average: 420, high: 425, low: 415,
  volume: 20_000_000, percentOfVolume: 1.19, venues: [{ venue: "HKEX", shares: 238_000, paid: 100_000_000, currency: "HKD", high: 425, low: 415 }],
  destination: "cancel", mandateUsed: 50_000_000, inBlackout: null,
  filing: { url: `https://www1.hkexnews.hk/listedco/listconews/sehk/${date.replaceAll("-", "")}.pdf`, publishedAt: `${date}T17:30:00+08:00`, revised: false, multiDay: false },
}));
const payload = (access: BuybacksPayload["access"]): BuybacksPayload => {
  const days = access === "preview" ? bought.slice(-10) : bought;
  return {
    symbol: "0700:HKEX", name: "Tencent Holdings Limited", status: "available", asOf: null, asOfSession: sessions.at(-1)!, heldFrom: sessions[0]!,
    access, totalDays: bought.length, previewDays: access === "preview" ? 10 : null, lockedDays: bought.length - days.length, truncated: days.length < bought.length,
    currency: "HKD", mandate: null, shares: null,
    summary: { last5: sum, last20: { ...sum, sessions: 20 }, ytd: sum, lastBuy: bought.at(-1)!.date, state: "paused" },
    blackout: { current: null, next: null, windows: [], daysToNext: null }, otherClasses: [],
    history: sessions.map((date) => ({ date, close: 420, volume: 20_000_000 })), days,
  };
};

async function mount(access: BuybacksPayload["access"]) {
  spies.push(spyOn(apiClient, "getCloudBuybacks").mockImplementation(async () => payload(access)));
  const state = createInitialState(createTestPaneConfig("/tmp/buybacks-pane-test-unused", { instanceId: "bb", paneId: "buybacks" }));
  state.focusedPaneId = "bb";
  state.paneState.bb = { cursorSymbol: "0700:HKEX" };
  state.tickers.set("0700:HKEX", createTestTicker("0700:HKEX", "Tencent", { exchange: "HKEX", currency: "HKD" }));
  await act(async () => {
    await tui.render(<TestPaneProvider state={state} paneId="bb" pluginId="ticker-research" runtime={createTestPluginRuntime()}>
      <PaneFooterProvider>{(footer) => <Box width={120} height={30} flexDirection="column">
        <Box height={29}><BuybacksView width={120} height={29} focused /></Box>
        <PaneFooterBar footer={footer} width={120} focused />
      </Box>}</PaneFooterProvider>
    </TestPaneProvider>, { width: 120, height: 30 });
  });
  await settleFrame(tui.setup(), 10);
  return tui.frame();
}

test("a preview that withholds sessions says so in the footer and lists only the sessions sent", async () => {
  const frame = await mount("preview");
  expect(frame).toContain("Pro preview");
  expect(frame).toContain(bought.at(-1)!.date);
  // The oldest session sent is listed; an older, withheld one is not.
  expect(frame).toContain(bought.at(-10)!.date);
  expect(frame).not.toContain(bought.at(-11)!.date);
});

test("the full history has no preview label", async () => {
  const frame = await mount("full");
  expect(frame).toContain(bought.at(-1)!.date);
  expect(frame).not.toContain("Pro preview");
});
