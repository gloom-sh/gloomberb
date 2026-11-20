import { useCallback, useSyncExternalStore, type ReactNode } from "react";
import type { DataTableRowSource } from "./types";

/** A visible row listens only to its own external data. */
export function ObservedTableRow<T>({ item, source, children }: {
  item: T; source: DataTableRowSource<T>; children: (item: T) => ReactNode;
}) {
  const subscribe = useCallback((notify: () => void) => source.subscribe(item, notify), [source, item]);
  const version = useCallback(() => source.version(item), [source, item]);
  useSyncExternalStore(subscribe, version, version);
  return children(source.read(item));
}
