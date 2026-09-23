import type { KeyEventLike } from "../../react/input";
import { isPlainBackspace } from "../../utils/back-navigation";
import { openSelectField, type SelectFieldHandle } from "../ui/select-field";
import {
  coerceFieldBoolean,
  getVisibleWorkflowFields,
  isWorkflowTextField,
} from "./helpers";
import type { ListJump, ListScreenState } from "./list/model";
import type { ThemePickerHandle } from "./theme-picker";
import type {
  CommandBarFieldValue,
  CommandBarRoute,
  CommandBarWorkflowField,
  CommandBarWorkflowRoute,
} from "./workflow/types";

export type RefLike<T> = { current: T };

export function consumeShortcutEvent(event: KeyEventLike): void {
  event.stopPropagation();
  event.preventDefault();
}

export function isMoveUpShortcut(event: KeyEventLike): boolean {
  return event.name === "up" || (event.ctrl && event.name === "p");
}

export function isMoveDownShortcut(event: KeyEventLike): boolean {
  return event.name === "down" || (event.ctrl && event.name === "n");
}

export function isCommitShortcut(event: KeyEventLike): boolean {
  return event.name === "return" || event.name === "enter";
}

/** Tab or Shift+Tab with no other modifier: the key that walks fields and lists. */
export function isPlainTab(event: KeyEventLike): boolean {
  return event.name === "tab" && !event.ctrl && !event.meta && !event.alt;
}

/**
 * Ctrl+S (Cmd+S on a Mac desktop) submits a workflow from any field. Not
 * Ctrl+Enter: a desktop text field already submits or moves on for any Enter
 * before this handler sees the key, so the form would be sent twice. Shift
 * stays out of it: Cmd/Ctrl+Shift+S shares the focused pane.
 */
export function isWorkflowSubmitShortcut(event: KeyEventLike): boolean {
  return (event.ctrl || event.meta) && !event.alt && !event.shift && event.name === "s";
}

/**
 * Page keys page through a list. Home and End belong to the caret in the query
 * input, so the first and last rows take Ctrl (or Cmd) with them.
 */
export function resolveListJump(event: KeyEventLike): ListJump | null {
  if (event.alt || event.shift) return null;
  const modified = event.ctrl || event.meta;
  if (!modified && event.name === "pageup") return "page-up";
  if (!modified && event.name === "pagedown") return "page-down";
  if (modified && event.name === "home") return "first";
  if (modified && event.name === "end") return "last";
  return null;
}

export function handleConfirmRouteShortcut({
  confirmCurrentRoute,
  currentRoute,
  event,
  popRoute,
}: {
  confirmCurrentRoute: () => void | Promise<void>;
  currentRoute: CommandBarRoute | null;
  event: KeyEventLike;
  popRoute: () => void;
}): boolean {
  if (currentRoute?.kind !== "confirm") return false;

  if (isPlainBackspace(event)) {
    consumeShortcutEvent(event);
    popRoute();
    return true;
  }
  if (isCommitShortcut(event) || event.name === "y") {
    consumeShortcutEvent(event);
    void confirmCurrentRoute();
    return true;
  }
  if (event.name === "n") {
    consumeShortcutEvent(event);
    popRoute();
    return true;
  }
  // One action and no fields: Tab has nowhere to go, and on the desktop it
  // must not carry focus out of the bar.
  if (event.name === "tab") consumeShortcutEvent(event);
  return true;
}

export function handleRouteBackShortcut({
  currentRoute,
  event,
  popRoute,
}: {
  currentRoute: CommandBarRoute | null;
  event: KeyEventLike;
  popRoute: () => void;
}): boolean {
  if (
    currentRoute
    && (currentRoute.kind === "mode"
      || currentRoute.kind === "picker"
      || currentRoute.kind === "pane-settings")
    && isPlainBackspace(event)
    && currentRoute.query.length === 0
  ) {
    consumeShortcutEvent(event);
    popRoute();
    return true;
  }
  return false;
}

export function handleWorkflowRouteShortcut({
  currentRoute,
  event,
  getWorkflowFieldStringValue,
  moveWorkflowFocus,
  nativePaneChrome,
  openWorkflowFieldPicker,
  popRoute,
  submitWorkflowRoute,
  updateWorkflowValue,
  workflowSelectFieldRefs,
}: {
  currentRoute: CommandBarRoute | null;
  event: KeyEventLike;
  getWorkflowFieldStringValue: (
    field: CommandBarWorkflowField,
    value: CommandBarFieldValue | undefined,
  ) => string;
  moveWorkflowFocus: (delta: number) => void;
  nativePaneChrome: boolean;
  openWorkflowFieldPicker: (
    route: CommandBarWorkflowRoute,
    field: CommandBarWorkflowField,
  ) => void;
  popRoute: () => void;
  submitWorkflowRoute: (route: CommandBarWorkflowRoute) => void | Promise<void>;
  updateWorkflowValue: (fieldId: string, value: CommandBarFieldValue) => void;
  workflowSelectFieldRefs: RefLike<Map<string, SelectFieldHandle>>;
}): boolean {
  if (currentRoute?.kind !== "workflow") return false;

  const visibleFields = getVisibleWorkflowFields(currentRoute.fields, currentRoute.values);
  const activeField = visibleFields.find((field) => field.id === currentRoute.activeFieldId) ?? visibleFields[0];
  const activeTextarea = activeField?.type === "textarea";

  // From any field, so a form that ends in a select or a toggle, where Enter
  // opens the picker, can still be sent without the mouse.
  if (isWorkflowSubmitShortcut(event)) {
    consumeShortcutEvent(event);
    if (!currentRoute.pending) void submitWorkflowRoute(currentRoute);
    return true;
  }

  if (isPlainBackspace(event)) {
    const activeValue = activeField
      ? getWorkflowFieldStringValue(activeField, currentRoute.values[activeField.id])
      : "";
    if (!activeField || !isWorkflowTextField(activeField) || activeValue.length === 0) {
      consumeShortcutEvent(event);
      popRoute();
      return true;
    }
  }

  if (event.name === "tab") {
    consumeShortcutEvent(event);
    moveWorkflowFocus(event.shift ? -1 : 1);
    return true;
  }

  if (activeTextarea && (event.name === "up" || event.name === "down" || (event.ctrl && (event.name === "p" || event.name === "n")))) {
    return true;
  }

  if (isMoveUpShortcut(event)) {
    consumeShortcutEvent(event);
    moveWorkflowFocus(-1);
    return true;
  }

  if (isMoveDownShortcut(event)) {
    consumeShortcutEvent(event);
    moveWorkflowFocus(1);
    return true;
  }

  if (event.name === "space" && activeField?.type === "toggle") {
    consumeShortcutEvent(event);
    updateWorkflowValue(activeField.id, !coerceFieldBoolean(currentRoute.values[activeField.id]));
    return true;
  }

  if (
    isCommitShortcut(event)
    || (nativePaneChrome && event.name === "space" && activeField?.type === "select")
  ) {
    if (!activeField) return true;
    if (activeField.type === "select" || activeField.type === "multi-select" || activeField.type === "ordered-multi-select" || activeField.type === "toggle") {
      consumeShortcutEvent(event);
      if (nativePaneChrome && activeField.type === "select") {
        openSelectField(workflowSelectFieldRefs.current.get(activeField.id));
        return true;
      }
      openWorkflowFieldPicker(currentRoute, activeField);
      return true;
    }
  }

  return true;
}

export function handlePickerRouteShortcut({
  activateListSelection,
  commitMultiSelectPicker,
  currentRoute,
  event,
  handleMultiSelectMove,
  handleMultiSelectToggle,
  moveListSelection,
  visibleListStateRef,
}: {
  activateListSelection: (options?: { secondary?: boolean }) => void;
  commitMultiSelectPicker: () => void;
  currentRoute: CommandBarRoute | null;
  event: KeyEventLike;
  handleMultiSelectMove: (direction: "up" | "down") => void;
  handleMultiSelectToggle: (optionId: string) => void;
  moveListSelection: (delta: number) => void;
  visibleListStateRef: RefLike<ListScreenState | null>;
}): boolean {
  if (currentRoute?.kind !== "picker") return false;

  if (isMoveUpShortcut(event)) {
    consumeShortcutEvent(event);
    moveListSelection(-1);
    return true;
  }
  if (isMoveDownShortcut(event)) {
    consumeShortcutEvent(event);
    moveListSelection(1);
    return true;
  }
  if (currentRoute.pickerId === "field-multi-select" && (event.name === "space" || event.sequence === " ")) {
    consumeShortcutEvent(event);
    const listState = visibleListStateRef.current;
    const selected = listState?.results[listState.selectedIdx];
    if (selected) handleMultiSelectToggle(selected.id);
    return true;
  }
  if (currentRoute.pickerId === "field-multi-select" && event.name === "[") {
    consumeShortcutEvent(event);
    handleMultiSelectMove("up");
    return true;
  }
  if (currentRoute.pickerId === "field-multi-select" && event.name === "]") {
    consumeShortcutEvent(event);
    handleMultiSelectMove("down");
    return true;
  }
  if (isCommitShortcut(event)) {
    consumeShortcutEvent(event);
    if (currentRoute.pickerId === "field-multi-select") {
      commitMultiSelectPicker();
      return true;
    }
    activateListSelection();
  }
  return true;
}

export function handlePaneSettingsRouteShortcut({
  activateListSelection,
  currentRoute,
  event,
  moveListSelection,
}: {
  activateListSelection: (options?: { secondary?: boolean }) => void;
  currentRoute: CommandBarRoute | null;
  event: KeyEventLike;
  moveListSelection: (delta: number) => void;
}): boolean {
  if (currentRoute?.kind !== "pane-settings") return false;

  if (isMoveUpShortcut(event)) {
    consumeShortcutEvent(event);
    moveListSelection(-1);
    return true;
  }
  if (isMoveDownShortcut(event)) {
    consumeShortcutEvent(event);
    moveListSelection(1);
    return true;
  }
  if (isCommitShortcut(event) || event.name === "space") {
    consumeShortcutEvent(event);
    activateListSelection();
  }
  return true;
}

export function handleThemePickerShortcut({
  event,
  themePickerActive,
  themePickerRef,
}: {
  event: KeyEventLike;
  themePickerActive: boolean;
  themePickerRef: RefLike<ThemePickerHandle | null>;
}): boolean {
  if (!themePickerActive) return false;

  if (isMoveUpShortcut(event)) {
    consumeShortcutEvent(event);
    themePickerRef.current?.move(-1);
    return true;
  }
  if (isMoveDownShortcut(event)) {
    consumeShortcutEvent(event);
    themePickerRef.current?.move(1);
    return true;
  }
  if (isCommitShortcut(event)) {
    consumeShortcutEvent(event);
    themePickerRef.current?.commit();
    return true;
  }
  return false;
}
