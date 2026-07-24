import { createContext, createElement, useContext, type ReactNode } from "react";

export interface KeyEventLike {
  key: string;
  name?: string;
  sequence?: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
  super?: boolean;
  targetEditable?: boolean;
  readonly defaultPrevented?: boolean;
  readonly propagationStopped?: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}

export interface ShortcutOptions {
  enabled?: boolean;
  scope?: string;
  phase?: "before" | "normal" | "after";
  allowEditable?: boolean;
  interceptNative?: boolean | ((event: KeyEventLike) => boolean);
}

export interface InputHost {
  useShortcut(
    handler: (event: KeyEventLike) => void,
    options?: ShortcutOptions,
  ): void;
  useViewport(): { width: number; height: number };
}

const InputHostContext = createContext<InputHost | null>(null);

export function InputHostProvider({
  host,
  children,
}: {
  host: InputHost;
  children: ReactNode;
}) {
  return createElement(InputHostContext, { value: host }, children);
}

function useInputHost(): InputHost {
  const host = useContext(InputHostContext);
  if (!host) {
    throw new Error("Input host hooks must be used inside InputHostProvider");
  }
  return host;
}

export function useShortcut(
  handler: (event: KeyEventLike) => void,
  options?: ShortcutOptions,
): void {
  useInputHost().useShortcut(handler, options);
}

export function shouldDeliverShortcut(
  event: KeyEventLike,
  allowEditable: boolean,
): boolean {
  if (allowEditable || event.targetEditable !== true) return true;
  return event.ctrl || event.meta || event.super === true;
}

export function useViewport(): { width: number; height: number } {
  return useInputHost().useViewport();
}
