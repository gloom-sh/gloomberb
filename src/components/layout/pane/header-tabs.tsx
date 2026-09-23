import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { TabsProps } from "../../ui/tabs";

const useRegistrationEffect = typeof document === "undefined" ? useEffect : useLayoutEffect;

/**
 * A pane's primary tab strip. On the desktop the pane chrome draws it in the
 * title bar, so the body starts with content instead of spending a row on tabs.
 * The terminal title is one text line with no room for tabs, so there the pane
 * keeps drawing its own `Tabs` in the body.
 */
export type PaneHeaderTabsRegistration = Pick<
  TabsProps,
  "tabs" | "activeValue" | "onSelect" | "focused" | "keyboardNavigation" | "paneMenu" | "onAdd" | "addLabel" | "onReorder" | "closeMode"
>;

export interface PaneHeaderTabsContextValue {
  set(owner: string, registration: PaneHeaderTabsRegistration): void;
  clear(owner: string): void;
}

const PaneHeaderTabsContext = createContext<PaneHeaderTabsContextValue | null>(null);

/** Owned by the pane chrome: the current registration and the value its body provider carries. */
export function usePaneHeaderTabsHost(enabled: boolean): {
  headerTabs: PaneHeaderTabsRegistration | null;
  contextValue: PaneHeaderTabsContextValue | null;
} {
  const [state, setState] = useState<{ owner: string; registration: PaneHeaderTabsRegistration } | null>(null);
  const set = useCallback((owner: string, registration: PaneHeaderTabsRegistration) => {
    setState({ owner, registration });
  }, []);
  // A nested view of the same pane (a detail that reuses the pane component)
  // must not take down the strip its parent registered.
  const clear = useCallback((owner: string) => {
    setState((current) => current?.owner === owner ? null : current);
  }, []);
  const value = useMemo<PaneHeaderTabsContextValue>(() => ({ set, clear }), [clear, set]);
  return { headerTabs: enabled ? state?.registration ?? null : null, contextValue: enabled ? value : null };
}

export function PaneHeaderTabsProvider({ value, children }: { value: PaneHeaderTabsContextValue | null; children: ReactNode }) {
  return <PaneHeaderTabsContext.Provider value={value}>{children}</PaneHeaderTabsContext.Provider>;
}

/**
 * Content nested inside a pane that owns the title bar (a research tab, a
 * stack detail) keeps its own tab strip in its body: only the pane's primary
 * strip goes to the header.
 */
export function NestedPaneTabs({ children }: { children: ReactNode }) {
  return <PaneHeaderTabsContext.Provider value={null}>{children}</PaneHeaderTabsContext.Provider>;
}

function registrationSignature(registration: PaneHeaderTabsRegistration | null): string {
  if (!registration) return "";
  return JSON.stringify([
    registration.tabs.map((tab) => [tab.value, tab.label, tab.disabled === true, !!tab.onClose, tab.fg ?? "", tab.reorderable !== false]),
    registration.activeValue,
    registration.focused === true,
    registration.keyboardNavigation !== false,
    !!registration.onAdd,
    registration.addLabel ?? "",
    !!registration.onReorder,
    registration.closeMode ?? "",
    registration.paneMenu !== false,
  ]);
}

/**
 * Hands the pane's tab strip to the chrome. Returns true when the chrome draws
 * it, in which case the pane must not draw its own `Tabs` or reserve a row.
 * Pass null when the pane has no strip right now.
 */
export function usePaneHeaderTabs(registration: PaneHeaderTabsRegistration | null): boolean {
  const context = useContext(PaneHeaderTabsContext);
  const owner = useId();
  const latestRef = useRef(registration);
  latestRef.current = registration;
  const signature = registrationSignature(registration);

  useRegistrationEffect(() => () => context?.clear(owner), [context, owner]);

  useRegistrationEffect(() => {
    if (!context) return;
    const current = latestRef.current;
    if (!current) {
      context.clear(owner);
      return;
    }
    // Callbacks read the latest committed registration, so inline handlers do
    // not re-register the chrome on every render.
    const tab = (value: string) => latestRef.current?.tabs.find((entry) => entry.value === value);
    context.set(owner, {
      ...current,
      tabs: current.tabs.map((entry) => ({
        ...entry,
        onClose: entry.onClose ? (value: string) => tab(value)?.onClose?.(value) : undefined,
        onDoubleClick: entry.onDoubleClick ? (value: string) => tab(value)?.onDoubleClick?.(value) : undefined,
        onContextMenu: entry.onContextMenu ? (value, event) => tab(value)?.onContextMenu?.(value, event) : undefined,
      })),
      onSelect: (value: string) => latestRef.current?.onSelect(value),
      onAdd: current.onAdd ? () => latestRef.current?.onAdd?.() : undefined,
      onReorder: current.onReorder ? (from: string, to: string) => latestRef.current?.onReorder?.(from, to) : undefined,
    });
  }, [context, owner, signature]);

  return context !== null && registration !== null;
}
