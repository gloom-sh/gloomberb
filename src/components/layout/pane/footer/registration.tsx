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
  type DependencyList,
  type ReactNode,
} from "react";
import {
  combinePaneFooterRegistrations,
  samePaneFooterRegistration,
  type CombinedPaneFooter,
  type PaneFooterRegistration,
  type PaneHint,
} from "./model";
import { useAppLanguage } from "../../../../i18n/react";
import type { ContextMenuItem } from "../../../../types/context-menu";

const usePaneFooterRegistrationEffect =
  typeof document === "undefined" ? useEffect : useLayoutEffect;

interface PaneFooterContextValue {
  register(registrationId: string, registration: PaneFooterRegistration | null): void;
  unregister(registrationId: string): void;
}

const PaneFooterContext = createContext<PaneFooterContextValue | null>(null);

/** Also gates non-footer interaction owned by an inactive pane/tab. */
export function usePaneFooterScopeActive(): boolean {
  return useContext(PaneFooterContext) !== null;
}

export function PaneFooterProvider({
  children,
}: {
  children: (footer: CombinedPaneFooter) => ReactNode;
}) {
  const [registrations, setRegistrations] = useState<Map<string, PaneFooterRegistration>>(() => new Map());

  const register = useCallback((registrationId: string, registration: PaneFooterRegistration | null) => {
    setRegistrations((current) => {
      const next = new Map(current);
      if (registration && ((registration.info?.length ?? 0) > 0 || (registration.hints?.length ?? 0) > 0 || (registration.menu?.length ?? 0) > 0 || (registration.keys?.length ?? 0) > 0)) {
        next.set(registrationId, registration);
      } else {
        next.delete(registrationId);
      }
      return next;
    });
  }, []);

  const unregister = useCallback((registrationId: string) => {
    setRegistrations((current) => {
      if (!current.has(registrationId)) return current;
      const next = new Map(current);
      next.delete(registrationId);
      return next;
    });
  }, []);

  const value = useMemo(() => ({ register, unregister }), [register, unregister]);
  const footer = useMemo(() => combinePaneFooterRegistrations(registrations), [registrations]);

  const [arrowClaims, setArrowClaims] = useState<ReadonlySet<string>>(() => new Set());
  const setArrowClaim = useCallback((id: string, claimed: boolean) => {
    setArrowClaims((current) => {
      if (current.has(id) === claimed) return current;
      const next = new Set(current);
      if (claimed) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  const arrowValue = useMemo(() => ({ claimed: arrowClaims.size > 0, setArrowClaim }), [arrowClaims, setArrowClaim]);

  return (
    <PaneFooterContext.Provider value={value}>
      <PaneArrowContext.Provider value={arrowValue}>
        {children(footer)}
      </PaneArrowContext.Provider>
    </PaneFooterContext.Provider>
  );
}

const PaneArrowContext = createContext<{ claimed: boolean; setArrowClaim(id: string, claimed: boolean): void } | null>(null);

/**
 * A focused tab strip owns Left and Right in its pane. It claims them here, so
 * a read-only chart in the same pane leaves them to the strip and the arrows
 * keep walking the tabs.
 */
export function usePaneArrowClaim(claimed: boolean) {
  const context = useContext(PaneArrowContext);
  const id = useId();
  const setArrowClaim = context?.setArrowClaim;
  useEffect(() => {
    if (!setArrowClaim) return;
    setArrowClaim(id, claimed);
    return () => setArrowClaim(id, false);
  }, [claimed, id, setArrowClaim]);
}

/** Whether a tab strip in this pane owns Left and Right. */
export function usePaneArrowsClaimed(): boolean {
  return useContext(PaneArrowContext)?.claimed ?? false;
}

export function PaneFooterScope({
  active,
  children,
}: {
  active: boolean;
  children: ReactNode;
}) {
  const context = useContext(PaneFooterContext);
  return (
    <PaneFooterContext.Provider value={active ? context : null}>
      {children}
    </PaneFooterContext.Provider>
  );
}

export function usePaneFooter(
  registrationId: string,
  factory: () => PaneFooterRegistration | null | undefined,
  deps: DependencyList,
) {
  const language = useAppLanguage();
  const context = useContext(PaneFooterContext);
  const previousRegistrationRef = useRef<PaneFooterRegistration | null>(null);
  const currentRegistrationRef = useRef<PaneFooterRegistration | null>(null);
  const lifetimeRef = useRef(0);

  usePaneFooterRegistrationEffect(() => {
    return () => {
      previousRegistrationRef.current = null;
      currentRegistrationRef.current = null;
      lifetimeRef.current += 1;
      context?.unregister(registrationId);
    };
  }, [context, registrationId]);

  usePaneFooterRegistrationEffect(() => {
    if (!context) return;
    const nextRegistration = factory() ?? null;
    currentRegistrationRef.current = nextRegistration;
    if (samePaneFooterRegistration(previousRegistrationRef.current, nextRegistration)) return;
    previousRegistrationRef.current = nextRegistration;
    const lifetime = lifetimeRef.current;
    // Keep visual equality independent of inline callback identity, while each
    // registered action follows the latest committed state of its own item.
    context.register(registrationId, nextRegistration ? {
      ...nextRegistration,
      info: nextRegistration.info?.map((segment) => ({
        ...segment,
        onPress: segment.onPress ? () => {
          if (lifetime !== lifetimeRef.current) return;
          const current = currentRegistrationRef.current?.info?.find((item) => item.id === segment.id);
          if (!current?.disabled) current?.onPress?.();
        } : undefined,
      })),
      hints: nextRegistration.hints?.map((hint) => ({
        ...hint,
        onPress: hint.onPress ? (event) => {
          if (lifetime !== lifetimeRef.current) return;
          const current = currentRegistrationRef.current?.hints?.find((item) => item.id === hint.id);
          if (!current?.disabled) current?.onPress?.(event);
        } : undefined,
      })),
      keys: nextRegistration.keys?.map((key) => ({
        ...key,
        onPress: key.onPress ? (event) => {
          if (lifetime !== lifetimeRef.current) return;
          const current = currentRegistrationRef.current?.keys?.find((item) => item.id === key.id);
          if (!current?.disabled) current?.onPress?.(event);
        } : undefined,
      })),
      menu: nextRegistration.menu
        ? latestMenuItems(nextRegistration.menu, () => (
          lifetime === lifetimeRef.current ? currentRegistrationRef.current?.menu : undefined
        ))
        : undefined,
    } : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context, language, registrationId, ...deps]);
}

/** Menu items call whatever the newest registration holds under the same id. */
function latestMenuItems(items: ContextMenuItem[], current: () => ContextMenuItem[] | undefined): ContextMenuItem[] {
  const find = (list: ContextMenuItem[] | undefined, id: string): ContextMenuItem | undefined => {
    for (const item of list ?? []) {
      if (item.type === "divider") continue;
      if (item.id === id) return item;
      const nested = find(item.submenu, id);
      if (nested) return nested;
    }
    return undefined;
  };
  return items.map((item) => {
    if (item.type === "divider" || item.type === "role") return item;
    return {
      ...item,
      submenu: item.submenu ? latestMenuItems(item.submenu, current) : undefined,
      onSelect: item.onSelect ? () => {
        const latest = find(current(), item.id);
        if (latest && latest.type !== "divider" && latest.type !== "role" && latest.enabled !== false) {
          return latest.onSelect?.();
        }
      } : undefined,
    };
  });
}

/**
 * Adds entries to the pane menu for actions that have no footer key: a kit
 * table's sort, a query bar filter, a tab's close. Follows the same scoping as
 * the footer, so an inactive tab's items drop out with its hints.
 */
export function usePaneMenuItems(
  registrationId: string,
  factory: () => ContextMenuItem[] | null | undefined,
  deps: DependencyList,
) {
  usePaneFooter(registrationId, () => {
    const menu = factory();
    return menu && menu.length > 0 ? { menu } : null;
  }, deps);
}

export function usePaneHints(
  registrationId: string,
  factory: () => PaneHint[] | null | undefined,
  deps: DependencyList,
) {
  usePaneFooter(registrationId, () => {
    const hints = factory();
    return hints && hints.length > 0 ? { hints } : null;
  }, deps);
}
