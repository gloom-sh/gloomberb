import type { KeyEventLike } from "../../react/input";
import { isPlainBackspace } from "../../utils/back-navigation";
import { openSelectField, type SelectFieldHandle } from "../ui/select-field";
import {
  coerceFieldBoolean,
  getVisibleWorkflowFields,
  isWorkflowTextField,
} from "./helpers";
import type { ListScreenState } from "./list/model";
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
  }
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

  if (activeTextarea && event.ctrl && event.name === "s") {
    consumeShortcutEvent(event);
    void submitWorkflowRoute(currentRoute);
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
