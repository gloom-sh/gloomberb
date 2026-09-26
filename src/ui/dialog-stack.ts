import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DialogApi } from "./dialog";

/**
 * The dialog stack both hosts share: open, close, settle, and settle anything
 * left open when the host unmounts. Hosts own rendering and focus. Kept out of
 * the public `gloomberb/dialog` module on purpose.
 */

export type DialogKind = "alert" | "prompt";

interface DialogStackOptions<E extends { id: string }> {
  idPrefix: string;
  /** Builds the host's record. `stackWasEmpty` is true for the first dialog of a stack. */
  createEntry(id: string, kind: DialogKind, options: Record<string, unknown>, stackWasEmpty: boolean): E;
  /** Runs once a closed dialog's promise has settled. */
  onClosed?(entry: E, remaining: readonly E[]): void;
  /** Wraps the state update, e.g. to flush it synchronously. */
  commit?(update: () => void): void;
}

let nextDialogId = 1;

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

  const open = useCallback(<T,>(kind: DialogKind, dialogOptions: Record<string, unknown>) => (
    new Promise<T | undefined>((resolve) => {
      const { createEntry, idPrefix } = optionsRef.current;
      const entry = createEntry(`${idPrefix}-${nextDialogId++}`, kind, dialogOptions, dialogsRef.current.length === 0);
      settlersRef.current.set(entry.id, (value) => resolve(value as T | undefined));
      publish([...dialogsRef.current, entry]);
    })
  ), [publish]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
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
    prompt: <T,>(dialogOptions: Record<string, unknown>) => open<T>("prompt", dialogOptions),
  }), [open]);

  return { dialogs, close, api };
}
