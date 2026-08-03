import type { BrokerAdapter } from "../../../types/broker";
import {
  coerceFieldString,
  normalizeFieldOptions,
} from "../helpers";
import type {
  CommandBarFieldOption,
  CommandBarFieldValue,
  CommandBarWorkflowField,
  CommandBarWorkflowRoute,
} from "./types";
import { buildCommandBarWorkflowRoute } from "./route-builder";

export type WorkflowStringValues = Record<string, string>;

export interface CommandBarBrokerChoice {
  id: string;
  label: string;
  description: string;
  adapter: BrokerAdapter;
}

export function buildBrokerChoices(brokers: ReadonlyMap<string, BrokerAdapter>): CommandBarBrokerChoice[] {
  return [...brokers.values()]
    .filter((adapter) => adapter.configSchema.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((adapter) => ({
      id: adapter.id,
      label: adapter.name,
      description: `Create a new ${adapter.name} profile`,
      adapter,
    }));
}

export function buildBrokerWorkflowRoute({
  brokerChoices,
  includeManualOption,
  selectorKey,
  submitLabel,
  subtitle,
  title,
}: {
  brokerChoices: CommandBarBrokerChoice[];
  selectorKey: "brokerType" | "source";
  title: string;
  subtitle: string | undefined;
  submitLabel: string;
  includeManualOption: boolean;
}): CommandBarWorkflowRoute | null {
  const options: CommandBarFieldOption[] = [];
  if (includeManualOption) {
    options.push({
      label: "Create Manual Portfolio",
      value: "manual",
      description: "Add tickers and positions by hand",
    });
  }
  options.push(...brokerChoices.map((choice) => ({
    label: `Connect ${choice.label}`,
    value: choice.id,
    description: includeManualOption ? `Auto-import positions via ${choice.label}` : choice.description,
  })));

  if (options.length === 0) return null;

  const fields: CommandBarWorkflowField[] = [{
    id: selectorKey,
    label: includeManualOption ? "Portfolio Source" : "Broker",
    type: "select",
    options,
    required: true,
  }];
  const values: Record<string, CommandBarFieldValue> = {
    [selectorKey]: options[0]!.value,
  };

  if (includeManualOption) {
    fields.push({
      id: "name",
      label: "Portfolio Name",
      type: "text",
      placeholder: "Main Portfolio",
      required: true,
      dependsOn: [{ key: selectorKey, value: "manual" }],
    });
    values.name = "Main Portfolio";
  }

  for (const choice of brokerChoices) {
    for (const field of choice.adapter.configSchema) {
      const fieldId = `${choice.id}:${field.key}`;
      const dependsOn = [
        { key: selectorKey, value: choice.id },
        ...(field.dependsOn
          ? [{ key: `${choice.id}:${field.dependsOn.key}`, value: field.dependsOn.value }]
          : []),
      ];
      if (field.type === "select") {
        fields.push({
          id: fieldId,
          label: field.label,
          type: "select",
          placeholder: field.placeholder,
          description: field.placeholder,
          required: field.required,
          options: normalizeFieldOptions(field.options),
          dependsOn,
        });
      } else {
        fields.push({
          id: fieldId,
          label: field.label,
          type: field.type === "number"
            ? "number"
            : field.type === "password"
              ? "password"
              : "text",
          placeholder: field.placeholder,
          description: field.placeholder,
          required: field.required,
          dependsOn,
        });
      }
      if (field.defaultValue) {
        values[fieldId] = field.defaultValue;
      } else if (field.type === "select" && field.options?.[0]?.value) {
        values[fieldId] = field.options[0].value;
      }
    }
  }

  return buildCommandBarWorkflowRoute({
    workflowId: `builtin:${title.toLowerCase().replace(/\s+/g, "-")}`,
    title,
    subtitle,
    fields,
    values,
    submitLabel,
    pendingLabel: "Connecting broker…",
    payload: {
      kind: "builtin",
      actionId: includeManualOption ? "new-portfolio" : "add-broker-account",
    },
  });
}

export function extractBrokerWorkflowValues(
  values: Record<string, CommandBarFieldValue>,
  selectorKey: "brokerType" | "source",
  brokerId: string,
): WorkflowStringValues {
  const next: WorkflowStringValues = {};
  for (const [key, rawValue] of Object.entries(values)) {
    if (!key.startsWith(`${brokerId}:`)) continue;
    next[key.slice(brokerId.length + 1)] = coerceFieldString(rawValue);
  }
  next[selectorKey] = brokerId;
  return next;
}
