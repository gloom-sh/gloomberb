import { describe, expect, test } from "bun:test";
import {
  askgReducer,
  canRateTurn,
  canRetryASKGError,
  describeASKGError,
  EMPTY_ASKG_CONVERSATION,
  requiresLocalConfirmation,
  rowSymbol,
  summarizeToolArguments,
  toolResultTables,
  turnsFromConversation,
  type ASKGConversationState,
} from "./model";
import type { ASKGSseEvent } from "./protocol";

function withTurn(): ASKGConversationState {
  return askgReducer(EMPTY_ASKG_CONVERSATION, {
    type: "prompt",
    turnId: "turn-1",
    prompt: "what is open",
    at: 0,
  });
}

function apply(state: ASKGConversationState, ...events: ASKGSseEvent[]): ASKGConversationState {
  return events.reduce((current, event) => askgReducer(current, { type: "event", event }), state);
}

describe("askgReducer", () => {
  test("builds the answer and one timeline row per tool call", () => {
    const state = apply(
      withTurn(),
      { seq: 1, type: "session", sessionId: "s1", turnId: "turn-1", model: "gloom-1", promptVersion: "v1" },
      { seq: 2, type: "text-delta", turnId: "turn-1", delta: "Reading " },
      {
        seq: 3,
        type: "tool-call",
        turnId: "turn-1",
        toolCallId: "call-1",
        name: "val",
        args: { range: "20Y" },
        writeTier: "read",
        requiresConfirmation: false,
        preview: null,
        timeoutMs: 30_000,
        expiresAt: new Date().toISOString(),
      },
      { seq: 4, type: "text-delta", turnId: "turn-1", delta: "the market." },
    );

    const turn = state.turns[0]!;
    expect(turn.answer).toBe("Reading the market.");
    expect(turn.tools).toHaveLength(1);
    expect(turn.tools[0]).toMatchObject({
      name: "val",
      origin: "client",
      status: "pending",
      argumentSummary: "range=20Y",
    });
  });

  test("keeps a server tool in the same timeline, marked as run by Gloom", () => {
    const state = apply(withTurn(), {
      seq: 1,
      type: "tool-executed",
      turnId: "turn-1",
      toolCallId: "server-1",
      name: "news.search",
      source: "server",
      status: "ok",
      summary: { rowCount: 6, elapsedMs: 120, truncated: false, note: "6 wire stories" },
    });

    expect(state.turns[0]?.tools[0]).toMatchObject({
      name: "news.search",
      origin: "server",
      status: "ok",
      rowCount: 6,
    });
  });

  test("a server tool row keeps the arguments its event carried, and has none from a server that sends none", () => {
    const executed = (seq: number, extra: Record<string, unknown>) => ({
      seq,
      type: "tool-executed",
      turnId: "turn-1",
      toolCallId: `server-${seq}`,
      name: "market.quotes",
      source: "server",
      status: "ok",
      summary: { rowCount: 2, elapsedMs: 90, truncated: false, note: "1 requested quote was unavailable." },
      ...extra,
    }) as ASKGSseEvent;
    const [withArgs, older, malformed] = apply(
      withTurn(),
      executed(1, { args: { symbols: ["NVDA", "AMD"], limit: 2 } }),
      executed(2, {}),
      executed(3, { args: ["NVDA"] }),
    ).turns[0]!.tools;

    expect(withArgs).toMatchObject({
      origin: "server",
      args: { symbols: ["NVDA", "AMD"], limit: 2 },
      argumentSummary: "NVDA,AMD · limit=2",
    });
    // The same row as an older server sends it: no arguments, the note as the summary.
    expect(older).toMatchObject({ origin: "server", argumentSummary: "1 requested quote was unavailable." });
    expect(older).not.toHaveProperty("args");
    expect(malformed).not.toHaveProperty("args");
  });

  test("drops events a resumed stream replays", () => {
    const streamed = apply(
      withTurn(),
      { seq: 1, type: "text-delta", turnId: "turn-1", delta: "half " },
      { seq: 2, type: "text-delta", turnId: "turn-1", delta: "answer" },
    );
    const resumed = apply(streamed, { seq: 2, type: "text-delta", turnId: "turn-1", delta: "answer" });
    expect(resumed.turns[0]?.answer).toBe("half answer");
  });

  test("a reused server turn id lands on the newest turn", () => {
    const first = apply(withTurn(), { seq: 1, type: "done", turnId: "turn-1", reason: "complete" });
    const second = askgReducer(first, { type: "prompt", turnId: "turn-1", prompt: "again", at: 1 });
    const streamed = apply(second, { seq: 1, type: "text-delta", turnId: "turn-1", delta: "new" });

    expect(streamed.turns[0]?.answer).toBe("");
    expect(streamed.turns[1]?.answer).toBe("new");
  });

  test("a local tool result fills in the row and offers undo when one exists", () => {
    const called = apply(withTurn(), {
      seq: 1,
      type: "tool-call",
      turnId: "turn-1",
      toolCallId: "call-1",
      name: "pane.set_setting",
      args: { paneId: "chart:main", key: "range", value: "5Y" },
      writeTier: "ui-write",
      requiresConfirmation: false,
      preview: null,
      timeoutMs: 10_000,
      expiresAt: new Date().toISOString(),
    });
    const state = askgReducer(called, {
      type: "tool-result",
      payload: {
        turnId: "turn-1",
        toolCallId: "call-1",
        status: "ok",
        truncated: false,
        elapsedMs: 8,
        rowCount: 1,
        undoToken: "undo-1",
      },
    });

    expect(state.turns[0]?.tools[0]).toMatchObject({
      status: "ok",
      rowCount: 1,
      undoToken: "undo-1",
      undo: { status: "available" },
    });
  });

  test("a script reports how it ended on its own row and leaves the rows of its calls alone", () => {
    const called = apply(withTurn(), {
      seq: 1,
      type: "tool-call",
      turnId: "turn-1",
      toolCallId: "script-1-1",
      name: "pane.set_setting",
      args: { paneId: "chart:main", key: "range", value: "5Y" },
      writeTier: "ui-write",
      requiresConfirmation: false,
      preview: null,
      timeoutMs: 10_000,
      expiresAt: new Date().toISOString(),
    });
    const ran = askgReducer(called, {
      type: "tool-result",
      payload: {
        turnId: "turn-1",
        toolCallId: "script-1-1",
        status: "ok",
        truncated: false,
        elapsedMs: 8,
        undoToken: "undo-1",
      },
    });
    const state = apply(
      ran,
      { seq: 2, type: "tool-result-ack", turnId: "turn-1", toolCallId: "script-1-1" },
      {
        seq: 3,
        type: "tool-executed",
        turnId: "turn-1",
        toolCallId: "script-1-1",
        name: "pane.set_setting",
        source: "remote-op",
        status: "ok",
        summary: { elapsedMs: 9, truncated: false },
      },
      {
        seq: 4,
        type: "tool-executed",
        turnId: "turn-1",
        toolCallId: "script-1-2",
        name: "news.search",
        source: "server",
        status: "error",
        summary: { elapsedMs: 40, truncated: false, note: "Search failed." },
      },
      // An echo that calls the client's own call a server one changes nothing.
      {
        seq: 5,
        type: "tool-executed",
        turnId: "turn-1",
        toolCallId: "script-1-1",
        name: "pane.set_setting",
        source: "server",
        status: "ok",
        summary: { elapsedMs: 9, truncated: false, note: "echo" },
      },
      // The script itself is reported last, once its calls are done.
      {
        seq: 6,
        type: "tool-executed",
        turnId: "turn-1",
        toolCallId: "script-1",
        name: "run_script",
        source: "server",
        status: "partial",
        summary: { rowCount: 2, elapsedMs: 1_200, truncated: false, note: "2 calls, 1 failed, 1.2 s" },
      },
    );

    const [call, serverCall, script, ...rest] = state.turns[0]!.tools;
    expect(rest).toEqual([]);
    expect(call).toMatchObject({
      toolCallId: "script-1-1",
      name: "pane.set_setting",
      origin: "client",
      writeTier: "ui-write",
      argumentSummary: "chart:main \u00b7 key=range \u00b7 value=5Y",
      undoToken: "undo-1",
      undo: { status: "available" },
    });
    expect(serverCall).toMatchObject({ name: "news.search", origin: "server", status: "error" });
    expect(script).toMatchObject({ name: "run_script", origin: "server", status: "partial" });
    expect(script?.note).toBe("2 calls, 1 failed, 1.2 s");
  });

  test("an error event describes the turn instead of leaving it streaming", () => {
    const state = apply(withTurn(), {
      seq: 1,
      type: "error",
      turnId: "turn-1",
      code: "rate_limited",
      message: "Too many questions.",
      retryable: true,
      retryAfterMs: 42_000,
    });
    expect(state.turns[0]).toMatchObject({
      status: "error",
      error: { code: "rate_limited", retryAfterMs: 42_000 },
    });
  });
});

describe("requiresLocalConfirmation", () => {
  test("stops account and broker writes, and lets reads and layout writes run", () => {
    expect(requiresLocalConfirmation({ writeTier: "read", requiresConfirmation: false })).toBe(false);
    expect(requiresLocalConfirmation({ writeTier: "ui-write", requiresConfirmation: false })).toBe(false);
    expect(requiresLocalConfirmation({ writeTier: "user-data", requiresConfirmation: false })).toBe(true);
    expect(requiresLocalConfirmation({ writeTier: "broker", requiresConfirmation: false })).toBe(true);
    // The server can ask for a confirmation on any tier.
    expect(requiresLocalConfirmation({ writeTier: "ui-write", requiresConfirmation: true })).toBe(true);
  });
});

describe("toolResultTables", () => {
  test("uses the columns a headless rows result declares", () => {
    const tables = toolResultTables({
      columns: [{ key: "symbol", header: "Ticker" }, { key: "last", header: "Last", align: "right" }],
      rows: [{ symbol: "NVDA", last: 120.5 }],
    });
    expect(tables).toHaveLength(1);
    expect(tables[0]?.columns).toEqual([
      { key: "symbol", header: "Ticker" },
      { key: "last", header: "Last", align: "right" },
    ]);
    expect(tables[0]?.rows).toHaveLength(1);
  });

  test("splits a bundle into one table per section, including entry sections", () => {
    const tables = toolResultTables({
      sections: [
        { title: "Multiples", rows: [{ metric: "P/E", value: 22 }] },
        { title: "Summary", entries: [{ label: "Median", value: 18, formatted: "18.0x" }] },
      ],
    });
    expect(tables.map((table) => table.title)).toEqual(["Multiples", "Summary"]);
    expect(tables[1]?.rows).toEqual([{ label: "Median", value: "18.0x" }]);
  });

  test("describes a plain remote operation result as fields", () => {
    const tables = toolResultTables({ paneId: "chart:main", ok: true });
    expect(tables[0]?.rows).toEqual([
      { label: "paneId", value: "chart:main" },
      { label: "ok", value: true },
    ]);
  });
});

describe("timeline row helpers", () => {
  test("summarizes arguments with the subject first", () => {
    expect(summarizeToolArguments({ range: "5Y", symbol: "NVDA" })).toBe("NVDA · range=5Y");
    expect(summarizeToolArguments({ resource: "app://panes" })).toBe("app://panes");
  });

  test("finds the symbol a result row is about", () => {
    expect(rowSymbol({ ticker: "aapl", note: "x" })).toBe("AAPL");
    expect(rowSymbol({ name: "Apple Inc" })).toBeNull();
  });
});

describe("daily questions left", () => {
  test("counts each turn the platform admits after the limits were read, and none once it refuses at the cap", () => {
    const limits = {
      requestsPerMinute: 20,
      turnsPerDay: 300,
      turnsRemainingToday: 12,
      maxToolCallsPerTurn: 8,
      turnWallClockMs: 60_000,
      clientToolTimeoutMs: 10_000,
    };
    const session = (seq: number, turnId: string): ASKGSseEvent => ({
      seq, type: "session", sessionId: "s1", turnId, model: "m", promptVersion: "v1",
    });
    let state = askgReducer(withTurn(), { type: "session-started", sessionId: "s1", model: "m", limits, acceptedTools: [], feedback: false });
    state = apply(state, session(1, "remote-1"));
    // A resumed stream replays its session frame; the turn is counted once.
    state = apply(state, session(1, "remote-1"));
    expect(state.limits?.turnsRemainingToday).toBe(11);

    state = askgReducer(state, { type: "prompt", turnId: "turn-2", prompt: "and now?", at: 1 });
    state = apply(state, { seq: 1, type: "error", turnId: "turn-2", code: "daily_turn_cap", message: "No questions left today.", retryable: false });
    expect(state.limits?.turnsRemainingToday).toBe(0);
  });
});

describe("failure handling", () => {
  test("offers a retry only where asking again could answer", () => {
    const failure = (code: Parameters<typeof canRetryASKGError>[0]["code"]) => (
      canRetryASKGError({ code, message: "", retryable: false })
    );
    expect(failure("network")).toBe(true);
    expect(failure("turn_timeout")).toBe(true);
    expect(failure("rate_limited")).toBe(true);
    expect(failure("model_unavailable")).toBe(true);
    expect(failure("internal")).toBe(true);
    expect(failure("tool_budget_exhausted")).toBe(true);

    expect(failure("transport_unsupported")).toBe(false);
    expect(failure("tier_required")).toBe(false);
    expect(failure("unauthorized")).toBe(false);
    expect(failure("daily_turn_cap")).toBe(false);
    expect(failure("model_usage_limit")).toBe(false);
    expect(failure("protocol")).toBe(false);
    expect(failure("turn_already_recorded")).toBe(false);
  });

  test("keeps the whole reason in the message rather than a title alone", () => {
    expect(describeASKGError({
      code: "rate_limited",
      message: "Too many requests.",
      retryable: true,
      retryAfterMs: 12_000,
    })).toBe("Rate limited: Too many requests. Try again in 12s.");
    expect(describeASKGError({
      code: "network",
      message: "Connection lost",
      retryable: true,
    })).toBe("Connection lost.");
    // The cap says when there will be more, in words, and never its code.
    expect(describeASKGError({
      code: "daily_turn_cap",
      message: "The daily Ask Gloom turn limit is used up. daily_turn_cap",
      retryable: false,
      retryAfterMs: 79_188_000,
    })).toBe("No questions left today. More in 22 h.");
  });

  test("a retried turn leaves no trace of the attempt it replaces", () => {
    const failed = askgReducer(withTurn(), {
      type: "turn-failed",
      turnId: "turn-1",
      error: { code: "network", message: "dropped", retryable: true },
    });
    expect(failed.turns).toHaveLength(1);

    const dropped = askgReducer(failed, { type: "drop-turn", turnId: "turn-1" });
    expect(dropped.turns).toHaveLength(0);
    expect(askgReducer(dropped, { type: "drop-turn", turnId: "turn-1" })).toBe(dropped);
  });
});

describe("stored conversations", () => {
  test("a stored conversation rebuilds as question and answer turns", () => {
    const at = "2026-09-20T10:00:00.000Z";
    const turns = turnsFromConversation({
      id: "conv-1",
      title: "Bonds",
      messageCount: 5,
      lastMessageAt: at,
      createdAt: at,
      updatedAt: at,
      messages: [
        { seq: 1, role: "user", text: "5y bonds?", tools: [], turnId: "t1", createdAt: at },
        {
          seq: 2,
          role: "assistant",
          text: "About 4.2%.",
          tools: [{
            toolCallId: "call-1",
            name: "econ.series",
            origin: "server",
            status: "ok",
            args: { symbol: "DGS5" },
            rowCount: 12,
          }],
          turnId: "t1",
          createdAt: at,
        },
        { seq: 3, role: "user", text: "and 10y?", tools: [], turnId: "t2", createdAt: at },
        { seq: 4, role: "assistant", text: "About 4.4%.", tools: [], turnId: "t2", createdAt: at },
        // Trimming can drop a question and leave its answer behind; the answer
        // still shows rather than being attached to an unrelated question.
        { seq: 5, role: "assistant", text: "Orphan.", tools: [], turnId: "t3", createdAt: at },
      ],
    });

    expect(turns).toHaveLength(3);
    expect(turns[0]).toMatchObject({ prompt: "5y bonds?", answer: "About 4.2%.", status: "complete" });
    expect(turns[0]?.tools[0]).toMatchObject({
      name: "econ.series",
      origin: "server",
      argumentSummary: "DGS5",
      rowCount: 12,
    });
    // No result means the row renders as one that cannot be expanded.
    expect(turns[0]?.tools[0]?.result).toBeUndefined();
    expect(turns[1]).toMatchObject({ prompt: "and 10y?", answer: "About 4.4%." });
    expect(turns[2]).toMatchObject({ prompt: "", answer: "Orphan." });
  });

  test("a stored script reads as it did live, its calls in their own rows", () => {
    const at = "2026-09-20T10:00:00.000Z";
    const [turn] = turnsFromConversation({
      id: "conv-3",
      title: "Margins",
      messageCount: 2,
      lastMessageAt: at,
      createdAt: at,
      updatedAt: at,
      messages: [
        { seq: 1, role: "user", text: "compare margins", tools: [], turnId: "t1", createdAt: at },
        {
          seq: 2,
          role: "assistant",
          text: "Partly.",
          tools: [
            { toolCallId: "s-1", name: "fa", origin: "client", status: "ok", args: { symbol: "NVDA" }, rowCount: 8 },
            { toolCallId: "s-2", name: "fa", origin: "client", status: "error", args: { symbol: "AMD" }, note: "No filings." },
            {
              toolCallId: "s",
              name: "run_script",
              origin: "server",
              status: "timeout",
              // Whatever the platform kept of the call, the code is not a summary.
              args: { code: "const a = await tools.fa({ symbol: 'NVDA' });" },
              rowCount: 2,
              note: "Script timed out after 2 calls, 20.0 s",
            },
          ],
          turnId: "t1",
          createdAt: at,
        },
      ],
    });

    expect(turn?.tools.map((row) => [row.name, row.status, row.rowCount])).toEqual([
      ["fa", "ok", 8],
      ["fa", "error", undefined],
      ["run_script", "timeout", 2],
    ]);
    // The arguments survive, so a reopened row names what it read.
    expect(turn?.tools[1]?.args).toEqual({ symbol: "AMD" });
    expect(turn?.tools[2]?.note).toBe("Script timed out after 2 calls, 20.0 s");
  });

  test("opening a conversation replaces the turns and starting one clears them", () => {
    const at = "2026-09-20T10:00:00.000Z";
    const opened = askgReducer(withTurn(), {
      type: "conversation-opened",
      conversation: {
        id: "conv-2",
        title: null,
        messageCount: 2,
        lastMessageAt: at,
        createdAt: at,
        updatedAt: at,
        messages: [
          { seq: 1, role: "user", text: "stored", tools: [], turnId: "t1", createdAt: at },
          { seq: 2, role: "assistant", text: "answer", tools: [], turnId: "t1", createdAt: at },
        ],
      },
    });
    expect(opened.conversationId).toBe("conv-2");
    expect(opened.turns.map((turn) => turn.prompt)).toEqual(["stored"]);

    const started = askgReducer(opened, { type: "conversation-started" });
    expect(started.conversationId).toBeNull();
    expect(started.turns).toEqual([]);
  });

  test("a reopened conversation shows the ratings it was given, on a server that takes them", () => {
    const at = "2026-09-20T10:00:00.000Z";
    const conversation = {
      id: "conv-3",
      title: null,
      messageCount: 6,
      lastMessageAt: at,
      createdAt: at,
      updatedAt: at,
      messages: [
        { seq: 1, role: "user" as const, text: "q1", tools: [], turnId: "t1", createdAt: at },
        {
          seq: 2,
          role: "assistant" as const,
          text: "a1",
          tools: [],
          turnId: "t1",
          createdAt: at,
          feedback: { rating: "down" as const, reason: "wrong" as const, shared: true },
        },
        { seq: 3, role: "user" as const, text: "q2", tools: [], turnId: "t2", createdAt: at },
        { seq: 4, role: "assistant" as const, text: "a2", tools: [], turnId: "t2", createdAt: at, feedback: null },
        { seq: 5, role: "user" as const, text: "q3", tools: [], turnId: "t3", createdAt: at },
        // An unknown thumb from a newer server is no rating rather than a wrong one.
        {
          seq: 6,
          role: "assistant" as const,
          text: "a3",
          tools: [],
          turnId: "t3",
          createdAt: at,
          feedback: { rating: "meh", reason: null, shared: false } as never,
        },
      ],
    };

    const older = askgReducer(EMPTY_ASKG_CONVERSATION, { type: "conversation-opened", conversation });
    expect(older.feedbackAvailable).toBe(false);
    expect(older.turns.some((turn) => canRateTurn(older, turn))).toBe(false);

    const opened = askgReducer(EMPTY_ASKG_CONVERSATION, {
      type: "conversation-opened",
      conversation: { ...conversation, capabilities: { feedback: 1 } },
    });
    expect(opened.feedbackAvailable).toBe(true);
    expect(opened.turns.map((turn) => turn.feedback)).toEqual([
      { rating: "down", reason: "wrong", shared: true, pending: null },
      undefined,
      undefined,
    ]);
    expect(opened.turns.every((turn) => canRateTurn(opened, turn))).toBe(true);
    // Starting over keeps what the server said about ratings; only the turns go.
    expect(askgReducer(opened, { type: "conversation-started" }).feedbackAvailable).toBe(true);
  });
});
