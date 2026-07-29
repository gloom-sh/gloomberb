import {
  createContext,
  useCallback,
  useContext,
  useEffect,
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

const usePaneFooterRegistrationEffect =
  typeof document === "undefined" ? useEffect : useLayoutEffect;

interface PaneFooterContextValue {
  register(registrationId: string, registration: PaneFooterRegistration | null): void;
  unregister(registrationId: string): void;
}

const PaneFooterContext = createContext<PaneFooterContextValue | null>(null);

export function PaneFooterProvider({
  children,
}: {
  children: (footer: CombinedPaneFooter) => ReactNode;
}) {
  const [registrations, setRegistrations] = useState<Map<string, PaneFooterRegistration>>(() => new Map());

  const register = useCallback((registrationId: string, registration: PaneFooterRegistration | null) => {
    setRegistrations((current) => {
      const next = new Map(current);
      if (registration && ((registration.info?.length ?? 0) > 0 || (registration.hints?.length ?? 0) > 0)) {
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

  return (
    <PaneFooterContext.Provider value={value}>
      {children(footer)}
    </PaneFooterContext.Provider>
  );
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

  usePaneFooterRegistrationEffect(() => {
    return () => {
      previousRegistrationRef.current = null;
      context?.unregister(registrationId);
    };
  }, [context, registrationId]);

  usePaneFooterRegistrationEffect(() => {
    if (!context) return;
    const nextRegistration = factory() ?? null;
    if (samePaneFooterRegistration(previousRegistrationRef.current, nextRegistration)) return;
    previousRegistrationRef.current = nextRegistration;
    context.register(registrationId, nextRegistration);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context, language, registrationId, ...deps]);
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
