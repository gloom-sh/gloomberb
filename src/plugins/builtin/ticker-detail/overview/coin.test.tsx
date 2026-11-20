import { expect, jest, spyOn, test } from "bun:test";
import { act, useState } from "react";
import { apiClient } from "../../../../api-client";
import { ApiRequestError } from "../../../../api-client/errors";
import type { PaneFooterSegment } from "../../../../components/layout/pane/footer/model";
import { createOpenTuiTestHarness } from "../../../../renderers/opentui/test-utils";
import { PaneInViewProvider } from "../../../../state/app/activity";
import { createInitialState } from "../../../../state/app/context";
import { createTestPaneConfig, createTestTicker, TestPaneFrame } from "../../../../test-support/pane";
import { createTestPluginRuntime } from "../../../../test-support/plugin-runtime";
import { Text } from "../../../../ui";
import { CRYPTO_OVERVIEW_REFRESH_MS, cryptoMarketsCache, loadCryptoMarkets } from "../../crypto-board/client";
import { cryptoFixture } from "../../crypto-board/test-fixture";
import { useCoinOverview } from "./coin";
import { buildOverviewStats } from "./model";

const tui = createOpenTuiTestHarness();
const config = createTestPaneConfig("/tmp/coin-overview-test-unused", { instanceId: "des", paneId: "ticker-detail" });
const ticker = createTestTicker("BTC-USD", "Bitcoin", { exchange: "CCC" });

test.each(["cold", "warm", "saved"] as const)("a visible unfocused coin shows figures with a %s board cache", async (cache) => {
  const state = createInitialState(config);
  const runtime = createTestPluginRuntime();
  const board = cryptoFixture();
  board.assets[0]!.maxSupply = 21_000_000;
  const request = spyOn(apiClient, "getCloudCryptoMarkets").mockResolvedValue(board);
  const Overview = ({ focused }: { focused: boolean }) => {
    const coin = useCoinOverview(ticker, null, focused);
    const rows = buildOverviewStats({
      coin: coin ?? undefined, quote: undefined, fundamentals: undefined, quoteCurrency: "USD", baseCurrency: "USD", toBase: (value) => value,
    });
    return <Text>{rows.map(({ label, value }) => `${label} ${value}`).join("\n")}</Text>;
  };
  const { root, setup } = await tui.createRoot({ width: 80, height: 12 });
  const render = (visible: boolean, focused = false) => act(async () => root.render(
    <TestPaneFrame state={state} paneId="des" pluginId="ticker-research" runtime={runtime} width={80} height={12}>
      {() => <PaneInViewProvider value={visible}><Overview focused={focused} /></PaneInViewProvider>}
    </TestPaneFrame>,
  ));

  jest.useFakeTimers({ now: new Date("2026-09-23T12:00:00Z") });
  try {
    if (cache !== "cold") await loadCryptoMarkets();
    request.mockClear();
    if (cache === "warm") jest.advanceTimersByTime(15_000);
    if (cache === "saved") jest.advanceTimersByTime(CRYPTO_OVERVIEW_REFRESH_MS);

    await render(false, true);
    expect(request).not.toHaveBeenCalled();

    await render(true);
    await setup.renderOnce();
    const frame = tui.frame();
    expect(frame).toContain("Market Cap 1.00T USD");
    expect(frame).toContain("Circ Supply 10B");
    expect(frame).toContain("Max Supply 21M");
    expect(frame).toContain("Rank #1");
    expect(frame.includes("saved copy from")).toBe(cache === "saved");
    const expectedRequests = cache === "cold" ? 1 : 0;
    expect(request).toHaveBeenCalledTimes(expectedRequests);

    await act(async () => { jest.advanceTimersByTime(CRYPTO_OVERVIEW_REFRESH_MS * 2); });
    await render(false, true);
    await act(async () => { jest.advanceTimersByTime(CRYPTO_OVERVIEW_REFRESH_MS * 2); });
    await render(true);
    expect(request).toHaveBeenCalledTimes(expectedRequests);
  } finally {
    await tui.destroy();
    jest.useRealTimers();
    request.mockRestore();
    cryptoMarketsCache.reset();
  }
});

test("a focused coin reuses a warm CRYP board and shows only failure or saved-copy status", async () => {
  const state = createInitialState(config);
  const runtime = createTestPluginRuntime();
  let status: PaneFooterSegment[] = [];
  let setFocused = (_focused: boolean) => {};
  let failing = true;
  const request = spyOn(apiClient, "getCloudCryptoMarkets").mockImplementation(async () => {
    if (failing) throw new ApiRequestError("Unavailable", 503);
    return cryptoFixture();
  });
  const Overview = () => {
    const [focused, changeFocus] = useState(false);
    setFocused = changeFocus;
    const coin = useCoinOverview(ticker, null, focused);
    return <Text>{coin?.name ?? "No coin figures"}</Text>;
  };
  const { root } = await tui.createRoot({ width: 80, height: 12 });
  const render = () => act(async () => root.render(
    <TestPaneFrame state={state} paneId="des" pluginId="ticker-research" runtime={runtime} width={80} height={12}>
      {(_, footer) => {
        status = footer.info;
        return <Overview />;
      }}
    </TestPaneFrame>,
  ));
  const advance = async (ms: number) => {
    await act(async () => { jest.advanceTimersByTime(ms); });
  };

  jest.useFakeTimers({ now: new Date("2026-09-23T13:00:00Z") });
  try {
    await render();
    expect(request).toHaveBeenCalledTimes(1);
    await act(async () => setFocused(true));
    expect(request).toHaveBeenCalledTimes(1);
    expect(status.flatMap(({ parts }) => parts)).toEqual([{ text: "Couldn't refresh", tone: "warning" }]);

    failing = false;
    for (let tick = 0; tick < 4; tick += 1) {
      await advance(15_000);
      await loadCryptoMarkets();
    }
    expect(request).toHaveBeenCalledTimes(5);
    await advance(CRYPTO_OVERVIEW_REFRESH_MS - 60_000);
    expect(request).toHaveBeenCalledTimes(5);
    expect(status).toEqual([]);

    failing = true;
    await advance(CRYPTO_OVERVIEW_REFRESH_MS - 1);
    expect(request).toHaveBeenCalledTimes(5);
    await advance(1);
    expect(request).toHaveBeenCalledTimes(6);
    expect(status).toHaveLength(1);
    expect(status[0]!.parts[0]).toMatchObject({ text: expect.stringContaining("saved copy"), tone: "warning" });

    await act(async () => setFocused(false));
    await advance(CRYPTO_OVERVIEW_REFRESH_MS * 2);
    expect(request).toHaveBeenCalledTimes(6);
  } finally {
    await tui.destroy();
    jest.useRealTimers();
    request.mockRestore();
    cryptoMarketsCache.reset();
  }
});
