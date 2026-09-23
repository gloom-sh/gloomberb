import { useThemeColors } from "../../theme/theme-context";
import { Box, ScrollBox, Text, useUiHost } from "../../ui";
import { useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import { TextAttributes, type ScrollBoxRenderable } from "../../ui";
import { hoverBg } from "../../theme/colors";
import { t } from "../../i18n";
import { useRemoteUiNode } from "../../remote/semantic-tree";
import { resolveRemoteItemIndex } from "../../remote/semantic-helpers";
import { isPlainKey, type KeyboardModifierEventLike } from "../../utils/keyboard";

export interface ListViewItem {
  id: string;
  label: string;
  description?: string;
  detail?: string;
  category?: string;
  kind?: string;
  right?: string;
  checked?: boolean;
  current?: boolean;
  disabled?: boolean;
}

export interface ListRowState {
  selected: boolean;
  hovered: boolean;
  disabled: boolean;
}

export interface ListViewProps {
  items: ListViewItem[];
  selectedIndex: number;
  scrollIndex?: number;
  onSelect?: (index: number) => void;
  onActivate?: (item: ListViewItem, index: number) => void;
  renderRow?: (item: ListViewItem, state: ListRowState, index: number) => ReactNode;
  getRowBackgroundColor?: (item: ListViewItem, state: ListRowState, index: number) => string | undefined;
  showSelectedDescription?: boolean;
  emptyMessage?: string;
  bgColor?: string;
  selectedBgColor?: string;
  hoverBgColor?: string;
  rowGap?: number;
  rowHeight?: number;
  surface?: "framed" | "plain";
  height?: number;
  flexGrow?: number;
  scrollable?: boolean;
  selectOnHover?: boolean;
  autoScrollToIndex?: boolean;
  /**
   * The rows are checkboxes (ToggleList). A focused desktop row toggles on
   * Space and leaves Enter to the surface around the list, the way a checkbox
   * leaves Enter to its dialog's default button.
   */
  checkboxRows?: boolean;
  onMouseScroll?: (event: any) => void;
  remoteRole?: string;
  remoteLabel?: string;
  remoteScope?: string;
  remoteItemKind?: string;
  remoteItemCategory?: string;
  remoteMetadata?: Record<string, unknown>;
}

/** Any row object; one with `disabled: true` is stepped over. */
type ListCursorItem = object;

function isDisabledRow(item: ListCursorItem | undefined): boolean {
  return !!item && "disabled" in item && item.disabled === true;
}

/**
 * The row `steps` enabled rows away in `direction`, or the last enabled row
 * before the end. With `wrap`, a step past one end continues from the other.
 * Disabled rows are never landed on.
 */
export function stepListCursor(
  items: readonly ListCursorItem[],
  index: number,
  direction: -1 | 1,
  steps = 1,
  wrap = false,
): number {
  let found = index;
  let remaining = steps;
  let next = index;
  for (let visited = 0; visited < items.length && remaining > 0; visited += 1) {
    next += direction;
    if (next < 0 || next >= items.length) {
      if (!wrap) break;
      next = next < 0 ? items.length - 1 : 0;
    }
    if (isDisabledRow(items[next])) continue;
    found = next;
    remaining -= 1;
  }
  return found;
}

export type ListCursorMove = (items: readonly ListCursorItem[], index: number) => number;

/**
 * How a key moves a list cursor: up/down and k/j one row, PageUp/PageDown a
 * page, Home/End to the first or last row, always skipping disabled rows.
 * Null for any other key, so the caller handles it.
 */
export function listCursorMove(event: KeyboardModifierEventLike, pageSize: number): ListCursorMove | null {
  const page = Math.max(1, Math.floor(pageSize));
  const move = (direction: -1 | 1, steps?: number): ListCursorMove => (items, index) => (
    stepListCursor(items, index, direction, steps ?? items.length)
  );
  if (isPlainKey(event, "up", "k")) return move(-1, 1);
  if (isPlainKey(event, "down", "j")) return move(1, 1);
  if (isPlainKey(event, "pageup")) return move(-1, page);
  if (isPlainKey(event, "pagedown")) return move(1, page);
  if (isPlainKey(event, "home")) return move(-1);
  if (isPlainKey(event, "end")) return move(1);
  return null;
}

function DefaultRow({
  item,
  selected,
}: {
  item: ListViewItem;
  selected: boolean;
}) {
  const colors = useThemeColors();
  // The label gives way to the detail: a long label is cut with an ellipsis
  // instead of wrapping under the row or running into the right column.
  return (
    <Box flexDirection="row" justifyContent="space-between" width="100%" minWidth={0}>
      <Box flexDirection="row" flexShrink={1} minWidth={0} overflow="hidden">
        <Text fg={selected ? colors.selectedText : colors.textDim} flexShrink={0}>
          {selected ? "\u25b8 " : "  "}
        </Text>
        <Text
          fg={selected ? colors.text : colors.textDim}
          attributes={selected ? TextAttributes.BOLD : 0}
          wrapMode="none"
          truncate
          flexShrink={1}
          minWidth={0}
        >
          {t(item.label)}
        </Text>
      </Box>
      {item.detail && (
        <Box flexShrink={0} paddingLeft={1}>
          <Text fg={colors.textMuted}>{t(item.detail)}</Text>
        </Box>
      )}
    </Box>
  );
}

export function ListView({
  items,
  selectedIndex,
  scrollIndex,
  onSelect,
  onActivate,
  renderRow,
  getRowBackgroundColor,
  showSelectedDescription = false,
  emptyMessage = "Nothing to show.",
  bgColor,
  selectedBgColor,
  hoverBgColor,
  rowGap,
  rowHeight,
  surface,
  height,
  flexGrow,
  scrollable = false,
  selectOnHover = false,
  autoScrollToIndex = true,
  checkboxRows,
  onMouseScroll,
  remoteRole = "list",
  remoteLabel,
  remoteScope,
  remoteItemKind,
  remoteItemCategory,
  remoteMetadata,
}: ListViewProps) {
  const colors = useThemeColors();
  useRemoteUiNode({
    role: remoteRole,
    label: remoteLabel ?? emptyMessage,
    actions: {
      select: (input) => {
        const index = resolveListIndex(input, items);
        if (index >= 0 && !items[index]?.disabled) onSelect?.(index);
      },
      activate: (input) => {
        const index = resolveListIndex(input, items);
        const item = index >= 0 ? items[index] : undefined;
        if (item && !item.disabled) {
          onSelect?.(index);
          onActivate?.(item, index);
        }
      },
    },
    metadata: {
      ...remoteMetadata,
      scope: remoteScope,
      selectedIndex,
      items: items.map((item, index) => ({
        index,
        id: item.id,
        label: item.label,
        detail: item.detail,
        category: item.category ?? remoteItemCategory,
        kind: item.kind ?? remoteItemKind,
        right: item.right,
        checked: item.checked,
        current: item.current,
        disabled: item.disabled === true,
      })),
    },
  });
  const HostListView = useUiHost().ListView as ComponentType<ListViewProps> | undefined;
  if (HostListView) {
    return (
      <HostListView
        items={items}
        selectedIndex={selectedIndex}
        scrollIndex={scrollIndex}
        onSelect={onSelect}
        onActivate={onActivate}
        renderRow={renderRow}
        getRowBackgroundColor={getRowBackgroundColor}
        showSelectedDescription={showSelectedDescription}
        emptyMessage={emptyMessage}
        bgColor={bgColor}
        selectedBgColor={selectedBgColor}
        hoverBgColor={hoverBgColor}
        rowGap={rowGap}
        rowHeight={rowHeight}
        surface={surface}
        height={height}
        flexGrow={flexGrow}
        scrollable={scrollable}
        selectOnHover={selectOnHover}
        autoScrollToIndex={autoScrollToIndex}
        checkboxRows={checkboxRows}
        onMouseScroll={onMouseScroll}
        remoteRole={remoteRole}
        remoteLabel={remoteLabel}
        remoteScope={remoteScope}
        remoteItemKind={remoteItemKind}
        remoteItemCategory={remoteItemCategory}
        remoteMetadata={remoteMetadata}
      />
    );
  }

  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  const baseBg = bgColor ?? colors.bg;
  const activeBg = selectedBgColor ?? colors.selected;
  const rowHoverBg = hoverBgColor ?? hoverBg(colors);
  const selectedItem = selectedIndex >= 0 ? items[selectedIndex] : undefined;
  const activeScrollIndex = scrollIndex ?? selectedIndex;
  const terminalRowHeight = rowHeight ?? 1;
  const terminalRowGap = rowGap ?? 0;
  const rowStride = terminalRowHeight + terminalRowGap;

  useEffect(() => {
    if (!scrollable || !autoScrollToIndex || activeScrollIndex < 0) return;
    const sb = scrollRef.current;
    if (!sb) return;
    const safeIndex = Math.min(activeScrollIndex, items.length - 1);
    const viewportH = Math.max(sb.viewport?.height ?? 1, 1);
    const rowTop = safeIndex * rowStride;
    if (rowTop < sb.scrollTop) {
      sb.scrollTo(rowTop);
    } else if (rowTop + terminalRowHeight > sb.scrollTop + viewportH) {
      sb.scrollTo(rowTop + terminalRowHeight - viewportH);
    }
  }, [activeScrollIndex, autoScrollToIndex, items.length, rowStride, scrollable, terminalRowHeight]);

  useEffect(() => {
    if (!scrollable) return;
    const sb = scrollRef.current;
    if (!sb) return;
    if (sb.verticalScrollBar) {
      sb.verticalScrollBar.visible = items.length * rowStride - terminalRowGap > (sb.viewport?.height ?? 0);
    }
  }, [items.length, height, flexGrow, rowStride, scrollable, terminalRowGap]);

  if (items.length === 0) {
    return (
      <Box height={1}>
        <Text fg={colors.textDim}>{t(emptyMessage)}</Text>
      </Box>
    );
  }

  const rows = items.map((item, index) => {
    const selected = index === selectedIndex;
    const hovered = index === hoveredIndex && !selected;
    const disabled = item.disabled === true;
    const state = { selected, hovered, disabled };
    const rowBg = getRowBackgroundColor?.(item, state, index)
      ?? (selected ? activeBg : hovered ? rowHoverBg : baseBg);

    return (
      <Box
        key={item.id}
        height={terminalRowHeight}
        cursor={disabled ? "default" : "pointer"}
        backgroundColor={rowBg}
        onMouseOver={() => {
          if (!disabled) {
            setHoveredIndex((current) => (current === index ? current : index));
            if (selectOnHover) onSelect?.(index);
          }
        }}
        {...(onMouseScroll ? { onMouseScroll } : {})}
        onMouseDown={() => {
          if (disabled) return;
          onSelect?.(index);
          onActivate?.(item, index);
        }}
      >
        {renderRow
          ? renderRow(item, state, index)
          : <DefaultRow item={item} selected={selected} />}
      </Box>
    );
  });

  return (
    <Box flexDirection="column" height={height} flexGrow={flexGrow}>
      {scrollable ? (
        <ScrollBox
          ref={scrollRef}
          height={height}
          flexGrow={flexGrow}
          scrollY
          focusable={false}
          {...(onMouseScroll ? { onMouseScroll } : {})}
        >
          <Box flexDirection="column" gap={terminalRowGap}>{rows}</Box>
        </ScrollBox>
      ) : <Box flexDirection="column" gap={terminalRowGap}>{rows}</Box>}

      {showSelectedDescription && selectedItem?.description && (
        <>
          <Box height={1} />
          <Box>
            <Text fg={colors.textDim}>{"    "}{t(selectedItem.description)}</Text>
          </Box>
        </>
      )}
    </Box>
  );
}

function resolveListIndex(input: unknown, items: ListViewItem[]): number {
  return resolveRemoteItemIndex(input, items, {
    id: (item) => item.id,
    label: (item) => item.label,
  });
}
