import { describe, expect, test } from "bun:test";
import type {
  ASKGStreamOptions,
  ASKGToolResultOutcome,
  ASKGTransport,
} from "../../../../api-client/askg";
import { ASKGSessionController } from "./controller";
import type { ASKGToolExecutor } from "./executor";
import { pendingConfirmation } from "./model";
import type {
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
      return options.toolResultOutcome ?? "accepted";
    },
    async cancelTurn() {},
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
});
