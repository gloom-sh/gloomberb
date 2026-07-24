/// <reference lib="dom" />
/** @jsxImportSource react */
import { useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from "react";
import {
  InputHostProvider,
  shouldDeliverShortcut,
  type InputHost,
  type KeyEventLike,
  type ShortcutOptions,
} from "../../../react/input";
import {
  isMouseBackNavigationButton,
  MOUSE_BACK_NAVIGATION_EVENT_NAME,
} from "../../../utils/back-navigation";
import {
  hasWebCtrlModifier,
  isEditableKeyboardTarget,
  normalizeWebKeyName,
  shouldConsumeWebAppKeyDown,
  shouldDispatchWebAppKeyDown,
  webKeySequence,
} from "./key-event";

export const WEB_CELL_WIDTH = 8;
export const WEB_CELL_HEIGHT = 18;

function toKeyEventLike(event: KeyboardEvent): KeyEventLike {
  const key = normalizeWebKeyName(event.key);
  let propagationStopped = false;
  return {
    key,
    name: key,
    sequence: webKeySequence(event),
    ctrl: hasWebCtrlModifier(event),
    shift: event.shiftKey,
    alt: event.altKey,
    meta: event.metaKey,
    super: event.metaKey,
    targetEditable: isEditableKeyboardTarget(event.target),
    get defaultPrevented() {
      return event.defaultPrevented;
    },
    get propagationStopped() {
      return propagationStopped;
    },
    preventDefault: () => event.preventDefault(),
    stopPropagation: () => {
      propagationStopped = true;
      event.stopPropagation();
    },
  };
}

function toMouseBackKeyEventLike(event: MouseEvent): KeyEventLike {
  let propagationStopped = false;
  return {
    key: MOUSE_BACK_NAVIGATION_EVENT_NAME,
    name: MOUSE_BACK_NAVIGATION_EVENT_NAME,
    sequence: "",
    ctrl: event.ctrlKey,
    shift: event.shiftKey,
    alt: event.altKey,
    meta: event.metaKey,
    super: event.metaKey,
    targetEditable: isEditableKeyboardTarget(event.target),
    get defaultPrevented() {
      return event.defaultPrevented;
    },
    get propagationStopped() {
      return propagationStopped;
    },
    preventDefault: () => event.preventDefault(),
    stopPropagation: () => {
      propagationStopped = true;
      event.stopPropagation();
    },
  };
}

interface ShortcutEntry {
  handlerRef: { current: (event: KeyEventLike) => void };
  enabledRef: { current: boolean };
  allowEditableRef: { current: boolean };
  interceptNativeRef: { current: NonNullable<ShortcutOptions["interceptNative"]> | false };
  phase: NonNullable<ShortcutOptions["phase"]>;
  order: number;
}

let nextShortcutOrder = 1;

function shouldInterceptNative(entry: ShortcutEntry, event: KeyEventLike): boolean {
  const interceptor = entry.interceptNativeRef.current;
  return typeof interceptor === "function" ? interceptor(event) : interceptor;
}

function subscribeViewport(listener: () => void): () => void {
  window.addEventListener("resize", listener);
  return () => window.removeEventListener("resize", listener);
}

let viewportSnapshot = { width: 0, height: 0 };

function getViewport() {
  const width = Math.max(1, window.innerWidth / WEB_CELL_WIDTH);
  const height = Math.max(1, window.innerHeight / WEB_CELL_HEIGHT);
  if (viewportSnapshot.width !== width || viewportSnapshot.height !== height) {
    viewportSnapshot = { width, height };
  }
  return viewportSnapshot;
}

function dispatchShortcutEntries(
  shortcutEvent: KeyEventLike,
  entries: readonly ShortcutEntry[],
  nativeInterceptionOnly = false,
  skipNativeInterceptors = false,
): void {
  for (const phase of ["before", "normal", "after"] as const) {
    if (phase === "after" && (shortcutEvent.defaultPrevented || shortcutEvent.propagationStopped)) break;
    const phaseEntries = entries
      .filter((entry) => entry.phase === phase)
      .map((entry) => ({
        entry,
        interceptsNative: shouldInterceptNative(entry, shortcutEvent),
      }))
      .sort((left, right) => (
        phase === "before" && left.interceptsNative !== right.interceptsNative
          ? Number(right.interceptsNative) - Number(left.interceptsNative)
          : left.entry.order - right.entry.order
      ));
    for (const { entry, interceptsNative } of phaseEntries) {
      if (!entry.enabledRef.current) continue;
      if (nativeInterceptionOnly && (phase !== "before" || !interceptsNative)) continue;
      if (skipNativeInterceptors && phase === "before" && interceptsNative) continue;
      if (!shouldDeliverShortcut(shortcutEvent, entry.allowEditableRef.current)) continue;
      entry.handlerRef.current(shortcutEvent);
      if (shortcutEvent.propagationStopped) break;
    }
    if (shortcutEvent.propagationStopped) break;
  }
}

export function dispatchWebNativeInterceptors(event: KeyboardEvent, entries: readonly ShortcutEntry[]): void {
  if (event.defaultPrevented || event.isComposing) return;
  dispatchShortcutEntries(toKeyEventLike(event), entries, true);
}

export function dispatchWebAppKeyDown(
  event: KeyboardEvent,
  entries: readonly ShortcutEntry[],
  nativeInterceptorsDispatched = false,
): void {
  if (event.defaultPrevented || event.isComposing) return;
  const shortcutEvent = toKeyEventLike(event);
  const nativeInterceptionOnly = !shouldDispatchWebAppKeyDown(event);

  dispatchShortcutEntries(shortcutEvent, entries, nativeInterceptionOnly, nativeInterceptorsDispatched);
  if (!nativeInterceptionOnly && shouldConsumeWebAppKeyDown(event)) event.preventDefault();
}

export function WebInputHostProvider({ children }: { children: ReactNode }) {
  const shortcutsRef = useRef<ShortcutEntry[]>([]);

  useEffect(() => {
    const onKeyDownCapture = (event: KeyboardEvent) => {
      dispatchWebNativeInterceptors(event, shortcutsRef.current);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      dispatchWebAppKeyDown(event, shortcutsRef.current, true);
    };
    window.addEventListener("keydown", onKeyDownCapture, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDownCapture, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  useEffect(() => {
    const preventBrowserBack = (event: MouseEvent) => {
      if (!isMouseBackNavigationButton(event.button)) return;
      event.preventDefault();
      event.stopPropagation();
    };
    const onMouseUp = (event: MouseEvent) => {
      if (!isMouseBackNavigationButton(event.button)) return;
      event.preventDefault();
      event.stopPropagation();
      dispatchShortcutEntries(toMouseBackKeyEventLike(event), shortcutsRef.current);
    };

    window.addEventListener("mousedown", preventBrowserBack, true);
    window.addEventListener("auxclick", preventBrowserBack, true);
    window.addEventListener("mouseup", onMouseUp, true);
    return () => {
      window.removeEventListener("mousedown", preventBrowserBack, true);
      window.removeEventListener("auxclick", preventBrowserBack, true);
      window.removeEventListener("mouseup", onMouseUp, true);
    };
  }, []);

  const host = useMemo<InputHost>(() => ({
    useShortcut(handler, options) {
      const handlerRef = useRef(handler);
      const enabledRef = useRef(options?.enabled !== false);
      const allowEditableRef = useRef(options?.allowEditable === true);
      const interceptNativeRef = useRef<NonNullable<ShortcutOptions["interceptNative"]> | false>(options?.interceptNative ?? false);
      handlerRef.current = handler;
      enabledRef.current = options?.enabled !== false;
      allowEditableRef.current = options?.allowEditable === true;
      interceptNativeRef.current = options?.interceptNative ?? false;

      useLayoutEffect(() => {
        const entry: ShortcutEntry = {
          handlerRef,
          enabledRef,
          allowEditableRef,
          interceptNativeRef,
          phase: options?.phase ?? "normal",
          order: nextShortcutOrder++,
        };
        shortcutsRef.current = [...shortcutsRef.current, entry].sort((a, b) => a.order - b.order);
        return () => {
          shortcutsRef.current = shortcutsRef.current.filter((current) => current !== entry);
        };
      }, [options?.phase, options?.scope]);
    },
    useViewport() {
      return useSyncExternalStore(subscribeViewport, getViewport, getViewport);
    },
  }), []);

  return (
    <InputHostProvider host={host}>
      {children}
    </InputHostProvider>
  );
}
