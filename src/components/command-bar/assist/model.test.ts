import { describe, expect, test } from "bun:test";
import {
  buildAssistResultItems,
  shouldAutoAskAssist,
  shouldShowAssistRow,
  type AssistRequestState,
} from "./model";

const handlers = {
  onAsk: () => {},
  onSignUp: () => {},
  onRunCandidate: () => {},
};

function labels(
  state: AssistRequestState,
  options?: { query?: string; enabled?: boolean; auto?: boolean },
): string[] {
  return buildAssistResultItems({
    ...handlers,
    query: options?.query ?? "chart nvidia vs amd",
    enabled: options?.enabled ?? true,
    auto: options?.auto ?? true,
    state,
  }).map((item) => item.label);
}

describe("shouldAutoAskAssist", () => {
  test("stays out of the way while the user speaks the command language", () => {
    expect(shouldAutoAskAssist({ query: "chart nvidia vs amd", hasShortcutIntent: false })).toBe(true);
    expect(shouldAutoAskAssist({ query: "nvda", hasShortcutIntent: false })).toBe(true);
    // A recognized prefix — with or without an argument — is not a question.
    expect(shouldAutoAskAssist({ query: "T NVDA", hasShortcutIntent: true })).toBe(false);
    expect(shouldAutoAskAssist({ query: "gg", hasShortcutIntent: false })).toBe(false);
    expect(shouldAutoAskAssist({ query: "   ", hasShortcutIntent: false })).toBe(false);
  });
});

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
    expect(labels({ status: "idle" }, { enabled: false })).toEqual(["Ask AI — sign up to enable"]);
  });

  test("renders each state of the request", () => {
    expect(labels({ status: "idle" })).toEqual(["Thinking…"]);
    expect(labels({ status: "idle" }, { auto: false })).toEqual([]);
    expect(labels({ status: "loading", query: "chart nvidia vs amd", source: "auto" }))
      .toEqual(["Thinking…"]);
    expect(labels({ status: "answered", query: "chart nvidia vs amd", source: "auto", candidates: [] }))
      .toEqual(["No command found — try HELP"]);
  });

  test("keeps failures silent unless the user asked for the answer", () => {
    const failure = { status: "error", query: "chart nvidia vs amd", kind: "rate-limited" } as const;
    expect(labels({ ...failure, source: "auto" })).toEqual([]);
    expect(labels({ ...failure, source: "explicit" }))
      .toEqual(["Rate limited — try again in a minute"]);
  });

  test("shows candidates input-first and runs the exact command-bar text", () => {
    const runs: Array<[string, string | undefined]> = [];
    const items = buildAssistResultItems({
      ...handlers,
      onRunCandidate: (input, prefix) => runs.push([input, prefix]),
      query: "chart nvidia vs amd",
      enabled: true,
      auto: true,
      state: {
        status: "answered",
        query: "chart nvidia vs amd",
        source: "auto",
        candidates: [{ input: "G NVDA AMD", title: "Chart NVDA vs AMD", prefix: "G", confidence: 0.9 }],
      },
    });

    expect(items[0]?.label).toBe("G NVDA AMD — Chart NVDA vs AMD");
    // The marker rides the trailing column instead of shifting the label.
    expect(items[0]?.right).toBe("✦");
    expect(items[0]?.accent).toBe(true);
    items[0]?.action();
    expect(runs).toEqual([["G NVDA AMD", "G"]]);
  });

  test("ignores an answer that belongs to an earlier query", () => {
    const state: AssistRequestState = {
      status: "answered",
      query: "chart nvidia",
      source: "auto",
      candidates: [{ input: "G NVDA", title: "Chart NVDA", prefix: "G", confidence: 0.9 }],
    };
    expect(labels(state, { query: "chart nvidia vs amd" })).toEqual(["Thinking…"]);
  });
});
