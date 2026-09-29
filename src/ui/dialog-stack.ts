import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DialogApi, DialogOptions, PromptContext } from "./dialog";

/**
 * The dialog stack both hosts share: open, close, settle, and settle anything
 * left open when the host unmounts. Hosts own rendering and focus. Kept out of
 * the public `gloomberb/dialog` module on purpose.
 */

export type DialogKind = "alert" | "prompt";

interface DialogStackOptions<E extends { id: string }> {
  idPrefix: string;
  /** Builds the host's record. `stackWasEmpty` is true for the first dialog of a stack. */
  createEntry(id: string, kind: DialogKind, options: DialogOptions<never>, stackWasEmpty: boolean): E;
  /** Runs once a closed dialog's promise has settled. */
  onClosed?(entry: E, remaining: readonly E[]): void;
  /** Wraps the state update, e.g. to flush it synchronously. */
  commit?(update: () => void): void;
}

let nextDialogId = 1;

interface MountedStack {
  /** The host's dialogs, updated the moment one opens or closes. */
  readonly dialogs: { readonly current: readonly { id: string }[] };
  close(id: string): void;
}

/** Every mounted host's stack. */
const mountedStacks = new Set<MountedStack>();
/** When each open dialog opened, across hosts. */
const openedAt = new WeakMap<object, number>();

/**
 * Whether a dialog is open now. Read from the stacks rather than from a
 * render, so a dialog that just closed itself (pane settings handing over to
 * the bar) already counts as closed. Anything that would open the command bar
 * checks this first: the bar would sit over the dialog without its keys.
 */
export function isDialogOpen(): boolean {
  for (const stack of mountedStacks) {
    if (stack.dialogs.current.length > 0) return true;
  }
  return false;
}

/**
 * Closes the dialog opened last, the one on top, as Esc would. False when no
 * dialog is open. For remote control, which has no Esc to press.
 */
export function dismissTopmostDialog(): boolean {
  let top: { stack: MountedStack; id: string; order: number } | null = null;
  for (const stack of mountedStacks) {
    const entry = stack.dialogs.current.at(-1);
    if (!entry) continue;
    const order = openedAt.get(entry) ?? 0;
    if (!top || order > top.order) top = { stack, id: entry.id, order };
  }
  top?.stack.close(top.id);
  return top !== null;
}

export function useDialogStack<E extends { id: string }>(options: DialogStackOptions<E>) {
  const [dialogs, setDialogs] = useState<E[]>([]);
  const dialogsRef = useRef<E[]>([]);
  const settlersRef = useRef(new Map<string, (value: unknown) => void>());
  const mountedRef = useRef(true);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const publish = useCallback((next: E[]) => {
    dialogsRef.current = next;
    if (!mountedRef.current) return;
    const { commit } = optionsRef.current;
    if (commit) commit(() => setDialogs(next));
    else setDialogs(next);
  }, []);

  const close = useCallback((id: string, value?: unknown) => {
    const current = dialogsRef.current;
    const target = current.find((dialog) => dialog.id === id);
    if (!target) return;
    const next = current.filter((dialog) => dialog.id !== id);
    publish(next);
    const settle = settlersRef.current.get(id);
    settlersRef.current.delete(id);
    settle?.(value);
    optionsRef.current.onClosed?.(target, next);
  }, [publish]);

  const open = useCallback(<T,>(kind: DialogKind, dialogOptions: DialogOptions<never>) => (
    new Promise<T | undefined>((resolve) => {
      const { createEntry, idPrefix } = optionsRef.current;
      const order = nextDialogId++;
      const entry = createEntry(`${idPrefix}-${order}`, kind, dialogOptions, dialogsRef.current.length === 0);
      openedAt.set(entry, order);
      settlersRef.current.set(entry.id, (value) => resolve(value as T | undefined));
      publish([...dialogsRef.current, entry]);
    })
  ), [publish]);

  useEffect(() => {
    mountedRef.current = true;
    // `close` keeps its identity for the life of the host.
    const mounted: MountedStack = { dialogs: dialogsRef, close };
    mountedStacks.add(mounted);
    return () => {
      mountedRef.current = false;
      mountedStacks.delete(mounted);
      const settlers = [...settlersRef.current.values()];
      settlersRef.current.clear();
      dialogsRef.current = [];
      for (const settle of settlers) settle(undefined);
    };
  }, []);

  const api = useMemo<DialogApi>(() => ({
    alert: async (dialogOptions) => {
      await open<void>("alert", dialogOptions);
    },
    prompt: <T,>(dialogOptions: DialogOptions<PromptContext<T>>) => open<T>("prompt", dialogOptions),
  }), [open]);

  return { dialogs, close, api };
}
