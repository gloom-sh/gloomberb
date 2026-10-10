import { describe, expect, test } from "bun:test";
import { ASKGTransportError } from "../../../../api-client/askg";
import type {
  ASKGStreamOptions,
  ASKGToolResultOutcome,
  ASKGTransport,
} from "../../../../api-client/askg";
import { ASKGSessionController } from "./controller";
import type { ASKGToolExecutor } from "./executor";
import { canRateTurn, pendingConfirmation } from "./model";
import type {
  ASKGFeedback,
  ASKGFeedbackRequest,
  ASKGSessionStartRequest,
  ASKGSessionStartResponse,
  ASKGSseEvent,
  ASKGTurnRequest,
  ClientToolManifest,
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

function sessionResponse(): ASKGSessionStartResponse {
  return {
    protocolVersion: 1,
    sessionId: "s1",
    manifestHash: MANIFEST.manifestHash,
    serverTools: [],
    acceptedTools: MANIFEST.tools.map((tool) => tool.name),
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
      return sessionResponse();
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
    loadManifest: async () => MANIFEST,
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
      async undo() {
        return { status: "ok", elapsedMs: 1 };
      },
    },
  };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
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

  test("offers scripts at session start and asks for them on every turn the session accepted them for", async () => {
    const harness = negotiationHarness([{ scripts: 1 }, undefined]);
    await harness.controller.ask("first");
    await harness.controller.ask("second");

    expect(harness.sessionRequests).toHaveLength(1);
    expect(harness.sessionRequests[0]?.capabilities).toEqual({ scripts: 1, feedback: 1 });
    // Each turn decides alone, so each one repeats what the session accepted.
    expect(harness.turnRequests.map((request) => request.capabilities)).toEqual([
      { scripts: 1 },
      { scripts: 1 },
    ]);

    // The session expires, and the server that renews it no longer runs them.
    harness.advance(120_000);
    await harness.controller.ask("third");

    expect(harness.sessionRequests).toHaveLength(2);
    expect(harness.sessionRequests[1]?.capabilities).toEqual({ scripts: 1, feedback: 1 });
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
