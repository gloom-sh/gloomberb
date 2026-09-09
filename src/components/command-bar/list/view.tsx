import { memo, useMemo, type RefObject } from "react";
import { t } from "../../../i18n";
import { useRemoteUiNode } from "../../../remote/semantic-tree";
import { commandBarBadgeText, type CommandBarBadgeTone } from "../../../theme/colors";
import { useThemeColors } from "../../../theme/theme-context";
import type { CommandBarResultLineSegment } from "../../../types/plugin";
import {
  Box,
  ScrollBox,
  Text,
  TextAttributes,
  type ScrollBoxRenderable,
} from "../../../ui";
import { truncateTextSegments } from "../../../utils/format";
import { Spinner } from "../../ui";
import { useCommandBarPalette } from "../panel/palette";
import { getRowPresentation, truncateText } from "../view-model";
import {
  BADGE_COLUMN_WIDTH,
  BADGE_GAP,
  badgeConsumesRight,
  resolveRowBadge,
} from "./badge";
import {
  getListRowsHeight,
  getResultItemLines,
  type CommandBarListRow,
  type ListScreenState,
  type ResultItem,
} from "./model";

export type CommandBarListScrollEvent = {
  stopPropagation: () => void;
  preventDefault: () => void;
  scroll?: { direction?: string; delta?: number };
};

/** Columns every row gives up to the badge column, badge or not. */
const BADGE_INDENT = BADGE_COLUMN_WIDTH + BADGE_GAP;

interface CommandBarListItemRowProps {
  item: ResultItem;
  globalIdx: number;
  isSelected: boolean;
  isHovered: boolean;
  listKind: ListScreenState["kind"];
  listTitle: string;
  listQuery: string;
  contentPadding: number;
  labelWidth: number;
  trailingWidth: number;
  nativePaneChrome: boolean;
  onHoverIndex: (index: number | null) => void;
  onListScroll: (event: CommandBarListScrollEvent) => void;
  onRowMouseDown: (event: any, item: ResultItem, globalIdx: number) => void;
}

const CommandBarListItemRow = memo(function CommandBarListItemRow({
  item,
  globalIdx,
  isSelected,
  isHovered,
  listKind,
  listTitle,
  listQuery,
  contentPadding,
  labelWidth,
  trailingWidth,
  nativePaneChrome,
  onHoverIndex,
  onListScroll,
  onRowMouseDown,
}: CommandBarListItemRowProps) {
  const palette = useCommandBarPalette(nativePaneChrome);
  const presentation = getRowPresentation(item, isSelected, trailingWidth > 0);
  const badge = resolveRowBadge(item);
  // The badge column and its gap come out of the label, so the right column
  // stays where it is for rows with and without a badge alike.
  const labelColumnWidth = Math.max(1, labelWidth - BADGE_INDENT);
  // A long title stops one cell short of the right column, so its ellipsis
  // never runs into the date or shortcut sitting there.
  const label = truncateText(presentation.label, Math.max(1, labelColumnWidth - (trailingWidth > 0 ? 1 : 0)));
  // "current" outranks the shortcut on the right; otherwise a badge lifted from
  // `right` must not be repeated there.
  const trailing = badgeConsumesRight(item) && !item.current
    ? ""
    : truncateText(presentation.trailing, trailingWidth);
  const lineWidth = labelColumnWidth + trailingWidth;
  const lines = useMemo(
    () => getResultItemLines(item).map((line) => truncateTextSegments(
      line.segments,
      lineWidth,
      (ellipsis) => ({ text: ellipsis, emphasis: "muted" as const }),
    )),
    [item, lineWidth],
  );
  const activate = () => onRowMouseDown({
    preventDefault() {},
    stopPropagation() {},
  }, item, globalIdx);
  useRemoteUiNode({
    role: "command-bar-result",
    label: item.label,
    disabled: item.disabled === true,
    actions: {
      activate,
      press: activate,
      secondary: item.secondaryAction ? () => item.secondaryAction?.() : undefined,
    },
    metadata: {
      index: globalIdx,
      selected: isSelected,
      hovered: isHovered,
      listKind,
      listTitle,
      listQuery,
      item: {
        id: item.id,
        label: item.label,
        detail: item.detail,
        category: item.category,
        kind: item.kind,
        right: item.right,
        shortcutQuery: item.shortcutQuery,
        searchText: item.searchText,
        checked: item.checked,
        current: item.current,
        disabled: item.disabled === true,
      },
    },
  });

  return (
    <Box
      key={item.id}
      flexDirection="column"
      height={1 + lines.length}
      paddingX={contentPadding}
      backgroundColor={isSelected
        ? palette.selectedBg
        : isHovered
          ? palette.hoverBg
          : (nativePaneChrome ? palette.panelBg : palette.bg)}
      onMouseOver={() => onHoverIndex(globalIdx)}
      onMouseOut={() => onHoverIndex(null)}
      {...(!nativePaneChrome ? { onMouseScroll: onListScroll } : {})}
      onMouseDown={(event: any) => onRowMouseDown(event, item, globalIdx)}
      data-command-bar-row-selected={nativePaneChrome && isSelected ? "true" : undefined}
      style={nativePaneChrome ? { borderRadius: 6 } : undefined}
    >
      <Box flexDirection="row" height={1}>
        <Box width={BADGE_INDENT} flexDirection="row">
          {badge && <CommandBarRowBadge text={badge.text} tone={badge.tone} width={BADGE_COLUMN_WIDTH} />}
        </Box>
        <Box width={labelColumnWidth}>
          <Text fg={isSelected ? palette.selectedText : presentation.primaryMuted ? palette.subtle : palette.text}>
            {label}
          </Text>
        </Box>
        <Box width={trailingWidth}>
          <Text
            fg={isSelected
              ? palette.selectedText
              : presentation.trailingAccent
                ? palette.accent
                : palette.subtle}
          >
            {trailing}
          </Text>
        </Box>
      </Box>
      {lines.map((segments, index) => (
        <Box
          key={`line:${index}`}
          flexDirection="row"
          height={1}
          width={lineWidth}
          marginLeft={BADGE_INDENT}
          overflow="hidden"
        >
          {segments.map((segment, segmentIndex) => (
            <Text
              key={segmentIndex}
              fg={resolveLineSegmentColor(segment, palette, isSelected)}
              attributes={segment.emphasis === "match" ? TextAttributes.BOLD : TextAttributes.NONE}
            >
              {segment.text}
            </Text>
          ))}
        </Box>
      ))}
    </Box>
  );
});

/**
 * A tag set flush against the label edge in a column padded to the widest tag
 * in the list, so the labels line up and the tags share one right edge. Text
 * only: a filled box would outweigh the label it introduces.
 */
function CommandBarRowBadge({ text, tone, width }: { text: string; tone: CommandBarBadgeTone; width: number }) {
  const themeColors = useThemeColors();
  return (
    <Box width={width} height={1}>
      <Text fg={commandBarBadgeText(tone, themeColors)}>
        {truncateText(text, width).padStart(width, " ")}
      </Text>
    </Box>
  );
}

/**
 * Matched runs keep their highlight on the selected row: the selection colour is
 * what tells you where you are, the match colour is what you were looking for.
 * A muted run (a source lead-in, an ellipsis) steps down one more level than
 * the snippet so it reads as metadata, except on the selected row where the
 * whole line takes the selection text so nothing there goes dim.
 */
function resolveLineSegmentColor(
  segment: CommandBarResultLineSegment,
  palette: ReturnType<typeof useCommandBarPalette>,
  isSelected: boolean,
): string {
  if (segment.emphasis === "match") return palette.match;
  if (isSelected) return palette.selectedText;
  return segment.emphasis === "muted" ? palette.heading : palette.subtle;
}

interface CommandBarListBodyProps {
  visibleListState: ListScreenState;
  nativeListRows: CommandBarListRow[];
  listBodyHeight: number;
  contentPadding: number;
  labelWidth: number;
  nativePaneChrome: boolean;
  nativeListScrollRef: RefObject<ScrollBoxRenderable | null>;
  queryDisplayWidth: number;
  trailingWidth: number;
  onHoverIndex: (index: number | null) => void;
  onListScroll: (event: CommandBarListScrollEvent) => void;
  onRowMouseDown: (event: any, item: ResultItem, globalIdx: number) => void;
}

export const CommandBarListBody = memo(function CommandBarListBody({
  visibleListState,
  nativeListRows,
  listBodyHeight,
  contentPadding,
  labelWidth,
  nativePaneChrome,
  nativeListScrollRef,
  queryDisplayWidth,
  trailingWidth,
  onHoverIndex,
  onListScroll,
  onRowMouseDown,
}: CommandBarListBodyProps) {
  const palette = useCommandBarPalette(nativePaneChrome);
  // Headings, messages and the spinner sit on the label edge: the badge column
  // is a gutter for the rows, not an indent for everything else.
  const labelEdgePadding = contentPadding + BADGE_INDENT;
  const labelEdgeWidth = Math.max(1, queryDisplayWidth - BADGE_INDENT);
  const visibleRows = useMemo(() => {
    const rows = nativeListRows;
    if (nativePaneChrome) return rows;
    const paddedRows = [...rows];
    // Padded in lines, not rows: a multi-line result already fills several.
    let filledLines = getListRowsHeight(rows);
    while (filledLines < listBodyHeight) {
      paddedRows.push({ kind: "filler", id: `filler:${paddedRows.length}` });
      filledLines += 1;
    }
    return paddedRows;
  }, [
    listBodyHeight,
    nativeListRows,
    nativePaneChrome,
  ]);

  const renderedRows = (
    <>
      {visibleRows.map((row) => {
        if (row.kind === "filler" || row.kind === "spacer") {
          return <Box key={row.id} height={1} />;
        }
        if (row.kind === "spinner") {
          return (
            <Box key={row.id} height={1} paddingLeft={labelEdgePadding} paddingRight={contentPadding} {...(!nativePaneChrome ? { onMouseScroll: onListScroll } : {})}>
              <Spinner label={t(row.label)} />
            </Box>
          );
        }
        if (row.kind === "message") {
          return (
            <Box key={row.id} height={1} paddingLeft={labelEdgePadding} paddingRight={contentPadding} {...(!nativePaneChrome ? { onMouseScroll: onListScroll } : {})}>
              <Text fg={palette.text}>{truncateText(t(row.label), labelEdgeWidth)}</Text>
            </Box>
          );
        }
        if (row.kind === "heading") {
          return (
            <Box key={row.id} height={1} paddingLeft={labelEdgePadding} paddingRight={contentPadding} {...(!nativePaneChrome ? { onMouseScroll: onListScroll } : {})}>
              <Text attributes={TextAttributes.BOLD} fg={row.accent ? palette.accent : palette.heading}>
                {truncateText(t(row.label), labelEdgeWidth)}
              </Text>
            </Box>
          );
        }

        const isSelected = row.globalIdx === visibleListState.selectedIdx;
        const isHovered = row.globalIdx === visibleListState.hoveredIdx && !isSelected;
        const itemRowKey = `item:${row.globalIdx}:${row.item.id}:${row.item.category}:${row.item.label}:${row.item.right || ""}`;
        return (
          <CommandBarListItemRow
            key={itemRowKey}
            item={row.item}
            globalIdx={row.globalIdx}
            isSelected={isSelected}
            isHovered={isHovered}
            listKind={visibleListState.kind}
            listTitle={visibleListState.title}
            listQuery={visibleListState.query}
            contentPadding={contentPadding}
            labelWidth={labelWidth}
            trailingWidth={trailingWidth}
            nativePaneChrome={nativePaneChrome}
            onHoverIndex={onHoverIndex}
            onListScroll={onListScroll}
            onRowMouseDown={onRowMouseDown}
          />
        );
      })}
    </>
  );

  return (
    <ScrollBox
      ref={nativeListScrollRef}
      flexDirection="column"
      height={listBodyHeight}
      scrollY
      focusable={false}
      {...(!nativePaneChrome ? { onMouseScroll: onListScroll } : {})}
    >
      {renderedRows}
    </ScrollBox>
  );
});
