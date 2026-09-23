import { useShortcut, type KeyEventLike } from "../../../react/input";
import { isPlainKey } from "../../../utils/keyboard";
import type { BrokerEditKey } from "./detail";

/**
 * The edit form's field ring. The list and detail actions (a, e, c, s, o, d)
 * are footer hints, which bind their own keys, and the table opens a row on
 * Enter, so only editing needs keys of its own.
 *
 * It runs before the app's Tab (next pane) and the stack's Esc (back), and
 * while a text field has the keyboard, so Tab walks every field, Esc cancels
 * the edit instead of closing the profile, and Enter saves from any row.
 */
export function useBrokerManagerKeyboard({
  activeEditKey,
  editing,
  editKeys,
  focused,
  scope,
  selectKeys,
  onActiveEditKeyChange,
  onCancelEdit,
  onCycleSelect,
  saveEdit,
}: {
  activeEditKey: BrokerEditKey;
  editing: boolean;
  editKeys: BrokerEditKey[];
  focused: boolean;
  /** Shared with the form's segmented controls so the two take turns on left and right. */
  scope: string;
  /** Rows edited with left and right: the enabled switch and select-type broker fields. */
  selectKeys: ReadonlySet<BrokerEditKey>;
  onActiveEditKeyChange: (key: BrokerEditKey) => void;
  onCancelEdit: () => void;
  onCycleSelect: (key: BrokerEditKey, direction: -1 | 1) => void;
  saveEdit: () => Promise<void>;
}) {
  useShortcut((event) => {
    if (event.defaultPrevented || event.propagationStopped) return;
    const consume = (event: KeyEventLike) => {
      event.preventDefault();
      event.stopPropagation();
    };
    const move = (delta: number) => {
      const index = Math.max(0, editKeys.indexOf(activeEditKey));
      const next = editKeys[(index + delta + editKeys.length) % editKeys.length];
      if (next) onActiveEditKeyChange(next);
    };
    const onSelectRow = !event.targetEditable && selectKeys.has(activeEditKey);

    if (isPlainKey(event, "escape") || (!event.targetEditable && isPlainKey(event, "backspace"))) {
      consume(event);
      onCancelEdit();
      return;
    }
    if (isPlainKey(event, "enter", "return")) {
      consume(event);
      saveEdit().catch(() => {});
      return;
    }
    if (event.name === "tab" && !event.ctrl && !event.alt && !event.meta && !event.super) {
      consume(event);
      move(event.shift ? -1 : 1);
      return;
    }
    if (!event.targetEditable && isPlainKey(event, "up", "k")) {
      consume(event);
      move(-1);
      return;
    }
    if (!event.targetEditable && isPlainKey(event, "down", "j")) {
      consume(event);
      move(1);
      return;
    }
    if (onSelectRow && isPlainKey(event, "left", "h", "right", "l", "space")) {
      consume(event);
      onCycleSelect(activeEditKey, isPlainKey(event, "left", "h") ? -1 : 1);
    }
  }, { enabled: focused && editing, phase: "before", scope, allowEditable: true });
}
