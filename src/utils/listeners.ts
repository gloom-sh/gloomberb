export interface ListenerSet {
  subscribe(listener: () => void): () => void;
  notify(): void;
}

/** Small subscriber set for `useSyncExternalStore` and module-level change notifications. */
export function createListenerSet(): ListenerSet {
  const listeners = new Set<() => void>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    notify() {
      for (const listener of [...listeners]) listener();
    },
  };
}
