import { expect, test } from "bun:test";
import type { CommandBarWorkflowRoute } from "../command-bar/workflow/types";
import { applyFormValue, focusAfterField, moveFormFocus } from "./model";

const route: CommandBarWorkflowRoute = {
  kind: "workflow",
  workflowId: "plugin-command:ai",
  title: "AI Agent",
  fields: [
    { id: "provider", label: "Provider", type: "select", options: [], clearOnChange: ["model"] },
    { id: "model", label: "Model", type: "text" },
    { id: "key", label: "API Key", type: "password", dependsOn: [{ key: "provider", value: "byok" }] },
  ],
  values: { provider: "byok", model: "opus", key: "sk" },
  activeFieldId: "key",
  submitLabel: "Create",
  pending: false,
  error: null,
  payload: { kind: "plugin-command", actionId: "ai" },
};

test("a changed selector clears what depends on it and hands focus back when the active field hides", () => {
  const next = applyFormValue({ ...route, error: "API Key is required." }, "provider", "claude");
  expect(next.values).toEqual({ provider: "claude", model: "", key: "sk" });
  expect(next.activeFieldId).toBe("provider");
  expect(next.error).toBeNull();
  // Writing the same value again leaves the dependents alone.
  expect(applyFormValue(route, "provider", "byok").values.model).toBe("opus");
});

test("the focus ring ends on the button: Tab wraps, the arrows stop, a pick moves on", () => {
  const onKey = { fieldId: "key", onSubmit: false };
  expect(moveFormFocus(route, onKey, 1, true)).toEqual({ fieldId: "key", onSubmit: true });
  expect(moveFormFocus(route, { fieldId: "key", onSubmit: true }, 1, true)).toEqual({ fieldId: "provider", onSubmit: false });
  expect(moveFormFocus(route, { fieldId: "key", onSubmit: true }, 1, false)).toEqual({ fieldId: "key", onSubmit: true });
  expect(moveFormFocus(route, { fieldId: "provider", onSubmit: false }, -1, false)).toEqual({ fieldId: "provider", onSubmit: false });
  expect(focusAfterField(route, "provider")).toEqual({ fieldId: "model", onSubmit: false });
  expect(focusAfterField(route, "key").onSubmit).toBe(true);
});
