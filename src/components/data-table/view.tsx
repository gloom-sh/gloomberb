import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import type { ScrollBoxRenderable } from "../../ui";
import { useShortcut } from "../../react/input";
import { DataTable, type DataTableColumn, type DataTableProps } from "../ui";
import {
  isNextTableRowKey,
  isPreviousTableRowKey,
  isTableActivationKey,
  stopTableKey,
  TableViewFrame,
  type TableViewKeyEvent,
  useResetTableScroll,
  useTableBodyScrollActivity,
  useTableViewState,
} from "../table-view-shared";

export type DataTableKeyEvent = TableViewKeyEvent;

const DATA_TABLE_SELECTION_COMMIT_DELAY_MS = 150;

export interface DataTableRootKeyContext {
  selectedIndex: number;
  itemCount: number;
}

export type DataTableSelectionChangeReason =
  | "keyboard"
  | "pointer"
  | "activation";

export type DataTableSelection<T> =
  | { kind: "none" }
  | {
      kind: "index";
      selectedIndex: number | null;
      onChange: (
        index: number,
        item: T,
        reason: DataTableSelectionChangeReason,
      ) => void;
    }
  | {
      kind: "id";
      selectedId: string | null;
      getId: (item: T, index: number) => string;
      onChange: (
        id: string,
        item: T,
        index: number,
        reason: DataTableSelectionChangeReason,
      ) => void;
    };

interface SelectionCommitTarget {
  index: number;
  id?: string;
}

export interface DataTableViewProps<
  T,
  C extends DataTableColumn = DataTableColumn,
> extends Omit<
    DataTableProps<T, C>,
    | "headerScrollRef"
    | "scrollRef"
    | "syncHeaderScroll"
    | "onBodyScrollActivity"
    | "isSelected"
    | "onSelect"
    | "onActivate"
  > {
  focused?: boolean;
  selection: DataTableSelection<T>;
  onActivate?: (item: T, index: number) => void;
  /**
   * Fires immediately as the lightweight visual cursor moves. Expensive detail
   * work and persisted selection belong in selection.onChange, which is
   * coalesced across keyboard repeats.
   */
  onCursorChange?: (
    item: T,
    index: number,
    reason: DataTableSelectionChangeReason,
  ) => void;
  isNavigable?: (item: T, index: number) => boolean;
  rootBefore?: ReactNode;
  rootAfter?: ReactNode;
  rootWidth?: number;
  rootHeight?: number;
  rootBackgroundColor?: string;
  headerScrollRef?: RefObject<ScrollBoxRenderable | null>;
  scrollRef?: RefObject<ScrollBoxRenderable | null>;
  syncHeaderScroll?: () => void;
  onBodyScrollActivity?: () => void;
  keyboardNavigation?: boolean;
  onRootKeyDown?: (
    event: DataTableKeyEvent,
    context: DataTableRootKeyContext,
  ) => boolean | void;
  resetScrollKey?: unknown;
}

export function DataTableView<
  T,
  C extends DataTableColumn = DataTableColumn,
>({
  focused = false,
  selection,
  onActivate,
  onCursorChange,
  isNavigable,
  rootBefore,
  rootAfter,
  rootWidth,
  rootHeight,
  rootBackgroundColor,
  headerScrollRef,
  scrollRef,
  syncHeaderScroll,
  onBodyScrollActivity,
  keyboardNavigation = true,
  onRootKeyDown,
  resetScrollKey,
  scrollToIndex,
  scrollToIndexVersion = 0,
  ...tableProps
}: DataTableViewProps<T, C>) {
  const {
    effectiveHeaderScrollRef,
    effectiveScrollRef,
    effectiveSyncHeaderScroll,
  } = useTableViewState({
    headerScrollRef,
    scrollRef,
    syncHeaderScroll,
  });
  const [cursorIndex, setCursorIndex] = useState<number | null>(null);
  const pendingCommitRef = useRef(false);
  const pendingCommitTargetRef = useRef<SelectionCommitTarget | null>(null);
  const pendingCommitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const selectionKey = selection.kind === "id"
    ? selection.selectedId
    : selection.kind === "index"
      ? selection.selectedIndex
      : null;
  const selectedIndexFromSelection = useMemo(() => {
    if (selection.kind === "none") return -1;
    if (selection.kind === "index") {
      const index = selection.selectedIndex;
      return typeof index === "number"
        && index >= 0
        && index < tableProps.items.length
        ? index
        : -1;
    }
    if (selection.selectedId == null) return -1;
    return tableProps.items.findIndex(
      (item, index) => selection.getId(item, index) === selection.selectedId,
    );
  }, [selection, selectionKey, tableProps.items]);
  const navigableIndices = useMemo(() => {
    if (!isNavigable) return null;
    return tableProps.items.reduce<number[]>((indices, item, index) => {
      if (isNavigable(item, index)) indices.push(index);
      return indices;
    }, []);
  }, [isNavigable, tableProps.items]);

  const isValidCursorIndex = useCallback((index: number | null) => {
    if (index == null || index < 0 || index >= tableProps.items.length) {
      return false;
    }
    if (!isNavigable) return true;
    const item = tableProps.items[index];
    return item !== undefined && isNavigable(item, index);
  }, [isNavigable, tableProps.items]);

  const defaultCursorIndex = selection.kind === "none"
    ? -1
    : isValidCursorIndex(selectedIndexFromSelection)
      ? selectedIndexFromSelection
      : navigableIndices
        ? navigableIndices[0] ?? -1
        : tableProps.items.length > 0
          ? 0
          : -1;
  const effectiveSelectedIndex = selection.kind === "none"
    ? -1
    : isValidCursorIndex(cursorIndex)
      ? cursorIndex!
      : defaultCursorIndex;
  const effectiveSelectedIndexRef = useRef(effectiveSelectedIndex);
  effectiveSelectedIndexRef.current = effectiveSelectedIndex;
  const [selectionScrollVersion, setSelectionScrollVersion] = useState(0);
  const [selectionScrollTarget, setSelectionScrollTarget] = useState<number | null>(null);
  const selectionScrollTargetRef = useRef<number | null>(null);
  const lastExternalSelectionScrollRef = useRef<{
    kind: DataTableSelection<T>["kind"];
    key: string | number | null;
    resolved: boolean;
  } | null>(null);
  const effectiveScrollToIndex = selectionScrollTarget ?? scrollToIndex;

  const requestSelectionScroll = useCallback((index: number) => {
    if (index < 0 || selectionScrollTargetRef.current === index) return;
    const scrollBox = effectiveScrollRef.current;
    const viewportHeight = scrollBox?.viewport?.height;
    const scrollTop = scrollBox?.scrollTop;
    if (
      typeof viewportHeight === "number"
      && typeof scrollTop === "number"
      && index >= Math.floor(scrollTop)
      && index < Math.floor(scrollTop) + Math.max(1, Math.floor(viewportHeight))
    ) return;
    selectionScrollTargetRef.current = index;
    setSelectionScrollTarget(index);
    setSelectionScrollVersion((current) => current + 1);
  }, [effectiveScrollRef]);
  const clearSelectionScrollTarget = useCallback(() => {
    if (selectionScrollTargetRef.current === null) return;
    selectionScrollTargetRef.current = null;
    setSelectionScrollTarget(null);
  }, []);

  useEffect(() => {
    if (scrollToIndex === undefined) return;
    clearSelectionScrollTarget();
  }, [clearSelectionScrollTarget, scrollToIndex, scrollToIndexVersion]);

  const clearPendingCommit = useCallback(() => {
    if (pendingCommitTimerRef.current) {
      clearTimeout(pendingCommitTimerRef.current);
      pendingCommitTimerRef.current = null;
    }
    pendingCommitRef.current = false;
    pendingCommitTargetRef.current = null;
    clearSelectionScrollTarget();
  }, [clearSelectionScrollTarget]);

  useEffect(() => {
    if (selection.kind === "none") {
      clearPendingCommit();
      setCursorIndex(null);
      return;
    }
    if (pendingCommitRef.current) return;
    setCursorIndex(defaultCursorIndex >= 0 ? defaultCursorIndex : null);
  }, [
    clearPendingCommit,
    defaultCursorIndex,
    navigableIndices,
    selectedIndexFromSelection,
    selection.kind,
    selectionKey,
    tableProps.items.length,
  ]);

  useEffect(() => () => {
    if (pendingCommitTimerRef.current) {
      clearTimeout(pendingCommitTimerRef.current);
      pendingCommitTimerRef.current = null;
    }
  }, []);

  const handleBodyScrollActivity = useTableBodyScrollActivity({
    onBodyScrollActivity,
    syncHeaderScroll: effectiveSyncHeaderScroll,
  });

  useResetTableScroll({
    headerScrollRef: effectiveHeaderScrollRef,
    scrollRef: effectiveScrollRef,
    resetScrollKey,
  });

  useEffect(() => {
    const current = {
      kind: selection.kind,
      key: selectionKey,
      resolved: selectedIndexFromSelection >= 0,
    };
    const previous = lastExternalSelectionScrollRef.current;
    lastExternalSelectionScrollRef.current = current;

    if (selection.kind === "none") {
      clearSelectionScrollTarget();
      return;
    }
    if (effectiveSelectedIndex < 0) return;

    const selectionChanged = !previous
      || previous.kind !== current.kind
      || previous.key !== current.key;
    const selectedRowAppeared = !previous?.resolved && current.resolved;
    if (selectionChanged || selectedRowAppeared) {
      requestSelectionScroll(effectiveSelectedIndex);
    }
  }, [
    clearSelectionScrollTarget,
    effectiveSelectedIndex,
    requestSelectionScroll,
    scrollToIndex,
    selectedIndexFromSelection,
    selection.kind,
    selectionKey,
  ]);

  const commitIndex = useCallback((
    index: number,
    reason: DataTableSelectionChangeReason,
  ) => {
    if (selection.kind === "none") return;
    if (index < 0 || index >= tableProps.items.length) return;
    const item = tableProps.items[index]!;
    if (isNavigable && !isNavigable(item, index)) return;

    if (selection.kind === "index") {
      selection.onChange(index, item, reason);
      return;
    }

    selection.onChange(selection.getId(item, index), item, index, reason);
  }, [isNavigable, selection, tableProps.items]);
  const commitIndexRef = useRef(commitIndex);

  useEffect(() => {
    commitIndexRef.current = commitIndex;
  }, [commitIndex]);

  const getCommitTarget = useCallback((index: number): SelectionCommitTarget | null => {
    if (selection.kind === "none") return null;
    if (index < 0 || index >= tableProps.items.length) return null;
    const item = tableProps.items[index]!;
    if (isNavigable && !isNavigable(item, index)) return null;
    return selection.kind === "id"
      ? { index, id: selection.getId(item, index) }
      : { index };
  }, [isNavigable, selection, tableProps.items]);

  const commitTarget = useCallback((
    target: SelectionCommitTarget | null,
    reason: DataTableSelectionChangeReason,
  ) => {
    if (!target) return;
    if (selection.kind !== "id" || target.id == null) {
      commitIndexRef.current(target.index, reason);
      return;
    }
    const currentIndex = tableProps.items.findIndex(
      (item, index) => selection.getId(item, index) === target.id,
    );
    if (currentIndex < 0) return;
    commitIndexRef.current(currentIndex, reason);
  }, [selection, tableProps.items]);

  const commitIndexImmediately = useCallback((
    index: number,
    reason: DataTableSelectionChangeReason,
  ) => {
    const target = getCommitTarget(index);
    clearPendingCommit();
    commitTarget(target, reason);
  }, [clearPendingCommit, commitTarget, getCommitTarget]);

  const scheduleCommitIndex = useCallback((index: number) => {
    if (selection.kind === "none") return;
    const target = getCommitTarget(index);
    if (!target) return;
    if (pendingCommitTimerRef.current) {
      clearTimeout(pendingCommitTimerRef.current);
    }
    pendingCommitRef.current = true;
    pendingCommitTargetRef.current = target;
    pendingCommitTimerRef.current = setTimeout(() => {
      pendingCommitTimerRef.current = null;
      pendingCommitRef.current = false;
      const pendingTarget = pendingCommitTargetRef.current;
      pendingCommitTargetRef.current = null;
      clearSelectionScrollTarget();
      commitTarget(pendingTarget, "keyboard");
    }, DATA_TABLE_SELECTION_COMMIT_DELAY_MS);
  }, [clearSelectionScrollTarget, commitTarget, getCommitTarget, selection.kind]);

  const updateCursorIndex = useCallback((
    index: number,
    options: {
      commit: "deferred" | "immediate" | "none";
      reason?: DataTableSelectionChangeReason;
    },
  ) => {
    if (selection.kind === "none") return;
    if (index < 0 || index >= tableProps.items.length) return;
    const item = tableProps.items[index]!;
    if (isNavigable && !isNavigable(item, index)) return;
    const reason = options.reason ?? (options.commit === "deferred"
      ? "keyboard"
      : options.commit === "immediate"
        ? "pointer"
        : "keyboard");
    if (effectiveSelectedIndexRef.current === index) {
      if (options.commit === "immediate") commitIndexImmediately(index, reason);
      return;
    }
    effectiveSelectedIndexRef.current = index;
    setCursorIndex(index);
    onCursorChange?.(item, index, reason);
    if (options.commit === "deferred") {
      requestSelectionScroll(index);
    }
    if (options.commit === "immediate") {
      commitIndexImmediately(index, reason);
    } else if (options.commit === "deferred") {
      scheduleCommitIndex(index);
    }
  }, [
    commitIndexImmediately,
    isNavigable,
    onCursorChange,
    requestSelectionScroll,
    scheduleCommitIndex,
    selection.kind,
    tableProps.items,
  ]);

  const activateIndex = useCallback((index: number) => {
    if (index < 0 || index >= tableProps.items.length) return;
    const item = tableProps.items[index]!;
    if (isNavigable && !isNavigable(item, index)) return;
    updateCursorIndex(index, { commit: "none", reason: "activation" });
    commitIndexImmediately(index, "activation");
    onActivate?.(item, index);
  }, [commitIndexImmediately, isNavigable, onActivate, tableProps.items, updateCursorIndex]);

  const selectByOffset = useCallback((offset: -1 | 1) => {
    if (!navigableIndices) {
      if (tableProps.items.length === 0) return;
      const selectedIndex = effectiveSelectedIndexRef.current;
      const nextIndex = selectedIndex >= 0
        ? Math.max(
            0,
            Math.min(selectedIndex + offset, tableProps.items.length - 1),
          )
        : 0;
      updateCursorIndex(nextIndex, { commit: "deferred" });
      return;
    }
    if (navigableIndices.length === 0) return;
    const currentPosition = navigableIndices.indexOf(effectiveSelectedIndexRef.current);
    const nextPosition = currentPosition >= 0
      ? Math.max(
          0,
          Math.min(currentPosition + offset, navigableIndices.length - 1),
        )
      : 0;
    const nextIndex = navigableIndices[nextPosition];
    if (nextIndex !== undefined) {
      updateCursorIndex(nextIndex, { commit: "deferred" });
    }
  }, [navigableIndices, tableProps.items.length, updateCursorIndex]);

  const activateSelection = useCallback(() => {
    if (!navigableIndices) {
      if (tableProps.items.length === 0) return;
      const selectedIndex = effectiveSelectedIndexRef.current;
      const activationIndex = selectedIndex >= 0
        && selectedIndex < tableProps.items.length
        ? selectedIndex
        : 0;
      activateIndex(activationIndex);
      return;
    }
    if (navigableIndices.length === 0) return;
    const selectedIndex = effectiveSelectedIndexRef.current;
    const selectedIsNavigable = navigableIndices.includes(selectedIndex);
    activateIndex(selectedIsNavigable ? selectedIndex : navigableIndices[0]!);
  }, [activateIndex, navigableIndices, tableProps.items.length]);

  const isItemSelected = useCallback((item: T, index: number) => (
    index === effectiveSelectedIndex
    && (!isNavigable || isNavigable(item, index))
  ), [effectiveSelectedIndex, isNavigable]);

  const handleTableSelect = useCallback((_item: T, index: number) => {
    updateCursorIndex(index, { commit: "immediate" });
  }, [updateCursorIndex]);

  const handleTableActivate = useCallback((_item: T, index: number) => {
    activateIndex(index);
  }, [activateIndex]);

  const handleRowMouseDown = useCallback((item: T, index: number, event: any) => {
    const handled = tableProps.onRowMouseDown?.(item, index, event);
    if (handled === true) {
      updateCursorIndex(index, { commit: "immediate" });
    }
    return handled;
  }, [tableProps.onRowMouseDown, updateCursorIndex]);

  const handleRowContextMenu = useCallback((item: T, index: number, event: any) => {
    updateCursorIndex(index, { commit: "immediate" });
    tableProps.onRowContextMenu?.(item, index, event);
  }, [tableProps.onRowContextMenu, updateCursorIndex]);

  useShortcut((event) => {
    if (event.defaultPrevented || event.propagationStopped) return;
    if (!focused || !keyboardNavigation) return;

    if (onRootKeyDown?.(event, {
      selectedIndex: effectiveSelectedIndexRef.current,
      itemCount: tableProps.items.length,
    })) return;
    if (tableProps.items.length === 0) return;

    if (isNextTableRowKey(event)) {
      stopTableKey(event);
      selectByOffset(1);
      return;
    }

    if (isPreviousTableRowKey(event)) {
      stopTableKey(event);
      selectByOffset(-1);
      return;
    }

    if (isTableActivationKey(event.name)) {
      stopTableKey(event);
      activateSelection();
    }
  });

  return (
    <TableViewFrame
      width={rootWidth}
      height={rootHeight}
      backgroundColor={rootBackgroundColor}
      before={rootBefore}
      after={rootAfter}
    >
      <DataTable<T, C>
        {...tableProps}
        headerScrollRef={effectiveHeaderScrollRef}
        scrollRef={effectiveScrollRef}
        syncHeaderScroll={effectiveSyncHeaderScroll}
        onBodyScrollActivity={handleBodyScrollActivity}
        scrollToIndex={effectiveScrollToIndex}
        scrollToIndexVersion={scrollToIndexVersion + selectionScrollVersion}
        isSelected={isItemSelected}
        onSelect={handleTableSelect}
        onActivate={handleTableActivate}
        onRowMouseDown={handleRowMouseDown}
        onRowContextMenu={handleRowContextMenu}
      />
    </TableViewFrame>
  );
}
