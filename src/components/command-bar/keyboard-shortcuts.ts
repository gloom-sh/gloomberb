import { useShortcut, type KeyEventLike } from "../../react/input";
import { matchesKeyChord, useKeybindings, type ResolvedKeybindings } from "../../app/keybindings";
import { useDialogState } from "../../ui/dialog";
import {
  consumeShortcutEvent,
  handlePickerRouteShortcut,
  handleRouteBackShortcut,
  handleThemePickerShortcut,
  isCommitShortcut,
  isMoveDownShortcut,
  isMoveUpShortcut,
  isPlainTab,
  resolveListJump,
  type RefLike,
} from "./keyboard-handlers";
import type { ListJump, ListScreenState } from "./list/model";
import type { ThemePickerHandle } from "./theme-picker";
import type { CommandBarRoute } from "./workflow/types";

interface CommandBarKeyboardShortcutArgs {
  acceptRootShortcutTab: () => boolean;
  acceptSelectedShortcutTab: () => boolean;
  activateListSelection: (options?: { secondary?: boolean }) => void;
  currentRoute: CommandBarRoute | null;
  dismissCommandBar: () => void;
  jumpListSelection: (target: ListJump) => void;
  moveListSelection: (delta: number) => void;
  popRoute: () => void;
  /** Clears an AI assist request; returns true when Esc was spent on it. */
  resetAssist: () => boolean;
  rootModeKind: string;
  setActiveListQuery: (query: string) => void;
  themePickerActive: boolean;
  themePickerRef: RefLike<ThemePickerHandle | null>;
  visibleListStateRef: RefLike<ListScreenState | null>;
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

export function useCommandBarKeyboardShortcuts({
  acceptRootShortcutTab,
  acceptSelectedShortcutTab,
  activateListSelection,
  currentRoute,
  dismissCommandBar,
  jumpListSelection,
  moveListSelection,
  popRoute,
  resetAssist,
  rootModeKind,
  setActiveListQuery,
  themePickerActive,
  themePickerRef,
  visibleListStateRef,
}: CommandBarKeyboardShortcutArgs): void {
  const keybindings = useKeybindings();
  // The bar sits under every dialog; one opened over it (a form, a sign-in)
  // gets the keyboard. The bar's handler runs first in the dispatch, so it
  // steps aside rather than relying on the dialog to stop it.
  const dialogOpen = useDialogState((state) => state.isOpen);
  useShortcut((event) => {
    if (event.name === "escape" || isTickerSearchToggle(event, keybindings)) {
      event.stopPropagation();
      event.preventDefault();
      // Esc first backs out of an AI answer, leaving the query and bar intact.
      if (event.name === "escape" && !currentRoute && resetAssist()) return;
      dismissCommandBar();
      return;
    }

    // Every screen of the bar types into the header prompt and picks from a
    // list under it.
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

    if (handleRouteBackShortcut({ currentRoute, event, popRoute })) {
      return;
    }

    if (handlePickerRouteShortcut({
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
  }, { phase: "before", allowEditable: true, enabled: !dialogOpen });
}
