import { afterEach, expect, test } from "bun:test";
import { act, useState } from "react";
import { setCloudApiFetchTransport } from "../../../api-client";
import type { PerpBoardPayload } from "../../../api-client/perps";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { createInitialState } from "../../../state/app/context";
import { createTestPaneConfig, TestPaneProvider } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { perpsCache } from "./client";
import { PerpEquityRow } from "./equity-row";
import { equityBoard } from "./test-fixture";

const tui = createOpenTuiTestHarness({ width: 60, height: 8 });
afterEach(() => { setCloudApiFetchTransport(null); perpsCache.reset(); });

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
  const state = createInitialState(createTestPaneConfig("/home/vince/.cache/gloom-smoke/perps-listing-identity/test", { paneId: "perps", instanceId: "test" }));
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
  await tui.waitForFrameToContain("NET · XYZ perp");
  await act(async () => { select(london); });
  await tui.renderFrames(1);
  expect(tui.frame()).not.toContain("NET · XYZ perp");
  await act(async () => { select(apple); });
  await tui.renderFrames(1);
  expect(tui.frame()).not.toContain("NET · XYZ perp");
  // A late response for London is also intentionally wrong: both the resource
  // owner and the response identity must prevent it from reaching the screen.
  await act(async () => { pendingLondon.resolve(equityBoard(nyse)); pendingApple.resolve(equityBoard(apple)); });
  await tui.waitForFrameToContain("AAPL · XYZ perp");
  expect(tui.frame()).not.toContain("NET · XYZ perp");
  expect(requests).toEqual([
    "/cloud/perps/equity/NET?identity=listing&exchange=NYSE",
    "/cloud/perps/equity/NET?identity=listing&exchange=LSE",
    "/cloud/perps/equity/AAPL?identity=listing&exchange=NASDAQ",
  ]);
});
