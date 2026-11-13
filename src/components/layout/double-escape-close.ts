import { useEffect, useRef } from "react";
import { useBeforeShortcut, useShortcut, type KeyEventLike } from "../../react/input";
import {
  armDoubleEscapeClose,
  createDoubleEscapeCloseState,
  isEscapeKeptFromClosing,
  isHeldEscapePress,
  offerEscapeTowardClose,
  resetDoubleEscapeClose,
  swallowEscapeAfterSingleClose,
  takeDoubleEscapeClose,
  takeSingleEscapeClose,
} from "../../utils/double-escape-close";

function isEscapeKey(event: KeyEventLike): boolean {
  return event.name === "escape" || event.name === "esc";
}

interface DoubleEscapeCloseOptions {
  /** The pane a pair of Esc presses closes. */
  targetId: string | null;
  /** A menu, dialog or other overlay is open: its Esc is its own. */
  overlayOpen: boolean;
  /** The pane is editing (input capture): its Esc counts only when the pane counts it. */
  editing: boolean;
  /** A drag is under way: Esc cancels it. */
  dragging?: () => boolean;
  /** Closes the target; false when nothing was closed and the Esc goes on to the pane. */
  close(): boolean;
  /**
   * Closes the target on one Esc that nothing in it took, where one Esc is
   * enough (a floating window); false where it is not, and the Esc goes on.
   */
  closeOnSingle?: () => boolean;
}

/**
 * Esc Esc closes the focused pane, even one that could still go back: every
 * Esc is the first half of a pair, whatever the pane did with it. Where one
 * Esc is enough (`closeOnSingle`, a floating window), an Esc nothing took
 * closes it, and the Esc after it at a double press's pace closes nothing
 * more. Kept out:
 *
 * - an Esc in a text field, or while the pane is editing, unless the pane
 *   counts it because nothing typed is left behind (an empty composer);
 * - an Esc while a menu, dialog or overlay is open, and one that closes a
 *   menu or popover of the pane's own (`keepEscapeFromClosing`);
 * - a held Esc, which closes one pane: the shortcut registry drops the
 *   repeats a host flags, and a stream the host cannot flag (a terminal)
 *   arms and closes nothing for as long as its presses come faster than a
 *   person's. A host that reports repeats has no such pause: Esc Esc, Esc
 *   Esc closes two panes however fast the presses come.
 *
 * A surface that takes Esc in a scoped `before` handler (onboarding, a form,
 * key capture) runs ahead of the arming and so never counts.
 */
export function useDoubleEscapeClose({ targetId, overlayOpen, editing, dragging, close, closeOnSingle }: DoubleEscapeCloseOptions): void {
  const stateRef = useRef(createDoubleEscapeCloseState());
  const live = useRef({ targetId, overlayOpen });
  live.current = { targetId, overlayOpen };
  /** Esc presses that came as a held key's, judged before they armed anything. */
  const heldRef = useRef(new WeakSet<object>());

  useEffect(() => {
    if (overlayOpen) resetDoubleEscapeClose(stateRef.current);
  }, [overlayOpen]);

  // Before any handler, so one in any phase or scope can count or keep its Esc.
  useBeforeShortcut((event) => {
    const state = stateRef.current;
    if (!isEscapeKey(event)) {
      resetDoubleEscapeClose(state);
      return;
    }
    const at = Date.now();
    if (isHeldEscapePress(state, at, event.repeat)) heldRef.current.add(event);
    offerEscapeTowardClose(event, {
      count: () => {
        if (!live.current.overlayOpen) armDoubleEscapeClose(state, live.current.targetId, at, event.repeat);
      },
      keep: () => resetDoubleEscapeClose(state),
    });
  });

  // The second Esc of a pair closes before anything else sees it, so a pane
  // with more to go back through still closes. Not in a text field.
  useShortcut((event) => {
    if (!isEscapeKey(event) || overlayOpen || editing || dragging?.()) return;
    const now = Date.now();
    if (swallowEscapeAfterSingleClose(stateRef.current, now, event.repeat)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (takeDoubleEscapeClose(stateRef.current, targetId, now, event.repeat) && close()) {
      event.preventDefault();
      event.stopPropagation();
    }
  }, { phase: "capture" });

  // One Esc that nothing took (the window had nothing to back out of, no menu
  // to close) closes a floating window, as it does a dialog or Help.
  useShortcut((event) => {
    if (!closeOnSingle || !isEscapeKey(event) || overlayOpen || editing || dragging?.()) return;
    if (isEscapeKeptFromClosing(event) || heldRef.current.has(event)) return;
    if (!closeOnSingle()) return;
    takeSingleEscapeClose(stateRef.current, Date.now());
    event.preventDefault();
    event.stopPropagation();
  }, { phase: "idle" });

  // The first: after the scoped surfaces that own their Esc (onboarding, a
  // form, key capture), so theirs never counts, and before the pane.
  useShortcut((event) => {
    if (!isEscapeKey(event)) return;
    const state = stateRef.current;
    if (overlayOpen || dragging?.()) {
      resetDoubleEscapeClose(state);
      return;
    }
    if (editing || isEscapeKeptFromClosing(event)) return;
    armDoubleEscapeClose(state, targetId, Date.now(), event.repeat);
  }, { phase: "before" });
}
