export interface PaneRequestChannel<T> {
  /** Delivers to the open panes, or holds the value until one subscribes. */
  request(value: T): void;
  /** Receives later requests, plus the one held for a pane that was not open yet. */
  subscribe(listener: (value: T) => void): () => void;
}

/**
 * Hands a one-shot request to a pane that may not be mounted yet: a command
 * opens the pane and asks it to show a tab, a record, or a question. The value
 * lives only in memory, so unlike pane params it is never saved with the
 * layout and replayed on the next launch.
 */
export function createPaneRequestChannel<T>(): PaneRequestChannel<T> {
  const listeners = new Set<(value: T) => void>();
  let pending: { value: T } | null = null;
  return {
    request(value) {
      if (listeners.size === 0) {
        pending = { value };
        return;
      }
      for (const listener of listeners) listener(value);
    },
    subscribe(listener) {
      listeners.add(listener);
      const held = pending;
      pending = null;
      if (held) listener(held.value);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
