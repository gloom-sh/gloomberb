import { useEffect, useMemo, useRef, useState } from "react";
import type { PluginRegistry } from "../../../../plugins/registry";
import type {
  CommandBarResultDef,
  CommandBarSearchContext,
  CommandBarSearchProvider,
} from "../../../../types/plugin";
import type { ResultItem } from "../../list/model";

const DEFAULT_MIN_QUERY_LENGTH = 3;
const DEFAULT_DEBOUNCE_MS = 300;

export function getAvailableCommandBarSearchProviders(
  pluginRegistry: Pick<PluginRegistry, "commandBarSearchProviders" | "getCommandBarSearchProviderPluginId">,
  disabledPlugins: readonly string[],
): CommandBarSearchProvider[] {
  const disabledPluginIds = new Set(disabledPlugins);
  return [...pluginRegistry.commandBarSearchProviders.values()].filter((provider) => {
    const pluginId = pluginRegistry.getCommandBarSearchProviderPluginId(provider.id);
    return !pluginId || !disabledPluginIds.has(pluginId);
  });
}

/**
 * Turns one provider row into a list row. The command bar owns the row model, so
 * a provider never gets to decide selection, kind, or what closing means.
 */
export function toProviderResultItem(
  provider: CommandBarSearchProvider,
  result: CommandBarResultDef,
  onExecuted: () => void,
): ResultItem {
  return {
    id: `search-provider:${provider.id}:${result.id}`,
    label: result.label,
    detail: result.detail ?? "",
    category: result.category ?? provider.category,
    kind: "action",
    lines: result.lines,
    badge: result.badge,
    right: result.right,
    searchText: [result.label, result.detail ?? "", ...(result.keywords ?? [])].join(" "),
    disabled: result.disabled,
    action: async () => {
      if (result.disabled) return;
      await result.execute();
      onExecuted();
    },
  };
}

interface ProviderResults {
  /** The exact query these rows answer; anything else on screen is stale. */
  query: string;
  items: ResultItem[];
}

interface UseCommandBarSearchProvidersOptions {
  providers: readonly CommandBarSearchProvider[];
  query: string;
  /** False while a route is open or a prefix already claimed the query. */
  enabled: boolean;
  context: CommandBarSearchContext;
  onExecuted: () => void;
}

/**
 * Runs plugin search providers for the root list. Each provider debounces and
 * aborts on its own, answers are memoized for the life of the bar, and rows are
 * only ever added to the static list: a provider that fails, hangs, or answers
 * late leaves what the command bar already resolved exactly as it was.
 */
export function useCommandBarSearchProviders({
  providers,
  query,
  enabled,
  context,
  onExecuted,
}: UseCommandBarSearchProvidersOptions): {
  providerResultItems: ResultItem[];
  providerSearching: boolean;
} {
  const [resultsByProvider, setResultsByProvider] = useState<Record<string, ProviderResults>>({});
  const [loadingProviderIds, setLoadingProviderIds] = useState<readonly string[]>([]);
  const cacheRef = useRef(new Map<string, CommandBarResultDef[]>());
  const timersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const abortsRef = useRef(new Map<string, AbortController>());
  /**
   * Query each provider has already been asked for. Rendered state lags a tick
   * behind, so reading it instead would let a re-render start a second request
   * for text that is already in flight.
   */
  const handledQueriesRef = useRef(new Map<string, string>());
  /** Read at request time only: selecting a ticker is not a new question. */
  const contextRef = useRef(context);
  contextRef.current = context;
  const onExecutedRef = useRef(onExecuted);
  onExecutedRef.current = onExecuted;

  useEffect(() => {
    const trimmed = query.trim();
    const cancel = (providerId: string) => {
      const timer = timersRef.current.get(providerId);
      if (timer) {
        clearTimeout(timer);
        timersRef.current.delete(providerId);
      }
      abortsRef.current.get(providerId)?.abort();
      abortsRef.current.delete(providerId);
      handledQueriesRef.current.delete(providerId);
    };
    const setLoading = (providerId: string, loading: boolean) => {
      setLoadingProviderIds((current) => {
        const isLoading = current.includes(providerId);
        if (loading === isLoading) return current;
        return loading ? [...current, providerId] : current.filter((id) => id !== providerId);
      });
    };
    const publish = (provider: CommandBarSearchProvider, forQuery: string, results: CommandBarResultDef[]) => {
      setResultsByProvider((current) => ({
        ...current,
        [provider.id]: {
          query: forQuery,
          items: results.map((result) => toProviderResultItem(
            provider,
            result,
            () => onExecutedRef.current(),
          )),
        },
      }));
    };

    const activeProviderIds = new Set(providers.map((provider) => provider.id));
    for (const providerId of [...handledQueriesRef.current.keys()]) {
      if (!activeProviderIds.has(providerId)) cancel(providerId);
    }

    for (const provider of providers) {
      const minLength = provider.minQueryLength ?? DEFAULT_MIN_QUERY_LENGTH;
      if (!enabled || trimmed.length < minLength) {
        cancel(provider.id);
        setLoading(provider.id, false);
        continue;
      }
      if (handledQueriesRef.current.get(provider.id) === trimmed) continue;

      cancel(provider.id);
      handledQueriesRef.current.set(provider.id, trimmed);

      const cached = cacheRef.current.get(`${provider.id}\n${trimmed}`);
      if (cached) {
        setLoading(provider.id, false);
        publish(provider, trimmed, cached);
        continue;
      }

      setLoading(provider.id, true);
      timersRef.current.set(provider.id, setTimeout(() => {
        timersRef.current.delete(provider.id);
        const controller = new AbortController();
        abortsRef.current.set(provider.id, controller);
        void (async () => {
          try {
            const results = await provider.provide(trimmed, contextRef.current, controller.signal);
            if (controller.signal.aborted) return;
            cacheRef.current.set(`${provider.id}\n${trimmed}`, results);
            publish(provider, trimmed, results);
          } catch {
            // A provider is an extra, never a precondition: its failure leaves
            // the rows the command bar resolved locally untouched.
            if (controller.signal.aborted) return;
            publish(provider, trimmed, []);
          } finally {
            if (abortsRef.current.get(provider.id) === controller) {
              abortsRef.current.delete(provider.id);
              setLoading(provider.id, false);
            }
          }
        })();
      }, provider.debounceMs ?? DEFAULT_DEBOUNCE_MS));
    }
  }, [enabled, providers, query]);

  useEffect(() => () => {
    for (const timer of timersRef.current.values()) clearTimeout(timer);
    timersRef.current.clear();
    for (const controller of abortsRef.current.values()) controller.abort();
    abortsRef.current.clear();
  }, []);

  const providerResultItems = useMemo(() => {
    const trimmed = query.trim();
    if (!enabled) return [];
    return [...providers]
      .sort((left, right) => (left.priority ?? 0) - (right.priority ?? 0))
      .flatMap((provider) => {
        const results = resultsByProvider[provider.id];
        return results?.query === trimmed ? results.items : [];
      });
  }, [enabled, providers, query, resultsByProvider]);

  const providerSearching = enabled && providers.some((provider) => loadingProviderIds.includes(provider.id));

  return { providerResultItems, providerSearching };
}
