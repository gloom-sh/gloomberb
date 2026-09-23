import { useShortcut, type KeyEventLike } from "../../react/input";
import { matchesKeyChord, useKeybindings, type ResolvedKeybindings } from "../../app/keybindings";
import type { SelectFieldHandle } from "../ui/select-field";
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
  isPlainTab,
  resolveListJump,
  type RefLike,
} from "./keyboard-handlers";
import type { ListJump, ListScreenState } from "./list/model";
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
  jumpListSelection: (target: ListJump) => void;
  moveListSelection: (delta: number) => void;
  moveWorkflowFocus: (delta: number) => void;
  nativePaneChrome: boolean;
  openWorkflowFieldPicker: (
    route: CommandBarWorkflowRoute,
    field: CommandBarWorkflowField,
  ) => void;
  popRoute: () => void;
  /** Clears an AI assist request; returns true when Esc was spent on it. */
  resetAssist: () => boolean;
  rootModeKind: string;
  setActiveListQuery: (query: string) => void;
  submitWorkflowRoute: (route: CommandBarWorkflowRoute) => void | Promise<void>;
  themePickerActive: boolean;
  themePickerRef: RefLike<ThemePickerHandle | null>;
  updateWorkflowValue: (fieldId: string, value: CommandBarFieldValue) => void;
  visibleListStateRef: RefLike<ListScreenState | null>;
  workflowSelectFieldRefs: RefLike<Map<string, SelectFieldHandle>>;
}

/**
 * Whether the key that opens ticker search should close the bar instead. The
 * bar toggles on any ticker-search chord that could not be typed into the
 * query: a modifier chord, a function key, or the backtick, which has always
 * closed the bar and is not a character anyone searches for. A plain letter
 * bound to ticker search stays typeable here.
 */
export function isTickerSearchToggle(event: KeyEventLike, keybindings: ResolvedKeybindings): boolean {
  const chords = keybindings.actionsById.get("ticker-search")?.chords ?? [];
  return chords.some((chord) => (
    (chord.key === "`" || chord.ctrl || chord.cmd || chord.primary || chord.alt || /^f\d+$/.test(chord.key))
    && matchesKeyChord(chord, event)
  ));
}

/** Screens that type into the header prompt and pick from a list under it. */
function isListScreenRoute(route: CommandBarRoute | null): boolean {
  return !route || route.kind === "mode" || route.kind === "picker" || route.kind === "pane-settings";
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
  jumpListSelection,
  moveListSelection,
  moveWorkflowFocus,
  nativePaneChrome,
  openWorkflowFieldPicker,
  popRoute,
  resetAssist,
  rootModeKind,
  setActiveListQuery,
  submitWorkflowRoute,
  themePickerActive,
  themePickerRef,
  updateWorkflowValue,
  visibleListStateRef,
  workflowSelectFieldRefs,
}: CommandBarKeyboardShortcutArgs): void {
  const keybindings = useKeybindings();
  useShortcut((event) => {
    if (event.name === "escape" || isTickerSearchToggle(event, keybindings)) {
      event.stopPropagation();
      event.preventDefault();
      // Esc first backs out of an AI answer, leaving the query and bar intact.
      if (event.name === "escape" && !currentRoute && resetAssist()) return;
      dismissCommandBar();
      return;
    }

    if (isListScreenRoute(currentRoute)) {
      const jump = resolveListJump(event);
      if (jump) {
        consumeShortcutEvent(event);
        if (themePickerActive) themePickerRef.current?.jump(jump);
        else jumpListSelection(jump);
        return;
      }
      // The query input keeps the keyboard: Tab completes a command prefix on
      // the root and walks the list on nested screens, but never moves focus
      // out of the bar.
      if (isPlainTab(event)) {
        consumeShortcutEvent(event);
        if (currentRoute) {
          moveListSelection(event.shift ? -1 : 1);
        } else if (visibleListStateRef.current && !acceptRootShortcutTab()) {
          acceptSelectedShortcutTab();
        }
        return;
      }
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
      workflowSelectFieldRefs,
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

    if (isCommitShortcut(event)) {
      consumeShortcutEvent(event);
      if (event.shift) {
        activateListSelection({ secondary: true });
        return;
      }
      activateListSelection();
    }
  }, { phase: "before", allowEditable: true });
}
