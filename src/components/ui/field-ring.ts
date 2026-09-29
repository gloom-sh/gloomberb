import { useCallback, useEffect, useMemo, useRef, type RefObject } from "react";
import { useShortcut } from "../../react/input";
import type { BoxRenderable, ScrollBoxRenderable } from "../../ui";
import { isPlainKey } from "../../utils/keyboard";
import { afterLayout, revealInScrollBox } from "./reveal-in-scroll-box";

export interface FieldRingOptions<Id extends string> {
  /** The fields in Tab order. */
  ids: readonly Id[];
  activeId: Id | null;
  onActivate: (id: Id) => void;
  /** Keys reach the ring only while this is true, e.g. while the pane has focus. */
  enabled: boolean;
  /**
   * Shortcut scope, shared with the form's own keys. The ring runs in the
   * "before" phase, so it sees Tab ahead of the app's pane cycling.
   */
  scope: string;
  /**
   * Past either end Tab lets go, so the next Tab moves to the next pane and
   * the form never traps the keyboard; j/k and the arrows stop there. With
   * `wrap` both go round instead.
   */
  wrap?: boolean;
  /** j/k and the arrows go round past either end even when Tab lets go. */
  wrapArrows?: boolean;
  /**
   * What Enter or Space does on a field that is not taking text: a button
   * presses, a checkbox toggles. A function is read when the key arrives.
   */
  actions?: Partial<Record<Id, () => void>> | ((id: Id) => (() => void) | null | undefined);
  /** Scrolls the field the keyboard moved to into view; pointer moves leave the scroll alone. */
  scrollRef?: RefObject<ScrollBoxRenderable | null>;
}

export interface FieldRing<Id extends string> {
  /** Ref for a field's outer box, so the ring can scroll it into view. Stable per id. */
  nodeRef: (id: Id) => (node: BoxRenderable | null) => void;
}

function step<Id>(ids: readonly Id[], current: Id | null, delta: 1 | -1, wrap: boolean): Id | undefined {
  const index = current === null ? -1 : ids.indexOf(current);
  if (index < 0) return wrap && delta < 0 ? ids[ids.length - 1] : ids[0];
  const next = index + delta;
  if (wrap) return ids[(next + ids.length) % ids.length];
  return ids[Math.max(0, Math.min(ids.length - 1, next))];
}

/**
 * The keyboard ring of a form: Tab and Shift+Tab, j/k and the arrows walk
 * `ids`, Enter and Space fire the active field's action, and a field the
 * keyboard reaches below the fold scrolls into view. Keys that type into a
 * text field (j, k, Space, Enter) stay with the field.
 */
export function useFieldRing<Id extends string>(options: FieldRingOptions<Id>): FieldRing<Id> {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  // Where the ring is, ahead of the render that shows it, so a key that
  // repeats faster than the pane renders still moves one field per press.
  const currentRef = useRef(options.activeId);
  currentRef.current = options.activeId;
  const nodes = useRef(new Map<Id, BoxRenderable>());
  const refs = useRef(new Map<Id, (node: BoxRenderable | null) => void>());
  const revealRef = useRef(false);

  const move = useCallback((next: Id | undefined) => {
    if (next === undefined) return;
    if (next !== currentRef.current) revealRef.current = true;
    currentRef.current = next;
    optionsRef.current.onActivate(next);
  }, []);

  useShortcut((event) => {
    const { ids, wrap = false, wrapArrows = wrap, actions } = optionsRef.current;
    const activeId = currentRef.current;
    const consume = () => {
      event.preventDefault?.();
      event.stopPropagation?.();
    };
    if (event.name === "tab" && !event.ctrl && !event.meta && !event.alt && !event.super) {
      const delta = event.shift ? -1 : 1;
      const index = activeId === null ? -1 : ids.indexOf(activeId);
      const next = wrap
        ? step(ids, activeId, delta, true)
        : index < 0 && delta < 0 ? undefined : ids[index + delta];
      if (next === undefined) return;
      consume();
      move(next);
      return;
    }
    if (event.targetEditable) return;
    if (isPlainKey(event, "down", "j", "up", "k")) {
      consume();
      move(step(ids, activeId, isPlainKey(event, "down", "j") ? 1 : -1, wrapArrows));
      return;
    }
    if (activeId !== null && isPlainKey(event, "enter", "return", "space")) {
      const action = typeof actions === "function" ? actions(activeId) : actions?.[activeId];
      if (!action) return;
      consume();
      action();
    }
  }, { allowEditable: true, phase: "before", scope: options.scope, enabled: options.enabled });

  const { activeId, scrollRef } = options;
  useEffect(() => {
    if (!revealRef.current || activeId === null) return;
    revealRef.current = false;
    return afterLayout(() => revealInScrollBox(scrollRef?.current ?? null, nodes.current.get(activeId) ?? null));
  }, [activeId, scrollRef]);

  const nodeRef = useCallback((id: Id) => {
    let ref = refs.current.get(id);
    if (!ref) {
      ref = (node: BoxRenderable | null) => {
        if (node) nodes.current.set(id, node);
        else nodes.current.delete(id);
      };
      refs.current.set(id, ref);
    }
    return ref;
  }, []);

  return useMemo(() => ({ nodeRef }), [nodeRef]);
}
