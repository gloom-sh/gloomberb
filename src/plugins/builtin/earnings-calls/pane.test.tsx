import { afterEach, expect, spyOn, test } from "bun:test";
import { act, useState } from "react";
import { apiClient, setCloudApiFetchTransport, type CloudEarningsCallPayload, type CloudEarningsTranscriptPayload } from "../../../api-client";
import { PaneFooterBar, PaneFooterProvider } from "../../../components/layout/pane/footer";
import { createInitialState } from "../../../state/app/context";
import { createTestPaneConfig, TestPaneProvider } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import { emitKeypress, testRender } from "../../../renderers/opentui/test-utils";
import { Box } from "../../../ui";
import { attachEarningsCallsPersistence, resetEarningsCallsPersistence } from "./data";
import { EarningsCallsPane } from "./pane";
import { TranscriptView, type ReaderTab } from "./transcript-view";

let setup: Awaited<ReturnType<typeof testRender>> | undefined;
let setSymbol: (symbol: string) => void;
const runtime = createTestPluginRuntime();
const restorers: Array<() => void> = [];
function Harness({ width = 80 }: { width?: number }) {
  const [symbol, set] = useState("FIRST");
  setSymbol = set;
  const config = createTestPaneConfig("/tmp/gloom-transcript-pane-test/unused-data", {
    instanceId: "calls:test", paneId: "earnings-calls", binding: { kind: "fixed", symbol },
  });
  const state = createInitialState(config);
  state.focusedPaneId = "calls:test";
  return <TestPaneProvider state={state} paneId="calls:test" pluginId="research" runtime={runtime}>
    <PaneFooterProvider>{footer => <Box width={width} height={21} flexDirection="column">
      <Box width={width} height={20}><EarningsCallsPane focused width={width} height={20} /></Box>
      <PaneFooterBar footer={footer} focused width={width} />
    </Box>}</PaneFooterProvider>
  </TestPaneProvider>;
}
function signIn() {
  apiClient.setSessionToken("controlled-test-session");
  apiClient.restoreCachedUser({
    id: "controlled-user", name: "Test", email: "test@example.invalid",
    emailVerified: true, plan: "pro", effectivePlan: "pro",
  } as never);
}
async function frames() {
  for (let i = 0; i < 6; i++) await act(async () => { await Bun.sleep(5); await setup!.renderOnce(); });
}
async function mount(width = 80) {
  await act(async () => { setup = await testRender(<Harness width={width} />, { width, height: 21 }); });
  await frames();
}
async function destroy() {
  if (setup) { await act(async () => setup!.renderer.destroy()); setup = undefined; }
}
async function press(key: string) {
  await act(async () => { key === "return" ? setup!.mockInput.pressEnter() : setup!.mockInput.pressKey(key); });
  await frames();
}
afterEach(async () => {
  await destroy();
  for (const restore of restorers.splice(0)) restore();
  setCloudApiFetchTransport(null);
  apiClient.setSessionToken(null);
  resetEarningsCallsPersistence();
});
const call = (ticker: string): CloudEarningsCallPayload => ({
  id: `${ticker}-call`, ticker, companyName: `${ticker} CORP`, fiscalYear: 2026, fiscalQuarter: 2,
  callAt: "2026-08-01T20:00:00Z", status: "published", durationSeconds: 3000,
  wordCount: 100, hasTranscript: true, sentiment: null,
});
const transcript = (ticker: string): CloudEarningsTranscriptPayload => ({
  ...call(ticker), timing: null, webcastUrl: null,
  fullText: `${ticker} controlled full text is present.\n\nMargin outlook remains available.`,
  turns: [], participants: [], summary: `${ticker} CONTROLLED SUMMARY`, guidance: null,
  riskFactors: null, notable: null, analystFocus: null, sentimentRationale: null,
  qaStartTurn: null, asrModel: null, updatedAt: "2026-08-02",
});
function manualPollTimers() {
  const originalSet = globalThis.setTimeout;
  const originalClear = globalThis.clearTimeout;
  let nextId = 900_000_000;
  const pending = new Map<number, () => void>();
  const set = spyOn(globalThis, "setTimeout").mockImplementation(((callback, delay, ...args) => {
    if (delay !== 20_000 && delay !== 15_000) return originalSet(callback, delay, ...args);
    const id = ++nextId;
    pending.set(id, () => callback(...args));
    return id;
  }) as typeof setTimeout);
  const clear = spyOn(globalThis, "clearTimeout").mockImplementation((timer) => {
    if (!pending.delete(Number(timer))) originalClear(timer);
  });
  restorers.push(() => { set.mockRestore(); clear.mockRestore(); });
  return {
    pending,
    async fire() {
      const entry = pending.entries().next().value;
      expect(entry).toBeDefined();
      pending.delete(entry![0]);
      await act(async () => entry![1]());
      await frames();
    },
  };
}

test("a pending company lookup remains pending after the pane reopens", async () => {
  signIn();
  attachEarningsCallsPersistence(new MemoryPluginPersistence());
  setCloudApiFetchTransport(async () => Response.json({ calls: [], pending: true }));
  await mount();
  expect(setup!.captureCharFrame()).toContain("Looking for FIRST");
  await destroy();
  await mount();
  expect(setup!.captureCharFrame()).toContain("Looking for FIRST");
});

test("identical pending responses keep polling until calls arrive and unmount cancels the next poll", async () => {
  signIn();
  const timers = manualPollTimers();
  let requests = 0;
  setCloudApiFetchTransport(async () => Response.json(++requests < 3
    ? { calls: [], pending: true } : { calls: [call("FIRST")] }));
  await mount();
  await timers.fire();
  expect(requests).toBe(2);
  expect(setup!.captureCharFrame()).toContain("Looking for FIRST");
  await timers.fire();
  expect(requests).toBe(3);
  expect(setup!.captureCharFrame()).toContain("FIRST CORP");
  expect(timers.pending.size).toBe(0);
  setCloudApiFetchTransport(async () => Response.json({ calls: [], pending: true }));
  await press("r");
  expect(timers.pending.size).toBe(1);
  await destroy();
  expect(timers.pending.size).toBe(0);
});

for (const rejected of [false, true]) {
  test(`a late previous-company ${rejected ? "error" : "response"} cannot replace the current company`, async () => {
    signIn();
    let finishFirst!: (response: Response) => void;
    setCloudApiFetchTransport(async (url) => new URL(String(url)).searchParams.get("ticker") === "FIRST"
      ? new Promise(resolve => { finishFirst = resolve; }) : Response.json({ calls: [call("SECOND")] }));
    await mount();
    await act(async () => setSymbol("SECOND"));
    await frames();
    expect(setup!.captureCharFrame()).toContain("SECOND CORP");
    await act(async () => finishFirst(rejected
      ? Response.json({ error: "Controlled denied" }, { status: 403 }) : Response.json({ calls: [call("FIRST")] })));
    await frames();
    expect(setup!.captureCharFrame()).toContain("SECOND CORP");
    expect(setup!.captureCharFrame()).not.toContain("FIRST CORP");
  });
}

for (const change of ["ticker", "access", "unmount"] as const) {
  test(`a pending detail result is invalidated on ${change} change`, async () => {
    signIn();
    const timers = manualPollTimers();
    let finishDetail!: (response: Response) => void;
    let detailRequests = 0;
    setCloudApiFetchTransport(async (url) => {
      const request = new URL(String(url));
      if (request.pathname.includes("FIRST-call")) {
        detailRequests++;
        return new Promise(resolve => { finishDetail = resolve; });
      }
      return Response.json({ calls: [call(request.searchParams.get("ticker") ?? "FIRST")] });
    });
    await mount();
    await press("return");
    expect(detailRequests).toBe(1);
    if (change === "ticker") { await act(async () => setSymbol("SECOND")); await frames(); }
    if (change === "access") { await act(async () => apiClient.setSessionToken(null)); await frames(); }
    if (change === "unmount") await destroy();
    // If the old detail handler survived, this response would schedule production polling.
    await act(async () => finishDetail(Response.json({ status: "pending" }, { status: 202 })));
    if (setup) await frames();
    expect(timers.pending.size).toBe(0);
    expect(detailRequests).toBe(1);
    if (change === "ticker") expect(setup!.captureCharFrame()).toContain("SECOND CORP");
    if (change === "access") expect(setup!.captureCharFrame()).toContain("Sign in");
  });
}

test("a late published transcript cannot appear under a newly opened company", async () => {
  signIn();
  let finishFirst!: (response: Response) => void;
  setCloudApiFetchTransport(async (url) => {
    const request = new URL(String(url));
    if (request.pathname.includes("FIRST-call")) {
      return new Promise(resolve => { finishFirst = resolve; });
    }
    if (request.pathname.includes("SECOND-call")) return Response.json(transcript("SECOND"));
    return Response.json({ calls: [call(request.searchParams.get("ticker") ?? "FIRST")] });
  });
  await mount();
  await press("return");
  await act(async () => setSymbol("SECOND"));
  await frames();
  await press("return");
  expect(setup!.captureCharFrame()).toContain("SECOND CONTROLLED SUMMARY");
  await act(async () => finishFirst(Response.json(transcript("FIRST"))));
  await frames();
  expect(setup!.captureCharFrame()).toContain("SECOND CONTROLLED SUMMARY");
  expect(setup!.captureCharFrame()).not.toContain("FIRST CONTROLLED SUMMARY");
});

for (const persisted of [false, true]) {
  test(`a refresh error retains ${persisted ? "cached" : "in-memory"} rows and its cause until recovery`, async () => {
    signIn();
    if (persisted) attachEarningsCallsPersistence(new MemoryPluginPersistence());
    let fail = false;
    setCloudApiFetchTransport(async () => fail
      ? Response.json({ error: "Controlled outage" }, { status: 503 }) : Response.json({ calls: [call("FIRST")] }));
    await mount();
    fail = true;
    await press("r");
    expect(setup!.captureCharFrame()).toContain("FIRST CORP");
    expect(setup!.captureCharFrame().includes("stale cache")).toBe(persisted);
    expect(setup!.captureCharFrame()).toContain("Controlled outage");
    fail = false;
    await press("r");
    expect(setup!.captureCharFrame()).toContain("FIRST CORP");
    expect(setup!.captureCharFrame()).not.toContain("Controlled outage");
    expect(setup!.captureCharFrame()).not.toContain("stale cache");
  });
}

test("an explicit unauthorized response gates the pane even after a successful cached load", async () => {
  signIn();
  attachEarningsCallsPersistence(new MemoryPluginPersistence());
  setCloudApiFetchTransport(async () => Response.json({ calls: [call("FIRST")] }));
  await mount();
  setCloudApiFetchTransport(async () => Response.json({ error: "Controlled auth required" }, { status: 401 }));
  await press("r");
  expect(setup!.captureCharFrame()).toContain("Sign in");
  expect(setup!.captureCharFrame()).not.toContain("FIRST CORP");
});

for (const width of [48, 80, 120]) {
  test(`published full text remains searchable without inventing Q&A at ${width} columns`, async () => {
    let setView!: (value: { tab: ReaderTab; query?: string }) => void;
    function Reader() {
      const [view, set] = useState<{ tab: ReaderTab; query?: string }>({ tab: "transcript" });
      setView = set;
      return <Box width={width} height={20}><TranscriptView transcript={transcript("SYN")}
        loading={false} error={null} tab={view.tab} query={view.query} onTabChange={() => {}}
        tabsFocused={false} width={width} /></Box>;
    }
    await act(async () => { setup = await testRender(<Reader />, { width, height: 20 }); });
    await frames();
    expect(setup!.captureCharFrame()).toContain("SYN controlled full text");
    await act(async () => setView({ tab: "transcript", query: "margin" }));
    await frames();
    expect(setup!.captureCharFrame()).toContain("Margin outlook remains available");
    expect(setup!.captureCharFrame()).not.toContain("SYN controlled full text");
    await act(async () => setView({ tab: "transcript", query: "absent" }));
    await frames();
    expect(setup!.captureCharFrame()).toContain("Nothing matching");
    await act(async () => setView({ tab: "qa" }));
    await frames();
    expect(setup!.captureCharFrame()).toContain("No question and answer");
    expect(setup!.captureCharFrame()).not.toContain("SYN controlled full text");
  });
}


test("opening another quarter never displays the previous quarter's transcript", async () => {
  signIn();
  const q2 = call("FIRST");
  const q1 = { ...call("FIRST"), id: "FIRST-q1", fiscalQuarter: 1, callAt: "2026-05-01T20:00:00Z" };
  let finish!: (response: Response) => void;
  setCloudApiFetchTransport(async (url) => {
    const request = new URL(String(url));
    if (request.pathname.includes("FIRST-call")) return Response.json({ ...transcript("FIRST"), summary: "Q2 ONLY OLD SUMMARY" });
    if (request.pathname.includes("FIRST-q1")) return new Promise(resolve => { finish = resolve; });
    return Response.json({ calls: [q2, q1] });
  });
  await mount();
  await press("return");
  expect(setup!.captureCharFrame()).toContain("Q2 ONLY OLD SUMMARY");
  await emitKeypress(setup!, { name: "escape", sequence: "\u001b" });
  await frames();
  await press("j");
  await press("return");
  const loading = setup!.captureCharFrame();
  expect(loading).toContain("Q1");
  expect(loading).toContain("Loading transcript");
  expect(loading).not.toContain("Q2 ONLY OLD SUMMARY");
  await act(async () => finish(Response.json({ ...transcript("FIRST"), ...q1, summary: "Q1 NEW SUMMARY" })));
  await frames();
  expect(setup!.captureCharFrame()).toContain("Q1 NEW SUMMARY");
  expect(setup!.captureCharFrame()).not.toContain("Q2 ONLY OLD SUMMARY");
});
