import { afterEach, expect, spyOn, test } from "bun:test";
import { act, useReducer, useState } from "react";
import { apiClient } from "../../../api-client";
import {
  testRender,
  settleFrame,
  emitKeypress,
  takeSavedTextFile,
} from "../../../renderers/opentui/test-utils";
import { TestPaneProvider, createTestPaneConfig } from "../../../test-support/pane";
import { appReducer, createInitialState } from "../../../state/app/context";
import { exportPaneTable } from "../../../state/pane-table-export-registry";
import { cryptoBoardCache } from "./client";
import { CryptoBoardPane } from "./pane";
import { cryptoFixture } from "./test-fixture";
let setup: Awaited<ReturnType<typeof testRender>> | undefined;
let restore: (() => void) | undefined;
afterEach(async () => {
  if (setup) await act(async () => setup!.renderer.destroy());
  setup = undefined;
  restore?.();
  restore = undefined;
  cryptoBoardCache.reset();
});
test("crypto board retains dated rows after failed refresh and detail tabs work through narrow-pane navigation", async () => {
  const data = cryptoFixture(),
    asOf = new Date().toISOString();
  data.generatedAt = asOf;
  data.asOf = asOf;
  data.rows[0]!.asOf = asOf;
  data.rows[0]!.price.asOf = asOf;
  data.rows[0]!.dailyChange.asOf = asOf;
  let fail = false;
  const query = spyOn(apiClient, "getCloudCryptoBoard").mockImplementation(async () => {
    if (fail) throw new Error("Controlled crypto outage");
    return data;
  });
  restore = () => query.mockRestore();
  cryptoBoardCache.reset();
  const config = createTestPaneConfig("/tmp/crypto-pane-test-unused", {
    instanceId: "cryp",
    paneId: "crypto-board",
  });
  const state = createInitialState(config);
  state.focusedPaneId = "cryp";
  let resize: (width: number) => void = () => {};
  function Harness() {
    const [width, setWidth] = useState(112);
    resize = setWidth;
    const [current, dispatch] = useReducer(appReducer, state);
    return (
      <TestPaneProvider
        state={current}
        dispatch={dispatch}
        paneId="cryp"
        pluginId="market-overview"
        runtime={{}}
      >
        <CryptoBoardPane width={width} height={25} focused />
      </TestPaneProvider>
    );
  }
  await act(async () => {
    setup = await testRender(<Harness />, { width: 112, height: 25 });
  });
  await settleFrame(setup!, 10);
  expect(setup!.captureCharFrame()).toContain("125.00");
  await exportPaneTable("cryp", "cryp.csv");
  const csv = takeSavedTextFile()!.text;
  expect(csv).toContain("+5.98%");
  expect(csv).toContain("34 BTC");
  await emitKeypress(setup!, { name: "down" });
  await settleFrame(setup!, 3);
  await emitKeypress(setup!, { name: "return" });
  await settleFrame(setup!, 8);
  expect(setup!.captureCharFrame()).toContain("100.00 to 124.00");
  await emitKeypress(setup!, { name: "l" });
  await settleFrame(setup!, 6);
  await act(async () => {
    resize(55);
    setup!.resize(55, 25);
  });
  await settleFrame(setup!, 6);
  await emitKeypress(setup!, { name: "escape" });
  await settleFrame(setup!, 6);
  fail = true;
  await emitKeypress(setup!, { name: "r" });
  await settleFrame(setup!, 10);
  await exportPaneTable("cryp", "retained.csv");
  expect(takeSavedTextFile()!.text).toBe(csv);
  expect(query).toHaveBeenCalledTimes(2);
});
