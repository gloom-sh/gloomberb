import { matchesNavigationKey, useKeybindings, type ResolvedKeybindings } from "../../app/keybindings";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import type { ScrollBoxRenderable } from "../../ui";
import { useBeforeShortcut, useShortcut } from "../../react/input";
import { isPlainKey, isPlainKeyboardEvent } from "../../utils/keyboard";
import { DataTable, PaneStatusBody, RowNote, type DataTableColumn, type DataTableColumnFit, type DataTableProps, type NoticeProps, type PaneStatusBodyProps } from "../ui";
import { useDataTableSortMenu } from "./sort-menu";
import { useDataTableColumnMenuItems } from "./column-menu";
import { drawnTableColumns, tableFreezesFirstColumn, tableRevealLeft, tableScrollStep } from "../ui/table-layout";
import { useDataTableColumnOrder } from "../ui/data-table/use-column-order";
import {
  TableViewFrame,
  useResetTableScroll,
  useTableBodyScrollActivity,
  useTableViewState,
} from "../table-view-shared";

export interface DataTableKeyEvent {
  name?: string;
  sequence?: string;
  ctrl?: boolean;
  meta?: boolean;
  super?: boolean;
  alt?: boolean;
  option?: boolean;
  shift?: boolean;
  readonly defaultPrevented?: boolean;
  readonly propagationStopped?: boolean;
  preventDefault?: () => void;
  stopPropagation?: () => void;
}

function stopTableKey(event: DataTableKeyEvent) {
  event.stopPropagation?.();
  event.preventDefault?.();
}

const DATA_TABLE_SELECTION_COMMIT_DELAY_MS = 150;

/** The keys that step the cursor: a burst of them is what the commit delay collapses. */
function isCursorStepKey(event: DataTableKeyEvent, bindings: ResolvedKeybindings): boolean {
  return matchesNavigationKey(bindings, "down", event) || matchesNavigationKey(bindings, "up", event)
    || isPlainKey(event, "home", "end", "pageup", "pagedown");
}

/** Shift+Left/Right or Ctrl+Left/Right, with no other modifier. */
function horizontalScrollDirection(event: DataTableKeyEvent): -1 | 0 | 1 {
  if (event.name !== "left" && event.name !== "right") return 0;
  const shiftOnly = event.shift === true && isPlainKeyboardEvent({ ...event, shift: false });
  const ctrlOnly = event.ctrl === true && isPlainKeyboardEvent({ ...event, ctrl: false });
  if (!shiftOnly && !ctrlOnly) return 0;
  return event.name === "left" ? -1 : 1;
}

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

/**
 * What the table's body shows instead of rows while it has none to show: its
 * first page loading after a tab or filter change, a failed load, a state
 * with nothing to list. The same states `PaneStatusBody` draws, in the
 * table's place under `rootBefore`, so the query bar and figures above stay
 * on screen (and a search field keeps its focus) while the body waits.
 */
export type DataTableBodyStatus = Omit<PaneStatusBodyProps, "children" | "width" | "height" | "align">;

function bodyStatusShown(status: DataTableBodyStatus | undefined): status is DataTableBodyStatus {
  return !!status && (!!status.error || status.loading === true || status.empty === true);
}

interface SelectionCommitTarget {
  index: number;
  id?: string;
}

/** The cursor's row to scroll into view, and the first row above it that comes with it. */
interface SelectionScrollTarget {
  index: number;
  from: number;
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
    | "scrollToIndexFrom"
  > {
  focused?: boolean;
  selection: DataTableSelection<T>;
  onActivate?: (item: T, index: number) => void;
  /**
   * Fires immediately as the lightweight visual cursor moves. Expensive detail
   * work and persisted selection belong in selection.onChange, which is
   * coalesced across keyboard repeats and lands before any other key reaches
   * a handler.
   */
  onCursorChange?: (
    item: T,
    index: number,
    reason: DataTableSelectionChangeReason,
  ) => void;
  isNavigable?: (item: T, index: number) => boolean;
  /**
   * A row that goes on from the row above it, as a wrapped description's
   * second line does: pressing it selects (or activates, or opens the menu
   * of) the row it belongs to, as pressing that row's first line does.
   */
  continuesRowAbove?: (item: T, index: number) => boolean;
  rootBefore?: ReactNode;
  rootAfter?: ReactNode;
  /**
   * What concerns one row, said under the table while that row is selected
   * (`RowNote`): the whole reason behind the few words the row shows, such as
   * a name a screen could not price or a peer whose figures are stale. Null
   * for a row with nothing to say. A note about one row never goes in the
   * footer, whose notes are the pane's (docs/pane-conventions.md, Row messages).
   */
  rowNote?: (item: T, index: number) => string | { text: string; tone: NonNullable<NoticeProps["tone"]> } | null | undefined;
  /**
   * Replaces the table (header and rows) with a loading, error or empty
   * state while `rootBefore` stays. Precedence is the caller's, as with
   * `PaneStatusBody`: pass `loading` only while there is nothing to show.
   */
  status?: DataTableBodyStatus;
  rootWidth?: number;
  rootHeight?: number;
  rootBackgroundColor?: string;
  headerScrollRef?: RefObject<ScrollBoxRenderable | null>;
  scrollRef?: RefObject<ScrollBoxRenderable | null>;
  syncHeaderScroll?: () => void;
  onBodyScrollActivity?: DataTableProps<T, C>["onBodyScrollActivity"];
  keyboardNavigation?: boolean;
  /**
   * Offers "Sort by…" in the pane menu while the table is focused. On by
   * default for a table whose headers sort (it has `onHeaderClick`); pass
   * false to leave it out.
   */
  sortable?: boolean;
  /** Leaves columns a header click does not sort (a sparkline) out of "Sort by…". */
  isColumnSortable?: (column: C) => boolean;
  /**
   * Sets the sort outright. Pass it when a header click cycles through an
   * unsorted state, so "Reverse Sort" flips the direction instead.
   */
  onSortChange?: (columnId: string, direction: "asc" | "desc") => void;
  onRootKeyDown?: (
    event: DataTableKeyEvent,
    context: DataTableRootKeyContext,
  ) => boolean | void;
  resetScrollKey?: unknown;
  initialScrollIndex?: number | null;
  /**
   * A column to bring to the middle of a table too wide for its pane: on
   * first draw and whenever it changes. A grid whose reading is in its middle
   * (OVDV's ATM column) opens on it rather than on its left edge.
   */
  revealColumnId?: string | null;
}

function ignoreHeaderClick(): void {}

export function DataTableView<
  T,
  C extends DataTableColumn = DataTableColumn,
>({
  focused = false,
  selection,
  onActivate,
  onCursorChange,
  isNavigable,
  continuesRowAbove,
  rootBefore,
  rootAfter,
  rowNote,
  status,
  rootWidth,
  rootHeight,
  rootBackgroundColor,
  headerScrollRef,
  scrollRef,
  syncHeaderScroll,
  onBodyScrollActivity,
  keyboardNavigation = true,
  sortable,
  isColumnSortable,
  onSortChange,
  onRootKeyDown,
  resetScrollKey,
  revealColumnId,
  scrollToIndex,
  scrollToIndexAlign,
  scrollToIndexVersion = 0,
  initialScrollIndex,
  onVisibleRangeChange,
  ...tableProps
}: DataTableViewProps<T, C>) {
  const onHeaderClick = tableProps.onHeaderClick;
  // Ordered here, so a sideways step and a revealed column count the columns as they are drawn.
  const columnOrder = useDataTableColumnOrder(
    tableProps.columns,
    tableProps.onColumnMove ? false : tableProps.columnReorder,
    { menu: false },
  );
  const columns = columnOrder.columns;
  const onColumnMove = tableProps.onColumnMove ?? columnOrder.onColumnMove;
  const anchoredColumns = tableProps.onColumnMove ? tableProps.anchoredColumns ?? 1 : columnOrder.anchoredColumns;
  const columnItems = useDataTableColumnMenuItems({
    enabled: focused && keyboardNavigation,
    columns,
    anchoredColumns,
    onColumnMove,
    customized: columnOrder.customized,
    reset: columnOrder.reset,
  });
  useDataTableSortMenu({
    enabled: focused && keyboardNavigation && !!onHeaderClick && (sortable ?? true),
    columns: isColumnSortable ? columns.filter(isColumnSortable) : columns,
    sortColumnId: tableProps.sortColumnId ?? null,
    sortDirection: tableProps.sortDirection ?? "asc",
    onHeaderClick: onHeaderClick ?? ignoreHeaderClick,
    onSortChange,
    columnItems,
  });
  const {
    effectiveHeaderScrollRef,
    effectiveScrollRef,
    effectiveSyncHeaderScroll,
  } = useTableViewState({
    headerScrollRef,
    scrollRef,
    syncHeaderScroll,
  });
  const navigation = useKeybindings();
  const [cursorIndex, setCursorIndex] = useState<number | null>(null);
  const pendingCommitRef = useRef(false);
  const pendingCommitTargetRef = useRef<SelectionCommitTarget | null>(null);
  const pendingCommitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const lastKeyboardCommitAtRef = useRef(Number.NEGATIVE_INFINITY);
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
  // The row the cursor last reached by a key. It scrolls into view with the
  // rows straight above it that the cursor passes over (a leading Period end,
  // a section's heading), which no key can reach. A row reached by a press
  // scrolls only itself, so nothing moves under the pointer between clicks.
  const keyboardCursorIndexRef = useRef<number | null>(null);
  const firstRowShownWithRef = useRef((index: number) => index);
  firstRowShownWithRef.current = (index) => {
    if (!isNavigable || index >= tableProps.items.length) return index;
    let first = index;
    while (first > 0 && !isNavigable(tableProps.items[first - 1]!, first - 1)) first -= 1;
    return first;
  };
  const [selectionScrollVersion, setSelectionScrollVersion] = useState(0);
  const [selectionScrollTarget, setSelectionScrollTarget] = useState<SelectionScrollTarget | null>(null);
  const selectionScrollTargetRef = useRef<SelectionScrollTarget | null>(null);
  const lastExternalSelectionScrollRef = useRef<{
    kind: DataTableSelection<T>["kind"];
    key: string | number | null;
    resolved: boolean;
  } | null>(null);
  const lastControlledScrollRequestRef = useRef({
    index: scrollToIndex,
    version: scrollToIndexVersion,
  });
  const controlledScrollRequestChanged = scrollToIndex !== undefined
    && (
      lastControlledScrollRequestRef.current.index !== scrollToIndex
      || lastControlledScrollRequestRef.current.version !== scrollToIndexVersion
    );
  const [restoreIndex, setRestoreIndex] = useState(initialScrollIndex ?? null);
  const restoring = restoreIndex !== null && scrollToIndex == null && selectionScrollTarget === null;
  const reportVisibleRange = useCallback<NonNullable<DataTableProps<T, C>["onVisibleRangeChange"]>>((range) => {
    if (restoring) {
      if (range.end === 0 || (range.start !== restoreIndex && range.end < tableProps.items.length)) return;
      setRestoreIndex(null);
    }
    onVisibleRangeChange?.(range);
  }, [onVisibleRangeChange, restoreIndex, restoring, tableProps.items.length]);
  const selectionScrollActive = !restoring && !controlledScrollRequestChanged && selectionScrollTarget !== null;
  const effectiveScrollToIndex = restoring ? restoreIndex : controlledScrollRequestChanged
    ? scrollToIndex
    : selectionScrollTarget?.index ?? scrollToIndex;

  const requestSelectionScroll = useCallback((index: number) => {
    if (index < 0) return;
    const from = keyboardCursorIndexRef.current === index ? firstRowShownWithRef.current(index) : index;
    const pending = selectionScrollTargetRef.current;
    if (pending?.index === index && pending.from === from) return;
    const scrollBox = effectiveScrollRef.current;
    const viewportHeight = scrollBox?.viewport?.height;
    const scrollTop = scrollBox?.scrollTop;
    if (
      typeof viewportHeight === "number"
      && typeof scrollTop === "number"
      && from >= Math.floor(scrollTop)
      && index < Math.floor(scrollTop) + Math.max(1, Math.floor(viewportHeight))
    ) return;
    const target = { index, from };
    selectionScrollTargetRef.current = target;
    setSelectionScrollTarget(target);
    setSelectionScrollVersion((current) => current + 1);
  }, [effectiveScrollRef]);
  const clearSelectionScrollTarget = useCallback(() => {
    if (selectionScrollTargetRef.current === null) return;
    selectionScrollTargetRef.current = null;
    setSelectionScrollTarget(null);
  }, []);

  useEffect(() => {
    lastControlledScrollRequestRef.current = {
      index: scrollToIndex,
      version: scrollToIndexVersion,
    };
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
    if (restoring || effectiveSelectedIndex < 0) return;

    const selectionChanged = !previous
      || previous.kind !== current.kind
      || previous.key !== current.key;
    const selectedRowAppeared = !previous?.resolved && current.resolved;
    if (selectionChanged || selectedRowAppeared) {
      // An external selection renders before the optimistic cursor's syncing
      // effect commits. Scroll to the new selection, retaining an immediate
      // cursor only while a keyboard navigation commit is still pending.
      requestSelectionScroll(pendingCommitRef.current ? effectiveSelectedIndex : defaultCursorIndex);
    }
  }, [
    clearSelectionScrollTarget,
    defaultCursorIndex,
    effectiveSelectedIndex,
    requestSelectionScroll,
    restoring,
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
    lastKeyboardCommitAtRef.current = performance.now();
    commitTarget(target, reason);
  }, [clearPendingCommit, commitTarget, getCommitTarget]);

  const flushPendingCommit = useCallback(() => {
    if (!pendingCommitRef.current) return;
    const target = pendingCommitTargetRef.current;
    clearPendingCommit();
    lastKeyboardCommitAtRef.current = performance.now();
    commitTarget(target, "keyboard");
  }, [clearPendingCommit, commitTarget]);
  const flushPendingCommitRef = useRef(flushPendingCommit);
  flushPendingCommitRef.current = flushPendingCommit;

  // The delay only coalesces a burst of steps. Any other key acts on the row
  // under the cursor, so a step still waiting commits before the key reaches
  // a handler, which reads the selection the pane holds.
  useBeforeShortcut((event) => {
    if (event.defaultPrevented || event.propagationStopped || isCursorStepKey(event, navigation)) return;
    flushPendingCommitRef.current();
  });

  const scheduleCommitIndex = useCallback((index: number) => {
    if (selection.kind === "none") return;
    const target = getCommitTarget(index);
    if (!target) return;
    // The first step after a pause commits at once, so a follower pane moves
    // with the cursor; steps that follow within the delay collapse into one
    // trailing commit, which is what keeps a held key from firing a load per
    // row.
    if (!pendingCommitRef.current && performance.now() - lastKeyboardCommitAtRef.current >= DATA_TABLE_SELECTION_COMMIT_DELAY_MS) {
      commitIndexImmediately(index, "keyboard");
      return;
    }
    if (pendingCommitTimerRef.current) {
      clearTimeout(pendingCommitTimerRef.current);
    }
    pendingCommitRef.current = true;
    pendingCommitTargetRef.current = target;
    pendingCommitTimerRef.current = setTimeout(() => {
      pendingCommitTimerRef.current = null;
      flushPendingCommitRef.current();
    }, DATA_TABLE_SELECTION_COMMIT_DELAY_MS);
  }, [commitIndexImmediately, getCommitTarget, selection.kind]);

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
    keyboardCursorIndexRef.current = options.commit === "deferred" ? index : null;
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
    // Enter on a collapsible group header does what clicking it does.
    const header = tableProps.renderSectionHeader?.(item, index);
    if (header?.expanded !== undefined && header.onMouseDown) {
      header.onMouseDown({ preventDefault: () => {}, stopPropagation: () => {} });
      return;
    }
    onActivate?.(item, index);
  }, [commitIndexImmediately, isNavigable, onActivate, tableProps.items, tableProps.renderSectionHeader, updateCursorIndex]);

  const selectByOffset = useCallback((offset: number) => {
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

  /** Home and End jump to the ends, PageUp and PageDown by one screen of rows. */
  const selectByJump = useCallback((name: string | undefined): boolean => {
    const total = navigableIndices?.length ?? tableProps.items.length;
    if (total === 0) return false;
    if (name === "home" || name === "end") {
      const edge = name === "home" ? 0 : total - 1;
      updateCursorIndex(navigableIndices ? navigableIndices[edge]! : edge, { commit: "deferred" });
      return true;
    }
    if (name !== "pageup" && name !== "pagedown") return false;
    const page = Math.max(1, Math.floor(effectiveScrollRef.current?.viewport?.height ?? 10) - 1);
    selectByOffset(name === "pageup" ? -page : page);
    return true;
  }, [effectiveScrollRef, navigableIndices, selectByOffset, tableProps.items.length, updateCursorIndex]);

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

  // The row handlers reach the latest cursor logic through a ref, so their
  // identity survives a parent render. Most callers build `selection` inline,
  // which used to give every handler a new identity on each render and made
  // every visible row re-render its cells, even when nothing in it changed.
  // The row a pressed line belongs to: itself, or for a line that goes on from
  // the row above, the first line of that row.
  const ownerIndex = (index: number) => {
    let owner = index;
    while (continuesRowAbove && owner > 0 && owner < tableProps.items.length
      && continuesRowAbove(tableProps.items[owner]!, owner)) owner -= 1;
    return owner;
  };
  const rowHandlerStateRef = useRef({
    activateIndex,
    onRowContextMenu: tableProps.onRowContextMenu,
    onRowMouseDown: tableProps.onRowMouseDown,
    ownerIndex,
    items: tableProps.items,
    updateCursorIndex,
  });
  rowHandlerStateRef.current = {
    activateIndex,
    onRowContextMenu: tableProps.onRowContextMenu,
    onRowMouseDown: tableProps.onRowMouseDown,
    ownerIndex,
    items: tableProps.items,
    updateCursorIndex,
  };

  const handleTableSelect = useCallback((_item: T, index: number) => {
    const latest = rowHandlerStateRef.current;
    latest.updateCursorIndex(latest.ownerIndex(index), { commit: "immediate" });
  }, []);

  const handleTableActivate = useCallback((_item: T, index: number) => {
    const latest = rowHandlerStateRef.current;
    latest.activateIndex(latest.ownerIndex(index));
  }, []);

  const handleRowMouseDown = useCallback((item: T, index: number, event: any) => {
    const latest = rowHandlerStateRef.current;
    const owner = latest.ownerIndex(index);
    const handled = latest.onRowMouseDown?.(latest.items[owner] ?? item, owner, event);
    if (handled === true) {
      latest.updateCursorIndex(owner, { commit: "immediate" });
    }
    return handled;
  }, []);

  const handleRowContextMenu = useCallback((item: T, index: number, event: any) => {
    const latest = rowHandlerStateRef.current;
    const owner = latest.ownerIndex(index);
    latest.updateCursorIndex(owner, { commit: "immediate" });
    latest.onRowContextMenu?.(latest.items[owner] ?? item, owner, event);
  }, []);

  // Wide tables scroll their columns on Shift+Left/Right, the way a chart pans,
  // and on Ctrl+Left/Right where the OS leaves those alone (macOS takes them to
  // switch Spaces). Plain arrows stay with tabs. Scoped so it runs before a tab
  // strip in the same pane, which would otherwise read Shift+Left as Left.
  const horizontalScrollScope = `data-table-columns:${useId()}`;
  // What the table's fit left out for width, and the way back to it (`DataTableProps.columnDropOrder`).
  const columnFitRef = useRef<DataTableColumnFit | null>(null);
  useShortcut((event) => {
    if (event.defaultPrevented || event.propagationStopped || event.targetEditable) return;
    const direction = horizontalScrollDirection(event);
    if (!direction || tableProps.items.length === 0) return;
    const body = effectiveScrollRef.current;
    const viewportWidth = body?.viewport?.width ?? 0;
    const currentLeft = body?.scrollLeft ?? 0;
    const maxLeft = Math.max(0, (body?.scrollWidth ?? 0) - viewportWidth);
    // The step right from a table fitted to its width draws every column as set, scrolled to the first one the
    // fit had left out; the step left from the start of all its columns fits them again.
    const fit = columnFitRef.current;
    if (direction > 0 && fit?.fitted) {
      stopTableKey(event);
      fit.showAll();
      return;
    }
    if (direction < 0 && fit?.all && currentLeft <= 0) {
      stopTableKey(event);
      fit.fit();
      return;
    }
    if (!body || viewportWidth <= 0 || maxLeft <= 0) return;
    // At either edge the key is still the table's, so it never falls through
    // to switch a tab.
    stopTableKey(event);
    // The columns in their order, at the widths the terminal's fit drew them.
    const drawn = drawnTableColumns.get(body) ?? columns;
    const nextLeft = tableScrollStep({
      columns: drawn,
      columnGap: tableProps.columnGap,
      horizontalPadding: tableProps.horizontalPadding,
      frozenFirstColumn: tableFreezesFirstColumn({
        freezeFirstColumn: tableProps.freezeFirstColumn,
        columns: drawn,
        columnGap: tableProps.columnGap,
        horizontalPadding: tableProps.horizontalPadding,
        viewportWidth,
        overflows: true,
      }),
      scrollLeft: currentLeft,
      direction,
      viewportWidth,
      maxLeft,
    });
    if (nextLeft === currentLeft) return;
    body.scrollLeft = nextLeft;
    effectiveSyncHeaderScroll();
  }, {
    enabled: focused && keyboardNavigation && tableProps.showHorizontalScrollbar !== false,
    scope: horizontalScrollScope,
  });

  // The column asked for, in the middle of the scrolled columns once the body has its width. Keyed on the
  // column and the pane's width only: a refresh that resizes a column to its new figures, or a scroll the
  // reader made with Shift+arrows, stays where it is. An empty table waits for its rows.
  const revealColumnIndex = revealColumnId == null ? -1 : columns.findIndex((column) => column.id === revealColumnId);
  const revealKey = revealColumnIndex < 0 ? null : `${revealColumnIndex}:${rootWidth ?? ""}`;
  const revealedKeyRef = useRef<string | null>(null);
  const hasRows = tableProps.items.length > 0;
  useEffect(() => {
    if (revealKey == null || !hasRows || revealedKeyRef.current === revealKey) return;
    /** True once the body is measured and placed, or there is nothing to scroll. */
    const reveal = () => {
      const body = effectiveScrollRef.current;
      const viewportWidth = body?.viewport?.width ?? 0;
      if (!body || viewportWidth <= 0) return false;
      const scrollWidth = body.scrollWidth ?? 0;
      const maxLeft = Math.max(0, scrollWidth - viewportWidth);
      if (maxLeft <= 0) {
        if (scrollWidth > 0) revealedKeyRef.current = revealKey;
        return scrollWidth > 0;
      }
      // The columns in their order, at the widths the terminal's fit drew them.
      const shared = { columns: drawnTableColumns.get(body) ?? columns, columnGap: tableProps.columnGap, horizontalPadding: tableProps.horizontalPadding };
      const nextLeft = tableRevealLeft({ ...shared, columnIndex: revealColumnIndex, viewportWidth, maxLeft,
        frozenFirstColumn: tableFreezesFirstColumn({ ...shared, freezeFirstColumn: tableProps.freezeFirstColumn, viewportWidth, overflows: true }) });
      if (nextLeft !== body.scrollLeft) {
        body.scrollLeft = nextLeft;
        effectiveSyncHeaderScroll();
      }
      revealedKeyRef.current = revealKey;
      return true;
    };
    // The body measures its width a frame or more after it mounts; a few tries, then it stays where it is.
    if (reveal()) return;
    const timers = [0, 50, 150, 400].map((delay) => setTimeout(() => {
      if (reveal()) timers.forEach(clearTimeout);
    }, delay));
    return () => timers.forEach(clearTimeout);
  }, [revealKey, hasRows]);

  useShortcut((event) => {
    if (event.defaultPrevented || event.propagationStopped) return;
    if (!focused || !keyboardNavigation) return;

    if (onRootKeyDown?.(event, {
      selectedIndex: effectiveSelectedIndexRef.current,
      itemCount: tableProps.items.length,
    })) {
      // Handled: nothing later, such as the footer's hint keys, acts on it again.
      event.preventDefault();
      return;
    }
    // Without a cursor there is nothing for these keys to move, so they stay
    // free for the pane scroll keys to scroll the rows.
    if (tableProps.items.length === 0 || selection.kind === "none") return;

    if (matchesNavigationKey(navigation, "down", event)) {
      stopTableKey(event);
      selectByOffset(1);
      return;
    }

    if (matchesNavigationKey(navigation, "up", event)) {
      stopTableKey(event);
      selectByOffset(-1);
      return;
    }

    // Enter activates with or without modifiers.
    if (event.name === "enter" || event.name === "return") {
      stopTableKey(event);
      activateSelection();
      return;
    }

    if (isPlainKeyboardEvent(event) && !event.targetEditable && selectByJump(event.name)) {
      stopTableKey(event);
    }
  });

  // The selected row's note follows the cursor, as the row's highlight does.
  const selectedItem = rowNote && effectiveSelectedIndex >= 0 && !bodyStatusShown(status) ? tableProps.items[effectiveSelectedIndex] : undefined;
  const note = selectedItem !== undefined ? rowNote!(selectedItem, effectiveSelectedIndex) : null;
  const noteView = note ? typeof note === "string" ? <RowNote>{note}</RowNote> : <RowNote tone={note.tone}>{note.text}</RowNote> : null;
  return (
    <TableViewFrame
      width={rootWidth}
      height={rootHeight}
      fit={tableProps.fitRows}
      backgroundColor={rootBackgroundColor}
      before={rootBefore}
      after={noteView ? <>{rootAfter}{noteView}</> : rootAfter}
    >
      {bodyStatusShown(status) ? <PaneStatusBody {...status} /> : <DataTable<T, C>
        {...tableProps}
        columns={columns}
        columnReorder={false}
        onColumnMove={onColumnMove}
        anchoredColumns={anchoredColumns}
        columnFitRef={columnFitRef}
        headerScrollRef={effectiveHeaderScrollRef}
        scrollRef={effectiveScrollRef}
        syncHeaderScroll={effectiveSyncHeaderScroll}
        onBodyScrollActivity={handleBodyScrollActivity}
        onVisibleRangeChange={restoring || onVisibleRangeChange ? reportVisibleRange : undefined}
        scrollToIndex={effectiveScrollToIndex}
        scrollToIndexFrom={selectionScrollActive ? selectionScrollTarget?.from : undefined}
        scrollToIndexAlign={restoring ? "start" : scrollToIndexAlign}
        scrollToIndexVersion={scrollToIndexVersion + selectionScrollVersion}
        isSelected={isItemSelected}
        onSelect={handleTableSelect}
        onActivate={handleTableActivate}
        onRowMouseDown={handleRowMouseDown}
        onRowContextMenu={handleRowContextMenu}
      />}
    </TableViewFrame>
  );
}
