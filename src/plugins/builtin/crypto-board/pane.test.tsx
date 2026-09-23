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
import { createTestDataProvider } from "../../../test-support/data-provider";
import { MarketDataCoordinator, setSharedMarketDataCoordinator } from "../../../market-data/coordinator";
import { AssetDataRouter } from "../../../sources/provider-router";
import type { QuoteSubscriptionTarget } from "../../../types/data-provider";
import { cryptoMarketsCache } from "./client";
import { CryptoBoardPane } from "./pane";
import { cryptoFixture } from "./test-fixture";

let setup: Awaited<ReturnType<typeof testRender>> | undefined;
let restore: (() => void) | undefined;
let coordinator: MarketDataCoordinator | undefined;
afterEach(async () => {
  if (setup) await act(async () => setup!.renderer.destroy());
  setup = undefined;
  setSharedMarketDataCoordinator(null);
  coordinator?.destroy();
  coordinator = undefined;
  restore?.();
  restore = undefined;
  cryptoMarketsCache.reset();
});

async function mountPane(width = 130) {
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
        <CryptoBoardPane width={width} height={20} focused />
      </TestPaneProvider>
    );
  }
  await act(async () => {
    setup = await testRender(<Harness />, { width, height: 20 });
  });
  await settleFrame(setup!, 10);
}

test("streamed quotes move the visible rows' price, change, returns and market cap", async () => {
  const query = spyOn(apiClient, "getCloudCryptoMarkets").mockImplementation(async () => cryptoFixture());
  restore = () => query.mockRestore();
  let subscribed: QuoteSubscriptionTarget[] = [];
  let deliver!: (target: QuoteSubscriptionTarget, quote: Record<string, unknown>) => void;
  const provider = new AssetDataRouter(createTestDataProvider({
    subscribeQuotes: (targets, onQuote) => {
      subscribed = targets;
      deliver = (target, quote) => onQuote(target, quote as never);
      return () => {};
    },
  }));
  coordinator = new MarketDataCoordinator(provider);
  setSharedMarketDataCoordinator(coordinator);
  await mountPane();
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
  expect(subscribed.map((target) => `${target.symbol}:${target.exchange}`).sort()).toEqual(["BTC-USD:CCC", "HYPE32196-USD:CCC"]);
  await act(async () => {
    deliver(subscribed.find((target) => target.symbol === "BTC-USD")!, {
      symbol: "BTC-USD",
      price: 110,
      change: 12,
      changePercent: 12.24,
      currency: "USD",
      exchangeName: "CCC",
      marketState: "REGULAR",
      lastUpdated: Date.now(),
      dataSource: "live",
      delivery: "stream",
      stale: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 520));
  });
  await settleFrame(setup!, 6);
  const frame = setup!.captureCharFrame();
  expect(frame).toContain("110");
  expect(frame).toContain("+12.24%");
  expect(frame).toContain("1.10T");
});

test("crypto board lists coins by market cap, switches to stablecoins and keeps rows through a failed refresh", async () => {
  const data = cryptoFixture();
  let fail = false;
  const query = spyOn(apiClient, "getCloudCryptoMarkets").mockImplementation(async () => {
    if (fail) throw new Error("Controlled crypto outage");
    return data;
  });
  restore = () => query.mockRestore();
  await mountPane();
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
  expect(csv).toContain("1.00T");

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
