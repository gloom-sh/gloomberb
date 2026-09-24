import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, useReducer } from "react";
import { apiClient, setCloudApiFetchTransport, type CloudThesis, type ThesisSignal } from "../../../../api-client";
import { PaneFooterProvider } from "../../../../components/layout/pane/footer";
import { TestDialogProvider, testRender } from "../../../../renderers/opentui/test-utils";
import { appReducer, createInitialState } from "../../../../state/app/context";
import { createTestPaneConfig, createTestTicker, TestPaneProvider } from "../../../../test-support/pane";
import { createTestPluginRuntime } from "../../../../test-support/plugin-runtime";
import type { PluginPersistence } from "../../../../types/plugin";
import { Box, Text } from "../../../../ui";
import { ThesisBoardPane } from "./board-pane";
import { thesisStore } from "./store";

type Setup = Awaited<ReturnType<typeof testRender>>;
let setup: Setup | undefined;

const PANE_ID = "thesis-test-pane";

const nvda: CloudThesis = {
  id: "t-nvda",
  owner: { kind: "user", id: "u0" },
  title: "NVDA",
  status: "active",
  conviction: 7,
  horizon: "3y",
  reviewEveryDays: 90,
  document: {
    summary: "AI capex keeps compounding and CUDA is the moat.",
    instruments: [{ symbol: "NVDA", side: "long", role: "core" }],
    evidence: { symbols: ["MSFT"], keywords: [] },
    pillars: [
      { id: "p1", text: "Data center revenue grows over 50% YoY", kind: "qualitative", status: "intact" },
      { id: "p2", text: "Gross margin holds", kind: "metric", metric: { key: "grossMarginPct", op: ">=", value: 70, unit: "%" }, status: "weakening" },
    ],
    killConditions: [{ id: "k1", text: "Hyperscaler capex cut over 20%", triggered: false }],
    catalysts: [{ id: "c1", text: "Q3 earnings", date: "2099-11-20", status: "pending" }],
  },
  outcome: null,
  health: "weakening",
  revision: 3,
  openSignals: 1,
  createdBy: "u0",
  updatedBy: { id: "u0", username: "vince", displayName: "Vince" },
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-15T00:00:00.000Z",
  reviewedAt: "2026-09-14T00:00:00.000Z",
  closedAt: null,
};

const asml: CloudThesis = {
  ...nvda,
  id: "t-asml",
  title: "ASML",
  conviction: 8,
  document: {
    ...nvda.document,
    instruments: [{ symbol: "ASML", side: "long", role: "core" }],
    pillars: [{ id: "p9", text: "EUV monopoly holds", kind: "qualitative", status: "intact" }],
    killConditions: [],
    catalysts: [],
  },
  health: "intact",
  openSignals: 0,
};

const signals: ThesisSignal[] = [
  {
    id: "s1",
    thesisId: "t-nvda",
    targetKind: "pillar",
    targetId: "p2",
    verdict: "challenges",
    confidence: 0.8,
    reason: "The 10-Q guides Q3 gross margin to 72-73%, below the 75% run rate.",
    source: { kind: "filing", title: "10-Q: Q3 gross margin guide 72-73%", at: "2026-09-13T00:00:00.000Z" },
    origin: "ai",
    status: "open",
    resolutionNote: null,
    createdBy: null,
    resolvedBy: null,
    createdAt: "2026-09-13T00:00:00.000Z",
    resolvedAt: null,
    snoozedUntil: null,
  },
];

const requests: string[] = [];

function respond(path: string, method: string): { status: number; body: unknown } {
  requests.push(`${method} ${path}`);
  if (path === "/theses") return { status: 200, body: { owners: [], count: 2, items: [nvda, asml] } };
  if (path === "/theses/t-nvda") return { status: 200, body: { ...nvda, signals } };
  if (path === "/theses/t-asml") return { status: 200, body: { ...asml, signals: [] } };
  if (path === "/teams") return { status: 200, body: { teams: [] } };
  return { status: 200, body: {} };
}

const tick = () => act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 5));
});

/**
 * The board fills from the store's first refresh, which crosses a request.
 * A fixed number of ticks is enough on a fast machine and not on a loaded CI
 * runner, so wait for that request to land before letting the render settle.
 */
async function flush(untilRequest: string | null = "GET /theses") {
  for (let i = 0; i < 200 && untilRequest && !requests.includes(untilRequest); i += 1) {
    await tick();
  }
  for (let i = 0; i < 4; i += 1) await tick();
}

function Harness({ focused = true }: { focused?: boolean }) {
  const [state, dispatch] = useReducer(appReducer, undefined, () => {
    const initial = createInitialState(createTestPaneConfig("/tmp/gloomberb-thesis-board", {
      instanceId: PANE_ID,
      paneId: "thesis-board",
    }));
    initial.focusedPaneId = PANE_ID;
    initial.tickers = new Map([
      ["NVDA", createTestTicker("NVDA", "NVIDIA", { portfolios: ["main"], positions: [{ portfolio: "main", shares: 100, avgCost: 90, broker: "manual" }] })],
      ["AAPL", createTestTicker("AAPL", "Apple", { portfolios: ["main"], positions: [{ portfolio: "main", shares: 10, avgCost: 150, broker: "manual" }] })],
    ]);
    return initial;
  });
  return (
    <TestDialogProvider>
      <Box flexDirection="column" width={110} height={30}>
        <TestPaneProvider state={state} dispatch={dispatch} paneId={PANE_ID} pluginId="gloomberb-cloud" runtime={createTestPluginRuntime()}>
          <PaneFooterProvider>
            {(footer) => (
              <>
                <ThesisBoardPane paneId={PANE_ID} paneType="thesis-board" focused={focused} width={110} height={26} />
                <Text>{`footer: ${footer.info.map((segment) => segment.parts.map((part) => part.text).join(" ")).join(" | ")} :: ${footer.hints.map((hint) => `[${hint.key}]${hint.label}`).join(" ")}`}</Text>
              </>
            )}
          </PaneFooterProvider>
        </TestPaneProvider>
      </Box>
    </TestDialogProvider>
  );
}

beforeEach(() => {
  requests.length = 0;
  setCloudApiFetchTransport(async (url, init) => {
    const parsed = new URL(url);
    const { status, body } = respond(parsed.pathname, init?.method ?? "GET");
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  });
  apiClient.setSessionToken("thesis-board-session");
  apiClient.restoreCachedUser({ id: "u0", username: "vince", emailVerified: true, plan: "pro" });
  // The store is a module singleton, and the cloud plugin's setup starts it.
  // Whatever ran earlier in the process may have left it started, which would
  // make `start()` below a no-op and the board load nothing.
  thesisStore.dispose();
  expect(apiClient.isVerified()).toBe(true);
});

afterEach(async () => {
  if (setup) {
    await act(async () => {
      setup!.renderer.destroy();
    });
    setup = undefined;
  }
  thesisStore.dispose();
  (thesisStore as unknown as { update: (patch: object) => void }).update({ theses: [], loaded: false, loading: false, error: null, offline: false });
  apiClient.setSessionToken(null);
});

describe("ThesisBoardPane", () => {
  test("lists theses by attention, then positions without one, with the book at risk in the footer", async () => {
    thesisStore.start();
    await act(async () => {
      setup = await testRender(<Harness />, { width: 110, height: 30 });
    });
    await flush();
    const frame = setup!.captureCharFrame();
    if (process.env.PRINT_FRAMES) console.log(frame);
    expect(requests).toContain("GET /theses");
    expect(frame).toContain("Needs attention");
    expect(frame).toContain("NVDA");
    expect(frame).toContain("weakening");
    expect(frame).toContain("1 to rule on");
    expect(frame).toContain("Active");
    expect(frame).toContain("ASML");
    expect(frame).toContain("Positions without a thesis");
    expect(frame).toContain("AAPL");
    expect(frame).toContain("[n]ew");
    // Scope and view sit in the query bar, not the footer.
    expect(frame).toContain("Portfolio");
    expect(frame).toContain("Weights");
  });

  test("the on-device copy is only called offline once the refresh fails", async () => {
    let failList: (error: Error) => void = () => {};
    setCloudApiFetchTransport(async (url, init) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/theses") return new Promise<Response>((_, reject) => { failList = reject; });
      const { status, body } = respond(parsed.pathname, init?.method ?? "GET");
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    });
    const saved = new Map<string, unknown>([["thesis-cache", [nvda, asml]]]);
    thesisStore.attach({ getState: (key: string) => saved.get(key) ?? null, setState: (key: string, value: unknown) => { saved.set(key, value); } } as unknown as PluginPersistence);
    thesisStore.start();
    await act(async () => {
      setup = await testRender(<Harness />, { width: 110, height: 30 });
    });
    await flush(null);
    const loading = setup!.captureCharFrame();
    expect(loading).toContain("ASML");
    expect(loading).toContain("footer: loading");
    expect(loading).not.toContain("offline copy");
    await act(async () => { failList(new Error("network down")); });
    await flush(null);
    expect(setup!.captureCharFrame()).toContain("offline copy");
  });

  test("enter opens the thesis: pillars, kill conditions, catalysts, and the open signal with its source", async () => {
    thesisStore.start();
    await act(async () => {
      setup = await testRender(<Harness />, { width: 110, height: 30 });
    });
    await flush();
    await act(async () => {
      setup!.mockInput.pressEnter();
      await setup!.renderOnce();
    });
    await flush();
    const frame = setup!.captureCharFrame();
    if (process.env.PRINT_FRAMES) console.log(frame);
    expect(requests).toContain("GET /theses/t-nvda");
    expect(frame).toContain("WEAKENING");
    expect(frame).toContain("Conviction 7/10");
    expect(frame).toContain("Horizon 3y");
    expect(frame).toContain("Listening to MSFT");
    expect(frame).toContain("Signals (1 open)");
    expect(frame).toMatch(/challenges\s+Gross margin holds/);
    expect(frame).toContain("10-Q: Q3 gross margin guide 72-73%");
    expect(frame).toContain("Data center revenue grows over 50% YoY");
    expect(frame).toContain("≥ 70%  weakening");
    expect(frame).toContain("Hyperscaler capex cut over 20%");
    expect(frame).toContain("not fired");
    expect(frame).toContain("Q3 earnings");
    // r is the app-wide refresh, so the review has its own key.
    expect(frame).toContain("[v] review");
  });

  test("w switches to conviction against weight", async () => {
    thesisStore.start();
    await act(async () => {
      setup = await testRender(<Harness />, { width: 110, height: 30 });
    });
    await flush();
    await act(async () => {
      setup!.mockInput.pressKey("w");
      await setup!.renderOnce();
    });
    await flush();
    const frame = setup!.captureCharFrame();
    if (process.env.PRINT_FRAMES) console.log(frame);
    expect(frame).toContain("GAP");
  });
});
