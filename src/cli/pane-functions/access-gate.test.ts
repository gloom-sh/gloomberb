import { describe, expect, test } from "bun:test";
import { incompleteReportGateMessage } from "./access-gate";
import type { DesktopPaneShotPayload } from "../desktop-pane-shot";
import type { ResolvedPaneFunction } from "./resolver";
import { shotUnusableReasonFor } from "./screenshot";

describe("a failed bot-safe report names the lock", () => {
  // The wording each Pro-gated loader already reports in its errors.
  test.each([
    ["Full history requires Gloom Pro"],
    ["Additional records and history need Gloom Pro."],
    ["Free preview: one holding, depth one. Full analysis requires Pro."],
    ["12 deals from the last 90 days need Gloom Pro"],
    ["Pro access required"],
  ])("%s", (error) => {
    expect(incompleteReportGateMessage("PERP", [error])).toBe(`PERP is not bot-safe: some values need Gloom Cloud Pro (locked). ${error.replace(/\.$/, "")}.`);
  });

  test("a sign-in wall wins over a Pro lock", () => {
    expect(incompleteReportGateMessage("SPLC", ["Full history requires Gloom Pro", "Sign in required"]))
      .toBe("SPLC is not bot-safe: it needs a Gloom Cloud sign-in. Full history requires Gloom Pro. Sign in required.");
  });

  test("errors that are not a gate keep the generic message", () => {
    expect(incompleteReportGateMessage("PERP", ["History reached the 5,000-observation limit; narrow the range"])).toBeNull();
    expect(incompleteReportGateMessage("PERP", ["Pro forma figures are unavailable"])).toBeNull();
    expect(incompleteReportGateMessage("PERP", undefined)).toBeNull();
  });
});

test("a gated pane's screenshot says what is locked, not that it is empty", () => {
  const resolved = { capability: { id: "perps-pane" } } as ResolvedPaneFunction;
  const payload = {} as DesktopPaneShotPayload;
  const rendered = { loadingStateDetected: false, errorStateDetected: false, emptyStateDetected: true };
  expect(shotUnusableReasonFor(resolved, payload, { ...rendered, accessGate: "pro" }, [], false)).toBe("Some values need Gloom Cloud Pro (locked).");
  expect(shotUnusableReasonFor(resolved, payload, { ...rendered, errorStateDetected: true, accessGate: "sign-in" }, [], false)).toBe("It needs a Gloom Cloud sign-in.");
  expect(shotUnusableReasonFor(resolved, payload, { ...rendered, accessGate: null }, [], false)).toBe("The pane rendered an empty state.");
});
