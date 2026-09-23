import { afterEach, expect, test } from "bun:test";
import { connectionHealth } from "../core/connection-health";
import type { AppState } from "../state/app/context";
import { createDefaultConfig } from "../types/config";
import { collectFeedbackDiagnostics } from "./diagnostics";

const disposers: Array<() => void> = [];
afterEach(() => {
  while (disposers.length) disposers.pop()!();
});

test("diagnostics stay under the server's 16k cap and never echo a request body", () => {
  const prompt = "What does page 40 of the 10-K say about ".repeat(600);
  for (let index = 0; index < 20; index += 1) {
    const id = `feedback-test-${index}`;
    disposers.push(connectionHealth.registerSource({ id, name: id, kind: "api" }));
    connectionHealth.reportRequest(id, {
      operation: "POST /askg/turn",
      success: false,
      latencyMs: 5,
      error: new Error(index === 0
        ? JSON.stringify({ type: "validation", on: "body", found: { input: prompt } })
        : `upstream failed ${"x".repeat(5000)}`),
    });
  }
  const state = { config: createDefaultConfig("/tmp/gloom-test"), focusedPaneId: null } as unknown as AppState;
  const serialized = JSON.stringify(collectFeedbackDiagnostics(state, null, { width: 120, height: 40 }));
  expect(serialized.length).toBeLessThanOrEqual(16_000);
  expect(serialized).not.toContain("10-K");
});
