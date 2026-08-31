import { describe, expect, test } from "bun:test";
import type { PaneTemplateDef, WizardStep } from "../../types/plugin";
import type { CommandBarWorkflowField } from "./workflow/types";
import {
  buildGeneratedTemplateField,
  getCollectionCommandAction,
  getCollectionCommandKind,
  getCollectionCommandVerb,
  getFirstVisibleFieldId,
  getVisibleWorkflowFields,
  isCollectionCommand,
  isRouteCommandId,
  isWorkflowTextField,
  looksDestructiveCommand,
  normalizeWizardFields,
  routeCommandIdToScreen,
  slugifyName,
  summarizeError,
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

  test("builds generated template fields from shortcut placeholders", () => {
    const tickerTemplate: PaneTemplateDef = {
      id: "detail",
      paneId: "detail",
      label: "Detail",
      description: "Open detail",
      shortcut: { prefix: "detail", argPlaceholder: "ticker" },
    };

    expect(buildGeneratedTemplateField(tickerTemplate, "AAPL")).toEqual({
      field: {
        id: "ticker",
        label: "Ticker",
        type: "text",
        required: true,
        placeholder: "AAPL",
      },
      initialValue: "AAPL",
    });

    expect(buildGeneratedTemplateField({
      ...tickerTemplate,
      shortcut: { prefix: "compare", argPlaceholder: "tickers" },
    }, null)).toEqual({
      field: {
        id: "tickers",
        label: "Tickers",
        type: "text",
        required: true,
        placeholder: "AAPL, MSFT, NVDA",
      },
      initialValue: "",
    });
  });

  test("maps route and collection command ids", () => {
    expect(isRouteCommandId("layout")).toBe(true);
    expect(routeCommandIdToScreen("layout")).toBe("layout");
    expect(isCollectionCommand("remove-portfolio")).toBe(true);
    expect(getCollectionCommandKind("remove-portfolio")).toBe("portfolio");
    expect(getCollectionCommandAction("remove-portfolio")).toBe("remove");
    expect(getCollectionCommandVerb("add")).toBe("Add");
  });

  test("identifies workflow text fields and destructive commands", () => {
    expect(isWorkflowTextField({ id: "name", label: "Name", type: "text" })).toBe(true);
    expect(isWorkflowTextField({ id: "prompt", label: "Prompt", type: "textarea" })).toBe(true);
    expect(isWorkflowTextField({ id: "enabled", label: "Enabled", type: "toggle" })).toBe(false);
    expect(looksDestructiveCommand({
      id: "reset-layout",
      label: "Reset Layout",
      description: "Reset all panes",
      keywords: ["danger"],
    })).toBe(true);
  });

  test("slugifies names and summarizes errors", () => {
    expect(slugifyName("Broker Account 01", "portfolio")).toBe("broker-account-01");
    expect(summarizeError(new Error("boom"))).toMatchObject({ name: "Error", message: "boom" });
    expect(summarizeError("broken")).toEqual({ message: "broken" });
  });
});
