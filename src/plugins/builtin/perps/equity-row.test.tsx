import { afterEach, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { act, useState } from "react";
import { setCloudApiFetchTransport } from "../../../api-client";
import type { PerpBoardPayload } from "../../../api-client/perps";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { createInitialState } from "../../../state/app/context";
import { createTestPaneConfig, TestPaneProvider } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { perpsCache, perpsMarketCache } from "./client";
import { PerpEquityRow } from "./equity-row";
import { PerpMarketsSection } from "./markets-section";
import { equityBoard, perpBoard, perpRow, venueRow } from "./test-fixture";
import { createTestQuote } from "../../../test-support/data-provider";

const tui = createOpenTuiTestHarness({ width: 60, height: 8 });
afterEach(() => { setCloudApiFetchTransport(null); perpsCache.reset(); perpsMarketCache.reset(); });

test("switching a saved bare symbol's listing hides cached and late issuer rows before the new request resolves", async () => {
  const nyse = { symbol: "NET", exchange: "NYSE" };
  const london = { symbol: "NET", exchange: "LSE" };
  const apple = { symbol: "AAPL", exchange: "NASDAQ" };
  const pendingLondon = Promise.withResolvers<PerpBoardPayload>();
  const pendingApple = Promise.withResolvers<PerpBoardPayload>();
  const requests: string[] = [];
  setCloudApiFetchTransport(async (input) => {
    const url = new URL(String(input));
    requests.push(url.pathname + url.search);
    if (url.searchParams.get("exchange") === "LSE") return Response.json(await pendingLondon.promise);
    if (url.pathname.endsWith("/AAPL")) return Response.json(await pendingApple.promise);
    return Response.json(equityBoard(nyse));
  });
  const state = createInitialState(createTestPaneConfig(join(homedir(), ".cache/gloom-smoke/perps-listing-identity/test"), { paneId: "perps", instanceId: "test" }));
  const runtime = createTestPluginRuntime();
  let select!: (next: typeof nyse) => void;
  function Harness() {
    const [listing, setListing] = useState(nyse);
    select = setListing;
    return <TestPaneProvider state={state} dispatch={() => {}} paneId="test" pluginId="market-overview" runtime={runtime}>
      <PerpEquityRow symbol={listing.symbol} exchange={listing.exchange} instrumentType="STK" />
    </TestPaneProvider>;
  }
  await tui.render(<Harness />);
  await tui.waitForFrameToContain("NET · Perpetual futures");
  await act(async () => { select(london); });
  await tui.renderFrames(1);
  expect(tui.frame()).not.toContain("NET · Perpetual futures");
  await act(async () => { select(apple); });
  await tui.renderFrames(1);
  expect(tui.frame()).not.toContain("NET · Perpetual futures");
  // A late response for London is also intentionally wrong: both the resource
  // owner and the response identity must prevent it from reaching the screen.
  await act(async () => { pendingLondon.resolve(equityBoard(nyse)); pendingApple.resolve(equityBoard(apple)); });
  await tui.waitForFrameToContain("AAPL · Perpetual futures");
  expect(tui.frame()).not.toContain("NET · Perpetual futures");
  expect(requests).toEqual([
    "/cloud/perps/equity/NET?identity=listing&exchange=NYSE",
    "/cloud/perps/equity/NET?identity=listing&exchange=LSE",
    "/cloud/perps/equity/AAPL?identity=listing&exchange=NASDAQ",
  ]);
});

test("the stock's perpetual reads in plain words, with when it was read and the funding interval spelled out", async () => {
  setCloudApiFetchTransport(async () => Response.json(equityBoard({ symbol: "AAPL", exchange: "NASDAQ" })));
  const state = createInitialState(createTestPaneConfig(join(homedir(), ".cache/gloom-smoke/perps-row-wording/test"), { paneId: "perps", instanceId: "test" }));
  const runtime = createTestPluginRuntime();
  const wide = createOpenTuiTestHarness({ width: 110, height: 4 });
  await wide.render(<TestPaneProvider state={state} dispatch={() => {}} paneId="test" pluginId="market-overview" runtime={runtime}>
    <PerpEquityRow symbol="AAPL" exchange="NASDAQ" instrumentType="STK" />
  </TestPaneProvider>);
  const frame = await wide.waitForFrameToContain("Perpetual futures (24/7 on-chain market)");
  expect(frame).toContain("AAPL · Perpetual futures (24/7 on-chain market)");
  expect(frame).toMatch(/Funding [+-]?[\d.]+% per 8 h/);
  expect(frame).toMatch(/as of .*UTC/);
  expect(frame).not.toContain("XYZ");
  expect(frame).not.toContain("/ 8h");
});

test("a perpetual market's own quote shows its contract: funding and open interest, read as PERP reads one market", async () => {
  const requests: string[] = [];
  const row = venueRow("binance", { symbol: "BZUSDT", marketId: "binance:BZUSDT", baseAsset: "BZ", assetClass: "energy" });
  setCloudApiFetchTransport(async (input) => {
    const url = new URL(String(input));
    requests.push(url.pathname + url.search);
    return Response.json({ ...perpBoard({ rows: [row], access: "preview" }), evidence: [], methodologyUrl: "" });
  });
  const state = createInitialState(createTestPaneConfig(join(homedir(), ".cache/gloom-smoke/perps-own-row/test"), { paneId: "perps", instanceId: "test" }));
  const wide = createOpenTuiTestHarness({ width: 110, height: 4 });
  await wide.render(<TestPaneProvider state={state} dispatch={() => {}} paneId="test" pluginId="market-overview" runtime={createTestPluginRuntime()}>
    <PerpEquityRow symbol="BZUSDT:BINANCE" exchange="BINANCE" instrumentType="PERP" />
  </TestPaneProvider>);
  const frame = await wide.waitForFrameToContain("BZ · Perpetual futures (24/7 Binance market)");
  expect(frame).toMatch(/Funding [+-]?[\d.]+% per 8 h · OI/);
  // The quote above it already shows the mark; a commodity contract has no stock to be compared with.
  expect(frame).not.toContain("vs last");
  expect(requests).toEqual(["/cloud/perps/market?marketId=binance%3ABZUSDT"]);
});

for (const width of [42, 105]) {
  const screen = createOpenTuiTestHarness({ width, height: 12 });
  test(`perpetual marks keep their units, and a displayed stock premium keeps its reference at ${width} columns`, async () => {
    const hk = { symbol: "9988", exchange: "HKEX" };
    const us = { symbol: "AAPL", exchange: "NASDAQ" };
    const stock = (listing: typeof hk, underlying: typeof hk, markPrice: number, underlyingPremium: number) => perpRow({
      marketId: `hyperliquid:xyz:${underlying.symbol}`, dex: "xyz", symbol: `xyz:${underlying.symbol}`, baseAsset: underlying.symbol,
      assetClass: "stocks", quoteCurrency: "USDC", markPrice, underlyingPremium, underlyingSymbol: underlying.symbol,
      underlying: { ...underlying, price: 86.26, currency: "USD", asOf: perpRow().observedAt, marketState: "CLOSED", sourceUrl: "" },
      equityMatch: { listing, underlying, basis: listing.symbol === underlying.symbol ? "listing" : "issuer" },
    });
    const baba = stock(hk, { symbol: "BABA", exchange: "NYSE" }, 89.16, 0.0336);
    const apple = stock(us, us, 250, 0.0123);
    const crypto = venueRow("binance", { baseAsset: "BTC", markPrice: 70123.45, premium: 0.0025 });
    setCloudApiFetchTransport(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/9988")) return Response.json(equityBoard(hk, { rows: [baba] }));
      if (path.endsWith("/AAPL")) return Response.json(equityBoard(us, { rows: [apple] }));
      return Response.json(perpBoard({ rows: [crypto] }));
    });
    const state = createInitialState(createTestPaneConfig(join(homedir(), ".cache/gloom-smoke/perps-row-wording/test"), { paneId: "perps", instanceId: "test" }));
    const runtime = createTestPluginRuntime();
    const withPane = (content: React.ReactNode) => <TestPaneProvider state={state} dispatch={() => {}} paneId="test" pluginId="market-overview" runtime={runtime}>{content}</TestPaneProvider>;
    const quote = createTestQuote({ symbol: "9988", currency: "HKD", price: 87.35, marketState: "REGULAR", dataSource: "live" });
    await screen.render(withPane(<PerpMarketsSection {...hk} instrumentType="STK" quote={quote} width={width} />));
    const hkFrame = await screen.waitForFrameToContain("89.16 USDC");
    if (width > 42) expect(hkFrame).toContain("+3.36% vs BABA USD");
    else expect(hkFrame).not.toContain("+3.36%");
    expect(hkFrame).not.toContain("vs last");

    await screen.render(withPane(<PerpMarketsSection {...us} instrumentType="STK" width={width} />));
    const usFrame = await screen.waitForFrameToContain("250.00 USDC");
    if (width > 42) expect(usFrame).toContain("+1.23% vs AAPL USD");

    await screen.render(withPane(<PerpMarketsSection symbol="BTC-USD" exchange="CCC" instrumentType="CRYPTOCURRENCY" width={width} />));
    const cryptoFrame = await screen.waitForFrameToContain("70,123.45 USDT");
    if (width > 42) expect(cryptoFrame).toContain("+0.25%");

    await screen.render(withPane(<PerpEquityRow {...hk} instrumentType="STK" width={width} />));
    const compact = await screen.waitForFrameToContain("89.16 USDC");
    if (width > 42) expect(compact).toContain("+3.36% vs BABA USD");
    else expect(compact).not.toContain("+3.36%");
  });
}
