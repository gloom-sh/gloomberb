import { act, useReducer, type Dispatch } from "react";
import { afterEach, expect, test } from "bun:test";
import { MarketDataCoordinator, setSharedMarketDataCoordinator } from "../../../market-data/coordinator";
import { AssetDataRouter } from "../../../sources/provider-router";
import { createTestDataProvider } from "../../../test-support/data-provider";
import type { QuoteSubscriptionTarget } from "../../../types/data-provider";
import { setCloudApiFetchTransport } from "../../../api-client";
import type { PerpBoardPayload, PerpRankingsPayload } from "../../../api-client/perps";
import { PaneFooterBar, PaneFooterKeys, PaneFooterProvider } from "../../../components/layout/pane/footer";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState, type AppAction, type AppState } from "../../../state/app/context";
import { createTestPaneConfig, TestPaneProvider } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import type { PaneInstanceConfig } from "../../../types/config";
import { Box } from "../../../ui";
import { perpsCache, perpsHistoryCache, perpsMarketCache, perpsRankingsCache } from "./client";
import { perpsInstance } from "./index";
import { PerpsPane } from "./pane";
import { equityBoard, longShort, perpBoard, perpHistory, perpRankings, perpRow, venueRow } from "./test-fixture";
const tui = createOpenTuiTestHarness();
let coordinator: MarketDataCoordinator | null = null;
const reset = () => {
  setCloudApiFetchTransport(null); perpsCache.reset(); perpsHistoryCache.reset(); perpsMarketCache.reset(); perpsRankingsCache.reset();
  setSharedMarketDataCoordinator(null); coordinator?.destroy(); coordinator = null;
};
afterEach(reset);
/** A second pane in the same test starts from empty caches. */
async function remount() { await tui.destroy(); reset(); }
/** The mounted app state and its dispatch, for a test that changes the instance the way the app does. */
let app: { state: AppState; dispatch: Dispatch<AppAction> } | null = null;
async function mount(settings: Record<string, unknown>, instance: Partial<PaneInstanceConfig> = {}, runtime = createTestPluginRuntime(), width = 110) {
  const id = instance.instanceId ?? "perps:test";
  const state = createInitialState(createTestPaneConfig("/tmp/perps-pane-test", { paneId: "perps", instanceId: id, settings, ...instance }));
  function Harness() {
    const [current, dispatch] = useReducer(appReducer, state);
    app = { state: current, dispatch };
    return <TestPaneProvider state={current} dispatch={dispatch} paneId={id} pluginId="market-overview" runtime={runtime}>
      <PaneFooterProvider>{(footer) => <Box width={width} height={25} flexDirection="column"><Box height={24}><PerpsPane width={width} height={24} focused /></Box><PaneFooterBar footer={footer} width={width} focused /><PaneFooterKeys paneId={id} footer={footer} focused /></Box>}</PaneFooterProvider>
    </TestPaneProvider>;
  }
  await act(async () => { await tui.render(<Harness />, { width, height: 25 }); });
}
/** Answers each perpetuals route from its own payload and records every request. */
function serve({ board = perpBoard(), rankings = perpRankings(), compare = perpBoard() }: { board?: PerpBoardPayload; rankings?: PerpRankingsPayload; compare?: PerpBoardPayload } = {}) {
  const calls: string[] = [];
  setCloudApiFetchTransport(async (input) => {
    const url = decodeURIComponent(String(input));
    calls.push(url);
    if (url.includes("/history")) return Response.json(perpHistory({ marketId: url.split("marketId=")[1]!.split("&")[0]!, locked: board.access === "preview", access: board.access }));
    if (url.includes("/market?")) {
      const marketId = url.split("marketId=")[1]!.split("&")[0]!;
      return Response.json({ ...board, rows: [...board.rows, ...compare.rows].filter((row) => row.marketId === marketId).slice(0, 1), evidence: [], methodologyUrl: "https://gloom.sh/docs/perpetuals" });
    }
    return Response.json(url.includes("/rankings") ? rankings : url.includes("/compare") ? compare : board);
  });
  return calls;
}

test("no market opens the board in its preview; a named market still opens its history", async () => {
  serve({ board: perpBoard({ access: "preview", locked: 2501, rows: [perpRow(), venueRow("bybit")] }) });
  await mount({ market: "" });
  const board = await tui.waitForFrameToContain("Upgrade for 2,501 more markets");
  expect(board).toContain("Bybit");
  expect(board).toContain("Hyperliquid");
  expect(board).not.toContain("NaN");
  await remount();
  serve({ board: perpBoard({ access: "preview", locked: 5, sources: ["hyperliquid", "binance"].map((source) => ({ source })) }) });
  await mount({ market: "BTC" });
  const history = await tui.waitForFrameToContain("Full history requires Gloom Pro.");
  expect(history).toContain("Funding / 8h");
  // The lock says what Pro adds, with the venues Gloom Cloud collects.
  expect(history).toContain("Gloom Pro adds Hyperliquid BTC history and every market on 2 venues.");
  expect(history).toContain("Upgrade for full history");
});

test("asking for a market again brings its pane back to that market from the board, and d opens its stock's DES", async () => {
  const stock = equityBoard({ symbol: "AAPL", exchange: "NASDAQ" }).rows[0]!;
  serve({ board: perpBoard({ access: "preview", locked: 5, rows: [perpRow(), stock] }) });
  const opened: Array<[string, string | undefined]> = [];
  const first = perpsInstance(stock.marketId);
  await mount(first.settings!, { instanceId: first.instanceId, params: first.params },
    createTestPluginRuntime({ pinTicker: (symbol, options) => { opened.push([options?.paneType ?? "", symbol]); } }));
  await tui.waitForFrameToContain("Full history requires Gloom Pro.");
  await tui.clickFrameText("Board");
  await tui.waitForFrameToContain("Search markets");
  // A stock's perpetual row pressed again: the workflow finds this pane by its id and stamps the new request on it.
  await Bun.sleep(2);
  const again = perpsInstance(stock.marketId);
  expect(again.instanceId).toBe(first.instanceId!);
  const { state, dispatch } = app!;
  const layout = state.config.layout;
  await act(async () => { dispatch({ type: "SET_CONFIG", config: { ...state.config, layout: { ...layout,
    instances: layout.instances.map((entry) => entry.instanceId === again.instanceId ? { ...entry, params: { ...entry.params, ...again.params } } : entry) } } }); });
  const frame = await tui.waitForFrameToContain("Full history requires Gloom Pro.");
  expect(frame).toContain(stock.marketId);
  expect(frame).not.toContain("Search markets");
  await tui.emitKeypress({ name: "d" });
  // DES of the listing, the way a ticker link opens it: the stock's own research pane comes forward when it is open.
  expect(opened).toEqual([["ticker-research", "AAPL"]]);
});

test("a named market opened on another tab, as `shot PERP <market> --tab evidence` does, stays on that tab", async () => {
  const stock = equityBoard({ symbol: "AAPL", exchange: "NASDAQ" }).rows[0]!;
  serve({ board: perpBoard({ rows: [stock] }) });
  const request = perpsInstance(stock.marketId);
  await mount({ ...request.settings, tab: "evidence" }, { instanceId: request.instanceId, params: request.params });
  expect(await tui.waitForFrameToContain("Funding 8h / APR")).not.toContain("Series");
});

test("free long/short history keeps the row's latest reading beside the same Pro lock as every series", async () => {
  serve({ board: perpBoard({ access: "preview", locked: 5, rows: [venueRow("binance", { longShortRatio: longShort() })] }) });
  await mount({ market: "BTC", metric: "long-short" });
  const frame = await tui.waitForFrameToContain("Full history requires Gloom Pro.");
  expect(frame).toContain("Long accounts");
  expect(frame).toContain("61.83%");
  expect(frame).toContain("1.62");
  expect(frame).toContain("Upgrade for full history");
});

test("the venue filter narrows the board, and Enter opens the chosen venue's contract in History", async () => {
  const calls = serve({ board: perpBoard({ rows: [perpRow(), venueRow("binance"), venueRow("bybit", { fundingRate: 0.0002 })] }) });
  await mount({ market: "", venue: "bybit" });
  const frame = await tui.waitForFrameToContain("+0.02000% /8h");
  expect(frame).not.toContain("Hyperliquid");
  expect(frame).not.toContain("Upgrade");
  await tui.emitKeypress({ name: "return" });
  await tui.waitForFrameToContain("Series");
  expect(calls.some((url) => url.includes("/market?marketId=bybit:BTCUSDT"))).toBe(true);
  expect(calls.some((url) => url.includes("/history?marketId=bybit:BTCUSDT"))).toBe(true);
});

test("rankings read as five sections of at most ten markets, with the preview's lock", async () => {
  const rows = Array.from({ length: 12 }, (_, index) => perpRow({ marketId: `hyperliquid:default:M${index}`, baseAsset: `M${index}`, fundingRate8h: 0.01 - index / 1000 }));
  serve({ rankings: perpRankings({ fundingPositive: rows, premiumDislocations: [venueRow("okx", { premium: -0.0877 })] }) });
  await mount({ market: "", tab: "rankings" });
  const pro = await tui.waitForFrameToContain("Closed-Market Dislocations");
  for (const heading of ["Highest Funding", "Lowest Funding", "OI Surges", "Premium Dislocations"]) expect(pro).toContain(heading);
  expect(pro).toContain("M9 ");
  expect(pro).not.toContain("M10");
  expect(pro).toContain("-8.770%");
  expect(pro).not.toContain("Upgrade");
  await remount();
  serve({ rankings: perpRankings({ access: "preview", locked: true, fundingPositive: rows.slice(0, 3) }) });
  await mount({ market: "", tab: "rankings" });
  expect(await tui.waitForFrameToContain("Upgrade for the full rankings")).toContain("M2 ");
});

test("compare spreads 8h funding between the venues it shows, dates each venue, and one venue shows no spread", async () => {
  serve({ compare: perpBoard({ rows: [venueRow("binance", { fundingRate8h: 0.00003, observedAt: "2026-10-03T23:11:40Z" }), venueRow("bybit", { fundingRate8h: 0.0001 })] }) });
  await mount({ market: "", tab: "compare" });
  // The footer line registers a frame after the rows paint, so wait for it: the spread and the table are on screen by then.
  const two = await tui.waitForFrameToContain("Binance 23:11 · Bybit 23:20 UTC · oldest");
  expect(two).toContain("Funding spread 8h");
  expect(two).toContain("0.0070pp");
  expect(two).toContain("Bybit over Binance");
  // The footer dates each venue by its own row, as `fn PERP` does, and the table keeps when each was observed.
  expect(two).toContain("10-03 23:11");
  await remount();
  serve({ compare: perpBoard({ access: "preview", locked: 3, rows: [perpRow()] }) });
  await mount({ market: "", tab: "compare" });
  const one = await tui.waitForFrameToContain("Upgrade for 3 more contracts");
  expect(one).toContain("Hyperliquid");
  expect(one).not.toContain("Funding spread");
});

test("the APR % column adds no data warning, and a market nothing matches says which to try", async () => {
  // APR's definition is in the CLI report, Evidence and the docs: a ⚠ on every board would not be a data problem.
  serve({ board: perpBoard({ rows: [perpRow(), venueRow("bybit")] }) });
  await mount({ market: "", tab: "board" }, {}, createTestPluginRuntime(), 160);
  const board = await tui.waitForFrameToContain("APR %");
  expect(board).not.toContain("⚠");
  await act(async () => tui.setup().mockInput.pressKey("!"));
  expect(tui.frame()).not.toMatch(/Data warnings|APR = current/);
  await remount();
  serve({ compare: perpBoard({ rows: [venueRow("binance"), venueRow("bybit")] }) });
  await mount({ market: "", tab: "compare" }, {}, createTestPluginRuntime(), 160);
  expect(await tui.waitForFrameToContain("APR %")).not.toContain("⚠");
  await act(async () => tui.setup().mockInput.pressKey("!"));
  expect(tui.frame()).not.toMatch(/Data warnings|APR = current/);
  await remount();
  // A typed name the board does not spell reads as its base asset; one nothing matches names the markets nearest to it.
  const calls = serve({ board: perpBoard({ rows: [venueRow("binance", { marketId: "binance:BZUSDT", symbol: "BZUSDT", baseAsset: "BZ", displayName: "Brent Crude" })] }) });
  await mount({ market: "brentt" });
  const none = await tui.waitForFrameToContain("No market matches.");
  expect(none).toContain("Try BZ.");
  expect(calls.some((url) => url.includes("search=BRENT"))).toBe(true);
});

test("evidence distinguishes source time, raw interval, reference price and retained revision", async () => {
  const board = perpBoard();
  setCloudApiFetchTransport(async (url) => Response.json(String(url).includes("/market?") ? { ...board, evidence: [{ kind: "funding", period_at: board.asOf, received_at: board.asOf, superseded_at: null, fingerprint: "revision-one", payload: {} }], methodologyUrl: "https://gloom.sh/docs/perpetuals" } : board));
  await mount({ tab: "evidence" });
  const frame = await tui.waitForFrameToContain("Funding 8h / APR");
  // The market funds hourly, so its APR is the 1h rate × 24 × 365, as the server computes it (+0.00083% × 24 × 365).
  expect(frame).toContain("+0.0066% / +7.27%  APR = current 1h rate × 24 × 365");
  // A crypto perp has no listed underlying, so the reference-price rows are left out rather than shown as unavailable.
  expect(frame).not.toContain("Underlying last");
  expect(frame).toContain("Source as of");
});

test("the board's footer says live only while every row on screen streams, and otherwise dates them by the oldest price", async () => {
  const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
  // Three markets read by the last pass, the oldest (Binance's ETH) 3 minutes before.
  const rows = [venueRow("binance", { observedAt: at(1) }), venueRow("bybit", { observedAt: at(2) }), venueRow("binance", { symbol: "ETHUSDT", observedAt: at(3) })];
  serve({ board: perpBoard({ access: "preview", locked: 2555, rows }) });
  let subscribed: QuoteSubscriptionTarget[] = [];
  let deliver!: (target: QuoteSubscriptionTarget, quote: Record<string, unknown>) => void;
  coordinator = new MarketDataCoordinator(new AssetDataRouter(createTestDataProvider({
    subscribeQuotes: (targets, onQuote) => { subscribed = targets; deliver = (target, quote) => onQuote(target, quote as never); return () => {}; },
  })));
  setSharedMarketDataCoordinator(coordinator);
  await mount({ market: "", tab: "board" }, {}, createTestPluginRuntime(), 180);
  await tui.waitForFrameToContain("Upgrade for 2,555 more markets");
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
  expect(subscribed.map((target) => target.symbol).sort()).toEqual(["BTCUSDT:BINANCE", "BTCUSDT:BYBIT", "ETHUSDT:BINANCE"]);
  // Nothing streams yet: the minute's read is neither live nor delayed; the line says how old its oldest price is.
  const read = await tui.waitForFrameToContain("UTC · oldest 3 min");
  expect(read).not.toMatch(/delayed|· live/);
  const stream = async (index: number) => {
    const row = { ...rows[index]!, markPrice: 81_000 + index, observedAt: new Date().toISOString() };
    await act(async () => {
      const target = subscribed.find((candidate) => candidate.symbol === `${row.symbol}:${row.venue.toUpperCase()}`)!;
      deliver(target, { symbol: target.symbol, price: row.markPrice, currency: row.quoteCurrency,
        change: 0, changePercent: 0, lastUpdated: Date.now(), dataSource: "live", delivery: "stream", stale: false, instrumentType: "PERP", perpetual: row });
      await new Promise((resolve) => setTimeout(resolve, 520));
    });
  };
  // Two of three stream, as a signed-out board streams 16 of its 21 rows: not live, and as old as the row left, though
  // its venue's newest price streams.
  await stream(0);
  await stream(1);
  const some = await tui.waitForFrameToContain("81,001.00");
  expect(some).toContain("UTC · oldest 3 min");
  expect(some).not.toMatch(/delayed|· live/);
  await stream(2);
  expect(await tui.waitForFrameToContain("oldest 0 min · live")).not.toContain("delayed");
});

test("the board's footer dates the rows on screen, not markets scrolled out of view", async () => {
  const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
  // Thirty markets: the last, below the fold, was read 50 minutes ago (a venue read hourly).
  const rows = Array.from({ length: 30 }, (_, index) => venueRow("binance", { symbol: `C${index}USDT`, observedAt: at(index === 29 ? 50 : 1) }));
  serve({ board: perpBoard({ rows }) });
  await mount({ market: "", tab: "board" }, {}, createTestPluginRuntime(), 180);
  // The pane shows about twenty rows; the footer is as old as they are.
  expect(await tui.waitForFrameToContain("UTC · oldest")).toContain("UTC · oldest 1 min ·");
});
