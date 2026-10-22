import { afterEach, expect, spyOn, test } from "bun:test";
import { act, useReducer } from "react";
import { apiClient } from "../../../api-client";
import { createOpenTuiTestHarness, settleFrame, takeSavedTextFile } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState } from "../../../state/app/context";
import { exportPaneTable } from "../../../state/pane-table-export-registry";
import { createTestPaneConfig, TestPaneProvider } from "../../../test-support/pane";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { MarketDataCoordinator, setSharedMarketDataCoordinator } from "../../../market-data/coordinator";
import { AssetDataRouter } from "../../../sources/provider-router";
import type { QuoteSubscriptionTarget } from "../../../types/data-provider";
import { cryptoMarketsCache, DEFI_TVL_CACHES, STABLECOIN_SUPPLY_CACHES } from "./client";
import { CryptoBoardPane } from "./pane";
import { cryptoFixture, defiTvlFixture, stablecoinSupplyFixture } from "./test-fixture";

const tui = createOpenTuiTestHarness();
let restore: (() => void) | undefined;
let coordinator: MarketDataCoordinator | undefined;
afterEach(() => {
  setSharedMarketDataCoordinator(null);
  coordinator?.destroy();
  coordinator = undefined;
  restore?.();
  restore = undefined;
  cryptoMarketsCache.reset();
  for (const cache of [...STABLECOIN_SUPPLY_CACHES, ...DEFI_TVL_CACHES]) cache.reset();
});

async function mountPane(width = 130, height = 20) {
  const config = createTestPaneConfig("/tmp/crypto-pane-test-unused", {
    instanceId: "cryp",
    paneId: "crypto-board",
  });
  const state = createInitialState(config);
  state.focusedPaneId = "cryp";
  function Harness() {
    const [current, dispatch] = useReducer(appReducer, state);
    return (
      <TestPaneProvider state={current} dispatch={dispatch} paneId="cryp" pluginId="market-overview" runtime={createTestPluginRuntime()}>
        <CryptoBoardPane paneId="cryp" paneType="crypto-board" width={width} height={height} focused />
      </TestPaneProvider>
    );
  }
  await act(async () => {
    await tui.render(<Harness />, { width, height });
  });
  await settleFrame(tui.setup(), 10);
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
  await settleFrame(tui.setup(), 6);
  const frame = tui.frame();
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
  const supply = spyOn(apiClient, "getCloudStablecoinSupply").mockImplementation(async () => stablecoinSupplyFixture());
  restore = () => {
    query.mockRestore();
    supply.mockRestore();
  };
  await mountPane();
  const frame = tui.frame();
  expect(frame).toContain("Coins");
  expect(frame).toContain("Bitcoin");
  expect(frame).toContain("HYPE");
  expect(frame).not.toContain("USDT");
  expect(frame).not.toMatch(/gloom cloud|utc day/i);

  await exportPaneTable("cryp", "coins.csv");
  const csv = takeSavedTextFile()!.text;
  expect(csv).toContain("BTC");
  expect(csv).toContain(",2.04,");
  expect(csv).toContain(",1000000000000");

  await tui.emitKeypress({ name: "l" });
  await settleFrame(tui.setup(), 8);
  expect(tui.frame()).toContain("Tether USDt");

  await tui.emitKeypress({ name: "h" });
  await settleFrame(tui.setup(), 8);
  fail = true;
  await tui.emitKeypress({ name: "r" });
  await settleFrame(tui.setup(), 10);
  await exportPaneTable("cryp", "retained.csv");
  expect(takeSavedTextFile()!.text).toBe(csv);
  expect(query).toHaveBeenCalledTimes(2);
});

function mockBoard(supply: () => Promise<ReturnType<typeof stablecoinSupplyFixture>>) {
  const query = spyOn(apiClient, "getCloudCryptoMarkets").mockImplementation(async () => cryptoFixture());
  const supplyQuery = spyOn(apiClient, "getCloudStablecoinSupply").mockImplementation(supply);
  restore = () => {
    query.mockRestore();
    supplyQuery.mockRestore();
  };
  return supplyQuery;
}

async function openStablecoins(width = 130) {
  await mountPane(width, 24);
  await tui.emitKeypress({ name: "l" });
  await settleFrame(tui.setup(), 10);
  return tui.frame();
}

test("the stablecoin tab charts supply above its rows, the legend and the table reading one figure", async () => {
  const supply = mockBoard(async () => stablecoinSupplyFixture());
  await mountPane(180, 24);
  // The coin tab never asks for supply.
  expect(supply).not.toHaveBeenCalled();
  await tui.emitKeypress({ name: "l" });
  await settleFrame(tui.setup(), 10);
  const frame = tui.frame();
  expect(frame).toMatch(/Total supply\s+300\.00B/);
  expect(frame).toMatch(/30D change\s+\+1\.80B/);
  // The legend reads each coin's own supply, not the stack's height at it.
  expect(frame).toMatch(/USDT 180\.00B \+ USDC 72\.00B × Other 48\.00B/);
  expect(frame).toMatch(/MCAP\s+SUPPLY\s+SUP 7D%\s+SUP 7D\s+SUP 30D%\s+SUP 30D\s+SHARE/);
  expect(frame).toMatch(/1\s+USDT\s+Tether USDt .*180\.00B\s+180\.00B\s+-0\.33%\s+-600\.00M\s+\+0\.11%\s+\+200\.00M\s+60\.00%/);
});

test("a supply outage leaves the stablecoin board as it is without supply and says the chart is unavailable", async () => {
  mockBoard(async () => {
    throw new Error("Controlled supply outage");
  });
  const frame = await openStablecoins();
  expect(frame).toContain("Tether USDt");
  expect(frame).toContain("MCAP");
  expect(frame).not.toContain("SUPPLY");
  expect(frame).toContain("Stablecoin supply is unavailable right now.");
});

test("the DeFi tab asks for TVL only once shown, dates every figure and its source, and lists chains on a click", async () => {
  const query = spyOn(apiClient, "getCloudCryptoMarkets").mockImplementation(async () => cryptoFixture());
  const defi = spyOn(apiClient, "getCloudDefiTvl").mockImplementation(async () => defiTvlFixture());
  restore = () => {
    query.mockRestore();
    defi.mockRestore();
  };
  await mountPane(150, 26);
  expect(defi).not.toHaveBeenCalled();
  await tui.clickFrameText("DeFi");
  const frame = await tui.waitForFrameToContain("Aave");
  expect(defi).toHaveBeenCalledTimes(1);
  expect(frame).toMatch(/Total DeFi TVL\s+92\.40B\s+as of 2026-09-23/);
  expect(frame).toMatch(/7D change\s+\+2\.01B\s+\+2\.22%/);
  expect(frame).toMatch(/Source\s+DefiLlama\s+daily since 2026-09-19/);
  // Protocols are the source's latest read, not the day's close.
  expect(frame).toContain("as of 2026-09-22 16:17 UTC");
  expect(frame).toMatch(/1\s+Aave\s+Lending\s+17\.88B/);

  await tui.clickFrameText("Chains");
  const chains = await tui.waitForFrameToContain("Ethereum");
  expect(chains).toMatch(/CHAIN\s+TOKEN\s+TVL/);
  expect(chains).toMatch(/1\s+Ethereum\s+ETH\s+55\.40B/);
  expect(chains).not.toContain("16:17 UTC");
});
