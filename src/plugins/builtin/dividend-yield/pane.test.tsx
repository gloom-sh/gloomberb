import { afterEach, expect, test } from "bun:test";
import { act, useState } from "react";
import { createInitialState } from "../../../state/app/context";
import { TestPaneProvider, createTestPaneConfig, createTestTicker } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { PaneFooterProvider, PaneFooterBar } from "../../../components/layout/pane/footer";
import { Box } from "../../../ui";
import { emitKeypress, testRender } from "../../../renderers/opentui/test-utils";
import { setHttpFetchTransport } from "../../../utils/http-transport";
import { DividendYieldPane } from "./pane";
import { fetchDividendData } from "./client";

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

test("summary failures retain cash and recover dated payment information through refresh", async () => {
  const day = Math.floor(Date.now() / 86400_000) * 86400;
  const exDate = day + 10 * 86400;
  const payDate = day + 30 * 86400;
  let mode: "valid" | "failed" | "invalid-ex" | "invalid-pay" = "valid";
  let chartRequests = 0;
  setHttpFetchTransport(async (url) => {
    if (url.includes("fc.yahoo.com")) return new Response("", { headers: { "set-cookie": "test=fixture" } });
    if (url.includes("getcrumb")) return new Response("fixture");
    if (url.includes("/chart/")) {
      chartRequests++;
      return Response.json({ chart: { result: [{
        meta: { currency: "USD", regularMarketPrice: 100, regularMarketTime: day, dataGranularity: "1mo" },
        timestamp: [day], indicators: { quote: [{ close: [100] }] },
        events: { dividends: { cash: { date: day - 86400, amount: 4 } } },
      }] } });
    }
    if (url.includes("/quoteSummary/")) {
      if (mode === "failed") throw new Error("Controlled summary unavailable");
      return Response.json({ quoteSummary: { result: [{ summaryDetail: { currency: "USD", dividendRate: { raw: 20 },
        exDividendDate: { raw: mode === "invalid-ex" ? 1e20 : exDate },
        dividendDate: { raw: mode === "invalid-pay" ? 1e20 : payDate },
      } }] } });
    }
    throw new Error(`Unexpected controlled request: ${url}`);
  });
  const id = "dividend-summary-refresh";
  const state = createInitialState(createTestPaneConfig("/tmp/dividend-summary-refresh", {
    instanceId: id, paneId: "dividend-yield", binding: { kind: "fixed", symbol: "INCOME" },
  }));
  state.tickers.set("INCOME", createTestTicker("INCOME"));
  setup = await testRender(<TestPaneProvider state={state} paneId={id} pluginId="dividend-yield" runtime={createTestPluginRuntime()}>
    <PaneFooterProvider>{(footer) => <Box width={80} height={24} flexDirection="column">
      <Box height={23} flexShrink={0}><DividendYieldPane focused width={80} height={23}/></Box>
      <PaneFooterBar footer={footer} focused width={80}/>
    </Box>}</PaneFooterProvider>
  </TestPaneProvider>, { width: 80, height: 24 });
  expect(await frame()).toContain(new Date(payDate * 1000).toISOString().slice(0, 10));
  for (const nextMode of ["failed", "invalid-ex", "invalid-pay", "valid"] as const) {
    mode = nextMode;
    const requestsBefore = chartRequests;
    await emitKeypress(setup!, { name: "r", sequence: "r" });
    const current = await frame();
    expect(chartRequests).toBe(requestsBefore + 1);
    expect(current).toContain("4.00%");
    if (mode === "valid") {
      expect(current).not.toContain("summary");
      expect(current).toContain(new Date(payDate * 1000).toISOString().slice(0, 10));
    } else {
      expect(current.match(/Dividend summary unavailable|Invalid dividend summary date/g)).toHaveLength(1);
      expect(current.trimEnd().split("\n").at(-1)).toContain("summary");
      if (mode !== "failed") expect(current).toContain("$20.00");
    }
  }
});

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

test.each([48, 80, 120])("cash integrity failures preserve usable rows and recover through the existing refresh action at %d columns", async (width) => {
  const day = new Date(new Date().toISOString().slice(0, 10)).getTime() / 1000;
  const recent = day - 10 * 86_400 + 14 * 3600;
  const recentDate = new Date(recent * 1000).toISOString().slice(0, 10);
  let mode: "complete" | "partial" | "invalid" | "empty" | "unknown-currency" = "complete";
  setHttpFetchTransport(async (url) => {
    if (url.includes("fc.yahoo.com")) return new Response("", { headers: { "set-cookie": "test=fixture" } });
    if (url.includes("getcrumb")) return new Response("fixture");
    if (url.includes("/chart/")) {
      const cash = { date: recent, amount: 4 };
      const old = { date: recent - 3 * 365 * 86_400, amount: 1 };
      const invalid = { date: day - 86_400 };
      const dividends = mode === "empty" ? {} : mode === "invalid" ? { invalid }
        : mode === "partial" ? { cash, old, invalid } : { cash, old };
      return Response.json({ chart: { result: [{
        meta: { currency: mode === "unknown-currency" ? undefined : "USD", exchangeTimezoneName: "America/New_York", regularMarketPrice: 100, regularMarketTime: day, dataGranularity: "1mo" },
        timestamp: [day], indicators: { quote: [{ close: [100] }] }, events: { dividends },
      }] } });
    }
    return Response.json({ quoteSummary: { result: [{ summaryDetail: { currency: "USD", dividendRate: { raw: 20 } } }] } });
  });
  const id = "cash-integrity-test";
  const state = createInitialState(createTestPaneConfig("/tmp/gloom-dividend-integrity-test", {
    instanceId: id, paneId: "dividend-yield", binding: { kind: "fixed", symbol: "CASHFUND" },
  }));
  state.tickers.set("CASHFUND", createTestTicker("CASHFUND"));
  await act(async () => {
    setup = await testRender(<TestPaneProvider state={state} paneId={id} pluginId="dividend-yield" runtime={createTestPluginRuntime()}>
      <PaneFooterProvider>{(footer) => <Box width={width} height={24} flexDirection="column">
        <Box height={23} flexShrink={0}><DividendYieldPane focused width={width} height={23} /></Box>
        <PaneFooterBar footer={footer} focused width={width} />
      </Box>}</PaneFooterProvider>
    </TestPaneProvider>, { width, height: 24 });
  });
  const complete = await frame();
  expect(complete).toContain("4.00%");
  expect(complete).toContain("TTM cash/share");
  expect(complete).toContain(recentDate);

  mode = "partial";
  await emitKeypress(setup!, { name: "r", sequence: "r" });
  const partial = await frame();
  expect(partial).toContain(recentDate);
  expect(partial).toContain("$4.00");
  expect(partial).toContain("$20.00");
  expect(partial).not.toContain("4.00%");
  expect(partial).not.toContain("TTM cash/share");
  expect(partial.match(/Incomplete cash history/g)).toHaveLength(1);
  expect(partial.trimEnd().split("\n").at(-1)).toContain("Incomplete cash history");

  mode = "invalid";
  await emitKeypress(setup!, { name: "r", sequence: "r" });
  const invalid = await frame();
  expect(invalid).toContain(recentDate);
  expect(invalid).toContain("Incomplete cash history");
  expect(invalid).not.toContain("4.00%");

  mode = "empty";
  await emitKeypress(setup!, { name: "r", sequence: "r" });
  const empty = await frame();
  expect(empty).toContain("0.00%");
  expect(empty).toContain("No cash distributions reported.");
  expect(empty).not.toContain(recentDate);
  expect(empty).not.toContain("Incomplete cash history");

  mode = "unknown-currency";
  await emitKeypress(setup!, { name: "r", sequence: "r" });
  const unknown = await frame();
  expect(unknown).toContain("Dividend currency is unavailable");
  expect(unknown).not.toContain(recentDate);
  expect(unknown).not.toContain("4.00%");

  mode = "complete";
  await emitKeypress(setup!, { name: "r", sequence: "r" });
  const recovered = await frame();
  expect(recovered).toContain("4.00%");
  expect(recovered).toContain(recentDate);
  expect(recovered).toContain("TTM cash/share");
  expect(recovered).not.toContain("Dividend currency is unavailable");
});

test.each(["invalid", "unknown-currency"] as const)("direct %s integrity failure retains only known cash rows across recovery, empty history and security changes", async (failure) => {
  const width = 80;
  const day = new Date(new Date().toISOString().slice(0, 10)).getTime() / 1000;
  const recent = day - 10 * 86400 + 14 * 3600;
  const recentDate = new Date(recent * 1000).toISOString().slice(0, 10);
  let mode: "complete" | "empty" | "failure" = "complete";
  const cashCurrency = failure === "unknown-currency" ? "GBP" : "USD";
  const cashLabel = cashCurrency === "GBP" ? "£4.00" : "$4.00";
  // The payment row: a round axis tick can share the amount.
  const cashRow = `${cashLabel} ${cashCurrency}`;
  setHttpFetchTransport(async (url) => {
    if (url.includes("fc.yahoo.com")) return new Response("", { headers: { "set-cookie": "test=fixture" } });
    if (url.includes("getcrumb")) return new Response("fixture");
    if (url.includes("/chart/")) {
      const dividends = mode === "empty" ? {} : mode === "failure" && failure === "invalid" ? { invalid: { date: recent } }
        : { cash: { date: recent, amount: url.includes("OTHER") ? 7 : 4 }, old: { date: recent - 3 * 365 * 86400, amount: 1 } };
      return Response.json({ chart: { result: [{ meta: {
        currency: mode === "failure" && failure === "unknown-currency" ? undefined : cashCurrency,
        exchangeTimezoneName: "America/New_York", regularMarketPrice: 100, regularMarketTime: day, dataGranularity: "1mo",
      }, timestamp: [day], indicators: { quote: [{ close: [100] }] }, events: { dividends } }] } });
    }
    return Response.json({ quoteSummary: { result: [{ summaryDetail: { currency: "USD", dividendRate: { raw: 20 } } }] } });
  });
  const runtime = createTestPluginRuntime();
  const loadData = (symbol: string) => fetchDividendData(symbol, 100, "", "USD");
  let changeSymbol!: (symbol: string) => void;
  function Harness() {
    const [symbol, setSymbol] = useState("CASHFUND");
    changeSymbol = setSymbol;
    const id = "cash-direct-integrity";
    const state = createInitialState(createTestPaneConfig("/tmp/gloom-dividend-direct-integrity", {
      instanceId: id, paneId: "dividend-yield", binding: { kind: "fixed", symbol },
    }));
    state.tickers.set(symbol, createTestTicker(symbol));
    return <TestPaneProvider state={state} paneId={id} pluginId="dividend-yield" runtime={runtime}>
      <PaneFooterProvider>{(footer) => <Box width={width} height={24} flexDirection="column">
        <Box height={23} flexShrink={0}><DividendYieldPane focused width={width} height={23} loadData={loadData} /></Box>
        <PaneFooterBar footer={footer} focused width={width} />
      </Box>}</PaneFooterProvider>
    </TestPaneProvider>;
  }
  await act(async () => { setup = await testRender(<Harness />, { width, height: 24 }); });
  const complete = await frame();
  expect(complete).toContain("4.00%");
  expect(complete).toContain("TTM cash/share");
  mode = "failure";
  await emitKeypress(setup!, { name: "r", sequence: "r" });
  const failed = await frame();
  expect(failed).toContain(recentDate);
  expect(failed).toContain(cashLabel);
  expect(failed).toContain("$20.00");
  expect(failed).toContain("20.00%");
  expect(failed).not.toContain("4.00%");
  expect(failed).not.toContain("TTM cash/share");
  expect(failed).toContain(failure === "invalid" ? "Incomplete cash history" : "Dividend currency is unavailable");
  if (cashCurrency === "GBP") expect(failed).not.toContain("$4.00");
  mode = "complete";
  await emitKeypress(setup!, { name: "r", sequence: "r" });
  const recovered = await frame();
  expect(recovered).toContain("4.00%");
  expect(recovered).toContain("TTM cash/share");
  mode = "empty";
  await emitKeypress(setup!, { name: "r", sequence: "r" });
  const empty = await frame();
  expect(empty).toContain("0.00%");
  expect(empty).not.toContain(recentDate);
  mode = "failure";
  await emitKeypress(setup!, { name: "r", sequence: "r" });
  const failedAfterEmpty = await frame();
  expect(failedAfterEmpty).not.toContain(recentDate);
  expect(failedAfterEmpty).toMatch(/TTM yield\s+—/);
  mode = "complete";
  await emitKeypress(setup!, { name: "r", sequence: "r" });
  const restored = await frame();
  expect(restored).toContain(recentDate);
  mode = "failure";
  await act(async () => { changeSymbol("OTHER"); });
  const changed = await frame();
  expect(changed).not.toContain(recentDate);
  expect(changed).not.toContain(cashRow);
  expect(changed).toContain(failure === "invalid" ? "Incomplete cash history" : "Dividend currency is unavailable");
  mode = "complete";
  await emitKeypress(setup!, { name: "r", sequence: "r" });
  const newSecurity = await frame();
  expect(newSecurity).toContain("7.00%");
  expect(newSecurity).not.toContain(cashRow);
});

test("short dividend panes keep history navigable while paging the complete summary", async () => {
  const { buildDividendMetrics } = await import("./client");
  const { toDividendPayment } = await import("./client");
  const now = new Date();
  const payments = Array.from({ length: 24 }, (_, index) => {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - index, 1));
    return toDividendPayment(date.toISOString().slice(0, 10), 0.25 + index / 100, "USD")!;
  });
  const data = {
    payments, currency: "USD", price: 50, historyAvailable: true,
    metrics: { ...buildDividendMetrics(payments, null, 50), nextPayDate: new Date("2030-01-15T00:00:00Z") },
  };
  const loader = async () => data;
  const id = "short-dividend-summary";
  const state = createInitialState(createTestPaneConfig("/tmp/short-dividend-summary", {
    instanceId: id, paneId: "dividend-yield", binding: { kind: "fixed", symbol: "INCOME" },
  }));
  state.tickers.set("INCOME", createTestTicker("INCOME"));
  const runtime = createTestPluginRuntime();
  await act(async () => {
    setup = await testRender(<TestPaneProvider state={state} paneId={id} pluginId="dividend-yield" runtime={runtime}>
      <DividendYieldPane focused width={40} height={9} loadData={loader} />
    </TestPaneProvider>, { width: 40, height: 9 });
  });
  const latest = payments[0]!.exDate.toISOString().slice(0, 10);
  expect(await frame()).toContain(latest);
  expect(await frame()).toContain("TTM yield");
  for (let index = 0; index < 2; index++) await emitKeypress(setup!, { name: "pagedown" }, { trackPropagation: true });
  expect(await frame()).toContain("Next pay");
  expect(await frame()).toContain("2030-01-15");
  expect(await frame()).toContain(latest);
  await emitKeypress(setup!, Array.from({ length: 8 }, () => ({ name: "down" })), { trackPropagation: true });
  expect((await frame()).split("EX-DATE")[1]).not.toContain(latest);
  expect(await frame()).toContain(payments[8]!.exDate.toISOString().slice(0, 10));
  for (let index = 0; index < 2; index++) await emitKeypress(setup!, { name: "pageup" }, { trackPropagation: true });
  expect(await frame()).toContain("TTM yield");
  expect(await frame()).toContain(payments[8]!.exDate.toISOString().slice(0, 10));
});
