/** @jsxImportSource react */
import { useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import {
  createShortcutRegistry,
  InputHostProvider,
  useRegisteredShortcut,
  type InputHost,
  type KeyEventLike,
} from "../../react/input";
import {
  isMouseBackNavigationButton,
  MOUSE_BACK_NAVIGATION_EVENT_NAME,
} from "../../utils/back-navigation";
import {
  hasWebCtrlModifier,
  isEditableKeyboardTarget,
  moveDialogFocus,
  normalizeWebKeyName,
  shouldConsumeWebAppKeyDown,
  webKeySequence,
} from "./key-event";
import { WEB_CELL_HEIGHT, WEB_CELL_WIDTH } from "../../theme/font-scale";

/** A shortcut event for a DOM event: `name`, `sequence` and `ctrl` say which key; the rest comes from the event. */
function domKeyEventLike(
  event: KeyboardEvent | MouseEvent,
  { name, sequence, ctrl }: { name: string; sequence: string; ctrl: boolean },
): KeyEventLike {
  let propagationStopped = false;
  return {
    key: name,
    name,
    sequence,
    ctrl,
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

export function toKeyEventLike(event: KeyboardEvent): KeyEventLike {
  return domKeyEventLike(event, {
    name: normalizeWebKeyName(event.key),
    sequence: webKeySequence(event),
    ctrl: hasWebCtrlModifier(event),
  });
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
    // Windows fires the Menu key's contextmenu on keyup. When the app used the
    // keydown (it opens the pane menu), the native menu must not follow.
    let menuKeyUsedAt = 0;
    const onKeyDown = (event: KeyboardEvent) => {
      const shortcutEvent = toKeyEventLike(event);
      shortcutRegistry.dispatch(shortcutEvent);
      if (event.key === "ContextMenu" && event.defaultPrevented) menuKeyUsedAt = Date.now();
      if (moveDialogFocus(event)) {
        event.preventDefault();
        return;
      }
      if (shouldConsumeWebAppKeyDown(event)) event.preventDefault();
    };
    const recentlyUsedMenuKey = () => Date.now() - menuKeyUsedAt < 1000;
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === "ContextMenu" && recentlyUsedMenuKey()) event.preventDefault();
    };
    const onContextMenu = (event: MouseEvent) => {
      // A right click (button 2) is the pointer's own menu; the key's has none.
      if (!recentlyUsedMenuKey() || event.button === 2) return;
      menuKeyUsedAt = 0;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("contextmenu", onContextMenu, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("contextmenu", onContextMenu, true);
    };
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
      shortcutRegistry.dispatch(domKeyEventLike(event, {
        name: MOUSE_BACK_NAVIGATION_EVENT_NAME,
        sequence: "",
        ctrl: event.ctrlKey,
      }));
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
