import { afterEach, expect, spyOn, test } from "bun:test";
import { act, useState } from "react";
import { apiClient, setCloudApiFetchTransport, type CloudProxyStatementListPayload, type CloudProxyStatementPayload } from "../../../api-client";
import { ApiRequestError } from "../../../api-client/errors";
import { PaneFooterBar, PaneFooterProvider } from "../../../components/layout/pane/footer";
import { emitKeypress, testRender } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState, type AppAction, type AppState } from "../../../state/app/context";
import { createTestPaneConfig, createTestTicker, TestPaneProvider } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import { Box } from "../../../ui";
import { attachExecutivesPersistence, loadProxyStatement, loadProxyStatements, resetExecutivesPersistence } from "./data";
import { ExecutivesPane } from "./pane";
import { parsePublicTickerKey } from "../../../utils/exchanges";

function statement(ticker: string, year: number): CloudProxyStatementPayload {
  return {
    id: `${ticker}-${year}`, ticker, proxyYear: year, fiscalYear: year - 1,
    fiscalYearLabel: `Fiscal ${year - 1}`, filedAt: `${year}-04-01`, updatedAt: `${year}-04-01`,
    company: { ticker, cik: null, name: ticker, shortName: ticker }, meetingDate: null,
    ceoName: null, ceoTitle: null, ceoTotal: null, ceoPriorYearTotal: null,
    payRatio: null, medianEmployeePay: null, sayOnPayPriorSupport: null,
    docUrl: `https://example.com/${ticker}/${year}`, ceo: null, namedExecutives: [],
    highlights: `${ticker} compensation ${year}`, keyFigures: [], otherYears: [],
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
let setup: Awaited<ReturnType<typeof testRender>> | undefined;
const restore: Array<() => void> = [];
afterEach(async () => {
  if (setup) await act(async () => setup!.renderer.destroy());
  setup = undefined;
  for (const undo of restore.splice(0)) undo();
  resetExecutivesPersistence();
  setCloudApiFetchTransport(null);
});
async function settle() {
  for (let i = 0; i < 4; i++) await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
    await setup!.renderOnce();
  });
}
async function mount(initialSymbol = "ALPHA", width = 100, height = 24) {
  const paneId = "executives:test";
  let selectTicker!: (ticker: string) => void;
  const runtime = createTestPluginRuntime();
  function Harness() {
    const [symbol, setSymbol] = useState(initialSymbol);
    selectTicker = setSymbol;
    // The selected proxy year is pane state, so the harness needs a reducer.
    const [paneState, setPaneState] = useState<AppState["paneState"]>({});
    const state = createInitialState(createTestPaneConfig("/tmp/executives-test", {
      paneId: "executives", instanceId: paneId, binding: { kind: "fixed", symbol },
    }));
    state.paneState = paneState;
    const dispatch = (action: AppAction) => setPaneState(appReducer(state, action).paneState);
    const listing = parsePublicTickerKey(symbol);
    state.tickers.set(symbol, createTestTicker(listing.symbol, listing.symbol, { exchange: listing.exchange ?? "NASDAQ" }));
    return <TestPaneProvider state={state} dispatch={dispatch} paneId={paneId} pluginId="ticker-research" runtime={runtime}>
      <PaneFooterProvider>{footer => <Box width={width} height={height} flexDirection="column">
        <Box height={height - 1}><ExecutivesPane focused width={width} height={height - 1} /></Box>
        <PaneFooterBar footer={footer} focused width={width} />
      </Box>}</PaneFooterProvider>
    </TestPaneProvider>;
  }
  setup = await testRender(<Harness />, { width, height });
  await settle();
  return async (ticker: string) => { await act(async () => selectTicker(ticker)); await settle(); };
}
async function selectYear(year: number) {
  const lines = setup!.captureCharFrame().split("\n");
  const y = lines.findIndex(line => line.includes(`${year} proxy`));
  expect(y).toBeGreaterThanOrEqual(0);
  const x = lines[y]!.indexOf(`${year} proxy`);
  await act(async () => setup!.mockMouse.click(x + 2, y));
  await settle();
}

test("a qualified US pane binding reaches issuer proxy list and year endpoints", async () => {
  const paths: string[] = [];
  setCloudApiFetchTransport(async (url) => {
    const path = new URL(url).pathname;
    paths.push(path);
    if (path === "/public/proxies/AAPL") return Response.json({
      company: statement("AAPL", 2026).company, proxies: [statement("AAPL", 2026)],
    });
    if (path === "/public/proxies/AAPL/2026") return Response.json(statement("AAPL", 2026));
    return Response.json({ message: "Unknown ticker" }, { status: 404 });
  });
  await mount("AAPL:XNAS");
  expect(paths).toEqual(["/public/proxies/AAPL", "/public/proxies/AAPL/2026"]);
  expect(setup!.captureCharFrame()).toContain("AAPL compensation 2026");
});

test("the CEO summary preserves reported zero compensation and its full decline", async () => {
  const report = statement("ALPHA", 2026);
  report.ceo = {
    name: "Zero Pay CEO", title: "Chief Executive Officer", total: 0, priorYearTotal: 100,
    salary: 0, bonus: 0, stockAwards: 0, optionAwards: 0, nonEquityIncentive: 0,
    pensionAndDeferred: 0, allOther: 0,
  };
  const list = spyOn(apiClient, "getProxyStatements").mockResolvedValue({ company: report.company, proxies: [report] });
  const detail = spyOn(apiClient, "getProxyStatement").mockResolvedValue(report);
  restore.push(() => list.mockRestore(), () => detail.mockRestore());
  await mount();
  const frame = setup!.captureCharFrame();
  expect(frame).toMatch(/\$0\s+Zero Pay CEO total pay, -100% vs prior year/);
});

test("a different proxy year clears the prior figures and filing action, and a failed year remains recoverable", async () => {
  const earlier = deferred<CloudProxyStatementPayload>();
  const list = spyOn(apiClient, "getProxyStatements").mockResolvedValue({ company: statement("ALPHA", 2026).company, proxies: [statement("ALPHA", 2026), statement("ALPHA", 2025)] });
  const detail = spyOn(apiClient, "getProxyStatement").mockImplementation(async (ticker, year) => year === 2025 ? earlier.promise : statement(ticker, year));
  restore.push(() => list.mockRestore(), () => detail.mockRestore());
  await mount();
  expect(setup!.captureCharFrame()).toContain("ALPHA compensation 2026");
  expect(setup!.captureCharFrame()).toContain("pen filing");
  await selectYear(2025);
  expect(setup!.captureCharFrame()).not.toContain("ALPHA compensation 2026");
  expect(setup!.captureCharFrame()).not.toContain("pen filing");
  await act(async () => earlier.reject(new Error("Selected proxy unavailable")));
  await settle();
  expect(setup!.captureCharFrame()).toContain("Selected proxy unavailable");
  expect(setup!.captureCharFrame()).not.toContain("Loading...");
  await selectYear(2026);
  expect(setup!.captureCharFrame()).toContain("ALPHA compensation 2026");
  expect(setup!.captureCharFrame()).not.toContain("Selected proxy unavailable");
});

test("changing ticker waits for its own proxy years and discards a late previous-company response", async () => {
  const betaList = deferred<CloudProxyStatementListPayload>();
  const oldYear = deferred<CloudProxyStatementPayload>();
  const list = spyOn(apiClient, "getProxyStatements").mockImplementation(async ticker => ticker === "BETA" ? betaList.promise : { company: statement(ticker, 2026).company, proxies: [statement(ticker, 2026), statement(ticker, 2025)] });
  const detail = spyOn(apiClient, "getProxyStatement").mockImplementation(async (ticker, year) => ticker === "ALPHA" && year === 2025 ? oldYear.promise : statement(ticker, year));
  restore.push(() => list.mockRestore(), () => detail.mockRestore());
  const selectTicker = await mount();
  await selectYear(2025);
  await selectTicker("BETA");
  expect(detail.mock.calls.filter(([ticker]) => ticker === "BETA")).toEqual([]);
  await act(async () => oldYear.resolve(statement("ALPHA", 2025)));
  await settle();
  expect(setup!.captureCharFrame()).not.toContain("ALPHA compensation");
  await act(async () => betaList.resolve({ company: statement("BETA", 2024).company, proxies: [statement("BETA", 2024)] }));
  await settle();
  expect(detail.mock.calls.filter(([ticker]) => ticker === "BETA")).toEqual([["BETA", 2024]]);
  expect(setup!.captureCharFrame()).toContain("BETA compensation 2024");
});

test("a failed single-year request can be retried from the footer without changing ticker", async () => {
  let unavailable = true;
  const list = spyOn(apiClient, "getProxyStatements").mockResolvedValue({ company: statement("ALPHA", 2026).company, proxies: [statement("ALPHA", 2026)] });
  const detail = spyOn(apiClient, "getProxyStatement").mockImplementation(async (ticker, year) => {
    if (unavailable) throw new Error("Proxy temporarily unavailable");
    return statement(ticker, year);
  });
  restore.push(() => list.mockRestore(), () => detail.mockRestore());
  await mount();
  expect(setup!.captureCharFrame()).toContain("Proxy temporarily unavailable");
  expect(setup!.captureCharFrame()).not.toContain("pen filing");
  unavailable = false;
  await act(async () => setup!.mockInput.pressKey("r"));
  await settle();
  expect(setup!.captureCharFrame()).toContain("ALPHA compensation 2026");
  expect(setup!.captureCharFrame()).not.toContain("Proxy temporarily unavailable");
  expect(detail).toHaveBeenCalledTimes(2);
});

function seedCache(stale = true) {
  const persistence = new MemoryPluginPersistence();
  const report = statement("ALPHA", 2026);
  const list = { company: report.company, proxies: [report] };
  const options = { sourceKey: "executives", schemaVersion: 1, stale, expired: stale };
  persistence.seedResource("proxies", "ALPHA", list, options);
  persistence.seedResource("proxy", "ALPHA:2026", report, options);
  attachExecutivesPersistence(persistence);
  return { persistence, report, list };
}

test("cached list and statement failures retain original age behind the warning indicator and refresh clears it", async () => {
  const { persistence, report, list: payload } = seedCache();
  const cacheOptions = { sourceKey: "executives", allowExpired: true };
  const original = persistence.getResource("proxy", "ALPHA:2026", cacheOptions)!;
  let unavailable = true;
  const list = spyOn(apiClient, "getProxyStatements").mockImplementation(async () => {
    if (unavailable) throw new Error("Discovery outage");
    return payload;
  });
  const detail = spyOn(apiClient, "getProxyStatement").mockImplementation(async () => {
    if (unavailable) throw new Error("Statement outage");
    return report;
  });
  restore.push(() => list.mockRestore(), () => detail.mockRestore());
  await mount();
  let frame = setup!.captureCharFrame();
  expect(frame).toContain("ALPHA compensation 2026");
  expect(frame).toContain("filed Apr 01, 2026");
  expect(frame).toContain("⚠");
  expect(frame).not.toContain("Discovery outage");
  expect(frame).not.toContain("Statement outage");
  expect(persistence.getResource("proxy", "ALPHA:2026", cacheOptions)).toEqual(original);
  await act(async () => setup!.mockInput.pressKey("!"));
  await settle();
  frame = setup!.captureCharFrame();
  expect(frame).toContain("Discovery outage");
  expect(frame).toContain("Statement outage");
  expect(frame).toContain(new Date(original.fetchedAt).toISOString());
  await emitKeypress(setup!, { name: "escape" });
  await settle();
  unavailable = false;
  await act(async () => setup!.mockInput.pressKey("r"));
  await settle();
  frame = setup!.captureCharFrame();
  expect(frame).toContain("ALPHA compensation 2026");
  expect(frame).not.toContain("⚠");
  const fresh = await loadProxyStatement("ALPHA", 2026);
  expect(fresh.refreshError).toBeUndefined();
  expect(fresh.fetchedAt).toBeGreaterThan(original.fetchedAt);
  expect(fresh.data?.filedAt).toBe(report.filedAt);
  expect(fresh.data?.updatedAt).toBe(report.updatedAt);
});

for (const status of [401, 402, 403, 404]) test(`authoritative ${status} responses never serve cached executive data`, async () => {
  const { persistence } = seedCache(false);
  const error = new ApiRequestError("Account not found", status);
  const list = spyOn(apiClient, "getProxyStatements").mockRejectedValue(error);
  const detail = spyOn(apiClient, "getProxyStatement").mockRejectedValue(error);
  restore.push(() => list.mockRestore(), () => detail.mockRestore());
  for (const load of [() => loadProxyStatements("ALPHA", { force: true }), () => loadProxyStatement("ALPHA", 2026, { force: true })]) {
    if (status === 404) expect(await load()).toEqual({ data: null, fetchedAt: null });
    else await expect(load()).rejects.toBe(error);
  }
  expect(persistence.getResource("proxies", "ALPHA", { sourceKey: "executives", allowExpired: true })).toBeNull();
  expect(persistence.getResource("proxy", "ALPHA:2026", { sourceKey: "executives", allowExpired: true })).toBeNull();
  await mount();
  const frame = setup!.captureCharFrame();
  expect(frame).not.toContain("ALPHA compensation");
  expect(frame).not.toContain("pen filing");
  expect(frame).not.toContain("⚠");
  expect(frame).toContain(status === 404 ? "No proxy statement on file" : "Account not found");
  if (status !== 404) expect(frame).not.toContain("No proxy statement on file");
});

test("an older forced request cannot replace a newer cached statement or mark its refresh failed", async () => {
  const { persistence, report } = seedCache(false);
  const old = deferred<CloudProxyStatementPayload>();
  const current = { ...report, highlights: "Current revised extraction" };
  const detail = spyOn(apiClient, "getProxyStatement")
    .mockImplementationOnce(() => old.promise).mockResolvedValue(current);
  restore.push(() => detail.mockRestore());
  const older = loadProxyStatement("ALPHA", 2026, { force: true });
  await Promise.resolve();
  await loadProxyStatement("ALPHA", 2026, { force: true });
  old.reject(new ApiRequestError("Retired request denied", 403));
  await expect(older).rejects.toThrow("Retired request denied");
  expect(persistence.getResource<CloudProxyStatementPayload>("proxy", "ALPHA:2026", { sourceKey: "executives" })?.value.highlights).toBe(current.highlights);
  expect((await loadProxyStatement("ALPHA", 2026)).data?.highlights).toBe(current.highlights);
  expect(detail).toHaveBeenCalledTimes(2);
});

test("failed forced refresh of fresh cached discovery is retried on reopen without resetting its age", async () => {
  const { persistence, list: payload } = seedCache(false);
  const original = persistence.getResource("proxies", "ALPHA", { sourceKey: "executives" })!;
  const list = spyOn(apiClient, "getProxyStatements")
    .mockRejectedValueOnce(new Error("Temporary discovery outage")).mockResolvedValue(payload);
  restore.push(() => list.mockRestore());
  const retained = await loadProxyStatements("ALPHA", { force: true });
  expect(retained.fetchedAt).toBe(original.fetchedAt);
  expect(retained.refreshError).toBe("Temporary discovery outage");
  expect((await loadProxyStatements("ALPHA")).refreshError).toBeUndefined();
  expect(list).toHaveBeenCalledTimes(2);
});

test("in-memory data survives a transient refresh but is removed when access is denied", async () => {
  const report = statement("ALPHA", 2026);
  let failure: Error | null = null;
  const list = spyOn(apiClient, "getProxyStatements").mockImplementation(async () => {
    if (failure) throw failure;
    return { company: report.company, proxies: [report] };
  });
  const detail = spyOn(apiClient, "getProxyStatement").mockImplementation(async () => {
    if (failure) throw failure;
    return report;
  });
  restore.push(() => list.mockRestore(), () => detail.mockRestore());
  await mount();
  failure = new Error("Transient request failed");
  await act(async () => setup!.mockInput.pressKey("r"));
  await settle();
  expect(setup!.captureCharFrame()).toContain("ALPHA compensation 2026");
  expect(setup!.captureCharFrame()).toContain("⚠");
  failure = new ApiRequestError("Account not found", 403);
  await act(async () => setup!.mockInput.pressKey("r"));
  await settle();
  const frame = setup!.captureCharFrame();
  expect(frame).toContain("Account not found");
  expect(frame).not.toContain("ALPHA compensation");
  expect(frame).not.toContain("pen filing");
  expect(frame).not.toContain("⚠");
});

test("failed rediscovery after an explicit 404 reports the failure instead of reusing the empty state", async () => {
  const list = spyOn(apiClient, "getProxyStatements")
    .mockRejectedValueOnce(new ApiRequestError("No proxy statements", 404))
    .mockRejectedValue(new Error("Discovery unavailable"));
  restore.push(() => list.mockRestore());
  await mount();
  expect(setup!.captureCharFrame()).toContain("No proxy statement on file");
  await act(async () => setup!.mockInput.pressKey("r"));
  await settle();
  expect(setup!.captureCharFrame()).toContain("Discovery unavailable");
  expect(setup!.captureCharFrame()).not.toContain("No proxy statement on file");
  expect(setup!.captureCharFrame()).not.toContain("⚠");
});


test("a narrow compensation pane keeps each executive total, full name, title and equity share accessible", async () => {
  const report = statement("ALPHA", 2026);
  report.highlights = "";
  report.namedExecutives = [{
    name: "Alexandra Longname", title: "Chief Financial Officer", total: 22_467_309,
    salary: 891_519, bonus: null, stockAwards: 18_433_135, optionAwards: null,
    nonEquityIncentive: 3_120_317, pensionAndDeferred: null, allOther: 22_338,
  }];
  const list = spyOn(apiClient, "getProxyStatements").mockResolvedValue({ company: report.company, proxies: [report] });
  const detail = spyOn(apiClient, "getProxyStatement").mockResolvedValue(report);
  restore.push(() => list.mockRestore(), () => detail.mockRestore());
  await mount("ALPHA", 32, 24);
  const frame = setup!.captureCharFrame();
  expect(frame).toContain("$22.5M");
  const words = frame.replace(/\s+/g, " ");
  expect(words).toContain("Alexandra Longname");
  expect(words).toContain("Chief Financial Officer");
  expect(words).toContain("82% equity");
});
