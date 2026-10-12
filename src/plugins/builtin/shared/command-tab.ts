import { useEffect, useRef } from "react";
import { usePluginPaneState } from "../../../public/react";
import { usePaneInstance } from "../../../state/app/context";
import type { PaneTemplateDef, PaneTemplateInstanceConfig } from "../../../types/plugin";

/**
 * A command's request (a market, a record), stamped so a later command can ask again: a pane the command reuses
 * sees the newer stamp even when it asks for the same thing.
 */
export function commandRequestParams(params: Record<string, string>): Record<string, string> {
  return { ...params, tabAt: String(Date.now()) };
}

/** A command's request to show one tab, stamped so a later command can ask again. */
export function commandTabParams(tab: string, params?: Record<string, string>): Record<string, string> {
  return commandRequestParams({ ...(params ?? {}), tab });
}

/** The template's pane, with the command's tab written onto the instance. */
function stampCommandTab(instance: PaneTemplateInstanceConfig | null, tab: string): PaneTemplateInstanceConfig | null {
  return instance ? { ...instance, params: commandTabParams(tab, instance.params) } : null;
}

export function withCommandTab(template: PaneTemplateDef, tab: string): PaneTemplateDef {
  const create = template.createInstance;
  return {
    ...template,
    createInstance: (context, options) => {
      const created = create?.(context, options);
      if (!created) return null;
      return created instanceof Promise ? created.then((instance) => stampCommandTab(instance, tab)) : stampCommandTab(created, tab);
    },
  };
}

/**
 * A value a command asked this pane to show, kept in pane state like a choice made in the pane: the stored
 * choice wins until a newer command arrives. `read` takes the value from the command's params, null when the
 * command names none. Another pane's params, such as Ticker Research around a nested tab, are ignored.
 */
export function useCommandValue<T>(
  paneId: string,
  stateKey: string,
  read: (params: Readonly<Record<string, string>>) => T | null,
  fallback: T,
): [T, (next: T) => void] {
  const instance = usePaneInstance();
  const params = instance?.paneId === paneId ? instance.params : undefined;
  const requested = params ? read(params) : null;
  const requestAt = params?.tabAt ?? "";
  const [value, setValue] = usePluginPaneState<T>(stateKey, requested ?? fallback);
  const seen = useRef(requestAt);
  useEffect(() => {
    if (requested === null || requestAt === seen.current) return;
    seen.current = requestAt;
    setValue(requested);
  }, [requestAt, requested, setValue]);
  return [value, setValue];
}

/** The tab a command asked this pane to show, one of `tabs`. */
export function useCommandTab<T extends string>(
  paneId: string,
  stateKey: string,
  tabs: readonly T[],
  fallback: T,
): [T, (next: T) => void] {
  return useCommandValue<T>(paneId, stateKey, (params) => (tabs as readonly string[]).includes(params.tab ?? "") ? params.tab as T : null, fallback);
}
