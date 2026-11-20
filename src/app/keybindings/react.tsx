import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import type { KeyEventLike } from "../../react/input";
import type { KeybindingsConfig } from "../../types/config";
import { matchesNavigationKey, type NavigationAction } from "./navigation";
import { resolveKeybindings, type ResolvedKeybindings } from "./resolve";

const KeybindingsContext = createContext<ResolvedKeybindings | null>(null);

let defaultKeybindings: ResolvedKeybindings | null = null;

/** The shipped table, for surfaces rendered outside the app tree such as tests. */
export function getDefaultKeybindings(): ResolvedKeybindings {
  if (!defaultKeybindings) defaultKeybindings = resolveKeybindings(undefined);
  return defaultKeybindings;
}

/** Resolves the config once per change; the app passes the result down and into its own hooks. */
export function useResolvedKeybindings(
  config: KeybindingsConfig | undefined,
  host?: "terminal" | "desktop",
): ResolvedKeybindings {
  return useMemo(() => resolveKeybindings(config, { host }), [config, host]);
}

export function KeybindingsProvider({
  value,
  children,
}: {
  value: ResolvedKeybindings;
  children: ReactNode;
}) {
  return <KeybindingsContext value={value}>{children}</KeybindingsContext>;
}

export function useKeybindings(): ResolvedKeybindings {
  return useContext(KeybindingsContext) ?? getDefaultKeybindings();
}

export function useNavigationKey(): (action: NavigationAction, event: KeyEventLike, options?: { allowEditable?: boolean }) => boolean {
  const bindings = useKeybindings();
  return useCallback((action, event, { allowEditable } = {}) => (
    matchesNavigationKey(bindings, action, event, { allowEditable })
  ), [bindings]);
}
