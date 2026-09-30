import type {
  PaneTemplateDef,
  WizardStep,
} from "../../../types/plugin";
import type {
  CommandBarFieldOption,
  CommandBarFieldValue,
  CommandBarWorkflowField,
  CommandBarWorkflowRoute,
} from "./types";

export function normalizeFieldOptions(
  options: Array<{ label: string; value: string; description?: string }> | undefined,
): CommandBarFieldOption[] {
  return (options ?? []).map((option) => ({
    label: option.label,
    value: option.value,
    description: option.description,
  }));
}

type FieldDependency = { key: string; value: string };

/**
 * Whether a workflow field or wizard step shows for the answers so far: every
 * answer it depends on, read as a string, holds the expected value. The
 * command-bar form and the dialog wizard both decide visibility here.
 */
export function dependenciesMet(
  dependsOn: FieldDependency | FieldDependency[] | undefined,
  values: Record<string, unknown>,
): boolean {
  if (!dependsOn) return true;
  const dependencies = Array.isArray(dependsOn) ? dependsOn : [dependsOn];
  return dependencies.every((dependency) => String(values[dependency.key] ?? "") === dependency.value);
}

/**
 * The later answers a change resets: the field's `clearOnChange` keys when the
 * new value differs from the one it replaces. The form compares with the value
 * it held, the dialog wizard with the one the step offered.
 */
export function keysClearedByChange(
  clearOnChange: string[] | undefined,
  previous: unknown,
  next: unknown,
): string[] {
  return clearOnChange && !Object.is(previous, next) ? clearOnChange : [];
}

/** The answer a wizard step starts on: its default, else a select's first option. */
export function wizardStepInitialValue(step: WizardStep): string | undefined {
  if (step.defaultValue) return step.defaultValue;
  if (step.type === "select" && step.options?.[0]?.value) return step.options[0].value;
  return undefined;
}

export function getVisibleWorkflowFields(
  fields: CommandBarWorkflowField[],
  values: Record<string, CommandBarFieldValue>,
): CommandBarWorkflowField[] {
  return fields.filter((field) => dependenciesMet(field.dependsOn, values));
}

export function getWorkflowSubmitLabel(route: CommandBarWorkflowRoute): string {
  return route.submitLabels?.find((entry) => dependenciesMet(entry.dependsOn, route.values))?.label ?? route.submitLabel;
}

function normalizeWorkflowCopy(value?: string): string {
  return (value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

export function getWorkflowFieldDescription(field: CommandBarWorkflowField): string | null {
  const description = field.description?.trim();
  if (!description) return null;
  if (normalizeWorkflowCopy(description) === normalizeWorkflowCopy(field.placeholder)) return null;
  return description;
}

export function estimateWorkflowBodyRows(route: CommandBarWorkflowRoute): number {
  const visibleFields = getVisibleWorkflowFields(route.fields, route.values);
  const introRows = (route.subtitle ? 1 : 0)
    + (route.description?.length ?? 0)
    + (route.subtitle || (route.description?.length ?? 0) > 0 ? 1 : 0);
  const fieldRows = visibleFields.reduce((total, field, index) => {
    const controlRows = field.type === "textarea" ? 6 : 1;
    const descriptionRows = getWorkflowFieldDescription(field) ? 1 : 0;
    const gapRows = index === visibleFields.length - 1 ? 0 : 1;
    return total + 1 + controlRows + descriptionRows + gapRows;
  }, 0);
  const statusRows = (route.error ? 1 : 0) + (route.pending && route.pendingLabel ? 1 : 0);
  return introRows + fieldRows + statusRows + 1;
}

export function coerceFieldString(value: CommandBarFieldValue | undefined): string {
  return typeof value === "string" ? value : "";
}

export function coerceFieldBoolean(value: CommandBarFieldValue | undefined): boolean {
  return value === true;
}

export function coerceFieldValues(value: CommandBarFieldValue | undefined): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function fieldOptionLabel(field: CommandBarWorkflowField, value: string): string {
  if (field.type !== "select" && field.type !== "multi-select" && field.type !== "ordered-multi-select") {
    return value;
  }
  return field.options.find((option) => option.value === value)?.label ?? value;
}

export function summarizeWorkflowFieldValue(
  field: CommandBarWorkflowField,
  value: CommandBarFieldValue | undefined,
): string {
  switch (field.type) {
    case "toggle":
      return coerceFieldBoolean(value) ? "On" : "Off";
    case "text":
    case "password":
    case "number": {
      const next = coerceFieldString(value).trim();
      return next.length > 0 ? next : "Unset";
    }
    case "textarea": {
      const next = coerceFieldString(value).replace(/\s+/g, " ").trim();
      return next.length > 0 ? next : "Unset";
    }
    case "select": {
      const selected = coerceFieldString(value);
      return selected ? fieldOptionLabel(field, selected) : "Choose…";
    }
    case "multi-select":
    case "ordered-multi-select": {
      const selected = coerceFieldValues(value);
      if (selected.length === 0) return "None";
      const labels = selected.map((entry) => fieldOptionLabel(field, entry)).slice(0, 3);
      const suffix = selected.length > 3 ? ` +${selected.length - 3}` : "";
      return `${labels.join(", ")}${suffix}`;
    }
    default:
      return "";
  }
}

export function normalizeWizardFields(steps: WizardStep[]): {
  fields: CommandBarWorkflowField[];
  description: string[];
  initialValues: Record<string, CommandBarFieldValue>;
  pendingLabel?: string;
  successLabel?: string;
} {
  const fields: CommandBarWorkflowField[] = [];
  const description: string[] = [];
  const initialValues: Record<string, CommandBarFieldValue> = {};
  let pendingLabel: string | undefined;
  let successLabel: string | undefined;

  for (const step of steps) {
    if (step.type === "info") {
      if (step.key.startsWith("_validate")) {
        pendingLabel = step.body?.[0] || step.label;
        successLabel = step.body?.[1];
      } else if (step.body) {
        description.push(...step.body);
      }
      continue;
    }

    const type = step.type === "password"
      ? "password"
      : step.type === "number"
        ? "number"
        : step.type === "textarea"
          ? "textarea"
        : step.type === "select"
          ? "select"
          : "text";
    const initialValue = wizardStepInitialValue(step);
    if (initialValue) initialValues[step.key] = initialValue;
    if (type === "select") {
      fields.push({
        id: step.key,
        label: step.label,
        type,
        options: normalizeFieldOptions(step.options),
        placeholder: step.placeholder,
        description: step.body?.[0],
        required: step.required !== false,
        dependsOn: step.dependsOn ? [{ key: step.dependsOn.key, value: step.dependsOn.value }] : undefined,
        clearOnChange: step.clearOnChange,
      });
      continue;
    }

    fields.push({
      id: step.key,
      label: step.label,
      type,
      placeholder: step.placeholder,
      description: step.body?.[0],
      required: step.required !== false,
      dependsOn: step.dependsOn ? [{ key: step.dependsOn.key, value: step.dependsOn.value }] : undefined,
      clearOnChange: step.clearOnChange,
    });
  }

  return { fields, description, initialValues, pendingLabel, successLabel };
}

export function getFirstVisibleFieldId(
  fields: CommandBarWorkflowField[],
  values: Record<string, CommandBarFieldValue>,
): string | null {
  return getVisibleWorkflowFields(fields, values)[0]?.id ?? null;
}

export function isWorkflowTextField(field: CommandBarWorkflowField | undefined): boolean {
  return field?.type === "text"
    || field?.type === "password"
    || field?.type === "number"
    || field?.type === "textarea";
}

export function buildGeneratedTemplateField(
  template: PaneTemplateDef,
  activeTicker: string | null,
): {
  field: CommandBarWorkflowField | null;
  initialValue: CommandBarFieldValue | undefined;
} {
  const placeholder = template.shortcut?.argPlaceholder;
  if (placeholder === "ticker") {
    return {
      field: {
        id: "ticker",
        label: "Ticker",
        type: "text",
        required: true,
        placeholder: activeTicker || "MSFT",
      },
      initialValue: activeTicker ?? "",
    };
  }
  if (placeholder === "tickers") {
    return {
      field: {
        id: "tickers",
        label: "Tickers",
        type: "text",
        required: !template.shortcut?.openWithoutArg,
        placeholder: "AAPL, MSFT, NVDA",
      },
      initialValue: "",
    };
  }
  return { field: null, initialValue: undefined };
}
