import {
  getFirstVisibleFieldId,
  getVisibleWorkflowFields,
  getWorkflowFieldDescription,
} from "../command-bar/workflow/fields";
import type {
  CommandBarFieldValue,
  CommandBarWorkflowRoute,
} from "../command-bar/workflow/types";
import type { ReactNode } from "react";
import { wrapTextLines } from "../../utils/text-wrap";
import { t } from "../../i18n";

/** A form in the modal: the command bar's workflow route, owned by the modal now. */
export type FormRoute = CommandBarWorkflowRoute;

/**
 * Where a submit can take the form instead of closing it, in the same dialog:
 * the step replaces the fields until the submit moves on, and Cancel or Esc
 * closes the form. Its body owns every key but Esc.
 */
export interface FormStep {
  kind: "custom";
  /** A new id mounts the body afresh. */
  id: string;
  title: string;
  subtitle?: string;
  render(context: FormStepContext): ReactNode;
}

export interface FormStepContext {
  /** Terminal rows the body may fill, between the title and the Cancel button. */
  bodyRows: number;
  /** Terminal columns inside the frame. */
  contentWidth: number;
}

/**
 * Where the keyboard is. The primary button is the last stop of the ring, so a
 * form whose fields are all selects can still be sent with Enter.
 */
export interface FormFocus {
  fieldId: string | null;
  onSubmit: boolean;
}

export function initialFormFocus(route: FormRoute): FormFocus {
  const fieldId = route.activeFieldId ?? getFirstVisibleFieldId(route.fields, route.values);
  return { fieldId, onSubmit: fieldId === null };
}

/**
 * Writes one value. A changed value clears the fields listed in its
 * `clearOnChange`, and a field that the new values hide gives the focus back
 * to the first visible one.
 */
export function applyFormValue(route: FormRoute, fieldId: string, value: CommandBarFieldValue): FormRoute {
  const values = { ...route.values, [fieldId]: value };
  const changedField = route.fields.find((field) => field.id === fieldId);
  if (!Object.is(route.values[fieldId], value)) {
    for (const key of changedField?.clearOnChange ?? []) values[key] = "";
  }
  const visible = getVisibleWorkflowFields(route.fields, values);
  const activeFieldId = route.activeFieldId && visible.some((field) => field.id === route.activeFieldId)
    ? route.activeFieldId
    : getFirstVisibleFieldId(route.fields, values);
  return { ...route, values, activeFieldId, error: null };
}

/** The stops of the focus ring: every visible field, then the primary button. */
function focusStops(route: FormRoute): Array<string | null> {
  return [...getVisibleWorkflowFields(route.fields, route.values).map((field) => field.id), null];
}

function stopIndex(route: FormRoute, focus: FormFocus): number {
  const stops = focusStops(route);
  if (focus.onSubmit) return stops.length - 1;
  return Math.max(0, stops.indexOf(focus.fieldId));
}

function focusAt(route: FormRoute, index: number): FormFocus {
  const stop = focusStops(route)[index] ?? null;
  return stop === null
    ? { fieldId: route.activeFieldId, onSubmit: true }
    : { fieldId: stop, onSubmit: false };
}

/** Tab wraps around the ring; the arrows stop at either end. */
export function moveFormFocus(route: FormRoute, focus: FormFocus, delta: number, wrap: boolean): FormFocus {
  const count = focusStops(route).length;
  const index = stopIndex(route, focus) + delta;
  if (wrap) return focusAt(route, ((index % count) + count) % count);
  return focusAt(route, Math.max(0, Math.min(count - 1, index)));
}

/** After a picker applied a value: the next visible field, or the button after the last. */
export function focusAfterField(route: FormRoute, fieldId: string): FormFocus {
  const stops = focusStops(route);
  const index = stops.indexOf(fieldId);
  return focusAt(route, index < 0 ? stops.length - 1 : index + 1);
}

export function isLastVisibleField(route: FormRoute, fieldId: string): boolean {
  return getVisibleWorkflowFields(route.fields, route.values).at(-1)?.id === fieldId;
}

export const FORM_TEXTAREA_ROWS = 6;

export interface FormRowLayout {
  fieldId: string;
  top: number;
  height: number;
}

function wrappedRows(text: string, width: number): number {
  return Math.max(1, wrapTextLines(text, Math.max(1, width)).length);
}

/**
 * Terminal rows of the scrolling body, drawn the way the body draws it: the
 * description lines and a spacer, then per field a label, the control, its
 * wrapped description and a gap. The height of the body and the scroll that
 * keeps the active field in view both come from here.
 */
export function layoutFormRows(route: FormRoute, width: number): { rows: FormRowLayout[]; total: number } {
  let top = 0;
  for (const line of route.description ?? []) top += wrappedRows(t(line), width);
  if ((route.description?.length ?? 0) > 0) top += 1;
  const visible = getVisibleWorkflowFields(route.fields, route.values);
  const rows = visible.map((field, index) => {
    const description = getWorkflowFieldDescription(field);
    const height = 1
      + (field.type === "textarea" ? FORM_TEXTAREA_ROWS : 1)
      + (description ? wrappedRows(t(description), width) : 0);
    const row = { fieldId: field.id, top, height };
    top += height + (index === visible.length - 1 ? 0 : 1);
    return row;
  });
  return { rows, total: top };
}
