import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { KeybindingsConfig } from "../../types/config";
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
