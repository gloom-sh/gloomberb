import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, useReducer } from "react";
import { apiClient, setCloudApiFetchTransport } from "../../../../api-client";
import { PaneFooterProvider } from "../../../../components/layout/pane/footer";
import { createOpenTuiTestHarness, TestDialogProvider } from "../../../../renderers/opentui/test-utils";
import { appReducer, createInitialState } from "../../../../state/app/context";
import { createTestPaneConfig, TestPaneProvider } from "../../../../test-support/pane";
import { createTestPluginRuntime } from "../../../../test-support/plugin-runtime";
import { setSharedRegistryForTests, type PluginRegistry } from "../../../registry";
import { Box, Text } from "../../../../ui";
import { askgConversationListStore } from "./conversation-store";
import { resetASKGClientManifestCache } from "./host";
import type { ASKGToolRow } from "./model";
import { ASKGPane } from "./pane";
import { describeToolRow } from "./tool-display";
import { ToolTimelineRow } from "./tool-timeline";

const tui = createOpenTuiTestHarness();

const PANE_ID = "askg-test-pane";
/** Narrow enough that the failure cannot fit on one line, and no sidebar. */
const PANE_WIDTH = 64;
/** Past the sidebar breakpoint, so the conversation list has room. */
const WIDE_PANE_WIDTH = 96;

const requests: string[] = [];
const sessionBodies: Array<Record<string, unknown>> = [];
const feedbackBodies: Array<Record<string, unknown>> = [];
let configPortfolios: Array<{ id: string; name: string; currency: string; brokerInstanceId?: string }> = [];
let sessionStatus = 200;
let storedConversations: Array<Record<string, unknown>> = [];
let storedTranscripts: Record<string, Record<string, unknown>> = {};

function Harness({ paneWidth = PANE_WIDTH, focused = true }: { paneWidth?: number; focused?: boolean }) {
  const [state, dispatch] = useReducer(appReducer, undefined, () => {
    const initial = createInitialState(createTestPaneConfig("/tmp/gloomberb-askg-pane", {
      instanceId: PANE_ID,
      paneId: "askg",
    }));
    initial.focusedPaneId = focused ? PANE_ID : null;
    initial.config = { ...initial.config, portfolios: configPortfolios };
    return initial;
  });
  return (
    <TestDialogProvider>
      <Box flexDirection="column" width={paneWidth} height={24}>
        <TestPaneProvider state={state} dispatch={dispatch} paneId={PANE_ID} pluginId="gloomberb-cloud" runtime={createTestPluginRuntime()}>
          <PaneFooterProvider>
            {(footer) => (
              <>
                <ASKGPane paneId={PANE_ID} paneType="askg" focused={focused} width={paneWidth} height={20} />
                <Text>{`footer: ${footer.hints.map((hint) => `[${hint.key}]${hint.label}`).join(" ")}`}</Text>
              </>
            )}
          </PaneFooterProvider>
        </TestPaneProvider>
      </Box>
    </TestDialogProvider>
  );
}

const tick = () => act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 5));
});

async function flush(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await tick();
}

function conversation(id: string, title: string) {
  const at = "2026-09-20T10:00:00.000Z";
  return {
    id,
    title,
    messageCount: 2,
    lastMessageAt: at,
    createdAt: at,
    updatedAt: at,
  };
}

function transcript(id: string, question: string, answer: string) {
  const at = "2026-09-20T10:00:00.000Z";
  return {
    ...conversation(id, question),
    messages: [
      { seq: 1, role: "user", text: question, tools: [], turnId: "turn-a", createdAt: at },
      { seq: 2, role: "assistant", text: answer, tools: [], turnId: "turn-a", createdAt: at },
    ],
  };
}

beforeEach(() => {
  requests.length = 0;
  sessionBodies.length = 0;
  feedbackBodies.length = 0;
  configPortfolios = [];
  sessionStatus = 200;
  storedConversations = [];
  storedTranscripts = {};
  askgConversationListStore.reset();
  // A transport that buffers whole responses, which is what the desktop had
  // before the streaming bridge: `isStreamingSupported` is false.
  setCloudApiFetchTransport(async (url, init) => {
    const parsed = new URL(url);
    requests.push(`${init?.method ?? "GET"} ${parsed.pathname}`);
    if (parsed.pathname === "/askg/session") {
      if (typeof init?.body === "string") sessionBodies.push(JSON.parse(init.body));
      if (sessionStatus !== 200) {
        return new Response(JSON.stringify({ message: "Ask Gloom is unavailable." }), {
          status: sessionStatus,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({
        protocolVersion: 1,
        sessionId: "s1",
        manifestHash: "sha256:test",
        serverTools: [],
        acceptedTools: [],
        rejectedTools: [],
        limits: {
          requestsPerMinute: 20,
          turnsPerDay: 300,
          turnsRemainingToday: 300,
          maxToolCallsPerTurn: 8,
          turnWallClockMs: 60_000,
          clientToolTimeoutMs: 10_000,
        },
        tier: "pro",
        model: "gloom-1",
        promptVersion: "v1",
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (parsed.pathname.startsWith("/askg/turns/") && init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      feedbackBodies.push(body);
      // Like the route: the stored rating, and once sent always sent.
      const shared = body.share === true || feedbackBodies.some((entry) => entry.share === true);
      return new Response(JSON.stringify({
        turnId: decodeURIComponent(parsed.pathname.split("/")[3] ?? ""),
        rating: body.rating,
        reason: body.reason ?? null,
        shared,
        updatedAt: "2026-09-20T10:01:00.000Z",
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (parsed.pathname === "/askg/conversations") {
      return new Response(
        JSON.stringify({ count: storedConversations.length, items: storedConversations }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    const stored = parsed.pathname.startsWith("/askg/conversations/")
      ? storedTranscripts[decodeURIComponent(parsed.pathname.split("/").at(-1) ?? "")]
      : undefined;
    if (parsed.pathname.startsWith("/askg/conversations/")) {
      if (!stored) return new Response("{}", { status: 404 });
      return new Response(JSON.stringify(stored), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  });
  apiClient.setSessionToken("askg-pane-session");
  apiClient.restoreCachedUser({ id: "u0", username: "ada", emailVerified: true, plan: "pro" });
  // The manifest only needs the pane catalog; no pane has to be registered for
  // the session to negotiate an empty tool set.
  resetASKGClientManifestCache();
  setSharedRegistryForTests({
    panes: new Map(),
    paneTemplates: new Map(),
  } as unknown as PluginRegistry);
});

afterEach(() => {
  setCloudApiFetchTransport(null);
  apiClient.setSessionToken(null);
  resetASKGClientManifestCache();
  setSharedRegistryForTests(undefined);
  askgConversationListStore.reset();
});

async function renderPane(paneWidth: number, focused = true): Promise<string> {
  await act(async () => {
    await tui.render(<Harness paneWidth={paneWidth} focused={focused} />, {
      width: paneWidth,
      height: 24,
    });
  });
  await flush();
  return tui.frame();
}

async function type(text: string): Promise<void> {
  await act(async () => {
    tui.setup().mockInput.typeText(text);
    await tui.setup().renderOnce();
  });
}

async function pressEnter(): Promise<void> {
  await act(async () => {
    tui.setup().mockInput.pressEnter();
    await tui.setup().renderOnce();
  });
}

/** Opens the pane and types straight away: the composer has the keyboard from the start. */
async function ask(question: string): Promise<string> {
  await renderPane(PANE_WIDTH);
  await type(question);
  await pressEnter();
  await flush();
  return tui.frame();
}

describe("ASKGPane failures", () => {
  test("a failure too long for the pane keeps its tail instead of running off the edge", async () => {
    const frame = await ask("what does a 5y bond return");

    expect(frame).toContain("Streaming unavailable");
    // The tail is the part the old single-line render lost.
    expect(frame).toContain("cannot open");
    // Nothing to retry: asking again in the same window fails the same way.
    expect(frame).not.toContain("[r]etry");
  });

  test("a failure a new attempt could answer offers a retry that asks again", async () => {
    sessionStatus = 503;
    const frame = await ask("what does a 5y bond return");

    expect(frame).toContain("Ask Gloom is unavailable");
    expect(frame).toContain("Retry");
    expect(frame).toContain("[r]etry");
    expect(requests.filter((entry) => entry === "POST /askg/session")).toHaveLength(1);

    // The composer keeps the keyboard for the next question; Esc hands it to the answer.
    await tui.emitKeypress({ name: "escape" });
    await tui.emitKeypress({ name: "r" });
    await flush();

    expect(requests.filter((entry) => entry === "POST /askg/session")).toHaveLength(2);
    // The failed attempt is replaced, not stacked above the retry.
    const retried = tui.frame();
    expect(retried.split("what does a 5y bond return").length - 1).toBe(1);
  });
});

describe("ASKGPane tool rows", () => {
  test("a partial row is one line and one short note, never the note Gloom reads", async () => {
    const row = (patch: Partial<ASKGToolRow>): ASKGToolRow => ({
      toolCallId: patch.name ?? "row",
      name: "pf",
      argumentSummary: "",
      writeTier: "read",
      origin: "client",
      status: "partial",
      requiresConfirmation: false,
      result: { rows: [] },
      expanded: false,
      ...patch,
    });
    const rows = [
      row({
        name: "pf",
        args: { text: "broker:ibkr-main:U1234567", limit: 200 },
        rowCount: 94,
        elapsedMs: 1_200,
        note: "No market value or P&L for 2337, 700, 7203, ARKK, SHOP, SQ, WMT; totals and weights leave them out",
      }),
      row({
        name: "port",
        args: { text: "broker:ibkr-main:U1234567", view: "risk" },
        rowCount: 8,
        elapsedMs: 6_300,
        note: "Quote listing differs from the requested holding (ARKK, SHOP, WMT, IEF); Treasury yield: Internal server error; "
          + "Volatility: Internal server error; Basket covers at most 94% of market value · 7 holdings left out; "
          + "metadata.coverage lists each with its reason; 3 holdings had no current quote; weighted at the latest completed close",
      }),
      row({ name: "cpi", status: "error", args: { text: "]" }, elapsedMs: 300, note: 'Request failed: {"code":"E_ARG"}' }),
    ];
    await act(async () => {
      await tui.render(
        <TestDialogProvider>
          <Box flexDirection="column" width={70} height={8}>
            {rows.map((entry) => (
              <ToolTimelineRow key={entry.toolCallId} row={entry} view={describeToolRow(entry)} width={70}
                selected={false} expanded={false} selectedRowRef={() => {}} onPress={() => {}} onUndo={() => {}} />
            ))}
          </Box>
        </TestDialogProvider>,
        { width: 70, height: 8 },
      );
    });
    await flush();
    const lines = tui.frame().split("\n").map((line) => line.trimEnd());

    expect(lines[0]).toMatch(/^▸ Holdings +U1234567 +94 rows · 1\.2 s ✓$/);
    expect(lines[1]?.trim()).toBe("7 of 94 positions had no price");
    expect(lines[2]).toMatch(/^▸ Portfolio risk +U1234567 · risk +8 rows · 6\.3 s ✓$/);
    expect(lines[3]?.trim()).toBe("Risk covers up to 94% of the portfolio's value · 7 holdings left out");
    expect(lines[4]).toMatch(/^▸ CPI +\] +300 ms x$/);
    expect(lines[5]?.trim()).toBe("Could not load this");
    expect(tui.frame()).not.toMatch(/metadata|Internal server error|E_ARG/);
  });
});

describe("ASKGPane context", () => {
  test("a question carries the user's portfolio ids, so Gloom does not guess them", async () => {
    sessionStatus = 503;
    configPortfolios = [
      { id: "main", name: "Main Portfolio", currency: "USD" },
      { id: "broker:ibkr-main:U1234567", name: "U1234567", currency: "USD", brokerInstanceId: "ibkr-main" },
    ];
    await ask("what do i have open");

    const context = sessionBodies[0]?.context as { userData?: { portfolios?: unknown[] } } | undefined;
    expect(context?.userData?.portfolios).toEqual([
      { id: "main", name: "Main Portfolio", kind: "manual" },
      { id: "broker:ibkr-main:U1234567", name: "U1234567", kind: "broker" },
    ]);
  });
});

describe("ASKGPane keyboard", () => {
  test("typing lands in the composer the moment the pane opens, with no Enter first", async () => {
    await renderPane(PANE_WIDTH);
    await type("what moved nvda");
    await flush();
    expect(tui.frame()).toContain("> what moved nvda");
  });

  test("a pane without the keyboard leaves typing to the pane that has it", async () => {
    await renderPane(PANE_WIDTH, false);
    await type("what moved nvda");
    await flush();
    expect(tui.frame()).not.toContain("what moved nvda");
  });

  test("an example question asks itself from the keyboard", async () => {
    sessionStatus = 503;
    await renderPane(PANE_WIDTH);
    // Up from an empty composer walks into the examples; Enter sends one.
    await tui.emitKeypress({ name: "up" });
    await tui.emitKeypress({ name: "return" });
    await flush();
    expect(requests).toContain("POST /askg/session");
    expect(tui.frame()).toContain("What is on this week's economic calendar?");

    // Asking hands the keyboard back to the composer: the next letters are a
    // follow-up, not shortcuts (n would start a new conversation).
    await type("and next week");
    await flush();
    expect(tui.frame()).toContain("> and next week");
    expect(tui.frame()).toContain("What is on this week's economic calendar?");
  });
});

describe("ASKGPane conversations", () => {
  test("the list never takes the left of the pane unasked; Left opens it", async () => {
    storedConversations = [
      conversation("conv-1", "Bond returns"),
      conversation("conv-2", "Nvidia margins"),
    ];
    const frame = await renderPane(WIDE_PANE_WIDTH);

    expect(requests).toContain("GET /askg/conversations");
    expect(frame).not.toContain("Bond returns");
    expect(frame).toContain("[←] conversations");

    // Left in an empty composer opens it, the way chat's does.
    await tui.emitKeypress({ name: "left" });
    await flush();
    expect(tui.frame()).toContain("Bond returns");
    expect(tui.frame()).toContain("Nvidia margins");

    await tui.emitKeypress({ name: "escape" });
    await flush();
    expect(tui.frame()).not.toContain("Bond returns");
  });

  test("a pane too narrow for the list beside the answer shows it in the answer's place", async () => {
    storedConversations = [
      conversation("conv-1", "Bond returns"),
      conversation("conv-2", "Nvidia margins"),
    ];
    storedTranscripts = {
      "conv-2": transcript("conv-2", "how are Nvidia margins", "Holding above 70%."),
    };
    const frame = await renderPane(PANE_WIDTH);
    expect(frame).not.toContain("Bond returns");

    await tui.emitKeypress({ name: "left" });
    await flush();
    expect(tui.frame()).toContain("Bond returns");
    expect(tui.frame()).not.toContain("Ask about your portfolio");

    await tui.emitKeypress({ name: "down" });
    await tui.emitKeypress({ name: "return" });
    await flush();
    expect(tui.frame()).not.toContain("Bond returns");
    expect(tui.frame()).toContain("Holding above 70%");
  });

  test("walking the list loads nothing until a row is opened, and only the open row is marked", async () => {
    storedConversations = [
      conversation("conv-1", "Bond returns"),
      conversation("conv-2", "Nvidia margins"),
    ];
    storedTranscripts = {
      "conv-2": transcript("conv-2", "how are Nvidia margins", "Holding above 70%."),
    };
    await renderPane(WIDE_PANE_WIDTH);

    await tui.emitKeypress({ name: "left" });
    await tui.emitKeypress({ name: "down" });
    await flush();
    expect(requests.filter((entry) => entry.startsWith("GET /askg/conversations/"))).toEqual([]);

    await tui.emitKeypress({ name: "return" });
    await flush();

    expect(requests).toContain("GET /askg/conversations/conv-2");
    expect(tui.frame()).toContain("how are Nvidia margins");
    expect(tui.frame()).toContain("Holding above 70%");

    // The list opens again on the conversation that is open, and only it is marked.
    await tui.emitKeypress({ name: "left" });
    await flush();
    const marked = tui.frame()
      .split("\n")
      .filter((line) => line.includes("\u203a"))
      .map((line) => line.trim());
    expect(marked).toHaveLength(1);
    expect(marked[0]).toContain("Nvidia margins");
  });

  test("nothing on screen is lost by accident: a new conversation and a closed pane both lead back", async () => {
    storedConversations = [conversation("conv-1", "Bond returns")];
    storedTranscripts = {
      "conv-1": transcript("conv-1", "what does a 5y bond return", "About 4.2%."),
    };
    // Even a single stored conversation is reachable: it is not the one on screen.
    await renderPane(WIDE_PANE_WIDTH);
    await tui.emitKeypress({ name: "left" });
    await tui.emitKeypress({ name: "return" });
    await flush();
    expect(tui.frame()).toContain("About 4.2%");

    // Esc then n starts over; the answer is one Left and Enter away.
    await tui.emitKeypress({ name: "escape" });
    await tui.emitKeypress({ name: "n" });
    await flush();
    expect(tui.frame()).not.toContain("About 4.2%");
    expect(tui.frame()).toContain("Ask about your portfolio");
    await tui.emitKeypress({ name: "left" });
    await flush();
    expect(tui.frame()).toContain("Bond returns");
    await tui.emitKeypress({ name: "return" });
    await flush();
    expect(tui.frame()).toContain("About 4.2%");

    // Closing the pane (Esc Esc) and opening it again brings the conversation back.
    await act(async () => {
      await tui.render(<Box />, { width: WIDE_PANE_WIDTH, height: 24 });
    });
    await renderPane(WIDE_PANE_WIDTH);
    expect(tui.frame()).toContain("About 4.2%");
  });
});

describe("ASKGPane answer ratings", () => {
  const ANSWER = "Holding above 70%.";

  /** Opens a stored conversation whose answers the server says can be rated. */
  async function openRateable(
    feedback: Record<string, unknown> | null = null,
    rateable = true,
    earlier: Array<Record<string, unknown>> = [],
  ): Promise<string> {
    const base = transcript("conv-2", "how are Nvidia margins", ANSWER);
    const stored = { ...base, messages: [...earlier, ...(base.messages as Array<Record<string, unknown>>)] };
    storedConversations = [
      conversation("conv-1", "Bond returns"),
      conversation("conv-2", "Nvidia margins"),
    ];
    storedTranscripts = {
      "conv-2": {
        ...stored,
        ...(rateable ? { capabilities: { feedback: 1 } } : {}),
        messages: (stored.messages as Array<Record<string, unknown>>).map((message) => (
          message.role === "assistant" && rateable ? { ...message, feedback } : message
        )),
      },
    };
    await renderPane(WIDE_PANE_WIDTH);
    await tui.emitKeypress({ name: "left" });
    await tui.emitKeypress({ name: "down" });
    await tui.emitKeypress({ name: "return" });
    await flush();
    // An opened conversation gives the composer the keyboard; Esc hands it to the answer.
    await tui.emitKeypress({ name: "escape" });
    await flush();
    return tui.frame();
  }

  test("an older server gets no control and no request", async () => {
    const frame = await openRateable(null, false);
    expect(frame).toContain(ANSWER);
    expect(frame).not.toContain("+1");
    expect(frame).not.toContain("[g]ood");

    await tui.emitKeypress({ name: "b" });
    await flush();
    expect(feedbackBodies).toEqual([]);
  });

  test("the keyboard rates the answer, picks a reason and sends it", async () => {
    const frame = await openRateable();
    // The thumbs sit under the answer, keyed while it is the one being rated.
    expect(frame).toContain("+1 g");
    expect(frame).toContain("-1 b");
    expect(frame).toContain("[g]ood");
    expect(frame).toContain("[b]ad");
    expect(frame).not.toContain("Send this answer to Gloom");

    await tui.emitKeypress({ name: "b" });
    await flush();
    expect(feedbackBodies).toEqual([{ rating: "down", reason: null }]);
    expect(requests).toContain("PUT /askg/turns/turn-a/feedback");
    const followUp = tui.frame();
    expect(followUp).toContain("Wrong");
    expect(followUp).toContain("Too slow");
    expect(followUp).toContain("Missing data");
    expect(followUp).toContain("Other");
    expect(followUp).toContain("Send this answer to Gloom");
    // The line wraps; what it promises is the point, not where it breaks.
    const disclosure = followUp.replace(/[\s│]+/g, " ");
    expect(disclosure).toContain("Sends your question, this answer as written (it can mention your holdings) and which tools ran, not the data they returned.");
    expect(followUp).toContain("[1]wrong [2]slow [3]missing [4]other [s]end");

    await tui.emitKeypress({ name: "3" });
    await flush();
    expect(feedbackBodies.at(-1)).toEqual({ rating: "down", reason: "missing_data" });

    await tui.emitKeypress({ name: "s" });
    await flush();
    expect(feedbackBodies.at(-1)).toEqual({ rating: "down", reason: "missing_data", share: true });
    const sent = tui.frame();
    expect(sent).toContain("Sent to Gloom");
    expect(sent).not.toContain("Send this answer to Gloom");
  });

  test("Esc closes the reasons without sending, and a thumbs up needs nothing more", async () => {
    await openRateable();
    await tui.emitKeypress({ name: "b" });
    await flush();
    expect(tui.frame()).toContain("Send this answer to Gloom");

    await tui.emitKeypress({ name: "escape" });
    await flush();
    expect(tui.frame()).not.toContain("Send this answer to Gloom");

    await tui.emitKeypress({ name: "g" });
    await flush();
    expect(feedbackBodies).toEqual([
      { rating: "down", reason: null },
      { rating: "up", reason: null },
    ]);
    expect(tui.frame()).not.toContain("Wrong");
  });

  test("the mouse rates, picks a reason and sends", async () => {
    await openRateable();
    await tui.clickFrameText("+1");
    await flush();
    expect(feedbackBodies).toEqual([{ rating: "up", reason: null }]);

    await tui.clickFrameText("-1");
    await flush();
    expect(feedbackBodies.at(-1)).toEqual({ rating: "down", reason: null });

    await tui.clickFrameText("Too slow");
    await flush();
    expect(feedbackBodies.at(-1)).toEqual({ rating: "down", reason: "slow" });

    await tui.clickFrameText("Send this answer to Gloom");
    await flush();
    expect(feedbackBodies.at(-1)).toEqual({ rating: "down", reason: "slow", share: true });
    expect(tui.frame()).toContain("Sent to Gloom");
  });

  test("j and k walk to an earlier answer, and the keys rate the answer they are on", async () => {
    const at = "2026-09-20T09:00:00.000Z";
    await openRateable(null, true, [
      { seq: -1, role: "user", text: "and AMD margins", tools: [], turnId: "turn-0", createdAt: at },
      { seq: 0, role: "assistant", text: "Around 50%.", tools: [], turnId: "turn-0", createdAt: at, feedback: null },
    ]);
    const keyed = (frame: string) => frame.split("\n").filter((line) => line.includes("+1 g")).length;
    // Only the newest answer shows the keys until the keyboard moves.
    expect(keyed(tui.frame())).toBe(1);
    expect(tui.frame().indexOf("+1 g")).toBeGreaterThan(tui.frame().indexOf("Holding above 70%."));

    await tui.emitKeypress({ name: "k" });
    await tui.emitKeypress({ name: "k" });
    await flush();
    const moved = tui.frame();
    expect(keyed(moved)).toBe(1);
    expect(moved.indexOf("+1 g")).toBeLessThan(moved.indexOf("Holding above 70%."));

    await tui.emitKeypress({ name: "g" });
    await flush();
    expect(requests).toContain("PUT /askg/turns/turn-0/feedback");
    expect(requests).not.toContain("PUT /askg/turns/turn-a/feedback");
  });

  test("a rating given before shows when the conversation is opened again", async () => {
    const frame = await openRateable({ rating: "down", reason: "wrong", shared: true });
    expect(frame).toContain("Sent to Gloom");
    // A sent answer offers no second send.
    expect(frame).not.toContain("Send this answer to Gloom");
    expect(feedbackBodies).toEqual([]);
  });
});
