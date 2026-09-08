/**
 * Dev-only stand-in for the ASKG platform endpoints, so the assistant pane can
 * be built and smoke-tested before the server branch lands. Never imported by
 * app code.
 *
 * Usage:
 *   bun run scripts/mock-askg-server.ts &
 *   GLOOMBERB_API_URL=http://localhost:8792 bun run dev
 *
 * The reply depends on the input: "val" runs a headless pane tool, "layout"
 * asks for a user-data confirmation, "error" reports a rate limit, "drop"
 * closes the stream mid answer so the client has to resume with Last-Event-ID,
 * and "late" refuses the tool result with 410 the way a lapsed window does.
 *
 * Pass --free to answer the session with 402, which is how the platform tells a
 * free verified account that Ask Gloom needs a paid plan.
 */
const PORT = Number(process.env.MOCK_ASKG_PORT ?? 8792);
const FREE_TIER = process.argv.includes("--free");

const USER = {
  id: "mock-user",
  email: "mock@gloom.sh",
  username: "mock",
  name: "Mock Account",
  emailVerified: true,
  plan: "pro",
  effectivePlan: "pro",
  trialEndsAt: null,
};

const toolResults = new Map<string, unknown>();
/** Tool calls whose result window has closed, answered with 410. */
const lateToolCalls = new Set<string>();
/** Streams already opened for a turn id, so a resume re-attaches. */
const seenTurns = new Set<string>();

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Set-Cookie": "gloomberb.session_token=mock-session-token; Path=/",
      ...(init.headers ?? {}),
    },
  });
}

async function waitForToolResult(toolCallId: string, timeoutMs = 30_000): Promise<unknown> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = toolResults.get(toolCallId);
    if (result) {
      toolResults.delete(toolCallId);
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}

interface TurnPlanStep {
  kind: "text" | "tool" | "server-tool" | "error" | "drop";
  text?: string;
  tool?: {
    name: string;
    args: Record<string, unknown>;
    writeTier: string;
    preview?: unknown;
    /** Closes the result window immediately, so the post is answered with 410. */
    late?: boolean;
  };
  server?: { name: string; rowCount: number; note: string };
}

function planFor(prompt: string): TurnPlanStep[] {
  const lower = prompt.toLowerCase();
  if (lower.includes("error") || lower.includes("limit")) {
    return [
      { kind: "text", text: "Checking the model budget" },
      { kind: "error" },
    ];
  }
  if (lower.includes("layout") || lower.includes("delete")) {
    return [
      { kind: "text", text: "That removes a saved layout, so it needs your approval.\n\n" },
      {
        kind: "tool",
        tool: {
          name: "layout.delete",
          args: { index: 1 },
          writeTier: "user-data",
          preview: {
            operation: "layout.delete",
            layout: "Research",
            panes: 4,
            reversible: "no",
          },
        },
      },
      { kind: "text", text: "Nothing else to do." },
    ];
  }
  if (lower.includes("late")) {
    return [
      { kind: "text", text: "Reading the workspace, but not waiting for it.\n\n" },
      {
        kind: "tool",
        tool: {
          name: "app.get_resource",
          args: { resource: "app://panes" },
          writeTier: "read",
          late: true,
        },
      },
      { kind: "text", text: "Answered without the tool." },
    ];
  }
  if (lower.includes("drop") || lower.includes("resume")) {
    return [
      { kind: "text", text: "Starting the answer, " },
      { kind: "drop" },
      { kind: "text", text: "and finishing it after the stream was resumed." },
    ];
  }
  if (lower.includes("val") || lower.includes("valuation") || lower.includes("market")) {
    return [
      { kind: "text", text: "Reading market valuation.\n\n" },
      { kind: "tool", tool: { name: "val", args: {}, writeTier: "read" } },
      { kind: "server-tool", server: { name: "news.search", rowCount: 6, note: "6 wire stories" } },
      {
        kind: "text",
        text: "Long horizon valuation is rich against history. **NVDA** and **AAPL** carry the index multiple.",
      },
    ];
  }
  return [
    { kind: "text", text: "Looking at your workspace.\n\n" },
    {
      kind: "tool",
      tool: { name: "app.get_resource", args: { resource: "app://panes" }, writeTier: "read" },
    },
    { kind: "server-tool", server: { name: "market.quote", rowCount: 3, note: "3 quotes" } },
    {
      kind: "text",
      text: "Your layout is open and reachable. Ask about a ticker such as **NVDA** for a deeper read.",
    },
  ];
}

function sseChunk(event: Record<string, unknown>): string {
  return `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function turnStream(
  prompt: string,
  sessionId: string,
  lastEventId: number,
  turnId: string,
): Response {
  const encoder = new TextEncoder();
  let seq = 0;

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: Record<string, unknown>) => {
        seq += 1;
        // A resumed stream replays nothing the client already applied.
        if (seq <= lastEventId) return;
        controller.enqueue(encoder.encode(sseChunk({ ...event, seq })));
      };

      send({ type: "session", sessionId, turnId, model: "gloom-1", promptVersion: "2024-06-01" });
      // The real stream pings every 15s; one up front proves the client's
      // decoder ignores comment frames.
      controller.enqueue(encoder.encode(": keep-alive\n\n"));

      for (const step of planFor(prompt)) {
        if (step.kind === "drop" && lastEventId === 0) {
          // Close without `done`, which is what a proxy timeout looks like.
          controller.close();
          return;
        }
        if (step.kind === "text" && step.text) {
          for (const word of step.text.split(/(\s+)/)) {
            if (!word) continue;
            send({ type: "text-delta", turnId, delta: word });
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          continue;
        }
        if (step.kind === "error") {
          send({
            type: "error",
            turnId,
            code: "rate_limited",
            message: "You have asked 20 questions this minute.",
            retryable: true,
            retryAfterMs: 42_000,
          });
          send({ type: "done", turnId, reason: "error" });
          controller.close();
          return;
        }
        if (step.kind === "server-tool" && step.server) {
          send({
            type: "tool-executed",
            turnId,
            toolCallId: `server-${step.server.name}`,
            name: step.server.name,
            source: "server",
            status: "ok",
            summary: {
              rowCount: step.server.rowCount,
              elapsedMs: 180,
              truncated: false,
              note: step.server.note,
            },
          });
          continue;
        }
        if (step.kind === "tool" && step.tool) {
          const toolCallId = `call-${seq + 1}`;
          if (step.tool.late) lateToolCalls.add(toolCallId);
          send({
            type: "tool-call",
            turnId,
            toolCallId,
            name: step.tool.name,
            args: step.tool.args,
            writeTier: step.tool.writeTier,
            requiresConfirmation: step.tool.writeTier !== "read",
            preview: step.tool.preview ?? null,
            timeoutMs: 30_000,
            expiresAt: new Date(Date.now() + 30_000).toISOString(),
          });
          if (step.tool.late) {
            // The turn continues with the synthetic timeout the route records.
            send({
              type: "tool-executed",
              turnId,
              toolCallId,
              name: step.tool.name,
              source: "remote-op",
              status: "timeout",
              summary: { elapsedMs: 0, truncated: false, note: "No result inside the window." },
            });
            continue;
          }
          const result = await waitForToolResult(toolCallId) as {
            status?: string;
            rowCount?: number;
            elapsedMs?: number;
            note?: string;
          } | null;
          send({ type: "tool-result-ack", turnId, toolCallId });
          send({
            type: "tool-executed",
            turnId,
            toolCallId,
            name: step.tool.name,
            source: step.tool.name.includes(".") ? "remote-op" : "headless",
            status: result?.status ?? "timeout",
            summary: {
              ...(result?.rowCount !== undefined ? { rowCount: result.rowCount } : {}),
              elapsedMs: result?.elapsedMs ?? 0,
              truncated: false,
              ...(result?.note ? { note: result.note } : {}),
            },
          });
          if (result?.status === "denied") {
            send({ type: "text-delta", turnId, delta: "\n\nLeft the layout alone." });
          }
          continue;
        }
      }

      send({
        type: "usage",
        turnId,
        inputTokens: 1_200,
        outputTokens: 320,
        totalTokens: 1_520,
        estimated: false,
      });
      send({ type: "done", turnId, reason: "complete" });
      controller.close();
    },
  });

  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

Bun.serve({
  port: PORT,
  idleTimeout: 0,
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/auth/get-session") return json({ user: USER });
    if (path === "/auth/sign-in" || path === "/auth/sign-up") return json({ user: USER });

    if (path === "/askg/session" && request.method === "POST") {
      if (FREE_TIER) {
        return json({ message: "Ask Gloom is included with Pro." }, { status: 402 });
      }
      const body = await request.json() as { tools?: unknown[]; manifestHash?: string };
      const tools = body.tools ?? [];
      console.log(`[askg] session start: ${tools.length} tools, hash ${body.manifestHash}`);
      return json({
        protocolVersion: 1,
        sessionId: "mock-session",
        manifestHash: body.manifestHash ?? "sha256:mock",
        serverTools: [
          {
            name: "news.search",
            source: "server",
            title: "News: Search",
            description: "Search the wire.",
            writeTier: "read",
            confirm: "never",
            timeoutMs: 15_000,
          },
        ],
        acceptedTools: (tools as Array<{ name: string }>).map((tool) => tool.name),
        rejectedTools: [],
        limits: {
          requestsPerMinute: 20,
          turnsPerDay: 100,
          turnsRemainingToday: 97,
          maxToolCallsPerTurn: 8,
          turnWallClockMs: 120_000,
          clientToolTimeoutMs: 30_000,
        },
        tier: "pro",
        model: "gloom-1",
        promptVersion: "2024-06-01",
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      });
    }

    const turnMatch = path.match(/^\/askg\/session\/([^/]+)\/turn$/);
    if (turnMatch && request.method === "POST") {
      const body = await request.json() as {
        turnId?: string;
        input?: string;
        history?: Array<{ role: string; text: string }>;
      };
      const lastEventId = Number(request.headers.get("Last-Event-ID") ?? "0") || 0;
      const turnId = body.turnId ?? "turn-0";
      const reattached = seenTurns.has(turnId);
      seenTurns.add(turnId);
      console.log(
        `[askg] turn ${turnId}${reattached ? " (re-attach)" : ""}: "${body.input}" lastEventId=${lastEventId} history=${body.history?.length ?? 0}`,
      );
      return turnStream(body.input ?? "", turnMatch[1] ?? "mock-session", lastEventId, turnId);
    }

    const resultMatch = path.match(/^\/askg\/session\/([^/]+)\/tool-result$/);
    if (resultMatch && request.method === "POST") {
      const payload = await request.json() as { toolCallId: string; status: string; rowCount?: number };
      const key = request.headers.get("Idempotency-Key");
      console.log(
        `[askg] tool-result ${payload.toolCallId} ${payload.status} rows=${payload.rowCount ?? "-"} key=${key}`,
      );
      if (key !== payload.toolCallId) {
        return json({ error: "idempotency key must equal toolCallId" }, { status: 400 });
      }
      if (lateToolCalls.has(payload.toolCallId)) {
        return json({ error: "result window closed" }, { status: 410 });
      }
      if (toolResults.has(payload.toolCallId)) return json({ status: "duplicate" }, { status: 202 });
      toolResults.set(payload.toolCallId, payload);
      return json({ status: "accepted" });
    }

    if (/^\/askg\/session\/[^/]+\/cancel$/.test(path)) {
      const body = await request.json().catch(() => ({})) as { turnId?: string };
      console.log(`[askg] cancel ${body.turnId ?? "-"}`);
      return json({ status: "cancelling" }, { status: 202 });
    }

    return json({ error: "not found", path }, { status: 404 });
  },
});

console.log(`Mock ASKG server on http://localhost:${PORT}`);
