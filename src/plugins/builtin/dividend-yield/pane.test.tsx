import { afterEach, expect, setSystemTime, test } from "bun:test";
import { act, useMemo, useState } from "react";
import { appReducer, createInitialState, type AppAction, type AppState } from "../../../state/app/context";
import { TestPaneFrame, TestPaneProvider, createTestPaneConfig, createTestTicker } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import type { ContextMenuItem } from "../../../types/context-menu";
import { UiHostProvider, useNativeRenderer, useRendererHost, useUiHost } from "../../../ui";
import { setHttpFetchTransport } from "../../../utils/http-transport";
import { DividendYieldPane } from "./pane";
import { fetchDividendData } from "./client";
import { formatDay } from "../../../utils/day-format";
import { chartResponse, hsbcIssuerDividendRead, marketTransport } from "./test-fixture";

const tui = createOpenTuiTestHarness();
const realNow = Date.now;
afterEach(() => {
  setHttpFetchTransport(null);
  setSystemTime();
  Date.now = realNow;
});

/** Render the pane bound to `symbol` in its footer frame. */
async function mountDividendPane(symbol: string, width = 80) {
  const id = `dividend-yield:${symbol}`;
  const state = createInitialState(createTestPaneConfig("/tmp/gloom-dividend-pane-test", {
    instanceId: id, paneId: "dividend-yield", binding: { kind: "fixed", symbol },
  }));
  state.tickers.set(symbol, createTestTicker(symbol));
  await act(async () => {
    await tui.render(<TestPaneFrame state={state} paneId={id} pluginId="dividend-yield" runtime={createTestPluginRuntime()} width={width} height={24}>
      {(body) => <DividendYieldPane focused {...body} />}
    </TestPaneFrame>, { width, height: 24 });
  });
}

async function frame() {
  for (let i = 0; i < 3; i++) await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await tui.setup().renderOnce();
  });
  return tui.frame();
}

/** HSBC's interim, gone ex on 5 Nov with its sterling cash not fixed until 7 Dec, read on 17 Nov; `source` is the notice it cites. */
async function hsbcUnfixedDeclaration(source?: Parameters<typeof hsbcIssuerDividendRead>[2]) {
  setSystemTime(new Date("2026-11-17T06:00:00Z"));
  setHttpFetchTransport(async () => Response.json({ status: "success", data: hsbcIssuerDividendRead("GBp", undefined, source) }));
  try {
    return await fetchDividendData("HSBA", 13.38, "LSE", "GBP");
  } finally {
    setSystemTime();
  }
}

test.each([44, 60])("an ex-dated unfixed sterling declaration keeps its row, estimate labels and fixing date at %d columns", async (width) => {
  const text = await renderLoaded(await hsbcUnfixedDeclaration(), width, 24);
  expect(text).toMatch(/05 Nov 2026\s+estimated 7\.5835p\s+\$0\.10/);
  expect(text).toContain("07 Dec 2026");
  expect(text).toContain("17 Dec 2026");
});

// A declaration that cited its notice took its history row's place, and the issuer's $0.10 went with it.
test("an ex-dated unfixed declaration that cites its notice keeps its estimated and declared cash on the row the notice joins", async () => {
  const text = await renderLoaded(await hsbcUnfixedDeclaration({ publisher: "HSBC", url: "https://example.com/interim.pdf" }), 80, 24);
  const rows = text.split("\n").filter((line) => /^\s*05 Nov 2026\s/.test(line));
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatch(/05 Nov 2026\s+estimated 7\.5835p\s+\$0\.10\s+Declared\s+HSBC\s/);
});

const NOTICE = { publisher: "KSEI", url: "https://example.com/cash.pdf", scheduleUrl: "https://example.com/schedule.pdf" };

/** A paid distribution and a declared one whose publisher issued the cash notice and the schedule apart. */
async function declaredWithNotice() {
  setSystemTime(new Date("2026-11-26T06:00:00Z"));
  setHttpFetchTransport(async () => Response.json({ status: "success", data: {
    summary: null,
    actions: { symbol: "MEDC", exchange: "JAKARTA", currency: "IDR", coverage: { dividends: "available" }, splits: [], earnings: [],
      dividends: [{ exDate: "2026-06-23", amount: 24, payDate: "2026-07-14" }],
      declaredDividends: [{ exDate: "2026-11-11", amount: 22.0252, payDate: "2026-12-02", source: NOTICE }] },
  } }));
  try {
    return await fetchDividendData("MEDC", null, "JAKARTA");
  } finally {
    setSystemTime();
  }
}

test("an unpaid distribution with a published notice keeps its status and source links beside the paid history", async () => {
  const data = await declaredWithNotice();
  expect(data.payments.map((payment) => payment.amount)).toEqual([24]);
  expect(data.metrics.nextPayDate).toEqual(new Date("2026-12-02"));
  const text = await renderLoaded(data, 80, 24);
  expect(text).toMatch(/11 Nov 2026\s+IDR\s+22\.0252\s+Declared\s+KSEI\s+Schedule/);
  expect(text).toMatch(/23 Jun 2026\s+IDR\s+24\.0000\s+Paid/);
  expect(text).toContain("02 Dec 2026");
});

// At 50 columns the two links ran together as "KSEISchedu", cut at the scrollbar.
test("a pane without the room for both source links keeps the notice link whole and opens the schedule from the row's menu", async () => {
  const data = await declaredWithNotice();
  const loadData = async () => data;
  const opened: string[] = [];
  let menu: ContextMenuItem[] = [];
  const state = createInitialState(createTestPaneConfig("/tmp/dividend-notice-links", {
    instanceId: "dividend-links", paneId: "dividend-yield", binding: { kind: "fixed", symbol: "MEDC" },
  }));
  state.tickers.set("MEDC", createTestTicker("MEDC"));
  function Pane({ width }: { width: number }) {
    const host = useRendererHost();
    const renderer = useMemo(() => ({ ...host, openExternal: async (url: string) => { opened.push(url); return true; } }), [host]);
    return (
      <UiHostProvider ui={useUiHost()} nativeRenderer={useNativeRenderer()} renderer={renderer}>
        <TestPaneFrame state={state} paneId="dividend-links" pluginId="dividend-yield" runtime={createTestPluginRuntime()} width={width} height={24}>
          {(body, footer) => { menu = footer.menu; return <DividendYieldPane focused {...body} loadData={loadData} />; }}
        </TestPaneFrame>
      </UiHostProvider>
    );
  }
  const render = async (width: number) => {
    await act(async () => { await tui.render(<Pane width={width} />, { width, height: 24 }); });
    return (await frame()).split("\n").find((line) => line.includes("11 Nov 2026"))!;
  };

  expect(await render(54)).toMatch(/IDR\s22\.0252\s+Declared\s+KSEI Schedule\s/);
  await tui.clickFrameText("Schedule");
  expect(opened).toEqual([NOTICE.scheduleUrl]);

  const narrow = await render(50);
  expect(narrow).toMatch(/11 Nov 2026\s+IDR\s22\.0252\s+Declared\s+KSEI\s/);
  expect(narrow).not.toContain("Sched");
  opened.length = 0;
  await tui.clickFrameText("KSEI");
  await tui.emitKeypress({ name: "return" });
  const schedule = menu.find((item) => "label" in item && item.label === "Open dividend schedule");
  await act(async () => { if (schedule && "onSelect" in schedule) await schedule.onSelect?.(); });
  expect(opened).toEqual([NOTICE.url, NOTICE.url, NOTICE.scheduleUrl]);
});

// Beside a sourced declaration every history row read "Paid", one still waiting on its pay date included.
test("a history row beside a sourced declaration says where it stands by its own dates, and sorts by it", async () => {
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  const unpaid = day(-6), paid = day(-96), undated = day(-186), declared = day(20);
  setHttpFetchTransport(async () => Response.json({ status: "success", data: {
    summary: null,
    actions: { symbol: "MEDC", exchange: "JAKARTA", currency: "IDR", coverage: { dividends: "available" }, splits: [], earnings: [],
      dividends: [{ exDate: unpaid, amount: 23, payDate: day(12) }, { exDate: paid, amount: 24, payDate: day(-75) }, { exDate: undated, amount: 25 }],
      declaredDividends: [{ exDate: declared, amount: 22, payDate: day(40), source: NOTICE }] },
  } }));
  const data = await fetchDividendData("MEDC", null, "JAKARTA");
  // The history, and the trailing year over it, stay on ex-dates: the row not paid yet counts.
  expect(data.payments.map((payment) => payment.amount)).toEqual([23, 24, 25]);
  expect(data.metrics.trailingRate).toBe(72);

  /** The table's rows down the pane, each as its ex-date and the status it reads. */
  const statuses = async () => (await frame()).split("\n").flatMap((line) => {
    const exDate = [declared, unpaid, paid, undated].find((date) => line.trimStart().startsWith(formatDay(date)));
    const status = /Declared|Paid|Ex-dated/.exec(line)?.[0];
    return exDate && status ? [`${exDate} ${status}`] : [];
  });
  await renderLoaded(data, 80, 24);
  expect(await statuses()).toEqual([`${declared} Declared`, `${unpaid} Declared`, `${paid} Paid`, `${undated} Ex-dated`]);
  // A press on the header sorts from the far end: the unpaid row stays with the declared one, apart from the paid.
  await tui.clickFrameText("STATUS");
  expect(await statuses()).toEqual([`${paid} Paid`, `${undated} Ex-dated`, `${declared} Declared`, `${unpaid} Declared`]);
});

test("summary failures retain cash and recover dated payment information through refresh", async () => {
  const day = Math.floor(Date.now() / 86400_000) * 86400;
  const exDate = day + 10 * 86400;
  const payDate = day + 30 * 86400;
  let mode: "valid" | "failed" | "invalid-ex" | "invalid-pay" = "valid";
  let chartRequests = 0;
  setHttpFetchTransport(marketTransport(async (url) => {
    if (url.includes("/chart/")) {
      chartRequests++;
      return chartResponse({
        meta: { currency: "USD", regularMarketPrice: 100, regularMarketTime: day, dataGranularity: "1mo" },
        time: day, dividends: { cash: { date: day - 86400, amount: 4 } },
      });
    }
    if (url.includes("/quoteSummary/")) {
      if (mode === "failed") throw new Error("Controlled summary unavailable");
      return Response.json({ quoteSummary: { result: [{ summaryDetail: { currency: "USD", dividendRate: { raw: 20 },
        exDividendDate: { raw: mode === "invalid-ex" ? 1e20 : exDate },
        dividendDate: { raw: mode === "invalid-pay" ? 1e20 : payDate },
      } }] } });
    }
    throw new Error(`Unexpected controlled request: ${url}`);
  }));
  await mountDividendPane("INCOME");
  expect(await frame()).toContain(formatDay(new Date(payDate * 1000).toISOString().slice(0, 10)));
  for (const nextMode of ["failed", "invalid-ex", "invalid-pay", "valid"] as const) {
    mode = nextMode;
    const requestsBefore = chartRequests;
    await tui.emitKeypress({ name: "r", sequence: "r" });
    const current = await frame();
    expect(chartRequests).toBe(requestsBefore + 1);
    expect(current).toContain("4.00%");
    if (mode === "valid") {
      expect(current).not.toContain("summary");
      expect(current).toContain(formatDay(new Date(payDate * 1000).toISOString().slice(0, 10)));
    } else {
      expect(current.match(/Dividend summary unavailable|Invalid dividend summary date/g)).toHaveLength(1);
      expect(current.trimEnd().split("\n").at(-1)).toContain("summary");
      if (mode !== "failed") expect(current).toContain("$20.00");
    }
  }
});

test.each([48, 80, 120])("native dividend refresh keeps the selected price's time and status reachable at %d columns", async (width) => {
  setSystemTime(new Date("2026-11-24T17:00:00Z"));
  const sourceTime = Math.floor(Date.now() / 1000);
  const oldTime = sourceTime - 10 * 86_400;
  let priceTime: number | undefined = oldTime;
  let fail = false;
  setHttpFetchTransport(marketTransport(async (url) => {
    if (url.includes("/chart/")) {
      if (fail) throw new Error("Controlled cash source unavailable");
      return chartResponse({
        meta: { currency: "USD", exchangeName: "NMS", regularMarketPrice: 100, regularMarketTime: priceTime, dataGranularity: "1mo" },
        time: sourceTime, dividends: { cash: { date: sourceTime - 86_400, amount: 4 } },
      });
    }
    return Response.json({ quoteSummary: { result: [{ summaryDetail: { currency: "USD" } }] } });
  }));
  await mountDividendPane("FUND", width);
  const before = await frame();
  expect(before).toContain("4.00%");
  expect(before).toContain(new Date(oldTime * 1000).toISOString());
  expect(before.match(/Stale price/g)).toHaveLength(1);
  expect(before).not.toContain("cash yield may be out of date");

  priceTime = undefined;
  await tui.emitKeypress({ name: "r", sequence: "r" });
  const missing = await frame();
  expect(missing).toContain("4.00%");
  expect(missing).toContain("Reference price time unavailable");
  expect(missing).not.toContain(new Date(oldTime * 1000).toISOString());

  priceTime = sourceTime;
  await tui.emitKeypress({ name: "r", sequence: "r" });
  const fresh = await frame();
  expect(fresh).toContain("4.00%");
  expect(fresh).toContain(new Date(sourceTime * 1000).toISOString());
  expect(fresh).not.toContain("Stale price");
  expect(fresh).not.toContain("time unavailable");
  if (width >= 80) expect(fresh).toContain("History fetched");

  fail = true;
  await tui.emitKeypress({ name: "r", sequence: "r" });
  const failed = await frame();
  expect(failed).toContain("No dividend data found");
  expect(failed).toContain("4.00%"); // Retained cash stays usable while its current failure is explicit.
  expect(failed).not.toContain("Price 20");
});

test.each([48, 80, 120])("cash integrity failures preserve usable rows and recover through the existing refresh action at %d columns", async (width) => {
  const day = new Date(new Date().toISOString().slice(0, 10)).getTime() / 1000;
  const recent = day - 10 * 86_400 + 14 * 3600;
  const recentDate = formatDay(new Date(recent * 1000).toISOString().slice(0, 10));
  let mode: "complete" | "partial" | "invalid" | "empty" | "unknown-currency" = "complete";
  setHttpFetchTransport(marketTransport(async (url) => {
    if (url.includes("/chart/")) {
      const cash = { date: recent, amount: 4 };
      const old = { date: recent - 3 * 365 * 86_400, amount: 1 };
      const invalid = { date: day - 86_400 };
      const dividends = mode === "empty" ? {} : mode === "invalid" ? { invalid }
        : mode === "partial" ? { cash, old, invalid } : { cash, old };
      return chartResponse({
        meta: { currency: mode === "unknown-currency" ? undefined : "USD", exchangeTimezoneName: "America/New_York", regularMarketPrice: 100, regularMarketTime: day, dataGranularity: "1mo" },
        time: day, dividends,
      });
    }
    return Response.json({ quoteSummary: { result: [{ summaryDetail: { currency: "USD", dividendRate: { raw: 20 } } }] } });
  }));
  await mountDividendPane("CASHFUND", width);
  const complete = await frame();
  expect(complete).toContain("4.00%");
  expect(complete).toContain("TTM dividend");
  expect(complete).toContain(recentDate);

  mode = "partial";
  await tui.emitKeypress({ name: "r", sequence: "r" });
  const partial = await frame();
  expect(partial).toContain(recentDate);
  expect(partial).toContain("$4.00");
  expect(partial).toContain("$20.00");
  expect(partial).not.toContain("4.00%");
  expect(partial).not.toContain("TTM dividend");
  expect(partial.match(/Incomplete cash history/g)).toHaveLength(1);
  expect(partial.trimEnd().split("\n").at(-1)).toContain("Incomplete cash history");

  mode = "invalid";
  await tui.emitKeypress({ name: "r", sequence: "r" });
  const invalid = await frame();
  expect(invalid).toContain(recentDate);
  expect(invalid).toContain("Incomplete cash history");
  expect(invalid).not.toContain("4.00%");

  mode = "empty";
  await tui.emitKeypress({ name: "r", sequence: "r" });
  const empty = await frame();
  expect(empty).toContain("0.00%");
  expect(empty).toContain("No cash distributions reported.");
  expect(empty).not.toContain(recentDate);
  expect(empty).not.toContain("Incomplete cash history");

  mode = "unknown-currency";
  await tui.emitKeypress({ name: "r", sequence: "r" });
  const unknown = await frame();
  expect(unknown).toContain("Dividend currency is unavailable");
  expect(unknown).not.toContain(recentDate);
  expect(unknown).not.toContain("4.00%");

  mode = "complete";
  await tui.emitKeypress({ name: "r", sequence: "r" });
  const recovered = await frame();
  expect(recovered).toContain("4.00%");
  expect(recovered).toContain(recentDate);
  expect(recovered).toContain("TTM dividend");
  expect(recovered).not.toContain("Dividend currency is unavailable");
});

test.each(["invalid", "unknown-currency"] as const)("direct %s integrity failure retains only known cash rows across recovery, empty history and security changes", async (failure) => {
  const width = 80;
  const day = new Date(new Date().toISOString().slice(0, 10)).getTime() / 1000;
  const recent = day - 10 * 86400 + 14 * 3600;
  const recentDate = formatDay(new Date(recent * 1000).toISOString().slice(0, 10));
  let mode: "complete" | "empty" | "failure" = "complete";
  const cashCurrency = failure === "unknown-currency" ? "GBP" : "USD";
  const cashLabel = cashCurrency === "GBP" ? "£4.00" : "$4.00";
  // The payment row: a round axis tick can share the amount.
  const cashRow = `${cashLabel} ${cashCurrency}`;
  setHttpFetchTransport(marketTransport(async (url) => {
    if (url.includes("/chart/")) {
      const dividends = mode === "empty" ? {} : mode === "failure" && failure === "invalid" ? { invalid: { date: recent } }
        : { cash: { date: recent, amount: url.includes("OTHER") ? 7 : 4 }, old: { date: recent - 3 * 365 * 86400, amount: 1 } };
      return chartResponse({ meta: {
        currency: mode === "failure" && failure === "unknown-currency" ? undefined : cashCurrency,
        exchangeTimezoneName: "America/New_York", regularMarketPrice: 100, regularMarketTime: day, dataGranularity: "1mo",
      }, time: day, dividends });
    }
    return Response.json({ quoteSummary: { result: [{ summaryDetail: { currency: "USD", dividendRate: { raw: 20 } } }] } });
  }));
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
    return <TestPaneFrame state={state} paneId={id} pluginId="dividend-yield" runtime={runtime} width={width} height={24}>
      {(body) => <DividendYieldPane focused {...body} loadData={loadData} />}
    </TestPaneFrame>;
  }
  await act(async () => { await tui.render(<Harness />, { width, height: 24 }); });
  const complete = await frame();
  expect(complete).toContain("4.00%");
  expect(complete).toContain("TTM dividend");
  mode = "failure";
  await tui.emitKeypress({ name: "r", sequence: "r" });
  const failed = await frame();
  expect(failed).toContain(recentDate);
  expect(failed).toContain(cashLabel);
  expect(failed).toContain("$20.00");
  expect(failed).toContain("20.00%");
  expect(failed).not.toContain("4.00%");
  expect(failed).not.toContain("TTM dividend");
  expect(failed).toContain(failure === "invalid" ? "Incomplete cash history" : "Dividend currency is unavailable");
  if (cashCurrency === "GBP") expect(failed).not.toContain("$4.00");
  mode = "complete";
  await tui.emitKeypress({ name: "r", sequence: "r" });
  const recovered = await frame();
  expect(recovered).toContain("4.00%");
  expect(recovered).toContain("TTM dividend");
  mode = "empty";
  await tui.emitKeypress({ name: "r", sequence: "r" });
  const empty = await frame();
  expect(empty).toContain("0.00%");
  expect(empty).not.toContain(recentDate);
  mode = "failure";
  await tui.emitKeypress({ name: "r", sequence: "r" });
  const failedAfterEmpty = await frame();
  expect(failedAfterEmpty).not.toContain(recentDate);
  // Four columns at 80 are too narrow for the full label, so it reads "TTM yld".
  expect(failedAfterEmpty).toMatch(/TTM yi?e?ld\s+—/);
  mode = "complete";
  await tui.emitKeypress({ name: "r", sequence: "r" });
  const restored = await frame();
  expect(restored).toContain(recentDate);
  mode = "failure";
  await act(async () => { changeSymbol("OTHER"); });
  const changed = await frame();
  expect(changed).not.toContain(recentDate);
  expect(changed).not.toContain(cashRow);
  expect(changed).toContain(failure === "invalid" ? "Incomplete cash history" : "Dividend currency is unavailable");
  mode = "complete";
  await tui.emitKeypress({ name: "r", sequence: "r" });
  const newSecurity = await frame();
  expect(newSecurity).toContain("7.00%");
  expect(newSecurity).not.toContain(cashRow);
});

async function renderLoaded(data: Awaited<ReturnType<typeof fetchDividendData>>, width: number, height: number) {
  const id = "dividend-kit";
  const state = createInitialState(createTestPaneConfig("/tmp/dividend-kit", {
    instanceId: id, paneId: "dividend-yield", binding: { kind: "fixed", symbol: "INCOME" },
  }));
  state.tickers.set("INCOME", createTestTicker("INCOME"));
  await act(async () => {
    await tui.render(<TestPaneProvider state={state} paneId={id} pluginId="dividend-yield" runtime={createTestPluginRuntime()}>
      <DividendYieldPane focused width={width} height={height} loadData={async () => data} />
    </TestPaneProvider>, { width, height });
  });
  return frame();
}

/** Quarterly payments, oldest first, raised by a cent a quarter each year. */
async function quarterlyIncome(currencyOf: (index: number) => string = () => "USD") {
  const { buildDividendMetrics, toDividendPayment } = await import("./client");
  const now = new Date();
  const payments = Array.from({ length: 20 }, (_, index) => {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - index * 3, 1));
    return toDividendPayment(date.toISOString().slice(0, 10), 0.3 - Math.floor(index / 4) / 100, currencyOf(index))!;
  });
  return { payments, currency: "USD", price: 50, historyAvailable: true, metrics: buildDividendMetrics(payments, null, 50) };
}

test("short dividend panes keep the yields and every payment row within reach", async () => {
  const { buildDividendMetrics, toDividendPayment } = await import("./client");
  const now = new Date();
  const payments = Array.from({ length: 24 }, (_, index) => {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - index, 1));
    return toDividendPayment(date.toISOString().slice(0, 10), 0.25 + index / 100, "USD")!;
  });
  const latest = formatDay(payments[0]!.exDate.toISOString().slice(0, 10));
  const lines = (await renderLoaded({ payments, currency: "USD", price: 50, historyAvailable: true,
    metrics: { ...buildDividendMetrics(payments, null, 50), nextPayDate: new Date("2030-01-15T00:00:00Z") } }, 40, 9)).split("\n");
  // One row of figures, the strip, then the table with its header and rows.
  expect(lines[0]).toContain("7.32%");
  expect(lines.join("\n")).toContain("Fwd yield");
  expect(lines.join("\n")).toContain("15 Jan 2030");
  expect(lines.join("\n")).toContain("EX-DATE");
  expect(lines.join("\n")).toContain(latest);
  await tui.emitKeypress(Array.from({ length: 8 }, () => ({ name: "down" })), { trackPropagation: true });
  const moved = await frame();
  expect(moved.split("EX-DATE")[1]).not.toContain(latest);
  expect(moved).toContain(formatDay(payments[8]!.exDate.toISOString().slice(0, 10)));
});

test("the TTM dividend steps up at each raise and follows the selected payment", async () => {
  const data = await quarterlyIncome();
  const initial = await renderLoaded(data, 88, 26);
  // Four $0.30 payments in the trailing year; the legend names the series in the AMOUNT column's units.
  expect(initial).toContain("● TTM dividend $1.20");
  // One currency: the amount's symbol says it, so no CCY column.
  expect(initial).toMatch(/EX-DATE ▼ +AMOUNT\s*\n/);
  expect(initial).not.toContain("CCY");
  // Four payments back, the year before the last raise.
  await tui.emitKeypress(Array.from({ length: 4 }, () => ({ name: "down" })));
  await act(async () => { await Bun.sleep(200); });
  expect(await frame()).toContain("● TTM dividend $1.16");
  await tui.emitKeypress({ name: "right" });
  expect(await frame()).toContain("● TTM dividend $1.17");
});

test("cash paid again after a year of none reads N/M for its growth, never a percentage", async () => {
  const data = await quarterlyIncome();
  const resumed = { ...data, metrics: { ...data.metrics, growth1Y: null, growth1YNotMeaningful: true } };
  const shown = await renderLoaded(resumed, 120, 26);
  expect(shown).toMatch(/1Y growth\s+N\/M/);
  expect(shown).not.toMatch(/1Y growth\s+n\/a/);
});

test.each([32, 46, 52, 60, 80, 120])("a payout keeps its label, value and basis detail without shortening unrelated labels at %d columns", async (width) => {
  const data = await quarterlyIncome();
  const shown = await renderLoaded({ ...data, metrics: { ...data.metrics, payoutRatio: 0.47 } }, width, 40);
  expect(shown).toMatch(/Payout\s+47\.0%/);
  expect(shown).toContain("TTM diluted EPS");
  expect(shown).not.toMatch(/Payout[^\n]*…/);
  if (width >= 80) {
    expect(shown).toContain("TTM/share");
    expect(shown).toContain("Fwd/share");
    expect(shown).toContain("1Y growth");
  }
});

test("payments that arrive after the first frame share one precision down the amount column", async () => {
  const { buildDividendMetrics, toDividendPayment } = await import("./client");
  const now = new Date();
  // A raise from $0.485 to $0.51: the column reads $0.510 over $0.485, never $0.51 beside it.
  const payments = Array.from({ length: 8 }, (_, index) => {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - index * 3, 1));
    return toDividendPayment(date.toISOString().slice(0, 10), index < 4 ? 0.51 : 0.485, "USD")!;
  });
  const shown = await renderLoaded({ payments, currency: "USD", price: 50, historyAvailable: true, metrics: buildDividendMetrics(payments, null, 50) }, 88, 26);
  expect(shown).toContain("$0.510");
  expect(shown).toContain("$0.485");
});

test("mixed-currency payments keep the currency column", async () => {
  const data = await quarterlyIncome((index) => index < 2 ? "USD" : "CAD");
  expect(await renderLoaded(data, 88, 26)).toContain("CCY");
});

test("DVD opened on several tickers ranks them by trailing yield as fn DVD does, and keeps a row for one it could not read", async () => {
  const { dividendYieldModule } = await import("./index");
  const template = dividendYieldModule.paneTemplates!.find((entry) => entry.id === "dividend-yield-pane")!;
  const context = { activeTicker: null } as never;
  // `shot DVD KO JNJ` passes the list; one ticker opens its own pane as before.
  const ranked = (await template.createInstance!(context, { arg: "KO,JNJ,GONE", symbol: "KO", symbols: ["KO", "JNJ", "GONE"] }))!;
  expect(ranked).toMatchObject({ title: "DVD KO, JNJ, GONE", binding: { kind: "none" }, settings: { rankSymbols: ["KO", "JNJ", "GONE"] } });
  expect(template.createInstance!(context, { arg: "KO", symbol: "KO" })).toMatchObject({ binding: { kind: "fixed", symbol: "KO" } });

  const { buildDividendMetrics, toDividendPayment } = await import("./client");
  const income = (amount: number) => {
    const now = new Date();
    const payments = [0, 3, 6, 9].map((months) => toDividendPayment(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months, 1))
      .toISOString().slice(0, 10), amount, "USD")!);
    return { payments, currency: "USD", price: 50, historyAvailable: true, metrics: buildDividendMetrics(payments, null, 50) };
  };
  const loadData = (async (symbol: string) => {
    if (symbol === "GONE") throw new Error("No dividend data found for GONE");
    return income(symbol === "KO" ? 0.5 : 0.75);
  }) as unknown as typeof fetchDividendData;
  const id = ranked.instanceId!;
  const initial = createInitialState(createTestPaneConfig("/tmp/dividend-ranking", {
    instanceId: id, paneId: "dividend-yield", binding: { kind: "none" }, settings: ranked.settings,
  }));
  const runtime = createTestPluginRuntime();
  function Live() {
    const [state, setState] = useState<AppState>(initial);
    return <TestPaneProvider state={state} dispatch={(action: AppAction) => setState((current) => appReducer(current, action))}
      paneId={id} pluginId="dividend-yield" runtime={runtime}>
      <DividendYieldPane focused width={110} height={10} loadData={loadData} />
    </TestPaneProvider>;
  }
  await act(async () => {
    await tui.render(<Live />, { width: 110, height: 10 });
  });
  const lines = (await frame()).split("\n");
  const header = lines.findIndex((line) => line.includes("TICKER"));
  expect(lines[header]).toMatch(/TICKER +YIELD TTM ▼ +FWD YIELD +PAYOUT +1Y GROWTH +3Y CAGR +LAST EX +NEXT PAY +NOTE/);
  // $3.00 and $2.00 a year over $50: JNJ first, then KO, and the ticker that failed last, marked not read.
  expect(lines[header + 1]).toMatch(/^\s*JNJ +6\.00%/);
  expect(lines[header + 2]).toMatch(/^\s*KO +4\.00%/);
  expect(lines[header + 3]).toMatch(/^\s*GONE .*not read/);
  // A header sorts by its column; a third click returns to the ranking.
  for (const order of [["GONE", "JNJ", "KO"], ["KO", "JNJ", "GONE"], ["JNJ", "KO", "GONE"]]) {
    await tui.clickFrameText("TICKER");
    const sorted = (await frame()).split("\n");
    expect(sorted.slice(header + 1, header + 4).map((line) => line.trim().split(/\s+/)[0])).toEqual(order);
  }
});
