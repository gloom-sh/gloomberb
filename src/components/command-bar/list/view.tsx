import { memo, useMemo, type RefObject } from "react";
import {
  Box,
  ScrollBox,
  Text,
  TextAttributes,
  type ScrollBoxRenderable,
} from "../../../ui";
import { Spinner } from "../../ui";
import { t } from "../../../i18n";
import { commandBarBadgeBg, commandBarBadgeText, type CommandBarBadgeTone } from "../../../theme/colors";
import { useThemeColors } from "../../../theme/theme-context";
import type { CommandBarResultLineSegment } from "../../../types/plugin";
import { truncateTextSegments } from "../../../utils/format";
import {
  BADGE_GAP,
  badgeConsumesRight,
  resolveBadgeColumnWidth,
  resolveRowBadge,
} from "./badge";
import {
  getListRowsHeight,
  getResultItemLines,
  type CommandBarListRow,
  type ListScreenState,
  type ResultItem,
} from "./model";
import { getRowPresentation, truncateText } from "../view-model";
import { useRemoteUiNode } from "../../../remote/semantic-tree";

export type CommandBarListScrollEvent = {
  stopPropagation: () => void;
  preventDefault: () => void;
  scroll?: { direction?: string; delta?: number };
};

interface CommandBarListItemRowProps {
  item: ResultItem;
  globalIdx: number;
  isSelected: boolean;
  isHovered: boolean;
  listKind: ListScreenState["kind"];
  listTitle: string;
  listQuery: string;
  /** Shared by every row of the list so labels line up; 0 when no row has a badge. */
  badgeColumnWidth: number;
  contentPadding: number;
  labelWidth: number;
  trailingWidth: number;
  nativePaneChrome: boolean;
  paletteAccentText: string;
  paletteBg: string;
  paletteHoverBg: string;
  paletteMatchText: string;
  paletteSelectedBg: string;
  paletteSelectedText: string;
  paletteSubtleText: string;
  paletteText: string;
  panelBg: string;
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
  badgeColumnWidth,
  contentPadding,
  labelWidth,
  trailingWidth,
  nativePaneChrome,
  paletteAccentText,
  paletteBg,
  paletteHoverBg,
  paletteMatchText,
  paletteSelectedBg,
  paletteSelectedText,
  paletteSubtleText,
  paletteText,
  panelBg,
  onHoverIndex,
  onListScroll,
  onRowMouseDown,
}: CommandBarListItemRowProps) {
  const presentation = getRowPresentation(item, isSelected, trailingWidth > 0);
  const badge = resolveRowBadge(item);
  // The badge column and its gap come out of the label, so the right column
  // stays where it is for rows with and without a badge alike.
  const badgeIndent = badgeColumnWidth > 0 ? badgeColumnWidth + BADGE_GAP : 0;
  const labelColumnWidth = Math.max(1, labelWidth - badgeIndent);
  const label = truncateText(presentation.label, labelColumnWidth);
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
        ? paletteSelectedBg
        : isHovered
          ? paletteHoverBg
          : (nativePaneChrome ? panelBg : paletteBg)}
      onMouseOver={() => onHoverIndex(globalIdx)}
      onMouseOut={() => onHoverIndex(null)}
      {...(!nativePaneChrome ? { onMouseScroll: onListScroll } : {})}
      onMouseDown={(event: any) => onRowMouseDown(event, item, globalIdx)}
      data-command-bar-row-selected={nativePaneChrome && isSelected ? "true" : undefined}
      style={nativePaneChrome ? { borderRadius: 6 } : undefined}
    >
      <Box flexDirection="row" height={1}>
        {badgeIndent > 0 && (
          <Box width={badgeIndent} flexDirection="row">
            {badge && (
              <CommandBarRowBadge
                text={badge.text}
                tone={badge.tone}
                width={badgeColumnWidth}
              />
            )}
          </Box>
        )}
        <Box width={labelColumnWidth}>
          <Text fg={isSelected ? paletteSelectedText : presentation.primaryMuted ? paletteSubtleText : paletteText}>
            {label}
          </Text>
        </Box>
        <Box width={trailingWidth}>
          <Text
            fg={isSelected
              ? paletteSelectedText
              : presentation.trailingAccent
                ? paletteAccentText
                : paletteSubtleText}
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
          marginLeft={badgeIndent}
          overflow="hidden"
        >
          {segments.map((segment, segmentIndex) => (
            <Text
              key={segmentIndex}
              fg={resolveLineSegmentColor(segment, {
                isSelected,
                paletteMatchText,
                paletteSelectedText,
                paletteSubtleText,
              })}
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
 * A tag with its own background, centred in a column padded to the widest tag
 * in the list. The desktop renderer paints the same coloured box; no cell
 * characters are drawn around it.
 */
function CommandBarRowBadge({ text, tone, width }: { text: string; tone: CommandBarBadgeTone; width: number }) {
  const themeColors = useThemeColors();
  const visible = truncateText(text, width);
  const lead = Math.max(0, Math.floor((width - visible.length) / 2));
  const padded = `${" ".repeat(lead)}${visible}`.padEnd(width, " ");
  return (
    <Box width={width} height={1} backgroundColor={commandBarBadgeBg(tone, themeColors)}>
      <Text fg={commandBarBadgeText(tone, themeColors)} attributes={TextAttributes.BOLD}>
        {padded}
      </Text>
    </Box>
  );
}

/**
 * Matched runs keep their highlight on the selected row: the selection colour is
 * what tells you where you are, the match colour is what you were looking for.
 */
function resolveLineSegmentColor(
  segment: CommandBarResultLineSegment,
  palette: {
    isSelected: boolean;
    paletteMatchText: string;
    paletteSelectedText: string;
    paletteSubtleText: string;
  },
): string {
  if (segment.emphasis === "match") return palette.paletteMatchText;
  return palette.isSelected ? palette.paletteSelectedText : palette.paletteSubtleText;
}

interface CommandBarListBodyProps {
  visibleListState: ListScreenState;
  nativeListRows: CommandBarListRow[];
  listBodyHeight: number;
  contentPadding: number;
  labelWidth: number;
  nativePaneChrome: boolean;
  nativeListScrollRef: RefObject<ScrollBoxRenderable | null>;
  paletteAccentText: string;
  paletteBg: string;
  paletteHeadingText: string;
  paletteHoverBg: string;
  paletteMatchText: string;
  paletteSelectedBg: string;
  paletteSelectedText: string;
  paletteSubtleText: string;
  paletteText: string;
  panelBg: string;
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
  paletteAccentText,
  paletteBg,
  paletteHeadingText,
  paletteHoverBg,
  paletteMatchText,
  paletteSelectedBg,
  paletteSelectedText,
  paletteSubtleText,
  paletteText,
  panelBg,
  queryDisplayWidth,
  trailingWidth,
  onHoverIndex,
  onListScroll,
  onRowMouseDown,
}: CommandBarListBodyProps) {
  const badgeColumnWidth = useMemo(
    () => resolveBadgeColumnWidth(
      nativeListRows.flatMap((row) => (row.kind === "item" ? [row.item] : [])),
    ),
    [nativeListRows],
  );
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
            <Box key={row.id} height={1} paddingX={contentPadding} {...(!nativePaneChrome ? { onMouseScroll: onListScroll } : {})}>
              <Spinner label={t(row.label)} />
            </Box>
          );
        }
        if (row.kind === "message") {
          return (
            <Box key={row.id} height={1} paddingX={contentPadding} {...(!nativePaneChrome ? { onMouseScroll: onListScroll } : {})}>
              <Text fg={paletteText}>{truncateText(t(row.label), queryDisplayWidth)}</Text>
            </Box>
          );
        }
        if (row.kind === "heading") {
          return (
            <Box key={row.id} height={1} paddingX={contentPadding} {...(!nativePaneChrome ? { onMouseScroll: onListScroll } : {})}>
              <Text attributes={TextAttributes.BOLD} fg={row.accent ? paletteAccentText : paletteHeadingText}>
                {truncateText(t(row.label), queryDisplayWidth)}
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
            badgeColumnWidth={badgeColumnWidth}
            contentPadding={contentPadding}
            labelWidth={labelWidth}
            trailingWidth={trailingWidth}
            nativePaneChrome={nativePaneChrome}
            paletteAccentText={paletteAccentText}
            paletteBg={paletteBg}
            paletteHoverBg={paletteHoverBg}
            paletteMatchText={paletteMatchText}
            paletteSelectedBg={paletteSelectedBg}
            paletteSelectedText={paletteSelectedText}
            paletteSubtleText={paletteSubtleText}
            paletteText={paletteText}
            panelBg={panelBg}
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
