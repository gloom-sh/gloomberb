import { describe, expect, test } from "bun:test";
import {
  buildAssistResultItems,
  shouldShowAssistRow,
  type AssistRequestState,
} from "./model";

const handlers = {
  onAsk: () => {},
  onSignUp: () => {},
  onRunCandidate: () => {},
};

function labels(state: AssistRequestState, options?: { query?: string; enabled?: boolean }): string[] {
  return buildAssistResultItems({
    ...handlers,
    query: options?.query ?? "chart nvidia vs amd",
    enabled: options?.enabled ?? true,
    state,
  }).map((item) => item.label);
}

describe("shouldShowAssistRow", () => {
  test("offers the AI on natural language, or on any dead end", () => {
    expect(shouldShowAssistRow({ query: "chart nvidia vs amd", resultCount: 4 })).toBe(true);
    expect(shouldShowAssistRow({ query: "zzzz", resultCount: 0 })).toBe(true);
    expect(shouldShowAssistRow({ query: "chart", resultCount: 3 })).toBe(false);
    expect(shouldShowAssistRow({ query: "  ", resultCount: 0 })).toBe(false);
    // Trailing whitespace alone is not a second word.
    expect(shouldShowAssistRow({ query: "chart ", resultCount: 3 })).toBe(false);
  });
});

describe("buildAssistResultItems", () => {
  test("routes signed-out users to sign up instead of the request", () => {
    expect(labels({ status: "idle" }, { enabled: false })).toEqual(["✦ Ask AI — sign up to enable"]);
  });

  test("renders each state of the request", () => {
    expect(labels({ status: "idle" })).toEqual(['✦ Ask AI: "chart nvidia vs amd"']);
    expect(labels({ status: "loading", query: "chart nvidia vs amd" })).toEqual(["✦ Thinking…"]);
    expect(labels({ status: "answered", query: "chart nvidia vs amd", candidates: [] }))
      .toEqual(["✦ No command found — try HELP"]);
    expect(labels({ status: "error", query: "chart nvidia vs amd", kind: "rate-limited" }))
      .toEqual(["✦ Rate limited — try again in a minute"]);
  });

  test("shows candidates input-first and runs the exact command-bar text", () => {
    const runs: string[] = [];
    const items = buildAssistResultItems({
      ...handlers,
      onRunCandidate: (input) => runs.push(input),
      query: "chart nvidia vs amd",
      enabled: true,
      state: {
        status: "answered",
        query: "chart nvidia vs amd",
        candidates: [{ input: "G NVDA AMD", title: "Chart NVDA vs AMD", prefix: "G", confidence: 0.9 }],
      },
    });

    expect(items[0]?.label).toBe("✦ G NVDA AMD — Chart NVDA vs AMD");
    items[0]?.action();
    expect(runs).toEqual(["G NVDA AMD"]);
  });

  test("ignores an answer that belongs to an earlier query", () => {
    const state: AssistRequestState = {
      status: "answered",
      query: "chart nvidia",
      candidates: [{ input: "G NVDA", title: "Chart NVDA", prefix: "G", confidence: 0.9 }],
    };
    expect(labels(state, { query: "chart nvidia vs amd" })).toEqual(['✦ Ask AI: "chart nvidia vs amd"']);
  });
});
