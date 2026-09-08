import { describe, expect, test } from "bun:test";
import {
  askgReducer,
  describeToolStatus,
  EMPTY_ASKG_CONVERSATION,
  requiresLocalConfirmation,
  rowSymbol,
  summarizeToolArguments,
  toolResultTables,
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

  test("reads the row count into the status once a tool returns", () => {
    const base = {
      toolCallId: "call-1",
      name: "val",
      argumentSummary: "",
      writeTier: "read" as const,
      origin: "client" as const,
      requiresConfirmation: false,
      expanded: false,
    };
    expect(describeToolStatus({ ...base, status: "running" })).toBe("running");
    expect(describeToolStatus({ ...base, status: "ok", rowCount: 1 })).toBe("1 row");
    expect(describeToolStatus({ ...base, status: "ok", rowCount: 12 })).toBe("12 rows");
    expect(describeToolStatus({ ...base, status: "timeout" })).toBe("timed out");
  });

  test("finds the symbol a result row is about", () => {
    expect(rowSymbol({ ticker: "aapl", note: "x" })).toBe("AAPL");
    expect(rowSymbol({ name: "Apple Inc" })).toBeNull();
  });
});
