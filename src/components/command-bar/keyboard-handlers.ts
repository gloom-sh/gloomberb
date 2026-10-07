import type { KeyEventLike } from "../../react/input";
import { isPlainBackspace } from "../../utils/back-navigation";
import type { ListJump } from "./list/model";
import type { ThemePickerHandle } from "./theme-picker";
import type { CommandBarRoute } from "./workflow/types";

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
 * Ctrl+S (Cmd+S on a Mac desktop) submits a form from any field. Not
 * Ctrl+Enter: a desktop text field already submits or moves on for any Enter
 * before the form's handler sees the key, so the form would be sent twice.
 * Shift stays out of it: Cmd/Ctrl+Shift+S shares the focused pane.
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

export function handleRouteBackShortcut({
  currentRoute,
  event,
  popRoute,
}: {
  currentRoute: CommandBarRoute | null;
  event: KeyEventLike;
  popRoute: () => void;
}): boolean {
  if (currentRoute && isPlainBackspace(event) && currentRoute.query.length === 0) {
    consumeShortcutEvent(event);
    popRoute();
    return true;
  }
  return false;
}

export function handlePickerRouteShortcut({
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
  if (isCommitShortcut(event)) {
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
