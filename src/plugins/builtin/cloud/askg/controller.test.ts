import { describe, expect, test } from "bun:test";
import { ASKGTransportError } from "../../../../api-client/askg";
import type {
  ASKGStreamOptions,
  ASKGToolResultOutcome,
  ASKGTransport,
} from "../../../../api-client/askg";
import type { MarketContext } from "../../../../cli/types";
import type { PaneFunctionCatalog } from "../../../../cli/pane-functions/catalog";
import type { RemoteControlRequest, RemoteControlResponse, RemoteUiNodeSnapshot } from "../../../../remote/types";
import { ASKGSessionController, CONFIRMATION_CLOSE_MARGIN_MS, type ASKGControllerManifest } from "./controller";
import { CONFIRMATION_WAITING_NOTE, createASKGToolExecutor, type ASKGToolExecutor } from "./executor";
import { buildASKGToolManifests } from "./manifest";
import { canRateTurn, NOT_APPROVED_IN_TIME_NOTE, pendingConfirmation } from "./model";
import type {
  ASKGFeedback,
  ASKGFeedbackRequest,
  ASKGSessionStartRequest,
  ASKGSessionStartResponse,
  ASKGSseEvent,
  ASKGToolCallEvent,
  ASKGTurnRequest,
  ClientToolManifest,
  JsonValue,
  ToolResultPayload,
} from "./protocol";

const READ_TOOL: ClientToolManifest = {
  name: "app.get_resource",
  source: "remote-op",
  title: "App: Get resource",
  description: "Read an app resource.",
  writeTier: "read",
  confirm: "never",
  timeoutMs: 10_000,
};

const WRITE_TOOL: ClientToolManifest = {
  ...READ_TOOL,
  name: "layout.delete",
  title: "Layout: Delete",
  writeTier: "user-data",
  confirm: "always",
};

const MANIFEST = { tools: [READ_TOOL, WRITE_TOOL], manifestHash: "sha256:test" };

function sessionResponse(manifest: ASKGControllerManifest = MANIFEST): ASKGSessionStartResponse {
  return {
    protocolVersion: 1,
    sessionId: "s1",
    manifestHash: manifest.manifestHash,
    serverTools: [],
    acceptedTools: manifest.tools.map((tool) => tool.name),
    rejectedTools: [],
    limits: {
      requestsPerMinute: 20,
      turnsPerDay: 100,
      turnsRemainingToday: 99,
      maxToolCallsPerTurn: 8,
      turnWallClockMs: 60_000,
      clientToolTimeoutMs: 10_000,
    },
    tier: "pro",
    model: "gloom-1",
    promptVersion: "v1",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
}

function toolCallEvent(seq: number, tool: ClientToolManifest): ASKGSseEvent {
  return {
    seq,
    type: "tool-call",
    turnId: "turn-1",
    toolCallId: `call-${seq}`,
    name: tool.name,
    args: { resource: "app://panes" },
    writeTier: tool.writeTier,
    requiresConfirmation: tool.confirm === "always",
    preview: { operation: tool.name },
    timeoutMs: tool.timeoutMs,
    expiresAt: new Date(Date.now() + tool.timeoutMs).toISOString(),
  };
}

interface Harness {
  controller: ASKGSessionController;
  posted: ToolResultPayload[];
  sessionRequests: ASKGSessionStartRequest[];
  turnRequests: ASKGTurnRequest[];
  emit(event: ASKGSseEvent): void;
  streamed: Promise<void>;
}

function createHarness(options: {
  script: ASKGSseEvent[];
  executor?: ASKGToolExecutor;
  manifest?: ASKGControllerManifest;
  toolResultOutcome?: ASKGToolResultOutcome;
  toolResultError?: Error;
} ): Harness {
  const posted: ToolResultPayload[] = [];
  const sessionRequests: ASKGSessionStartRequest[] = [];
  const turnRequests: ASKGTurnRequest[] = [];
  let emit: (event: ASKGSseEvent) => void = () => {};
  let finishStream: (() => void) | null = null;

  const transport: ASKGTransport = {
    isStreamingSupported: () => true,
    async startSession(request) {
      sessionRequests.push(request);
      return sessionResponse(options.manifest);
    },
    async streamTurn(_sessionId: string, request: ASKGTurnRequest, streamOptions: ASKGStreamOptions) {
      turnRequests.push(request);
      emit = (event) => streamOptions.onEvent(event);
      await new Promise<void>((resolve) => {
        finishStream = resolve;
      });
      return "complete";
    },
    async postToolResult(_sessionId: string, payload: ToolResultPayload) {
      posted.push(payload);
      if (options.toolResultError) throw options.toolResultError;
      return options.toolResultOutcome ?? "accepted";
    },
    async cancelTurn() {},
    ...noConversations,
  };

  const controller = new ASKGSessionController({
    transport,
    loadManifest: async () => options.manifest ?? MANIFEST,
    getExecutor: () => options.executor ?? null,
    client: { kind: "tui", version: "1" },
    createId: () => "turn-1",
  });

  const streamed = controller.ask("what is open").then(() => {});
  return {
    controller,
    posted,
    sessionRequests,
    turnRequests,
    streamed,
    emit: (event) => {
      emit(event);
      if (event.type === "done") finishStream?.();
    },
  };
}

function executorReturning(payload: Partial<ToolResultPayload>): {
  executor: ASKGToolExecutor;
  calls: Array<{ name: string; confirmed: boolean | undefined }>;
} {
  const calls: Array<{ name: string; confirmed: boolean | undefined }> = [];
  return {
    calls,
    executor: {
      async execute(call, executeOptions) {
        calls.push({ name: call.name, confirmed: executeOptions?.confirmed });
        return {
          turnId: call.turnId,
          toolCallId: call.toolCallId,
          status: "ok",
          truncated: false,
          elapsedMs: 5,
          ...payload,
        };
      },
      async gate() {
        return null;
      },
      async undo() {
        return { status: "ok", elapsedMs: 1 };
      },
    },
  };
}

async function settle(): Promise<void> {
  // Calls that change something take turns, which costs a few more microtasks.
  for (let index = 0; index < 24; index += 1) await Promise.resolve();
}

/**
 * A controller on a server that answers each new session with the next
 * capabilities in `accepted`, and ends every turn straight away.
 */
function negotiationHarness(accepted: unknown[]) {
  const sessionRequests: ASKGSessionStartRequest[] = [];
  const turnRequests: ASKGTurnRequest[] = [];
  let clock = Date.parse("2026-10-01T12:00:00.000Z");
  let sessions = 0;
  let turns = 0;
  const transport: ASKGTransport = {
    isStreamingSupported: () => true,
    async startSession(request) {
      sessionRequests.push(request);
      const capabilities = accepted[sessions];
      sessions += 1;
      return {
        ...sessionResponse(),
        sessionId: `s${sessions}`,
        expiresAt: new Date(clock + 60_000).toISOString(),
        ...(capabilities === undefined
          ? {}
          : { capabilities: capabilities as ASKGSessionStartResponse["capabilities"] }),
      };
    },
    async streamTurn(_sessionId, request, streamOptions) {
      turnRequests.push(request);
      streamOptions.onEvent({ seq: 1, type: "done", turnId: request.turnId, reason: "complete" });
      return "complete";
    },
    async postToolResult() {
      return "accepted";
    },
    async cancelTurn() {},
    ...noConversations,
  };
  const controller = new ASKGSessionController({
    transport,
    loadManifest: async () => MANIFEST,
    getExecutor: () => null,
    client: { kind: "tui", version: "1" },
    now: () => clock,
    createId: () => `turn-${(turns += 1)}`,
  });
  return {
    controller,
    sessionRequests,
    turnRequests,
    advance(ms: number) {
      clock += ms;
    },
  };
}

/** The conversation and rating surface a turn-focused double never exercises. */
const noConversations = {
  async listConversations() {
    return [];
  },
  async loadConversation() {
    return null;
  },
  async renameConversation() {
    return null;
  },
  async deleteConversation() {
    return false;
  },
  async sendFeedback() {
    return null;
  },
};

describe("ASKGSessionController", () => {
  test("runs a read tool through the executor and posts the result back", async () => {
    const { executor, calls } = executorReturning({ rowCount: 6, result: { rows: [] } });
    const harness = createHarness({ script: [], executor });
    await settle();

    harness.emit(toolCallEvent(1, READ_TOOL));
    await settle();

    expect(calls).toEqual([{ name: "app.get_resource", confirmed: true }]);
    expect(harness.posted).toHaveLength(1);
    expect(harness.posted[0]).toMatchObject({
      toolCallId: "call-1",
      status: "ok",
      rowCount: 6,
    });

    const row = harness.controller.getState().turns[0]?.tools[0];
    expect(row).toMatchObject({ name: "app.get_resource", status: "ok", rowCount: 6 });

    harness.emit({ seq: 2, type: "done", turnId: "turn-1", reason: "complete" });
    await harness.streamed;
  });

  test("sends the client turn id and the negotiated manifest", async () => {
    const harness = createHarness({ script: [] });
    await settle();
    expect(harness.sessionRequests[0]).toMatchObject({
      protocolVersion: 1,
      manifestHash: MANIFEST.manifestHash,
    });
    expect(harness.turnRequests[0]).toMatchObject({ turnId: "turn-1", input: "what is open" });
    harness.emit({ seq: 1, type: "done", turnId: "turn-1", reason: "complete" });
    await harness.streamed;
  });

  test("offers scripts, sources and follow-ups at session start and asks for them on every turn the session accepted them for", async () => {
    const harness = negotiationHarness([{ scripts: 1, sources: 1, feedback: 1, followUps: 1 }, undefined]);
    await harness.controller.ask("first");
    await harness.controller.ask("second");

    expect(harness.sessionRequests).toHaveLength(1);
    expect(harness.sessionRequests[0]?.capabilities).toEqual({ scripts: 1, feedback: 1, sources: 1, followUps: 1 });
    // Each turn decides alone, so each one repeats what the session accepted;
    // a rating is the session's alone and never goes with a turn.
    expect(harness.turnRequests.map((request) => request.capabilities)).toEqual([
      { scripts: 1, sources: 1, followUps: 1 },
      { scripts: 1, sources: 1, followUps: 1 },
    ]);

    // The session expires, and the server that renews it no longer runs them.
    harness.advance(120_000);
    await harness.controller.ask("third");

    expect(harness.sessionRequests).toHaveLength(2);
    expect(harness.sessionRequests[1]?.capabilities).toEqual({ scripts: 1, feedback: 1, sources: 1, followUps: 1 });
    expect(harness.turnRequests[2]).not.toHaveProperty("capabilities");
  });

  test("a server that does not answer with scripts gets the turns it always got", async () => {
    // Absent from an older server; anything but scripts: 1 is not an acceptance.
    for (const accepted of [undefined, {}, { scripts: 2 }, { scripts: true }]) {
      const harness = negotiationHarness([accepted]);
      await harness.controller.ask("what is open");

      expect(harness.turnRequests[0]).not.toHaveProperty("capabilities");
      expect(harness.controller.getState().turns[0]?.status).toBe("complete");
    }
  });

  test("holds a user-data tool until it is approved, and declines without running it", async () => {
    const { executor, calls } = executorReturning({});
    const harness = createHarness({ script: [], executor });
    await settle();

    harness.emit(toolCallEvent(1, WRITE_TOOL));
    await settle();

    expect(calls).toHaveLength(0);
    const waiting = pendingConfirmation(harness.controller.getState());
    expect(waiting).toMatchObject({ toolCallId: "call-1", status: "awaiting-confirmation" });

    harness.controller.resolveConfirmation("call-1", false);
    await settle();

    expect(calls).toHaveLength(0);
    expect(harness.posted[0]).toMatchObject({ status: "denied" });
    expect(harness.controller.getState().turns[0]?.tools[0]?.status).toBe("denied");

    harness.emit({ seq: 2, type: "done", turnId: "turn-1", reason: "complete" });
    await harness.streamed;
  });

  test("runs a user-data tool once approved", async () => {
    const { executor, calls } = executorReturning({});
    const harness = createHarness({ script: [], executor });
    await settle();

    harness.emit(toolCallEvent(1, WRITE_TOOL));
    await settle();
    harness.controller.resolveConfirmation("call-1", true);
    await settle();

    expect(calls).toEqual([{ name: "layout.delete", confirmed: true }]);
    expect(harness.posted[0]).toMatchObject({ status: "ok" });

    harness.emit({ seq: 2, type: "done", turnId: "turn-1", reason: "complete" });
    await harness.streamed;
  });

  test("closes a prompt the server gave up on, and a late approval runs nothing", async () => {
    const { executor, calls } = executorReturning({});
    const harness = createHarness({ script: [], executor });
    await settle();

    harness.emit(toolCallEvent(1, WRITE_TOOL));
    await settle();
    expect(pendingConfirmation(harness.controller.getState())).toMatchObject({ toolCallId: "call-1" });

    // The server stopped waiting for call-1: its prompt closes, and the next call asks.
    harness.emit({
      seq: 2,
      type: "tool-executed",
      turnId: "turn-1",
      toolCallId: "call-1",
      name: WRITE_TOOL.name,
      source: "remote-op",
      status: "timeout",
      summary: { elapsedMs: 60_000, truncated: false, note: "The client did not answer within 60000ms." },
    });
    await settle();
    expect(harness.controller.getState().turns[0]?.tools[0]).toMatchObject({
      status: "timeout",
      note: NOT_APPROVED_IN_TIME_NOTE,
    });
    harness.emit(toolCallEvent(3, WRITE_TOOL));
    await settle();
    expect(pendingConfirmation(harness.controller.getState())).toMatchObject({ toolCallId: "call-3" });
    // A click that arrives anyway writes nothing and tells the server nothing.
    harness.controller.resolveConfirmation("call-1", true);
    await settle();
    expect(calls).toHaveLength(0);
    expect(harness.posted).toHaveLength(0);

    // The turn ends with call-3 still open: it closes the same way.
    harness.emit({ seq: 4, type: "done", turnId: "turn-1", reason: "complete" });
    await harness.streamed;
    expect(pendingConfirmation(harness.controller.getState())).toBeNull();
    harness.controller.resolveConfirmation("call-3", true);
    await settle();
    expect(calls).toHaveLength(0);
    expect(harness.posted).toHaveLength(0);
  });

  test("closes a prompt on its own before the server stops waiting", async () => {
    const { executor, calls } = executorReturning({});
    const harness = createHarness({ script: [], executor });
    await settle();

    // The frame's window, not the manifest's minute: an older server waits 10 s.
    harness.emit(toolCallEvent(1, { ...WRITE_TOOL, timeoutMs: CONFIRMATION_CLOSE_MARGIN_MS + 20 }));
    await settle();
    expect(pendingConfirmation(harness.controller.getState())).toMatchObject({ toolCallId: "call-1" });

    await new Promise((resolve) => setTimeout(resolve, 60));
    await settle();
    expect(pendingConfirmation(harness.controller.getState())).toBeNull();
    // Gloom hears why at once, while it still waits for the call.
    expect(harness.posted).toEqual([expect.objectContaining({
      toolCallId: "call-1",
      status: "timeout",
      note: NOT_APPROVED_IN_TIME_NOTE,
    })]);

    harness.controller.resolveConfirmation("call-1", true);
    await settle();
    expect(calls).toHaveLength(0);
    expect(harness.posted).toHaveLength(1);

    harness.emit({ seq: 2, type: "done", turnId: "turn-1", reason: "complete" });
    await harness.streamed;
  });

  test("asks about the change the app resolved, and the app does not ask again", async () => {
    const executed: Array<{ confirmed?: boolean; confirmedChange?: string }> = [];
    const executor: ASKGToolExecutor = {
      async preview() {
        return { kind: "change", summary: "Add MSFT (NASDAQ) to Tech", confirmKey: "add|tech|MSFT" };
      },
      async execute(call, options) {
        executed.push({ confirmed: options?.confirmed, confirmedChange: options?.confirmedChange });
        return { turnId: call.turnId, toolCallId: call.toolCallId, status: "ok", truncated: false, elapsedMs: 1 };
      },
      async gate() {
        return null;
      },
      async undo() {
        return { status: "ok", elapsedMs: 1 };
      },
    };
    const harness = createHarness({ script: [], executor });
    await settle();

    harness.emit(toolCallEvent(1, WRITE_TOOL));
    await settle();
    expect(pendingConfirmation(harness.controller.getState())).toMatchObject({ preview: "Add MSFT (NASDAQ) to Tech" });

    harness.controller.resolveConfirmation("call-1", true);
    await settle();
    expect(executed).toEqual([{ confirmed: true, confirmedChange: "add|tech|MSFT" }]);

    harness.emit({ seq: 2, type: "done", turnId: "turn-1", reason: "complete" });
    await harness.streamed;
  });

  test("answers a refused or no-op change without asking", async () => {
    const answers = [{ kind: "refusal", message: "Refused: \"Desk\" is a team watchlist." }, { kind: "no-change" }] as const;
    const executed: Array<boolean | undefined> = [];
    let next = 0;
    const executor: ASKGToolExecutor = {
      async preview() {
        return answers[next++] ?? null;
      },
      async execute(call, options) {
        executed.push(options?.confirmed);
        return { turnId: call.turnId, toolCallId: call.toolCallId, status: "ok", truncated: false, elapsedMs: 1 };
      },
      async gate() {
        return null;
      },
      async undo() {
        return { status: "ok", elapsedMs: 1 };
      },
    };
    const harness = createHarness({ script: [], executor });
    await settle();

    harness.emit(toolCallEvent(1, WRITE_TOOL));
    harness.emit(toolCallEvent(2, WRITE_TOOL));
    await settle();

    expect(pendingConfirmation(harness.controller.getState())).toBeNull();
    expect(harness.posted.map(({ toolCallId, status }) => [toolCallId, status])).toEqual([["call-1", "error"], ["call-2", "ok"]]);
    expect(harness.posted[0]?.note).toContain("team watchlist");
    expect(executed).toEqual([true]);

    harness.emit({ seq: 3, type: "done", turnId: "turn-1", reason: "complete" });
    await harness.streamed;
  });

  test("shows a result the server refused as too late as a timed out tool", async () => {
    const { executor } = executorReturning({ rowCount: 2 });
    const harness = createHarness({ script: [], executor, toolResultOutcome: "too-late" });
    await settle();

    harness.emit(toolCallEvent(1, READ_TOOL));
    await settle();

    const row = harness.controller.getState().turns[0]?.tools[0];
    expect(row?.status).toBe("timeout");
    expect(row?.note).toContain("Gloom answered without it");

    harness.emit({ seq: 2, type: "done", turnId: "turn-1", reason: "complete" });
    await harness.streamed;
  });

  test("a result the server could not take reads as not sent, without the response body", async () => {
    const { executor } = executorReturning({ rowCount: 2038, status: "partial", note: "1211: Current USD listing identity unavailable" });
    const body = JSON.stringify({
      type: "validation",
      on: "body",
      property: "/note",
      message: "Expected string length less or equal to 500",
      found: { note: "x".repeat(2_000) },
    });
    const harness = createHarness({
      script: [],
      executor,
      toolResultError: new ASKGTransportError("internal", body, { status: 422 }),
    });
    await settle();

    harness.emit(toolCallEvent(1, READ_TOOL));
    await settle();

    const row = harness.controller.getState().turns[0]?.tools[0];
    expect(row?.status).toBe("error");
    expect(row?.note).toBe("Could not send this result to Gloom, so it answered without it.");

    harness.emit({ seq: 2, type: "done", turnId: "turn-1", reason: "complete" });
    await harness.streamed;
  });

  test("never leaves a tool row running when the turn ends", async () => {
    const harness = createHarness({ script: [] });
    await settle();
    harness.emit(toolCallEvent(1, WRITE_TOOL));
    await settle();
    harness.emit({ seq: 2, type: "done", turnId: "turn-1", reason: "cancelled" });
    await harness.streamed;

    const turn = harness.controller.getState().turns[0];
    expect(turn?.status).toBe("cancelled");
    expect(turn?.tools[0]?.status).toBe("cancelled");
  });

  test("retrying a failed question asks it again in place of the attempt that failed", async () => {
    const inputs: string[] = [];
    let turnIds = 0;
    let attempts = 0;
    const transport: ASKGTransport = {
      isStreamingSupported: () => true,
      async startSession() {
        return sessionResponse();
      },
      async streamTurn(_sessionId, request, streamOptions) {
        inputs.push(request.input);
        attempts += 1;
        if (attempts === 1) {
          throw new ASKGTransportError("network", "The connection dropped.", { retryable: true });
        }
        streamOptions.onEvent({
          seq: 1,
          type: "text-delta",
          turnId: request.turnId,
          delta: "About 4.2%.",
        });
        streamOptions.onEvent({ seq: 2, type: "done", turnId: request.turnId, reason: "complete" });
        return "complete";
      },
      async postToolResult() {
        return "accepted";
      },
      async cancelTurn() {},
      ...noConversations,
    };
    const controller = new ASKGSessionController({
      transport,
      loadManifest: async () => MANIFEST,
      getExecutor: () => null,
      client: { kind: "tui", version: "1" },
      createId: () => `turn-${(turnIds += 1)}`,
    });

    await controller.ask("what does a 5y bond return");
    expect(controller.getState().turns).toHaveLength(1);
    expect(controller.getState().turns[0]).toMatchObject({ id: "turn-1", status: "error" });
    expect(controller.getState().turns[0]?.error?.code).toBe("network");

    await controller.retryTurn("turn-1");

    const turns = controller.getState().turns;
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      id: "turn-2",
      prompt: "what does a 5y bond return",
      status: "complete",
      answer: "About 4.2%.",
    });
    expect(inputs).toEqual([
      "what does a 5y bond return",
      "what does a 5y bond return",
    ]);
  });

  test("a conversation is named by the stream and continued by the next question", async () => {
    const requests: ASKGTurnRequest[] = [];
    const transport: ASKGTransport = {
      isStreamingSupported: () => true,
      async startSession() {
        return sessionResponse();
      },
      async streamTurn(_sessionId, request, streamOptions) {
        requests.push(request);
        streamOptions.onEvent({
          seq: 1,
          type: "session",
          sessionId: "s1",
          turnId: request.turnId,
          model: "gloom-1",
          promptVersion: "v1",
          conversationId: "conv-1",
        });
        streamOptions.onEvent({
          seq: 2,
          type: "text-delta",
          turnId: request.turnId,
          delta: "Answered.",
        });
        streamOptions.onEvent({ seq: 3, type: "done", turnId: request.turnId, reason: "complete" });
        return "complete";
      },
      async postToolResult() {
        return "accepted";
      },
      async cancelTurn() {},
      ...noConversations,
    };
    let ids = 0;
    const controller = new ASKGSessionController({
      transport,
      loadManifest: async () => MANIFEST,
      getExecutor: () => null,
      client: { kind: "tui", version: "1" },
      createId: () => `turn-${(ids += 1)}`,
    });

    await controller.ask("first question");
    expect(controller.getState().conversationId).toBe("conv-1");
    // The first question cannot name a conversation and carries its own
    // history; the second names one and lets the platform own the context.
    expect(requests[0]?.conversationId).toBeUndefined();

    await controller.ask("second question");
    expect(requests[1]?.conversationId).toBe("conv-1");
    expect(requests[1]?.history).toBeUndefined();
  });

  test("opening a stored conversation replaces the transcript and continues it", async () => {
    const requests: ASKGTurnRequest[] = [];
    const transport: ASKGTransport = {
      isStreamingSupported: () => true,
      async startSession() {
        return sessionResponse();
      },
      async streamTurn(_sessionId, request, streamOptions) {
        requests.push(request);
        streamOptions.onEvent({ seq: 1, type: "done", turnId: request.turnId, reason: "complete" });
        return "complete";
      },
      async postToolResult() {
        return "accepted";
      },
      async cancelTurn() {},
      ...noConversations,
    };
    const controller = new ASKGSessionController({
      transport,
      loadManifest: async () => MANIFEST,
      getExecutor: () => null,
      client: { kind: "tui", version: "1" },
      createId: () => "turn-live",
    });

    controller.openConversation({
      id: "conv-7",
      title: "Bonds",
      messageCount: 2,
      lastMessageAt: "2026-09-20T10:00:00.000Z",
      createdAt: "2026-09-20T10:00:00.000Z",
      updatedAt: "2026-09-20T10:00:00.000Z",
      messages: [
        {
          seq: 1,
          role: "user",
          text: "what does a 5y bond return",
          tools: [],
          turnId: "turn-a",
          createdAt: "2026-09-20T10:00:00.000Z",
        },
        {
          seq: 2,
          role: "assistant",
          text: "About 4.2%.",
          tools: [
            {
              toolCallId: "call-1",
              name: "econ.series",
              origin: "server",
              status: "ok",
              rowCount: 12,
              elapsedMs: 30,
            },
          ],
          turnId: "turn-a",
          createdAt: "2026-09-20T10:00:01.000Z",
        },
      ],
    });

    const state = controller.getState();
    expect(state.conversationId).toBe("conv-7");
    expect(state.turns).toHaveLength(1);
    expect(state.turns[0]).toMatchObject({
      prompt: "what does a 5y bond return",
      answer: "About 4.2%.",
      status: "complete",
    });
    // A stored row names the tool without pretending its rows are still there.
    expect(state.turns[0]?.tools[0]).toMatchObject({
      name: "econ.series",
      origin: "server",
      rowCount: 12,
    });
    expect(state.turns[0]?.tools[0]?.result).toBeUndefined();

    await controller.ask("and 10y");
    expect(requests[0]?.conversationId).toBe("conv-7");

    controller.startConversation();
    expect(controller.getState().conversationId).toBeNull();
    expect(controller.getState().turns).toEqual([]);
  });

  test("a turn that did not fail is not re-asked", async () => {
    const inputs: string[] = [];
    const transport: ASKGTransport = {
      isStreamingSupported: () => true,
      async startSession() {
        return sessionResponse();
      },
      async streamTurn(_sessionId, request, streamOptions) {
        inputs.push(request.input);
        streamOptions.onEvent({ seq: 1, type: "done", turnId: request.turnId, reason: "complete" });
        return "complete";
      },
      async postToolResult() {
        return "accepted";
      },
      async cancelTurn() {},
      ...noConversations,
    };
    const controller = new ASKGSessionController({
      transport,
      loadManifest: async () => MANIFEST,
      getExecutor: () => null,
      client: { kind: "tui", version: "1" },
      createId: () => "turn-1",
    });

    await controller.ask("what is open");
    await controller.retryTurn("turn-1");
    await controller.retryTurn("missing-turn");

    expect(inputs).toEqual(["what is open"]);
    expect(controller.getState().turns).toHaveLength(1);
  });
});

/**
 * A controller whose every question is answered in full, on a server that
 * takes ratings when `feedback` is set. `send` plays the rating route.
 */
function feedbackHarness(options: {
  feedback?: boolean;
  send?: (request: ASKGFeedbackRequest) => Promise<ASKGFeedback | null>;
} = {}) {
  const sent: Array<{ turnId: string; request: ASKGFeedbackRequest }> = [];
  let turns = 0;
  // Like the route: once sent, an answer stays sent.
  let shared = false;
  const transport: ASKGTransport = {
    isStreamingSupported: () => true,
    async startSession() {
      return {
        ...sessionResponse(),
        ...(options.feedback === false ? {} : { capabilities: { feedback: 1 as const } }),
      };
    },
    async streamTurn(_sessionId, request, streamOptions) {
      const turnId = request.turnId;
      streamOptions.onEvent({ seq: 1, type: "session", sessionId: "s1", turnId, model: "gloom-1", promptVersion: "v1", conversationId: "conv-1" });
      streamOptions.onEvent({ seq: 2, type: "text-delta", turnId, delta: "Up 3% this week." });
      streamOptions.onEvent({ seq: 3, type: "done", turnId, reason: "complete" });
      return "complete";
    },
    async postToolResult() {
      return "accepted";
    },
    async cancelTurn() {},
    ...noConversations,
    async sendFeedback(turnId, request) {
      sent.push({ turnId, request });
      if (options.send) return options.send(request);
      shared = shared || request.share === true;
      return { rating: request.rating, reason: request.reason ?? null, shared };
    },
  };
  const controller = new ASKGSessionController({
    transport,
    loadManifest: async () => MANIFEST,
    getExecutor: () => null,
    client: { kind: "tui", version: "1" },
    createId: () => `turn-${(turns += 1)}`,
  });
  return { controller, sent, turn: () => controller.getState().turns[0]! };
}

describe("ASKGSessionController answer ratings", () => {
  test("a finished answer can be rated only on a server that said it takes ratings", async () => {
    const older = feedbackHarness({ feedback: false });
    await older.controller.ask("how is the fund doing");
    expect(canRateTurn(older.controller.getState(), older.turn())).toBe(false);
    await older.controller.rateAnswer(older.turn().id, "up");
    expect(older.sent).toEqual([]);

    const current = feedbackHarness();
    await current.controller.ask("how is the fund doing");
    expect(canRateTurn(current.controller.getState(), current.turn())).toBe(true);
    await current.controller.rateAnswer(current.turn().id, "down");
    expect(current.sent).toEqual([{ turnId: "turn-1", request: { rating: "down", reason: null } }]);
    expect(current.turn().feedback).toEqual({ rating: "down", reason: null, shared: false, pending: null });
  });

  test("a reason rides on the thumbs down, sharing carries only consent, and a thumbs up drops the reason", async () => {
    const { controller, sent, turn } = feedbackHarness();
    await controller.ask("how is the fund doing");
    await controller.rateAnswer(turn().id, "down");
    await controller.chooseFeedbackReason(turn().id, "missing_data");
    await controller.shareAnswer(turn().id);
    // Already sent: a second send asks for nothing.
    await controller.shareAnswer(turn().id);
    await controller.rateAnswer(turn().id, "up");

    expect(sent.map((entry) => entry.request)).toEqual([
      { rating: "down", reason: null },
      { rating: "down", reason: "missing_data" },
      // No question, answer or tool in the request: the server copies its own.
      { rating: "down", reason: "missing_data", share: true },
      { rating: "up", reason: null },
    ]);
    expect(turn().feedback).toEqual({ rating: "up", reason: null, shared: true, pending: null });
  });

  test("a refused rating goes back quietly, and a refusal that means ratings cannot work hides them", async () => {
    let failure: Error | null = new ASKGTransportError("network", "offline", { retryable: true });
    const { controller, turn } = feedbackHarness({
      send: async (request) => {
        if (failure) throw failure;
        return { rating: request.rating, reason: null, shared: false };
      },
    });
    await controller.ask("how is the fund doing");

    await controller.rateAnswer(turn().id, "up");
    expect(turn().feedback).toBeUndefined();
    expect(controller.getState().feedbackAvailable).toBe(true);

    failure = null;
    await controller.rateAnswer(turn().id, "up");
    failure = new ASKGTransportError("unauthorized", "Sign in to Gloom Cloud to ask Gloom.");
    await controller.rateAnswer(turn().id, "down");
    expect(turn().feedback).toMatchObject({ rating: "up", pending: null });
    expect(controller.getState().feedbackAvailable).toBe(false);
    expect(canRateTurn(controller.getState(), turn())).toBe(false);
  });

  test("an answer the server does not know hides the control instead of failing on every click", async () => {
    const { controller, turn } = feedbackHarness({ send: async () => null });
    await controller.ask("how is the fund doing");
    await controller.rateAnswer(turn().id, "down");

    expect(turn().feedback).toBeUndefined();
    expect(controller.getState().feedbackAvailable).toBe(false);
  });

  test("quick changes go out in order and the last choice is the one left showing", async () => {
    const pending: Array<PromiseWithResolvers<ASKGFeedback | null>> = [];
    const { controller, sent, turn } = feedbackHarness({
      send: () => {
        const next = Promise.withResolvers<ASKGFeedback | null>();
        pending.push(next);
        return next.promise;
      },
    });
    await controller.ask("how is the fund doing");

    const first = controller.rateAnswer(turn().id, "down");
    const second = controller.rateAnswer(turn().id, "up");
    await settle();
    // The control shows the latest choice while both are out.
    expect(turn().feedback).toMatchObject({ rating: "up", pending: "rating" });
    expect(sent.map((entry) => entry.request.rating)).toEqual(["down"]);

    pending[0]!.resolve({ rating: "down", reason: null, shared: false });
    await first;
    await settle();
    // The older answer does not win, and the newer request only now goes out.
    expect(turn().feedback).toMatchObject({ rating: "up", pending: "rating" });
    expect(sent.map((entry) => entry.request.rating)).toEqual(["down", "up"]);

    pending[1]!.resolve({ rating: "up", reason: null, shared: false });
    await second;
    expect(turn().feedback).toEqual({ rating: "up", reason: null, shared: false, pending: null });
  });

  test("a send the server could not complete says so on the answer", async () => {
    const { controller, turn } = feedbackHarness({
      send: async (request) => ({ rating: request.rating, reason: request.reason ?? null, shared: false }),
    });
    await controller.ask("how is the fund doing");
    await controller.rateAnswer(turn().id, "down");
    await controller.shareAnswer(turn().id);

    expect(turn().feedback).toMatchObject({ rating: "down", shared: false, shareFailed: true });
  });
});

/**
 * The app's real manifest and executor over a screen of semantic controls, so
 * a UI call goes through the policy it shares with the terminal relay.
 */
function screenHarness() {
  const catalog: PaneFunctionCatalog = { panes: new Map(), paneTemplates: new Map(), destroy() {} };
  const tools = buildASKGToolManifests(catalog).tools;
  const manifest = { tools, manifestHash: "sha256:screen" };
  const screen: RemoteUiNodeSnapshot[] = [
    { id: "ui:1", role: "button", label: "Place LIVE order", actions: ["press"], paneId: "broker-ticket:1" },
    { id: "ui:2", role: "form-field", label: "Symbol", actions: ["setValue"], paneId: "broker-ticket:1" },
    { id: "ui:3", role: "table", label: "Data table", actions: ["activateRow", "scrollBy", "selectRow"], paneId: "portfolio-list:1" },
    { id: "ui:4", role: "menu", label: "Layout", actions: ["select"], metadata: { selection: "none", items: [{ id: "delete", label: "Delete Layout" }] }, paneId: "portfolio-list:1" },
    { id: "ui:5", role: "menu", label: "Sort by", actions: ["select"], metadata: { selection: "single", items: [{ id: "name", label: "Name" }] }, paneId: "portfolio-list:1" },
    {
      id: "ui:6",
      role: "list",
      label: "Results",
      actions: ["activate", "select"],
      metadata: { scope: "command-bar", items: [{ index: 0, id: "ticker:AAPL", label: "AAPL", kind: "ticker" }, { index: 1, id: "theme", label: "Change Theme", kind: "command" }] },
    },
  ];
  /** What `ui://node/{id}` adds: the pane's title, and a table's every row. */
  const paneTitles: Record<string, string> = { "broker-ticket:1": "Trade AAPL", "portfolio-list:1": "Main Portfolio" };
  const tableRows = [
    { key: "AAPL", cells: [{ text: "AAPL" }, { text: "120" }] },
    { key: "MSFT", cells: [{ text: "MSFT" }, { text: "40" }] },
  ];
  const layouts = [{ name: "Main" }, { name: "Semis" }];
  let treeFails = false;
  const ran: RemoteControlRequest[] = [];
  const remoteHandler = async (request: RemoteControlRequest): Promise<RemoteControlResponse> => {
    if (request.type === "get") {
      if (request.resource === "ui://tree") {
        return treeFails ? { ok: false, error: { code: "remote_error", message: "The screen could not be read." } } : { ok: true, data: screen };
      }
      if (request.resource.startsWith("ui://node/")) {
        const node = screen.find((entry) => entry.id === decodeURIComponent(request.resource.slice("ui://node/".length)));
        if (!node) return { ok: false, error: { code: "remote_error", message: "No such node." } };
        return {
          ok: true,
          data: {
            ...node,
            ...(node.role === "table" ? { metadata: { ...node.metadata, rows: tableRows } } : {}),
            ...(node.paneId && paneTitles[node.paneId] ? { paneTitle: paneTitles[node.paneId] } : {}),
          },
        };
      }
      if (request.resource === "app://layouts") return { ok: true, data: layouts };
      return { ok: true, data: [] };
    }
    ran.push(request);
    return { ok: true, data: { done: true } };
  };
  const executor = createASKGToolExecutor({ manifests: tools, registry: catalog, context: {} as MarketContext, remoteHandler });
  const harness = createHarness({ script: [], executor, manifest });
  let seq = 0;
  const call = (operation: string, args: Record<string, JsonValue>, frame: Partial<ASKGToolCallEvent> = {}): string => {
    const tool = tools.find((entry) => entry.name === operation)!;
    seq += 1;
    harness.emit({
      seq,
      type: "tool-call",
      turnId: "turn-1",
      toolCallId: `call-${seq}`,
      name: tool.name,
      args,
      writeTier: tool.writeTier,
      requiresConfirmation: tool.confirm === "always",
      preview: null,
      timeoutMs: tool.timeoutMs,
      expiresAt: new Date(Date.now() + tool.timeoutMs).toISOString(),
      ...frame,
    });
    return `call-${seq}`;
  };
  return {
    ...harness,
    screen,
    paneTitles,
    tableRows,
    layouts,
    failTree: () => {
      treeFails = true;
    },
    call,
    /** The UI and layout operations that ran, not the reads and dry runs that vetted them. */
    ran: () => ran.flatMap((request) => (request.type === "call" && !request.dryRun ? [request.operation] : [])),
    result: (toolCallId: string) => harness.posted.find((payload) => payload.toolCallId === toolCallId),
    question: () => pendingConfirmation(harness.controller.getState()),
  };
}

/** The executor reads the screen and runs under timers, past what microtasks settle. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

const PLACE_ORDER = { role: "button", label: "Place LIVE order" };

describe("Ask Gloom acting on the screen", () => {
  test("a press asks first, naming the control by label and role and the pane it is in", async () => {
    const h = screenHarness();
    await flush();
    const id = h.call("ui.invoke_matching", PLACE_ORDER);
    await flush();

    expect(h.question()).toMatchObject({ toolCallId: id, confirmTitle: "Press \"Place LIVE order\" (button)", preview: "Pane: Trade AAPL" });
    expect(h.ran()).toEqual([]);

    h.controller.resolveConfirmation(id, true);
    await flush();
    expect(h.ran()).toEqual(["ui.invokeMatching"]);
    expect(h.result(id)?.status).toBe("ok");
    h.controller.dispose();
  });

  test("a declined press and one left unanswered do not run", async () => {
    const h = screenHarness();
    await flush();
    const declined = h.call("ui.invoke_matching", PLACE_ORDER);
    await flush();
    h.controller.resolveConfirmation(declined, false);
    await flush();
    expect(h.result(declined)).toMatchObject({ status: "denied", note: "You declined this action." });

    // The server waits a little longer than the prompt stays open.
    const unanswered = h.call("ui.invoke_matching", PLACE_ORDER, {
      expiresAt: new Date(Date.now() + CONFIRMATION_CLOSE_MARGIN_MS + 30).toISOString(),
    });
    await flush();
    expect(h.question()?.toolCallId).toBe(unanswered);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(h.question()).toBeNull();
    expect(h.result(unanswered)).toMatchObject({ status: "timeout", note: NOT_APPROVED_IN_TIME_NOTE });
    expect(h.ran()).toEqual([]);
    h.controller.dispose();
  });

  test("a control that changed between the question and the answer is not pressed", async () => {
    const h = screenHarness();
    await flush();
    const relabelled = h.call("ui.invoke_matching", PLACE_ORDER);
    await flush();
    // The same node now says something else.
    h.screen[0] = { ...h.screen[0]!, label: "Close all positions" };
    h.controller.resolveConfirmation(relabelled, true);
    await flush();
    expect(h.result(relabelled)).toMatchObject({ status: "denied" });
    expect(h.result(relabelled)?.note).toContain("changed while the person decided");

    // The same button, but the pane it is in moved to another ticker.
    h.screen[0] = { ...h.screen[0]!, label: "Place LIVE order" };
    const moved = h.call("ui.invoke", { nodeId: "ui:1", action: "press" });
    await flush();
    h.paneTitles["broker-ticket:1"] = "Trade TSLA";
    h.controller.resolveConfirmation(moved, true);
    await flush();
    expect(h.result(moved)?.status).toBe("denied");
    expect(h.ran()).toEqual([]);
    h.controller.dispose();
  });

  test("a screen that cannot be read refuses the call instead of running it", async () => {
    const h = screenHarness();
    await flush();
    h.failTree();
    const id = h.call("ui.invoke_matching", PLACE_ORDER);
    await flush();
    expect(h.question()).toBeNull();
    expect(h.result(id)?.status).toBe("error");
    expect(h.ran()).toEqual([]);
    h.controller.dispose();
  });

  test("scrolling and setting a field's value run without asking", async () => {
    const h = screenHarness();
    await flush();
    const scroll = h.call("ui.invoke", { nodeId: "ui:3", action: "scrollBy", input: { delta: 3 } });
    const type = h.call("ui.invoke_matching", { role: "form-field", label: "Symbol", action: "setValue", input: "AAPL" });
    await flush();

    expect(h.question()).toBeNull();
    expect(h.ran()).toEqual(["ui.invoke", "ui.invokeMatching"]);
    expect([h.result(scroll)?.status, h.result(type)?.status]).toEqual(["ok", "ok"]);
    h.controller.dispose();
  });

  test("a frame that asks for confirmation is asked about, even for a call that never asks", async () => {
    const h = screenHarness();
    await flush();
    const id = h.call("ui.invoke", { nodeId: "ui:3", action: "scrollBy", input: { delta: 3 } }, { requiresConfirmation: true });
    await flush();
    expect(h.question()?.toolCallId).toBe(id);
    expect(h.ran()).toEqual([]);
    h.controller.resolveConfirmation(id, true);
    await flush();
    expect(h.ran()).toEqual(["ui.invoke"]);
    h.controller.dispose();
  });

  test("an item of a plain menu and a row a table opens are asked about by their label", async () => {
    const h = screenHarness();
    await flush();
    const menu = h.call("ui.invoke", { nodeId: "ui:4", action: "select", input: "delete" });
    await flush();
    expect(h.question()).toMatchObject({ toolCallId: menu, confirmTitle: "Choose \"Delete Layout\" from \"Layout\" (menu)", preview: "Pane: Main Portfolio" });
    h.controller.resolveConfirmation(menu, false);
    await flush();

    const row = h.call("ui.invoke", { nodeId: "ui:3", action: "activateRow", input: 1 });
    await flush();
    expect(h.question()).toMatchObject({ toolCallId: row, confirmTitle: "Choose \"MSFT\" in \"Data table\" (table)" });
    // The rows moved: the second one is another ticker now.
    h.tableRows.reverse();
    h.controller.resolveConfirmation(row, true);
    await flush();
    expect(h.result(row)?.status).toBe("denied");

    // A select field's menu only picks a value.
    const sort = h.call("ui.invoke", { nodeId: "ui:5", action: "select", input: "name" });
    await flush();
    expect(h.result(sort)?.status).toBe("ok");
    expect(h.ran()).toEqual(["ui.invoke"]);
    h.controller.dispose();
  });

  test("a command-bar row that opens a ticker runs, one that runs a command asks, and one not there is refused", async () => {
    const h = screenHarness();
    await flush();
    const ticker = h.call("command_bar.activate_result", { label: "AAPL" });
    await flush();
    expect(h.result(ticker)?.status).toBe("ok");

    const command = h.call("command_bar.activate_result", { label: "Change Theme" });
    await flush();
    expect(h.question()).toMatchObject({ toolCallId: command, confirmTitle: "Run \"Change Theme\" from the command bar" });
    h.controller.resolveConfirmation(command, true);
    await flush();

    const missing = h.call("command_bar.activate_result", { label: "Sign Out" });
    await flush();
    expect(h.result(missing)).toMatchObject({ status: "denied", note: "No matching command-bar result is visible." });
    expect(h.ran()).toEqual(["commandBar.activateResult", "commandBar.activateResult"]);
    h.controller.dispose();
  });

  test("deleting a layout asks first, naming it, and not if another took its place", async () => {
    const h = screenHarness();
    await flush();
    const id = h.call("layout.delete", { index: 1 });
    await flush();
    expect(h.question()).toMatchObject({ toolCallId: id, confirmTitle: "Delete the layout \"Semis\"" });

    h.layouts.splice(1, 1, { name: "Research" });
    h.controller.resolveConfirmation(id, true);
    await flush();
    expect(h.result(id)?.status).toBe("denied");
    expect(h.ran()).toEqual([]);
    h.controller.dispose();
  });

  test("a press on Ask Gloom's own Approve is refused, whatever the call says", async () => {
    const h = screenHarness();
    // Another conversation's approval row is on screen; this one waits for nothing.
    h.screen.push({ id: "ui:9", role: "button", label: "Approve", actions: ["press"], metadata: { scope: "askg-prompt" } });
    await flush();
    const byLabel = h.call("ui.invoke_matching", { role: "button", label: "Approve" });
    const byId = h.call("ui.invoke", { nodeId: "ui:9", action: "press" });
    await flush();

    expect(h.question()).toBeNull();
    expect([h.result(byLabel)?.status, h.result(byId)?.status]).toEqual(["denied", "denied"]);
    expect(h.ran()).toEqual([]);
    h.controller.dispose();
  });

  test("while a question waits, nothing else that changes the app runs, and reads still do", async () => {
    const h = screenHarness();
    await flush();
    const remove = h.call("layout.delete", { index: 1 });
    await flush();
    const changes = [
      h.call("ui.invoke", { nodeId: "ui:3", action: "scrollBy", input: { delta: 3 } }),
      h.call("ui.invoke_matching", PLACE_ORDER),
      h.call("pane.set_state", { paneId: "broker-ticket:1", patch: { symbol: "TSLA" } }),
      h.call("ticker.navigate", { symbol: "TSLA" }),
    ];
    const read = h.call("app.get_resource", { resource: "app://layouts" });
    await flush();

    expect(changes.map((id) => h.result(id))).toEqual(changes.map(() => expect.objectContaining({ status: "denied", note: CONFIRMATION_WAITING_NOTE })));
    expect(h.result(read)?.status).toBe("ok");
    // The question on screen is still the layout's, and nothing ran.
    expect(h.question()?.toolCallId).toBe(remove);
    expect(h.ran()).toEqual([]);

    h.controller.resolveConfirmation(remove, true);
    await flush();
    expect(h.ran()).toEqual(["layout.delete"]);
    h.controller.dispose();
  });

  test("calls that arrive together take turns: one question at a time, and its approval runs", async () => {
    const h = screenHarness();
    await flush();
    // In the same tick, before anything is read.
    const press = h.call("ui.invoke_matching", PLACE_ORDER);
    const remove = h.call("layout.delete", { index: 1 });
    const patch = h.call("pane.set_state", { paneId: "broker-ticket:1", patch: { symbol: "TSLA" } });
    await flush();

    expect(h.question()?.toolCallId).toBe(press);
    expect([h.result(remove)?.note, h.result(patch)?.note]).toEqual([CONFIRMATION_WAITING_NOTE, CONFIRMATION_WAITING_NOTE]);
    h.controller.resolveConfirmation(press, true);
    await flush();
    expect(h.result(press)?.status).toBe("ok");
    expect(h.ran()).toEqual(["ui.invokeMatching"]);

    // In the other order, the change runs first and the press is asked about after it.
    const first = h.call("pane.set_state", { paneId: "broker-ticket:1", patch: { symbol: "TSLA" } });
    const second = h.call("ui.invoke_matching", PLACE_ORDER);
    await flush();
    expect(h.result(first)?.status).toBe("ok");
    expect(h.question()?.toolCallId).toBe(second);
    h.controller.dispose();
  });
});
