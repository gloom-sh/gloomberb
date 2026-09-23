import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

export interface TransientLayoutState {
  id: "pane-focus";
  label: string;
  /** The keybinding action whose key the status bar puts before the label. */
  shortcutActionId?: string;
  active: boolean;
  onActivate?: () => void;
  onDeactivate?: () => void;
  onExit?: () => void;
}

interface TransientLayoutContextValue {
  transientLayout: TransientLayoutState | null;
  setTransientLayout: (layout: TransientLayoutState | null) => void;
}

const noop = () => {};

const TransientLayoutContext = createContext<TransientLayoutContextValue>({
  transientLayout: null,
  setTransientLayout: noop,
});

function sameTransientLayout(
  left: TransientLayoutState | null,
  right: TransientLayoutState | null,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.id === right.id
    && left.label === right.label
    && left.shortcutActionId === right.shortcutActionId
    && left.active === right.active
    && left.onActivate === right.onActivate
    && left.onDeactivate === right.onDeactivate
    && left.onExit === right.onExit;
}

export function TransientLayoutProvider({ children }: { children: ReactNode }) {
  const [transientLayout, setTransientLayoutState] = useState<TransientLayoutState | null>(null);
  const setTransientLayout = useCallback((layout: TransientLayoutState | null) => {
    setTransientLayoutState((current) => (sameTransientLayout(current, layout) ? current : layout));
  }, []);
  const value = useMemo(() => ({
    transientLayout,
    setTransientLayout,
  }), [setTransientLayout, transientLayout]);

  return (
    <TransientLayoutContext.Provider value={value}>
      {children}
    </TransientLayoutContext.Provider>
  );
}

export function useTransientLayout(): TransientLayoutContextValue {
  return useContext(TransientLayoutContext);
}
