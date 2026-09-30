import { expect, test } from "bun:test";
import type { ReactElement } from "react";
import type { WizardStep } from "../types/plugin";
import { runPaneTemplateDialogWizard } from "./pane-template-dialog-wizard";

/** Answers each prompt in turn and records the default each step offered. */
async function runWizard(steps: WizardStep[], answers: string[]) {
  const defaults: Array<string | undefined> = [];
  const dialog = {
    prompt: async ({ content }: { content: (context: unknown) => ReactElement }) => {
      const element = content({});
      defaults.push((element.props as { step?: { defaultValue?: string } }).step?.defaultValue);
      return answers.shift();
    },
  };
  const values = await runPaneTemplateDialogWizard(dialog as never, steps);
  return { defaults, values };
}

const providerStep = (defaultValue?: string): WizardStep => ({
  key: "providerId",
  label: "Provider",
  type: "select",
  defaultValue,
  clearOnChange: ["modelId"],
  options: [
    { label: "Claude", value: "claude" },
    { label: "OpenAI", value: "codex" },
  ],
});

const modelStep: WizardStep = {
  key: "modelId",
  label: "Model",
  type: "text",
  required: false,
  defaultValue: "claude-opus-4-8",
};

test("changing a sequential wizard selector clears a later default", async () => {
  const { defaults, values } = await runWizard([providerStep("claude"), modelStep], ["codex", ""]);

  expect(defaults).toEqual(["claude", undefined]);
  expect(values).toEqual({ providerId: "codex", modelId: "" });
});

test("keeping a selector's preselected first option leaves later defaults alone", async () => {
  const { defaults, values } = await runWizard([providerStep(), modelStep], ["claude", "claude-opus-4-8"]);

  expect(defaults).toEqual([undefined, "claude-opus-4-8"]);
  expect(values).toEqual({ providerId: "claude", modelId: "claude-opus-4-8" });
});
