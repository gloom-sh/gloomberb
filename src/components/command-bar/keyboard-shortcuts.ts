import { useShortcut } from "../../react/input";
import type { NativeSelectElement } from "../ui/native-select";
import {
  consumeShortcutEvent,
  handleConfirmRouteShortcut,
  handlePaneSettingsRouteShortcut,
  handlePickerRouteShortcut,
  handleRouteBackShortcut,
  handleThemePickerShortcut,
  handleWorkflowRouteShortcut,
  isCommitShortcut,
  isMoveDownShortcut,
  isMoveUpShortcut,
  type RefLike,
} from "./keyboard-handlers";
import type { ListScreenState } from "./list/model";
import type { ThemePickerHandle } from "./theme-picker";
import type {
  CommandBarFieldValue,
  CommandBarRoute,
  CommandBarWorkflowField,
  CommandBarWorkflowRoute,
} from "./workflow/types";

interface CommandBarKeyboardShortcutArgs {
  acceptRootShortcutTab: () => boolean;
  acceptSelectedShortcutTab: () => boolean;
  activateListSelection: (options?: { secondary?: boolean }) => void;
  commitMultiSelectPicker: () => void;
  confirmCurrentRoute: () => void | Promise<void>;
  currentRoute: CommandBarRoute | null;
  dismissCommandBar: () => void;
  getWorkflowFieldStringValue: (
    field: CommandBarWorkflowField,
    value: CommandBarFieldValue | undefined,
  ) => string;
  handleMultiSelectMove: (direction: "up" | "down") => void;
  handleMultiSelectToggle: (optionId: string) => void;
  moveListSelection: (delta: number) => void;
  moveWorkflowFocus: (delta: number) => void;
  nativePaneChrome: boolean;
  openWorkflowFieldPicker: (
    route: CommandBarWorkflowRoute,
    field: CommandBarWorkflowField,
  ) => void;
  popRoute: () => void;
  rootModeKind: string;
  setActiveListQuery: (query: string) => void;
  submitWorkflowRoute: (route: CommandBarWorkflowRoute) => void | Promise<void>;
  themePickerActive: boolean;
  themePickerRef: RefLike<ThemePickerHandle | null>;
  updateWorkflowValue: (fieldId: string, value: CommandBarFieldValue) => void;
  visibleListStateRef: RefLike<ListScreenState | null>;
  workflowNativeSelectRefs: RefLike<Map<string, NativeSelectElement>>;
}

export function useCommandBarKeyboardShortcuts({
  acceptRootShortcutTab,
  acceptSelectedShortcutTab,
  activateListSelection,
  commitMultiSelectPicker,
  confirmCurrentRoute,
  currentRoute,
  dismissCommandBar,
  getWorkflowFieldStringValue,
  handleMultiSelectMove,
  handleMultiSelectToggle,
  moveListSelection,
  moveWorkflowFocus,
  nativePaneChrome,
  openWorkflowFieldPicker,
  popRoute,
  rootModeKind,
  setActiveListQuery,
  submitWorkflowRoute,
  themePickerActive,
  themePickerRef,
  updateWorkflowValue,
  visibleListStateRef,
  workflowNativeSelectRefs,
}: CommandBarKeyboardShortcutArgs): void {
  useShortcut((event) => {
    if (event.name === "escape" || event.name === "`") {
      event.stopPropagation();
      event.preventDefault();
      dismissCommandBar();
      return;
    }

    if (handleConfirmRouteShortcut({
      confirmCurrentRoute,
      currentRoute,
      event,
      popRoute,
    })) {
      return;
    }

    if (handleRouteBackShortcut({ currentRoute, event, popRoute })) {
      return;
    }

    if (handleWorkflowRouteShortcut({
      currentRoute,
      event,
      getWorkflowFieldStringValue,
      moveWorkflowFocus,
      nativePaneChrome,
      openWorkflowFieldPicker,
      popRoute,
      submitWorkflowRoute,
      updateWorkflowValue,
      workflowNativeSelectRefs,
    })) {
      return;
    }

    if (handlePickerRouteShortcut({
      activateListSelection,
      commitMultiSelectPicker,
      currentRoute,
      event,
      handleMultiSelectMove,
      handleMultiSelectToggle,
      moveListSelection,
      visibleListStateRef,
    })) {
      return;
    }

    if (handlePaneSettingsRouteShortcut({
      activateListSelection,
      currentRoute,
      event,
      moveListSelection,
    })) {
      return;
    }

    if (handleThemePickerShortcut({
      event,
      themePickerActive,
      themePickerRef,
    })) {
      return;
    }

    const activeListState = visibleListStateRef.current;
    if (!activeListState) return;

    if (!currentRoute && event.name === "tab") {
      if (acceptRootShortcutTab() || acceptSelectedShortcutTab()) {
        consumeShortcutEvent(event);
        return;
      }
    }

    if (isMoveDownShortcut(event)) {
      consumeShortcutEvent(event);
      moveListSelection(1);
      return;
    }

    if (isMoveUpShortcut(event)) {
      consumeShortcutEvent(event);
      moveListSelection(-1);
      return;
    }

    if ((event.meta && (event.name === "backspace" || event.name === "delete")) || (event.ctrl && event.name === "u")) {
      consumeShortcutEvent(event);
      setActiveListQuery("");
      return;
    }

    if ((event.ctrl && event.name === "w") || (event.meta && (event.name === "h" || event.name === "u"))) {
      consumeShortcutEvent(event);
      const trimmed = activeListState.query.replace(/\s+$/, "");
      const nextQuery = trimmed.replace(/[^\s]+$/, "").replace(/\s+$/, "");
      setActiveListQuery(nextQuery);
      return;
    }

    const pluginToggleMode = (currentRoute?.kind === "mode" && currentRoute.screen === "plugins")
      || (!currentRoute && rootModeKind === "plugins");
    if (pluginToggleMode && event.name === "space") {
      consumeShortcutEvent(event);
      const selected = activeListState.results[activeListState.selectedIdx];
      if (selected?.pluginToggle) {
        void selected.pluginToggle();
      }
      return;
    }

    if (isCommitShortcut(event)) {
      consumeShortcutEvent(event);
      if (event.shift) {
        activateListSelection({ secondary: true });
        return;
      }
      activateListSelection();
    }
  }, {
    phase: "before",
    allowEditable: true,
    interceptNative: (event) => event.targetEditable === true,
  });
}
