import { describe, expect, test } from "bun:test";
import type { WizardStep } from "../../types/plugin";
import type { CommandBarWorkflowField } from "./workflow/types";
import {
  getFirstVisibleFieldId,
  getVisibleWorkflowFields,
  normalizeWizardFields,
  summarizeWorkflowFieldValue,
} from "./helpers";

const workflowFields: CommandBarWorkflowField[] = [
  {
    id: "source",
    label: "Source",
    type: "select",
    options: [
      { label: "Manual", value: "manual" },
      { label: "Broker", value: "broker" },
    ],
  },
  {
    id: "account",
    label: "Account",
    type: "text",
    dependsOn: [{ key: "source", value: "broker" }],
  },
  {
    id: "enabled",
    label: "Enabled",
    type: "toggle",
  },
];

describe("command-bar helpers", () => {
  test("filters visible workflow fields by dependencies", () => {
    expect(getVisibleWorkflowFields(workflowFields, { source: "manual" }).map((field) => field.id)).toEqual([
      "source",
      "enabled",
    ]);
    expect(getFirstVisibleFieldId(workflowFields, { source: "broker" })).toBe("source");
  });

  test("summarizes workflow field values using labels and truncation", () => {
    expect(summarizeWorkflowFieldValue(workflowFields[2]!, true)).toBe("On");
    expect(summarizeWorkflowFieldValue(workflowFields[0]!, "broker")).toBe("Broker");
    expect(summarizeWorkflowFieldValue({
      id: "prompt",
      label: "Prompt",
      type: "textarea",
    }, "quality\ncompounders")).toBe("quality compounders");
    expect(summarizeWorkflowFieldValue({
      id: "columns",
      label: "Columns",
      type: "ordered-multi-select",
      options: [
        { label: "Symbol", value: "symbol" },
        { label: "Price", value: "price" },
        { label: "P&L", value: "pnl" },
        { label: "Volume", value: "volume" },
      ],
    }, ["symbol", "price", "pnl", "volume"])).toBe("Symbol, Price, P&L +1");
  });

  test("normalizes wizard fields and derives defaults from steps", () => {
    const steps: WizardStep[] = [
      { key: "intro", label: "Intro", type: "info", body: ["Line one", "Line two"] },
      { key: "_validate-broker", label: "Validate", type: "info", body: ["Connecting…", "Connected"] },
      { key: "mode", label: "Mode", type: "select", clearOnChange: ["account"], options: [{ label: "Paper", value: "paper" }, { label: "Live", value: "live" }] },
      { key: "account", label: "Account", type: "text", defaultValue: "DU12345", dependsOn: { key: "mode", value: "live" } },
      { key: "prompt", label: "Prompt", type: "textarea", defaultValue: "Find quality compounders" },
      { key: "modelId", label: "Model", type: "text", required: false },
    ];

    const normalized = normalizeWizardFields(steps);

    expect(normalized.description).toEqual(["Line one", "Line two"]);
    expect(normalized.pendingLabel).toBe("Connecting…");
    expect(normalized.successLabel).toBe("Connected");
    expect(normalized.initialValues).toEqual({
      mode: "paper",
      account: "DU12345",
      prompt: "Find quality compounders",
    });
    expect(normalized.fields[1]?.dependsOn).toEqual([{ key: "mode", value: "live" }]);
    expect(normalized.fields[0]?.clearOnChange).toEqual(["account"]);
    expect(normalized.fields[2]?.type).toBe("textarea");
    expect(normalized.fields[3]?.required).toBe(false);
  });
});
