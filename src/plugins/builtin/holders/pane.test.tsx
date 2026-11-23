import { afterEach, expect, spyOn, test } from "bun:test";
import { act } from "react";
import { apiClient } from "../../../api-client";
import { footerTimeText, PaneFooterBar, PaneFooterProvider } from "../../../components/layout/pane/footer";
import { stampRetrievedAt } from "../../../data/saved-copies";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { createInitialState } from "../../../state/app/context";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { TestPaneProvider, createTestPaneConfig, createTestTicker } from "../../../test-support/pane";
import type { DataProvider } from "../../../types/data-provider";
import type { HolderData } from "../../../types/financials";
import { Box } from "../../../ui";
import { DataServiceUnreachableError } from "../../../utils/network-failure";
import { HoldersView } from "./pane";

const PANE_ID = "holders:FUN";
const WIDTH = 120;
const HEIGHT = 16;
const tui = createOpenTuiTestHarness();
const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => { for (const spy of spies.splice(0)) spy.mockRestore(); });

// The source's short list of FUN's largest holders, two of its ten.
const SHORT_LIST: HolderData = {
  symbol: "FUN", name: "Six Flags Entertainment Corporation", currency: "USD", exchange: "NYSE", asOf: "2026-09-30",
  holders: [
    { ownerType: "institution", name: "Blackrock Inc.", reportDate: "2026-09-30", shares: 15_790_000, value: 174_610_000, percentHeld: 0.1543 },
    { ownerType: "institution", name: "Morgan Stanley", reportDate: "2026-09-30", shares: 6_290_000, value: 69_580_000, percentHeld: 0.0615 },
  ],
};

function Harness({ provider }: { provider: DataProvider }) {
  const config = createTestPaneConfig("/tmp/gloomberb-holders-pane-test", { instanceId: PANE_ID, paneId: "holders", binding: { kind: "fixed", symbol: "FUN" } });
  const state = createInitialState(config);
  state.focusedPaneId = PANE_ID;
  state.tickers = new Map([["FUN", createTestTicker("FUN", "Six Flags", { exchange: "NYSE" })]]);
  return (
    <TestPaneProvider state={state} paneId={PANE_ID} pluginId="holders" runtime={createTestPluginRuntime({ getMarketData: () => provider })}>
      <PaneFooterProvider>{(footer) => (
        <Box flexDirection="column" width={WIDTH} height={HEIGHT}>
          <Box width={WIDTH} height={HEIGHT - 1}><HoldersView width={WIDTH} height={HEIGHT - 1} focused /></Box>
          <PaneFooterBar footer={footer} focused width={WIDTH} />
        </Box>
      )}</PaneFooterProvider>
    </TestPaneProvider>
  );
}

/**
 * Offline, DES Ownership showed the source's short list where the 13F holder
 * index's every filer goes, dated as read when it was drawn, and a hung proxy
 * held it a minute while 13F name lookups waited on a service that had not
 * answered the index.
 */
test("a short list standing in for an index that could not be read says so with its own time, and asks the service nothing more", async () => {
  const readAt = Date.now() - 40 * 60_000;
  const asked: string[] = [];
  spies.push(spyOn(apiClient, "getCloudSec13F").mockImplementation((async (view: string) => {
    asked.push(view);
    throw new DataServiceUnreachableError(Object.assign(new Error("Unable to connect"), { code: "ConnectionRefused" }));
  }) as never));
  // A copy the cache served again, read 40 minutes ago.
  const provider = { id: "test", name: "Test", getHolders: async () => stampRetrievedAt(SHORT_LIST, readAt) } as unknown as DataProvider;
  await act(async () => { await tui.render(<Harness provider={provider} />, { width: WIDTH, height: HEIGHT }); });
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await act(async () => {
      await Bun.sleep(1);
      await tui.setup().renderOnce();
    });
  }
  const frame = tui.frame();
  expect(frame).toContain("Blackrock Inc.");
  expect(frame).toContain(`holder index could not be read; short list from ${footerTimeText(readAt)}`);
  // The index was asked once; no holder's name was looked up on a service that did not answer it.
  expect(asked).toEqual(["ticker-holdings"]);
  expect(frame).not.toContain("13F matching");
});
