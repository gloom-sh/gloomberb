import { useMemo, type ReactNode } from "react";
import { useNativeRenderer } from "../../ui";
import {
  createShortcutRegistry,
  InputHostProvider,
  useRegisteredShortcut,
  type InputHost,
} from "../../react/input";
import { toKeyEventLike, useKeyboard, useTerminalDimensions } from "./host";

export function OpenTuiInputHostProvider({ children }: { children: ReactNode }) {
  const renderer = useNativeRenderer();
  const shortcutRegistry = useMemo(() => createShortcutRegistry(), []);

  useKeyboard((event) => {
    const shortcutEvent = toKeyEventLike(event);
    shortcutEvent.targetEditable = renderer.currentFocusedEditor != null;
    shortcutRegistry.dispatch(shortcutEvent);
  });

  const host = useMemo<InputHost>(() => ({
    useShortcut(handler, options) {
      useRegisteredShortcut(shortcutRegistry, handler, options);
    },
    useViewport() {
      const dimensions = useTerminalDimensions();
      return { width: dimensions.width, height: dimensions.height };
    },
  }), [shortcutRegistry]);

  return (
    <InputHostProvider host={host}>
      {children}
    </InputHostProvider>
  );
}
