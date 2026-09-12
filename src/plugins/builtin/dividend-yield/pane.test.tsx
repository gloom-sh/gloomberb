import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createInitialState } from "../../../state/app/context";
import { TestPaneProvider, createTestPaneConfig, createTestTicker } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { PaneFooterProvider, PaneFooterBar } from "../../../components/layout/pane/footer";
import { Box } from "../../../ui";
import { emitKeypress, testRender } from "../../../renderers/opentui/test-utils";
import { setHttpFetchTransport } from "../../../utils/http-transport";
import { DividendYieldPane } from "./pane";

let setup: Awaited<ReturnType<typeof testRender>> | undefined;
afterEach(async () => {
  if (setup) await act(async () => { setup!.renderer.destroy(); });
  setup = undefined;
  setHttpFetchTransport(null);
});

async function frame() {
  for (let i = 0; i < 3; i++) await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await setup!.renderOnce();
  });
  return setup!.captureCharFrame();
}

test.each([48, 80, 120])("native dividend refresh keeps the selected price's time and status reachable at %d columns", async (width) => {
  const sourceTime = Math.floor(Date.now() / 1000);
  const oldTime = sourceTime - 10 * 86_400;
  let priceTime: number | undefined = oldTime;
  let fail = false;
  setHttpFetchTransport(async (url) => {
    if (url.includes("fc.yahoo.com")) return new Response("", { headers: { "set-cookie": "test=fixture" } });
    if (url.includes("getcrumb")) return new Response("fixture");
    if (url.includes("/chart/")) {
      if (fail) throw new Error("Controlled cash source unavailable");
      return Response.json({ chart: { result: [{
        meta: { currency: "USD", exchangeName: "NMS", regularMarketPrice: 100, regularMarketTime: priceTime, dataGranularity: "1mo" },
        timestamp: [sourceTime], indicators: { quote: [{ close: [100] }] },
        events: { dividends: { cash: { date: sourceTime - 86_400, amount: 4 } } },
      }] } });
    }
    return Response.json({ quoteSummary: { result: [] } });
  });
  const id = "income-price-test";
  const state = createInitialState(createTestPaneConfig("/tmp/gloom-dividend-price-test", {
    instanceId: id, paneId: "dividend-yield", binding: { kind: "fixed", symbol: "FUND" },
  }));
  state.tickers.set("FUND", createTestTicker("FUND"));
  await act(async () => {
    setup = await testRender(<TestPaneProvider state={state} paneId={id} pluginId="dividend-yield" runtime={createTestPluginRuntime()}>
      <PaneFooterProvider>{(footer) => <Box width={width} height={24} flexDirection="column">
        <Box height={23} flexShrink={0}><DividendYieldPane focused width={width} height={23} /></Box>
        <PaneFooterBar footer={footer} focused width={width} />
      </Box>}</PaneFooterProvider>
    </TestPaneProvider>, { width, height: 24 });
  });
  const before = await frame();
  expect(before).toContain("4.00%");
  expect(before).toContain(new Date(oldTime * 1000).toISOString());
  expect(before.match(/Stale price/g)).toHaveLength(1);
  expect(before).not.toContain("cash yield may be out of date");

  priceTime = undefined;
  await emitKeypress(setup!, { name: "r", sequence: "r" });
  const missing = await frame();
  expect(missing).toContain("4.00%");
  expect(missing).toContain("Reference price time unavailable");
  expect(missing).not.toContain(new Date(oldTime * 1000).toISOString());

  priceTime = sourceTime;
  await emitKeypress(setup!, { name: "r", sequence: "r" });
  const fresh = await frame();
  expect(fresh).toContain("4.00%");
  expect(fresh).toContain(new Date(sourceTime * 1000).toISOString());
  expect(fresh).not.toContain("Stale price");
  expect(fresh).not.toContain("time unavailable");
  if (width >= 80) expect(fresh).toContain("History fetched");

  fail = true;
  await emitKeypress(setup!, { name: "r", sequence: "r" });
  const failed = await frame();
  expect(failed).toContain("No dividend data found");
  expect(failed).toContain("4.00%"); // Retained cash stays usable while its current failure is explicit.
  expect(failed).not.toContain("Price 20");
});
