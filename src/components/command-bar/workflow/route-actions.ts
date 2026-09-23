import type { Dispatch, RefObject, SetStateAction } from "react";
import type { InputRenderable, TextareaRenderable } from "../../../ui";
import type { SelectFieldHandle } from "../../ui/select-field";
import {
  coerceFieldBoolean,
  coerceFieldString,
  coerceFieldValues,
  getFirstVisibleFieldId,
  getVisibleWorkflowFields,
  isWorkflowTextField,
} from "../helpers";
import type {
  CommandBarFieldValue,
  CommandBarRoute,
  CommandBarWorkflowField,
  CommandBarWorkflowRoute,
} from "./types";

export type CommandBarWorkflowInputRefs = Record<string, RefObject<InputRenderable | TextareaRenderable | null>>;

export function getCommandBarWorkflowInputRef(
  store: CommandBarWorkflowInputRefs,
  fieldId: string,
): RefObject<InputRenderable | TextareaRenderable | null> {
  if (!store[fieldId]) {
    store[fieldId] = { current: null };
  }
  return store[fieldId]!;
}

export function setWorkflowSelectFieldHandle(
  refs: Map<string, SelectFieldHandle>,
  fieldId: string,
  element: SelectFieldHandle | null,
): void {
  if (element) {
    refs.set(fieldId, element);
  } else {
    refs.delete(fieldId);
  }
}

export function focusWorkflowTextField(
  inputRefs: CommandBarWorkflowInputRefs,
  route: CommandBarWorkflowRoute,
): void {
  const visibleFields = getVisibleWorkflowFields(route.fields, route.values);
  const activeField = visibleFields.find((field) => field.id === route.activeFieldId) ?? visibleFields[0];
  if (!activeField || !isWorkflowTextField(activeField)) return;
  getCommandBarWorkflowInputRef(inputRefs, activeField.id).current?.focus?.();
}

function readWorkflowTextareaValue(
  inputRefs: CommandBarWorkflowInputRefs,
  fieldId: string,
  fallback = "",
): string {
  const ref = getCommandBarWorkflowInputRef(inputRefs, fieldId).current;
  const nextValue = (ref as TextareaRenderable | null)?.editBuffer?.getText?.();
  return typeof nextValue === "string" ? nextValue : fallback;
}

export function getWorkflowFieldStringValueFromRefs(
  inputRefs: CommandBarWorkflowInputRefs,
  field: CommandBarWorkflowField,
  value: CommandBarFieldValue | undefined,
): string {
  return field.type === "textarea"
    ? readWorkflowTextareaValue(inputRefs, field.id, coerceFieldString(value))
    : coerceFieldString(value);
}

function updateWorkflowValueInRouteStack(
  current: CommandBarRoute[],
  fieldId: string,
  value: CommandBarFieldValue,
): CommandBarRoute[] {
  let workflowIndex = -1;
  for (let index = current.length - 1; index >= 0; index -= 1) {
    if (current[index]?.kind === "workflow") {
      workflowIndex = index;
      break;
    }
  }
  if (workflowIndex < 0) return current;

  const next = [...current];
  const route = next[workflowIndex]!;
  if (route.kind !== "workflow") return current;
  const nextValues = { ...route.values, [fieldId]: value };
  const changedField = route.fields.find((field) => field.id === fieldId);
  if (!Object.is(route.values[fieldId], value)) {
    for (const key of changedField?.clearOnChange ?? []) nextValues[key] = "";
  }
  const nextActiveFieldId = route.activeFieldId && getVisibleWorkflowFields(route.fields, nextValues).some((field) => field.id === route.activeFieldId)
    ? route.activeFieldId
    : getFirstVisibleFieldId(route.fields, nextValues);
  next[workflowIndex] = {
    ...route,
    values: nextValues,
    activeFieldId: nextActiveFieldId,
    error: null,
  };
  return next;
}

function syncWorkflowTextareaField({
  fallback = "",
  fieldId,
  inputRefs,
  updateWorkflowValue,
}: {
  fallback?: string;
  fieldId: string;
  inputRefs: CommandBarWorkflowInputRefs;
  updateWorkflowValue: (fieldId: string, value: CommandBarFieldValue) => void;
}): string {
  const nextValue = readWorkflowTextareaValue(inputRefs, fieldId, fallback);
  updateWorkflowValue(fieldId, nextValue);
  return nextValue;
}

export function syncActiveWorkflowTextareaAction({
  inputRefs,
  route,
  updateWorkflowValue,
}: {
  inputRefs: CommandBarWorkflowInputRefs;
  route: CommandBarWorkflowRoute | null;
  updateWorkflowValue: (fieldId: string, value: CommandBarFieldValue) => void;
}): void {
  if (route?.kind !== "workflow") return;
  const visibleFields = getVisibleWorkflowFields(route.fields, route.values);
  const activeField = visibleFields.find((field) => field.id === route.activeFieldId) ?? visibleFields[0];
  if (activeField?.type !== "textarea") return;
  syncWorkflowTextareaField({
    fieldId: activeField.id,
    fallback: coerceFieldString(route.values[activeField.id]),
    inputRefs,
    updateWorkflowValue,
  });
}

export function moveWorkflowFocusAction({
  delta,
  route,
  syncActiveWorkflowTextarea,
  updateTopRoute,
}: {
  delta: number;
  route: CommandBarWorkflowRoute | null;
  syncActiveWorkflowTextarea: (route: CommandBarWorkflowRoute | null) => void;
  updateTopRoute: (updater: (route: CommandBarRoute) => CommandBarRoute) => void;
}): void {
  if (route?.kind !== "workflow") return;
  syncActiveWorkflowTextarea(route);
  const visibleFields = getVisibleWorkflowFields(route.fields, route.values);
  if (visibleFields.length === 0) return;
  const currentIndex = Math.max(0, visibleFields.findIndex((field) => field.id === route.activeFieldId));
  const nextIndex = Math.max(0, Math.min(currentIndex + delta, visibleFields.length - 1));
  updateTopRoute((route) => route.kind === "workflow"
    ? { ...route, activeFieldId: visibleFields[nextIndex]?.id ?? route.activeFieldId }
    : route);
}

export function openWorkflowFieldPickerAction({
  field,
  pushRoute,
  route,
  syncActiveWorkflowTextarea,
  updateWorkflowValue,
}: {
  field: CommandBarWorkflowField;
  pushRoute: (route: CommandBarRoute) => void;
  route: CommandBarWorkflowRoute;
  syncActiveWorkflowTextarea: (route: CommandBarWorkflowRoute | null) => void;
  updateWorkflowValue: (fieldId: string, value: CommandBarFieldValue) => void;
}): void {
  syncActiveWorkflowTextarea(route);
  if (field.type === "toggle") {
    updateWorkflowValue(field.id, !coerceFieldBoolean(route.values[field.id]));
    return;
  }
  if (field.type === "select") {
    pushRoute({
      kind: "picker",
      pickerId: "field-select",
      title: field.label,
      query: "",
      selectedIdx: Math.max(0, field.options.findIndex((option) => option.value === coerceFieldString(route.values[field.id]))),
      hoveredIdx: null,
      options: field.options.map((option) => ({
        id: option.value,
        label: option.label,
        detail: option.description,
        description: option.description,
      })),
      payload: {
        parentKind: "workflow",
        fieldId: field.id,
        fieldType: field.type,
      },
    });
    return;
  }
  if (field.type === "multi-select" || field.type === "ordered-multi-select") {
    pushRoute({
      kind: "picker",
      pickerId: "field-multi-select",
      title: field.label,
      query: "",
      selectedIdx: 0,
      hoveredIdx: null,
      options: field.options.map((option) => ({
        id: option.value,
        label: option.label,
        detail: option.description,
        description: option.description,
      })),
      payload: {
        parentKind: "workflow",
        fieldId: field.id,
        fieldType: field.type,
        selectedValues: coerceFieldValues(route.values[field.id]),
      },
    });
  }
}

export function updateRouteStack(
  setRouteStack: Dispatch<SetStateAction<CommandBarRoute[]>>,
  fieldId: string,
  value: CommandBarFieldValue,
): void {
  setRouteStack((current) => updateWorkflowValueInRouteStack(current, fieldId, value));
}
