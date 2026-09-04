import { describe, expect, test } from "bun:test";
import type { HeadlessPaneDefinition } from "../../../../types/headless";
import { marketValuationHeadless } from "../../market-valuation/headless";
import {
  ASKG_PROTOCOL_VERSION,
  TOOL_NAME_PATTERN,
  type ASKGSessionStartRequest,
  type ASKGSessionStartResponse,
  type ASKGSseEvent,
  type ToolManifest,
  type ToolResultPayload,
} from "./protocol";

function jsonRoundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function projectHeadlessDefinition(
  definition: HeadlessPaneDefinition,
): ToolManifest {
  const options = definition.options.map(({ settingKey: _settingKey, pluginState: _pluginState, ...option }) => option);
  const columns = definition.columns?.map(({ format: _format, ...column }) => column);
  return {
    name: "market.valuation",
    source: "headless",
    title: "Market valuation",
    description: "Compare whole-market valuation ratios with their history.",
    writeTier: "read",
    shape: definition.shape,
    argument: definition.argument,
    options,
    ...(columns ? { columns } : {}),
    confirm: "never",
    timeoutMs: 30_000,
  };
}

describe("ASKG protocol", () => {
  test("round-trips session negotiation, a manifest, every event, and a tool result", () => {
    const manifest: ToolManifest = {
      name: "layout.place_pane",
      source: "remote-op",
      title: "Place pane",
      description: "Move a pane to a layout region.",
      writeTier: "ui-write",
      inputSchema: {
        type: "object",
        properties: {
          paneId: { type: "string" },
          region: { type: "string", enum: ["left", "right", "floating"] },
        },
        required: ["paneId", "region"],
        additionalProperties: false,
      },
      confirm: "never",
      timeoutMs: 10_000,
    };
    const sessionRequest: ASKGSessionStartRequest = {
      protocolVersion: ASKG_PROTOCOL_VERSION,
      client: { kind: "tui", version: "0.8.0" },
      context: {
        query: "Compare NVDA valuation",
        symbol: "NVDA",
        paneId: "ticker:main",
        layout: { id: "layout-1" },
      },
      tools: [manifest],
      manifestHash: "sha256:manifest-1",
    };
    const sessionResponse: ASKGSessionStartResponse = {
      protocolVersion: ASKG_PROTOCOL_VERSION,
      sessionId: "session-1",
      manifestHash: sessionRequest.manifestHash,
      serverTools: [],
      acceptedTools: [manifest.name],
      rejectedTools: [{ name: "invalid.tool", reason: "Unknown source" }],
      limits: {
        requestsPerMinute: 20,
        turnsPerDay: 300,
        turnsRemainingToday: 299,
        maxToolCallsPerTurn: 25,
        turnWallClockMs: 90_000,
        clientToolTimeoutMs: 10_000,
      },
      tier: "pro",
      model: "gpt-5.6-luna",
      promptVersion: "2026-09-04",
      expiresAt: "2026-09-04T21:30:00.000Z",
    };
    const events: ASKGSseEvent[] = [
      {
        type: "session",
        seq: 1,
        sessionId: "session-1",
        turnId: "turn-1",
        model: "gpt-5.6-luna",
        promptVersion: "2026-09-04",
      },
      { type: "text-delta", seq: 2, turnId: "turn-1", delta: "NVDA" },
      {
        type: "tool-call",
        seq: 3,
        turnId: "turn-1",
        toolCallId: "call-1",
        name: manifest.name,
        args: { paneId: "chart:main", region: "right" },
        writeTier: "ui-write",
        requiresConfirmation: false,
        preview: { paneId: "chart:main", region: "right", dryRun: true },
        timeoutMs: 10_000,
        expiresAt: "2026-09-04T21:00:10.000Z",
      },
      {
        type: "tool-executed",
        seq: 4,
        turnId: "turn-1",
        toolCallId: "call-server-1",
        name: "market.quote",
        source: "server",
        status: "ok",
        summary: {
          rowCount: 1,
          elapsedMs: 24,
          truncated: false,
          note: "Fresh quote",
          sample: { symbol: "NVDA", price: 180 },
        },
      },
      { type: "tool-result-ack", seq: 5, turnId: "turn-1", toolCallId: "call-1" },
      {
        type: "error",
        seq: 6,
        turnId: "turn-1",
        code: "rate_limited",
        message: "Try again shortly.",
        retryable: true,
        retryAfterMs: 1_000,
      },
      {
        type: "usage",
        seq: 7,
        turnId: "turn-1",
        inputTokens: 120,
        outputTokens: 30,
        totalTokens: 150,
        estimated: false,
      },
      { type: "done", seq: 8, turnId: "turn-1", reason: "complete" },
    ];
    const result: ToolResultPayload = {
      turnId: "turn-1",
      toolCallId: "call-1",
      status: "ok",
      result: { moved: true },
      rowCount: 1,
      truncated: false,
      elapsedMs: 12,
      rev: "rev-2",
      undoToken: "undo-1",
    };

    expect(new RegExp(TOOL_NAME_PATTERN).test(manifest.name)).toBe(true);
    expect(jsonRoundTrip(manifest)).toEqual(manifest);
    expect(jsonRoundTrip(sessionRequest)).toEqual(sessionRequest);
    expect(jsonRoundTrip(sessionResponse)).toEqual(sessionResponse);
    expect(events.map(jsonRoundTrip)).toEqual(events);
    expect(jsonRoundTrip(result)).toEqual(result);
  });

  test("projects a migrated headless definition without executable fields", () => {
    const manifest = projectHeadlessDefinition(marketValuationHeadless);
    const serialized = JSON.stringify(manifest);

    expect(new RegExp(TOOL_NAME_PATTERN).test(manifest.name)).toBe(true);
    expect(manifest).toMatchObject({
      source: "headless",
      writeTier: "read",
      shape: marketValuationHeadless.shape,
      argument: marketValuationHeadless.argument,
      confirm: "never",
    });
    expect(manifest.options).toHaveLength(marketValuationHeadless.options.length);
    expect(serialized).not.toContain("load");
    expect(serialized).not.toContain("settingKey");
    expect(serialized).not.toContain("pluginState");
    expect(serialized).not.toContain("format");
    expect(jsonRoundTrip(manifest)).toEqual(manifest);
  });
});
