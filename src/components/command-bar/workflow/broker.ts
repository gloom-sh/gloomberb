import {
  brokerMethodLabel,
  brokerMethodSummary,
  type BrokerDirectoryEntry,
  type BrokerMethod,
} from "../../../brokers/directory";
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

/** The field that picks a portfolio's source: Manual, or a broker. */
const SOURCE_FIELD_ID = "source";

/** Asked only for a broker offered more than one way. */
function brokerMethodFieldId(entryKey: string): string {
  return `method:${entryKey}`;
}

/**
 * New Portfolio's form: a manual portfolio, or one a broker fills. A broker
 * offered both ways asks how to connect, and one connected on this device asks
 * for its fields. Brokers themselves are added in the Brokers pane.
 */
export function buildBrokerWorkflowRoute({
  directory,
  submitLabel,
  subtitle,
  title,
}: {
  directory: BrokerDirectoryEntry[];
  title: string;
  subtitle: string | undefined;
  submitLabel: string;
}): CommandBarWorkflowRoute {
  const selectorKey = SOURCE_FIELD_ID;
  const options: CommandBarFieldOption[] = [{
    label: "Manual",
    value: "manual",
    description: "Add tickers and positions by hand",
  }];
  options.push(...directory.map((entry) => ({
    label: entry.name,
    value: entry.key,
    description: brokerMethodSummary(entry),
  })));

  const fields: CommandBarWorkflowField[] = [{
    id: selectorKey,
    label: "Portfolio Source",
    type: "select",
    options,
    required: true,
  }, {
    id: "name",
    label: "Portfolio Name",
    type: "text",
    placeholder: "Main Portfolio",
    required: true,
    dependsOn: [{ key: selectorKey, value: "manual" }],
  }];
  const values: Record<string, CommandBarFieldValue> = {
    [selectorKey]: "manual",
    name: "Main Portfolio",
  };
  const submitLabels: NonNullable<CommandBarWorkflowRoute["submitLabels"]> = [];

  for (const entry of directory) {
    const entryDependency = { key: selectorKey, value: entry.key };
    const methodFieldId = brokerMethodFieldId(entry.key);
    const choosesMethod = entry.methods.length > 1;
    if (choosesMethod) {
      fields.push({
        id: methodFieldId,
        label: "Method",
        type: "select",
        options: entry.methods.map((method) => ({ label: brokerMethodLabel(entry, method), value: method.kind })),
        required: true,
        dependsOn: [entryDependency],
      });
      values[methodFieldId] = entry.methods[0]!.kind;
    }
    const whenMethod = (kind: BrokerMethod["kind"]) => [
      entryDependency,
      ...(choosesMethod ? [{ key: methodFieldId, value: kind }] : []),
    ];

    for (const method of entry.methods) {
      if (method.kind === "signed-in") {
        // Nothing to fill in: the dialog does the rest.
        submitLabels.push({ dependsOn: whenMethod("signed-in"), label: "Connect" });
        continue;
      }
      for (const field of method.adapter.configSchema) {
        const fieldId = `${entry.key}:${field.key}`;
        const dependsOn = [
          ...whenMethod("device"),
          ...(field.dependsOn
            ? [{ key: `${entry.key}:${field.dependsOn.key}`, value: field.dependsOn.value }]
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
  }

  return {
    ...buildCommandBarWorkflowRoute({
      workflowId: `builtin:${title.toLowerCase().replace(/\s+/g, "-")}`,
      title,
      subtitle,
      fields,
      values,
      submitLabel,
      pendingLabel: "Connecting broker…",
      payload: { kind: "builtin", actionId: "new-portfolio" },
      // Submit resolves the choice against the list the user saw, not a newer one.
      payloadMeta: { brokerDirectory: directory },
    }),
    ...(submitLabels.length > 0 ? { submitLabels } : {}),
  };
}

/** The broker and method a submitted workflow chose, or null when none was. */
export function resolveBrokerWorkflowSelection(
  route: CommandBarWorkflowRoute,
): { entry: BrokerDirectoryEntry; method: BrokerMethod } | null {
  const directory = (route.payloadMeta?.brokerDirectory ?? []) as BrokerDirectoryEntry[];
  const entry = directory.find((candidate) => candidate.key === coerceFieldString(route.values[SOURCE_FIELD_ID]));
  if (!entry) return null;
  const kind = entry.methods.length > 1 ? coerceFieldString(route.values[brokerMethodFieldId(entry.key)]) : "";
  const method = entry.methods.find((candidate) => candidate.kind === kind) ?? entry.methods[0];
  return method ? { entry, method } : null;
}

export function extractBrokerWorkflowValues(
  values: Record<string, CommandBarFieldValue>,
  brokerId: string,
): WorkflowStringValues {
  const next: WorkflowStringValues = {};
  for (const [key, rawValue] of Object.entries(values)) {
    if (!key.startsWith(`${brokerId}:`)) continue;
    next[key.slice(brokerId.length + 1)] = coerceFieldString(rawValue);
  }
  next[SOURCE_FIELD_ID] = brokerId;
  return next;
}
