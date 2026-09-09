import { useThemeColors } from "../../theme/theme-context";
import { Box, ScrollBox, Text, useUiHost } from "../../ui";
import { useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import { TextAttributes, type ScrollBoxRenderable } from "../../ui";
import { hoverBg } from "../../theme/colors";
import { t } from "../../i18n";
import { useRemoteUiNode } from "../../remote/semantic-tree";
import { resolveRemoteItemIndex } from "../../remote/semantic-helpers";

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
  onMouseScroll?: (event: any) => void;
  remoteRole?: string;
  remoteLabel?: string;
  remoteScope?: string;
  remoteItemKind?: string;
  remoteItemCategory?: string;
  remoteMetadata?: Record<string, unknown>;
}

function DefaultRow({
  item,
  selected,
}: {
  item: ListViewItem;
  selected: boolean;
}) {
  const colors = useThemeColors();
  return (
    <Box flexDirection="row" justifyContent="space-between" width="100%">
      <Box flexDirection="row">
        <Text fg={selected ? colors.selectedText : colors.textDim}>
          {selected ? "\u25b8 " : "  "}
        </Text>
        <Text
          fg={selected ? colors.text : colors.textDim}
          attributes={selected ? TextAttributes.BOLD : 0}
        >
          {t(item.label)}
        </Text>
      </Box>
      {item.detail && (
        <Text fg={selected ? colors.textMuted : colors.textMuted}>{t(item.detail)}</Text>
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
