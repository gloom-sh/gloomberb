import { Box } from "../../ui";
import { TextAttributes, type ScrollBoxRenderable } from "../../ui";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { t } from "../../i18n";
import { useAppLanguage } from "../../i18n/react";
import { formatTimeAgo } from "../../utils/datetime-format";
import { displayWidth } from "../../utils/format";
import { colors } from "../../theme/colors";
import { nextHeaderSort } from "../../utils/sort-values";
import { toTimestampMillis } from "../../utils/timestamp";
import { DataTableStackView } from "../data-table/stack-view";
import { usePaneFooter } from "../layout/pane/footer";
import { usePinnedList } from "../use-pinned-moment";
import type { DataTableKeyEvent, DataTableRootKeyContext } from "../data-table/view";
import {
  activeStackIndex,
  sortIndexedStackRows,
  type IndexedStackRow,
  type StackSortPreference,
} from "../feed-stack-controller";
import type { DataTableCell, DataTableColumn } from "../ui";
import { PaneLinkMenu } from "../ui/external-link";
import { tableColumnWidth } from "../ui/table-layout";
import { DetailReader, type DetailFact } from "../reader/detail-reader";

export interface FeedDataTableItem {
  id: string;
  eyebrow?: string;
  /** A tone for the source cell, such as a form that matters; the text carries the meaning. */
  eyebrowColor?: string;
  title: string;
  /** What an export writes for the title when it differs from the text: its days in ISO where the text puts them first. */
  titleValue?: string;
  timestamp?: Date | string | null;
  detailTitle?: string;
  /** Short lines over the text; the terminal's form of the facts when both are given. */
  detailMeta?: string[];
  /** Label and value pairs the desktop and the web show as a block over the text. */
  detailFacts?: DetailFact[];
  detailBody?: string | null;
  detailNote?: string | null;
}

type DetailColumnId = "time" | "source" | "title";
type DetailColumn = DataTableColumn & { id: DetailColumnId };

type DetailRow = IndexedStackRow<FeedDataTableItem>;

type SortPreference = StackSortPreference<DetailColumnId>;

/**
 * The first column when it is not how long ago each item came in: a list of
 * filings dates each row by the day it was filed (`formatFilingDate`).
 */
export interface FeedDataTableTimeColumn {
  label: string;
  width: number;
  format: (timestamp: Date | string) => string;
  /**
   * Each item's `timestamp` is an instant, to the minute or finer, so the
   * feed follows the tab's pinned crosshair: it selects the newest item out
   * by the pinned moment and mutes the later ones. The default column (how
   * long ago) is one. Leave it unset for a day, such as a filing date: a day
   * cannot say whether it came before a moment in it.
   */
  instant?: boolean;
}

interface FeedDataTableStackViewProps {
  width: number;
  height: number;
  focused: boolean;
  items: FeedDataTableItem[];
  selectedIdx: number;
  onSelect: (index: number) => void;
  rootBefore?: ReactNode;
  rootAfter?: ReactNode;
  onRootKeyDown?: (event: DataTableKeyEvent, context: DataTableRootKeyContext) => boolean | void;
  sourceLabel?: string;
  titleLabel?: string;
  timeColumn?: FeedDataTableTimeColumn;
  emptyStateTitle?: string;
  emptyStateHint?: string;
  isItemRead?: (item: FeedDataTableItem) => boolean;
  onOpenItem?: (item: FeedDataTableItem, index: number) => void;
  /** Controlled open item, for panes that keep it in pane state so it restores and travels with a share. */
  openItemId?: string | null;
  onOpenItemIdChange?: (itemId: string | null) => void;
  scrollRef?: RefObject<ScrollBoxRenderable | null>;
  onBodyScrollActivity?: () => void;
  /** Warms the detail of an item once the cursor rests on its row; see DataTableStackView. */
  prefetchDetail?: (item: FeedDataTableItem, index: number) => void;
}

function timestampValue(item: FeedDataTableItem): number {
  return itemMoment(item) ?? 0;
}

function itemMoment(item: FeedDataTableItem): number | null {
  if (!item.timestamp) return null;
  const timestamp = toTimestampMillis(item.timestamp);
  return Number.isFinite(timestamp) ? timestamp : null;
}

const rowId = (row: DetailRow) => row.item.id;
const rowMoment = (row: DetailRow) => itemMoment(row.item);

/** The item the selection is on, by id, and whether it went out of the list. */
interface KeptSelection {
  index: number;
  id: string | null;
  lost: boolean;
}

/**
 * Where the selection is once the items or the owner's index change. The
 * owner moving the index moves it. In a feed that streams (`streams`), items
 * coming in above it, or going out, leave it on the same item, though its
 * index moves; when its item goes out, it takes the row now in its place, and
 * says the item was `lost`, so a pin can pick the row at the pin instead. A
 * feed that does not stream (filings by day) keeps the owner's index as it
 * is, so an owner that sends a filtered list back to its top gets the top.
 */
function keepSelection(kept: KeptSelection, items: readonly FeedDataTableItem[], index: number, streams: boolean): KeptSelection {
  const id = items[index]?.id ?? null;
  if (!streams || index !== kept.index || kept.id === null) {
    return index === kept.index && id === kept.id && !kept.lost ? kept : { index, id, lost: false };
  }
  if (id === kept.id || items.some((item) => item.id === kept.id)) return kept;
  return { index, id: items[Math.min(index, items.length - 1)]?.id ?? null, lost: true };
}

function compareText(a: string, b: string): number {
  return a.localeCompare(b, "en-US", { sensitivity: "base" });
}

function compareRows(a: DetailRow, b: DetailRow, columnId: DetailColumnId) {
  switch (columnId) {
    case "time":
      return timestampValue(a.item) - timestampValue(b.item);
    case "source":
      return compareText(a.item.eyebrow ?? "", b.item.eyebrow ?? "");
    case "title":
      return compareText(a.item.title, b.item.title);
  }
}

function buildColumns(
  width: number,
  sourceLabel: string,
  titleLabel: string,
  items: FeedDataTableItem[],
  timeColumn: FeedDataTableTimeColumn | undefined,
): DetailColumn[] {
  const timeLabel = timeColumn ? t(timeColumn.label) : t("Time");
  const timeWidth = tableColumnWidth({ width: timeColumn?.width ?? 8, label: timeLabel });
  // Long sources (insider names, publishers) get more room as the pane
  // widens, from 14 cells up to 24; the title keeps its minimum.
  const sourceCap = Math.min(24, Math.max(14, Math.floor(width * 0.18)));
  let longestSource = Math.max(displayWidth(sourceLabel), 6);
  for (const item of items) {
    if (item.eyebrow) longestSource = Math.max(longestSource, displayWidth(item.eyebrow));
  }
  // The table widens a column to fit its header, so budget what it will draw.
  const sourceWidth = tableColumnWidth({ width: Math.min(longestSource, sourceCap), label: sourceLabel });
  const titleWidth = Math.max(
    16,
    width - (timeWidth + 1) - (sourceWidth + 1) - 3,
  );

  return [
    { id: "time", label: timeLabel, width: timeWidth, align: "left" },
    { id: "source", label: sourceLabel, width: sourceWidth, align: "left" },
    { id: "title", label: titleLabel, width: titleWidth, align: "left" },
  ];
}

export function FeedDataTableStackView({
  width,
  height,
  focused,
  items,
  selectedIdx,
  onSelect,
  rootBefore,
  rootAfter,
  onRootKeyDown,
  sourceLabel = "Source",
  titleLabel = "Headline",
  timeColumn,
  emptyStateTitle = "No items.",
  emptyStateHint,
  isItemRead,
  onOpenItem,
  openItemId: controlledOpenItemId,
  onOpenItemIdChange,
  scrollRef,
  onBodyScrollActivity,
  prefetchDetail,
}: FeedDataTableStackViewProps) {
  const language = useAppLanguage();
  const [sortPreference, setSortPreference] = useState<SortPreference>({
    columnId: "time",
    direction: "desc",
  });
  const [localOpenItemId, setLocalOpenItemId] = useState<string | null>(null);
  const controlled = controlledOpenItemId !== undefined;
  const openItemId = controlled ? controlledOpenItemId : localOpenItemId;
  const setOpenItemId = useCallback((itemId: string | null) => {
    if (controlled) onOpenItemIdChange?.(itemId);
    else setLocalOpenItemId(itemId);
  }, [controlled, onOpenItemIdChange]);
  const detailScrollRef = useRef<ScrollBoxRenderable>(null);
  const columns = useMemo(
    () => buildColumns(width, t(sourceLabel), t(titleLabel), items, timeColumn),
    [items, language, sourceLabel, timeColumn, titleLabel, width],
  );
  const sortedRows = useMemo(() => {
    return sortIndexedStackRows(items, sortPreference, compareRows);
  }, [items, sortPreference]);
  // The owner keeps an index; a feed of instants, which streams and follows
  // the tab's pin, keeps the item at it. It moves the owner's index along with
  // the item (below), and the row drawn selected is the item's from the first
  // frame.
  const streams = timeColumn ? timeColumn.instant === true : true;
  const [keptState, setKept] = useState<KeptSelection>(() => ({ index: selectedIdx, id: items[selectedIdx]?.id ?? null, lost: false }));
  let kept = keptState;
  const nextKept = keepSelection(kept, items, selectedIdx, streams);
  if (nextKept !== kept) {
    kept = nextKept;
    setKept(nextKept);
  }
  const keptIdx = kept.id === null ? -1
    : items[selectedIdx]?.id === kept.id ? selectedIdx : items.findIndex((item) => item.id === kept.id);
  const shownIdx = keptIdx >= 0 ? keptIdx : selectedIdx;
  useEffect(() => {
    if (keptIdx >= 0 && keptIdx !== selectedIdx) onSelect(keptIdx);
  }, [keptIdx, onSelect, selectedIdx]);
  const selectedRowIndex = sortedRows.findIndex(
    (row) => row.itemIndex === shownIdx,
  );
  const activeRowIndex = activeStackIndex(sortedRows.length, selectedRowIndex);
  const openItem = useMemo(
    () =>
      openItemId
        ? items.find((item) => item.id === openItemId) ?? null
        : null,
    [items, openItemId],
  );
  const activeOpenItemId = openItem ? openItem.id : null;

  const openRow = useCallback((row: DetailRow | undefined) => {
    if (!row) return;
    onOpenItem?.(row.item, row.itemIndex);
    setOpenItemId(row.item.id);
  }, [onOpenItem, setOpenItemId]);

  // Reading on: the next or previous item opens in place, and the list cursor
  // follows it so Back lands on the last one read.
  const openRowIndex = openItem ? sortedRows.findIndex((row) => row.item.id === openItem.id) : -1;
  const openAdjacent = useCallback((step: 1 | -1) => {
    const row = openRowIndex >= 0 ? sortedRows[openRowIndex + step] : undefined;
    if (!row) return;
    onSelect(row.itemIndex);
    openRow(row);
  }, [onSelect, openRow, openRowIndex, sortedRows]);
  const detailFooterId = `feed-detail:${useId()}`;
  usePaneFooter(detailFooterId, () => (focused && openRowIndex >= 0 ? {
    // After the pane's own hints.
    order: 1,
    hints: [
      { id: "feed-next", key: "n", label: "ext", title: "Next Item", disabled: openRowIndex >= sortedRows.length - 1, onPress: () => openAdjacent(1) },
      { id: "feed-previous", key: "p", label: "rev", title: "Previous Item", disabled: openRowIndex <= 0, onPress: () => openAdjacent(-1) },
    ],
  } : null), [focused, openAdjacent, openRowIndex, sortedRows.length]);

  useEffect(() => {
    // A controlled id may name an item that is still loading; the owner
    // decides when to give it up.
    if (openItemId && !openItem && !controlled) {
      setOpenItemId(null);
    }
  }, [controlled, openItem, openItemId, setOpenItemId]);

  useEffect(() => {
    if (!controlled) onOpenItemIdChange?.(activeOpenItemId);
  }, [activeOpenItemId, controlled, onOpenItemIdChange]);

  useEffect(() => {
    if (keptIdx < 0 && items.length > 0 && selectedIdx >= items.length) {
      onSelect(Math.max(0, items.length - 1));
    }
  }, [items.length, keptIdx, onSelect, selectedIdx]);

  // Items out at an instant follow the tab's pinned crosshair, as the news
  // feeds do: the newest out by then is selected when the pin moves, the
  // later ones read muted. A selected item gone from the feed reads as no
  // selection there, so the pin's row takes its place.
  const selectRow = useCallback((id: string) => {
    const row = sortedRows.find((entry) => entry.item.id === id);
    if (!row) return;
    setKept((current) => (current.lost ? { ...current, lost: false } : current));
    onSelect(row.itemIndex);
  }, [onSelect, sortedRows]);
  const { isAfterPin } = usePinnedList<DetailRow>("feed-table:pin", {
    follows: streams,
    enabled: !openItem,
    rows: sortedRows,
    getId: rowId,
    moment: rowMoment,
    selectedId: kept.lost ? null : kept.id,
    select: selectRow,
  });

  const renderCell = useCallback((
    row: DetailRow,
    column: DetailColumn,
    _index: number,
    rowState: { selected: boolean },
  ): DataTableCell => {
    switch (column.id) {
      case "time":
        return {
          text: row.item.timestamp ? (timeColumn ? timeColumn.format(row.item.timestamp) : formatTimeAgo(row.item.timestamp)) : "",
          color: colors.textDim,
        };
      case "source":
        return {
          text: row.item.eyebrow ?? "",
          color: row.item.eyebrowColor ?? colors.textMuted,
        };
      case "title":
        return {
          text: row.item.title,
          ...(row.item.titleValue !== undefined ? { value: row.item.titleValue } : {}),
          color: colors.text,
          attributes: isItemRead
            ? isItemRead(row.item)
              ? TextAttributes.NONE
              : TextAttributes.BOLD
            : rowState.selected
              ? TextAttributes.BOLD
              : TextAttributes.NONE,
        };
    }
  }, [isItemRead, timeColumn]);

  const detailContent = openItem ? (
    <DetailReader
      ref={detailScrollRef}
      resetScrollKey={openItem.id}
      width={width}
      meta={openItem.detailMeta}
      facts={openItem.detailFacts}
      body={openItem.detailBody}
      note={openItem.detailNote}
    />
  ) : (
    <Box flexGrow={1} />
  );

  return (
    <DataTableStackView<DetailRow, DetailColumn>
      focused={focused}
      detailOpen={!!openItem}
      onBack={() => setOpenItemId(null)}
      detailContent={<PaneLinkMenu>{detailContent}</PaneLinkMenu>}
      detailTitle={openItem ? openItem.detailTitle ?? openItem.title : undefined}
      selection={{
        kind: "index",
        selectedIndex: activeRowIndex,
        onChange: (_index, row) => onSelect(row.itemIndex),
      }}
      onActivate={(row) => openRow(row)}
      prefetchDetail={prefetchDetail ? (row) => prefetchDetail(row.item, row.itemIndex) : undefined}
      rootBefore={rootBefore}
      rootAfter={rootAfter}
      rootWidth={width}
      rootHeight={height}
      onRootKeyDown={onRootKeyDown}
      detailScrollRef={detailScrollRef}
      columns={columns}
      items={sortedRows}
      sortColumnId={sortPreference.columnId}
      sortDirection={sortPreference.direction}
      onHeaderClick={(columnId) =>
        setSortPreference((current) =>
          nextHeaderSort(current, columnId as DetailColumnId, { firstDirection: columnId === "time" ? "desc" : "asc" })
        )}
      getItemKey={(row) => row.item.id}
      renderCell={renderCell}
      isRowMuted={isAfterPin}
      selectedTextOverridesCellColor
      emptyStateTitle={t(emptyStateTitle)}
      emptyStateHint={emptyStateHint}
      showHorizontalScrollbar={false}
      scrollRef={scrollRef}
      onBodyScrollActivity={onBodyScrollActivity}
    />
  );
}
