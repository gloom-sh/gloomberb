import { afterEach, describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { act, useReducer } from "react";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { apiClient, setCloudApiFetchTransport } from "../../../api-client";
import { appReducer, createInitialState } from "../../../state/app/context";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { createDefaultConfig } from "../../../types/config";
import { ResearchSearchPane } from "./pane";
import { TestPaneProvider } from "../../../test-support/pane";

const PANE_ID = "research-search:test";

const HIT = {
  id: "hit-1",
  docType: "transcript",
  sourceId: "call-1",
  chunkIndex: 2,
  ticker: "AAPL",
  publishedAt: "2026-05-02T21:00:00.000Z",
  title: "Apple FQ2 2026 Earnings Call",
  url: "https://example.com/call-1",
  snippet: "we expect <mark>gross margin</mark> to expand",
  score: 4.2,
  metadata: { speaker: "Tim Cook", role: "CEO", isQa: false },
};

const DOCUMENT = {
  docType: "transcript",
  sourceId: "call-1",
  ticker: "AAPL",
  title: "Apple FQ2 2026 Earnings Call",
  url: "https://example.com/call-1",
  publishedAt: "2026-05-02T21:00:00.000Z",
  chunks: [
    {
      id: "chunk-0",
      chunkIndex: 0,
      body: "Operator opening remarks.",
      metadata: { speaker: "Operator" },
    },
    {
      id: "chunk-2",
      chunkIndex: 2,
      body: "we expect gross margin to expand next quarter",
      metadata: { speaker: "Tim Cook", role: "CEO" },
    },
  ],
};

const tui = createOpenTuiTestHarness();

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    text: async () => JSON.stringify(body),
  } as Response;
}

const SAVED_SEARCH = {
  id: "saved-1",
  name: "gross margin",
  query: "gross margin",
  filters: { tickers: ["AAPL"], docTypes: ["transcript"] },
  alertEnabled: false,
  alertChannels: [],
  lastRunAt: null,
  lastMatchAt: "2026-05-03T09:00:00.000Z",
  matchCount: 4,
  createdAt: "2026-05-01T00:00:00.000Z",
};

interface RecordedRequest {
  path: string;
  method: string;
  body?: unknown;
}

function installTransport(): { requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  setCloudApiFetchTransport(async (url, init) => {
    const parsed = new URL(String(url));
    requests.push({
      path: parsed.pathname,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (parsed.pathname === "/cloud/search/saved") {
      return jsonResponse({ searches: [SAVED_SEARCH] });
    }
    if (parsed.pathname.startsWith("/cloud/search/saved/")) {
      return jsonResponse({ search: { ...SAVED_SEARCH, alertEnabled: true } });
    }
    if (parsed.pathname === "/cloud/search") {
      return jsonResponse({
        hits: [HIT],
        total: 1,
        countCapped: false,
        hasMore: false,
        nextOffset: 1,
        tookMs: 12,
      });
    }
    if (parsed.pathname.startsWith("/cloud/search/documents/")) {
      return jsonResponse({ document: DOCUMENT });
    }
    return jsonResponse({});
  });
  return { requests };
}

function signIn(plan: "free" | "pro" = "free"): void {
  apiClient.setSessionToken("test-session");
  apiClient.restoreCachedUser({
    id: "user-1",
    name: "Test",
    email: "test@example.com",
    username: "test",
    emailVerified: true,
    plan,
    effectivePlan: plan,
  } as never);
}

function Harness({ mode = "results" }: { mode?: "results" | "saved" }) {
  const initialState = createInitialState(createDefaultConfig(join(homedir(), ".cache/gloom-smoke/glo239/research-search-test")));
  initialState.focusedPaneId = PANE_ID;
  initialState.paneState[PANE_ID] = {
    pluginState: { "research-search": { query: "gross margin", mode } },
  } as never;
  const [state, dispatch] = useReducer(appReducer, initialState);

  return (
    <TestPaneProvider state={state} dispatch={dispatch} paneId={PANE_ID} pluginId="research-search" runtime={createTestPluginRuntime()}>
      <ResearchSearchPane
        paneId={PANE_ID}
        paneType="research-search"
        focused
        width={110}
        height={20}
      />
    </TestPaneProvider>
  );
}

async function pressKey(name: string, shift = false) {
  await tui.emitKeypress({ name, shift }, { frames: 0, trackPropagation: true });
  await tui.setup().renderOnce();
}

async function renderPane(mode: "results" | "saved" = "results") {
  const { root, setup } = await tui.createRoot({ width: 110, height: 20 });
  await act(async () => root.render(<Harness mode={mode} />));
  await setup.renderOnce();
}

afterEach(() => {
  setCloudApiFetchTransport(null);
  apiClient.setSessionToken(null);
});

describe("ResearchSearchPane", () => {
  // Searching and reading a hit are free: the pane used to refuse to issue the
  // request at all without Pro, which was stricter than the server ever was.
  test("a free account searches and opens the document at the chunk that matched", async () => {
    installTransport();
    signIn();

    await renderPane();
    await tui.waitForFrameToContain("Apple FQ2 2026 Earnings Call");

    await pressKey("return");

    const frame = await tui.waitForFrameToContain("Tim Cook");
    expect(frame).toContain("Tim Cook");
    expect(frame).toContain("to expand next quarter");
  });

  // A field owns the keyboard, so Tab has to be claimed ahead of the app's
  // pane cycle to reach the other field instead of leaving the pane.
  test("Tab and Shift+Tab move between the query and tickers fields", async () => {
    installTransport();
    signIn();

    await renderPane();
    await tui.waitForFrameToContain("Apple FQ2 2026 Earnings Call");

    // Esc clears whichever field is active, which shows where Tab landed.
    await pressKey("/");
    await pressKey("tab");
    await pressKey("escape");
    expect(tui.frame()).toContain("Apple FQ2 2026 Earnings Call");

    await pressKey("/");
    await pressKey("tab");
    await pressKey("tab", true);
    await pressKey("escape");
    await tui.waitForFrameToContain("Type a query to search");
  });

  test("flips a saved-search alert and persists it", async () => {
    const { requests } = installTransport();
    signIn("pro");

    await renderPane("saved");
    await tui.waitForFrameToContain("[ ]");

    await pressKey("a");
    await tui.waitForFrameToContain("[\u2713]");

    const write = requests.find((request) => request.method === "PATCH");
    expect(write?.path).toBe("/cloud/search/saved/saved-1");
    expect(write?.body).toEqual({ alertEnabled: true });
    expect(tui.frame()).toContain("[\u2713]");
  });
});
