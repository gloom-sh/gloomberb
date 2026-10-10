import { act, useReducer } from "react";
import { afterEach, expect, test } from "bun:test";
import { setCloudApiFetchTransport } from "../../../api-client";
import type { PerpBoardPayload, PerpRankingsPayload } from "../../../api-client/perps";
import { PaneFooterBar, PaneFooterKeys, PaneFooterProvider } from "../../../components/layout/pane/footer";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState } from "../../../state/app/context";
import { createTestPaneConfig, TestPaneProvider } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { Box } from "../../../ui";
import { perpsCache, perpsHistoryCache, perpsMarketCache, perpsRankingsCache } from "./client";
import { PerpsPane } from "./pane";
import { longShort, perpBoard, perpHistory, perpRankings, perpRow, venueRow } from "./test-fixture";
const tui = createOpenTuiTestHarness();
const reset = () => { setCloudApiFetchTransport(null); perpsCache.reset(); perpsHistoryCache.reset(); perpsMarketCache.reset(); perpsRankingsCache.reset(); };
afterEach(reset);
/** A second pane in the same test starts from empty caches. */
async function remount() { await tui.destroy(); reset(); }
async function mount(settings: Record<string, unknown>) {
  const id = "perps:test";
  const state = createInitialState(createTestPaneConfig("/tmp/perps-pane-test", { paneId: "perps", instanceId: id, settings }));
  function Harness() {
    const [current, dispatch] = useReducer(appReducer, state);
    return <TestPaneProvider state={current} dispatch={dispatch} paneId={id} pluginId="market-overview" runtime={createTestPluginRuntime()}>
      <PaneFooterProvider>{(footer) => <Box width={110} height={25} flexDirection="column"><Box height={24}><PerpsPane width={110} height={24} focused /></Box><PaneFooterBar footer={footer} width={110} focused /><PaneFooterKeys paneId={id} footer={footer} focused /></Box>}</PaneFooterProvider>
    </TestPaneProvider>;
  }
  await act(async () => { await tui.render(<Harness />, { width: 110, height: 25 }); });
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
  serve({ board: perpBoard({ access: "preview", locked: 5 }) });
  await mount({ market: "BTC" });
  const history = await tui.waitForFrameToContain("Full history requires Gloom Pro.");
  expect(history).toContain("Funding / 8h");
  expect(history).toContain("Upgrade for full history");
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

test("compare spreads 8h funding between the venues it shows, and one venue shows no spread", async () => {
  serve({ compare: perpBoard({ rows: [venueRow("binance", { fundingRate8h: 0.00003 }), venueRow("bybit", { fundingRate8h: 0.0001 })] }) });
  await mount({ market: "", tab: "compare" });
  const two = await tui.waitForFrameToContain("Funding spread 8h");
  expect(two).toContain("0.0070pp");
  expect(two).toContain("Bybit over Binance");
  await remount();
  serve({ compare: perpBoard({ access: "preview", locked: 3, rows: [perpRow()] }) });
  await mount({ market: "", tab: "compare" });
  const one = await tui.waitForFrameToContain("Upgrade for 3 more contracts");
  expect(one).toContain("Hyperliquid");
  expect(one).not.toContain("Funding spread");
});

test("evidence distinguishes source time, raw interval, reference price and retained revision", async () => {
  const board = perpBoard();
  setCloudApiFetchTransport(async (url) => Response.json(String(url).includes("/market?") ? { ...board, evidence: [{ kind: "funding", period_at: board.asOf, received_at: board.asOf, superseded_at: null, fingerprint: "revision-one", payload: {} }], methodologyUrl: "https://gloom.sh/docs/perpetuals" } : board));
  await mount({ tab: "evidence" });
  const frame = await tui.waitForFrameToContain("Funding 8h / APR");
  // A crypto perp has no listed underlying, so the reference-price rows are left out rather than shown as unavailable.
  expect(frame).not.toContain("Underlying last");
  expect(frame).toContain("Source as of");
});
