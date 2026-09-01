import { memo, useLayoutEffect, useMemo, useRef, type RefObject } from "react";
import {
  Box,
  Input,
  ScrollBox,
  Text,
  TextAttributes,
  type InputRenderable,
  type ScrollBoxRenderable,
} from "../../../ui";
import { Spinner } from "../../ui";
import { t } from "../../../i18n";
import type { CommandBarResultLineSegment } from "../../../types/plugin";
import { truncateTextSegments } from "../../../utils/format";
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

interface CommandBarListHeaderProps {
  kind: ListScreenState["kind"];
  title: string;
  query: string;
  queryDisplayWidth: number;
  nativePaneChrome: boolean;
  inputBg: string;
  paletteBg: string;
  paletteText: string;
  paletteSubtleText: string;
  cursorColor: string;
  contentPadding: number;
  rootGhostSuffix: string | null;
  rootQueryLength: number;
  rootShortcutFeedback: string | null;
  onQueryChange: (query: string) => void;
}

export const CommandBarListHeader = memo(function CommandBarListHeader({
  kind,
  title,
  query,
  queryDisplayWidth,
  nativePaneChrome,
  inputBg,
  paletteBg,
  paletteText,
  paletteSubtleText,
  cursorColor,
  contentPadding,
  rootGhostSuffix,
  rootQueryLength,
  rootShortcutFeedback,
  onQueryChange,
}: CommandBarListHeaderProps) {
  const inputRef = useRef<InputRenderable | null>(null);

  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input || input.editBuffer.getText() === query) return;
    input.editBuffer.setText?.(query);
    input.setCursorOffset?.(query.length);
  }, [kind, query, title]);

  return (
    <>
      <Box height={1} paddingX={contentPadding}>
        <Box
          width={queryDisplayWidth}
          height={1}
          position="relative"
          backgroundColor={nativePaneChrome ? undefined : inputBg}
          style={nativePaneChrome ? undefined : {
            overflow: "hidden",
          }}
        >
          <Input
            key={`${kind}:${title}`}
            ref={inputRef}
            value={query}
            onInput={onQueryChange}
            placeholder={kind === "root" ? t("Command or plain English…") : title === "Security Description" ? t("Search tickers") : t("Filter")}
            focused
            data-gloom-remote-scope="command-bar"
            data-gloom-remote-surface="command-bar"
            width={nativePaneChrome ? "100%" : queryDisplayWidth}
            backgroundColor={nativePaneChrome ? "transparent" : paletteBg}
            focusedBackgroundColor={nativePaneChrome ? "transparent" : paletteBg}
            textColor={paletteText}
            focusedTextColor={paletteText}
            placeholderColor={paletteSubtleText}
            cursorColor={cursorColor}
          />
          {kind === "root" && rootGhostSuffix && (
            <Box
              position="absolute"
              top={0}
              left={Math.max(0, Math.min(rootQueryLength, queryDisplayWidth - 1))}
              width={Math.max(0, queryDisplayWidth - Math.min(rootQueryLength, queryDisplayWidth - 1))}
              height={1}
            >
              <Text fg={paletteSubtleText}>
                {truncateText(
                  rootGhostSuffix,
                  Math.max(0, queryDisplayWidth - Math.min(rootQueryLength, queryDisplayWidth - 1)),
                )}
              </Text>
            </Box>
          )}
        </Box>
      </Box>
      <Box height={1} paddingX={contentPadding}>
        {kind === "root" && rootShortcutFeedback
          ? (
            <Text fg={paletteSubtleText}>
              {truncateText(rootShortcutFeedback, queryDisplayWidth)}
            </Text>
          )
          : null}
      </Box>
    </>
  );
});

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
  const label = truncateText(presentation.label, labelWidth);
  const trailing = truncateText(presentation.trailing, trailingWidth);
  const lineWidth = labelWidth + trailingWidth;
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
        <Box width={labelWidth}>
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
        <Box key={`line:${index}`} flexDirection="row" height={1} width={lineWidth} overflow="hidden">
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
