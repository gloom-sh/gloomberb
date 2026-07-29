/** @jsxImportSource react */
import { useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import {
  createShortcutRegistry,
  InputHostProvider,
  useRegisteredShortcut,
  type InputHost,
  type KeyEventLike,
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

export function WebInputHostProvider({ children }: { children: ReactNode }) {
  const shortcutRegistry = useMemo(() => createShortcutRegistry(), []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const shortcutEvent = toKeyEventLike(event);
      shortcutRegistry.dispatch(shortcutEvent);
      if (shouldConsumeWebAppKeyDown(event)) event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [shortcutRegistry]);

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
      shortcutRegistry.dispatch(toMouseBackKeyEventLike(event));
    };

    window.addEventListener("mousedown", preventBrowserBack, true);
    window.addEventListener("auxclick", preventBrowserBack, true);
    window.addEventListener("mouseup", onMouseUp, true);
    return () => {
      window.removeEventListener("mousedown", preventBrowserBack, true);
      window.removeEventListener("auxclick", preventBrowserBack, true);
      window.removeEventListener("mouseup", onMouseUp, true);
    };
  }, [shortcutRegistry]);

  const host = useMemo<InputHost>(() => ({
    useShortcut(handler, options) {
      useRegisteredShortcut(shortcutRegistry, handler, options);
    },
    useViewport() {
      return useSyncExternalStore(subscribeViewport, getViewport, getViewport);
    },
  }), [shortcutRegistry]);

  return (
    <InputHostProvider host={host}>
      {children}
    </InputHostProvider>
  );
}
