import { afterEach, expect, spyOn, test } from "bun:test";
import { act, useReducer } from "react";
import { apiClient } from "../../../api-client";
import {
  emitKeypress,
  settleFrame,
  takeSavedTextFile,
  testRender,
} from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState } from "../../../state/app/context";
import { exportPaneTable } from "../../../state/pane-table-export-registry";
import { createTestPaneConfig, TestPaneProvider } from "../../../test-support/pane";
import { cryptoMarketsCache } from "./client";
import { CryptoBoardPane } from "./pane";
import { cryptoFixture } from "./test-fixture";

let setup: Awaited<ReturnType<typeof testRender>> | undefined;
let restore: (() => void) | undefined;
afterEach(async () => {
  if (setup) await act(async () => setup!.renderer.destroy());
  setup = undefined;
  restore?.();
  restore = undefined;
  cryptoMarketsCache.reset();
});

test("crypto board lists coins by market cap, switches to stablecoins and keeps rows through a failed refresh", async () => {
  const data = cryptoFixture();
  let fail = false;
  const query = spyOn(apiClient, "getCloudCryptoMarkets").mockImplementation(async () => {
    if (fail) throw new Error("Controlled crypto outage");
    return data;
  });
  restore = () => query.mockRestore();
  const config = createTestPaneConfig("/tmp/crypto-pane-test-unused", {
    instanceId: "cryp",
    paneId: "crypto-board",
  });
  const state = createInitialState(config);
  state.focusedPaneId = "cryp";
  function Harness() {
    const [current, dispatch] = useReducer(appReducer, state);
    return (
      <TestPaneProvider state={current} dispatch={dispatch} paneId="cryp" pluginId="market-overview" runtime={{}}>
        <CryptoBoardPane width={130} height={20} focused />
      </TestPaneProvider>
    );
  }
  await act(async () => {
    setup = await testRender(<Harness />, { width: 130, height: 20 });
  });
  await settleFrame(setup!, 10);
  const frame = setup!.captureCharFrame();
  expect(frame).toContain("Coins");
  expect(frame).toContain("Bitcoin");
  expect(frame).toContain("HYPE");
  expect(frame).not.toContain("USDT");
  expect(frame).not.toMatch(/alpaca|utc day/i);

  await exportPaneTable("cryp", "coins.csv");
  const csv = takeSavedTextFile()!.text;
  expect(csv).toContain("BTC");
  expect(csv).toContain("+2.04%");
  expect(csv).toContain("1T");

  await emitKeypress(setup!, { name: "l" });
  await settleFrame(setup!, 8);
  expect(setup!.captureCharFrame()).toContain("Tether USDt");

  await emitKeypress(setup!, { name: "h" });
  await settleFrame(setup!, 8);
  fail = true;
  await emitKeypress(setup!, { name: "r" });
  await settleFrame(setup!, 10);
  await exportPaneTable("cryp", "retained.csv");
  expect(takeSavedTextFile()!.text).toBe(csv);
  expect(query).toHaveBeenCalledTimes(2);
});
