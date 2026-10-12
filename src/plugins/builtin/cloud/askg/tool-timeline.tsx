import { useCallback, useEffect, useMemo, useState } from "react";
import { ActionRow } from "../../../../components/ui/action-row";
import {
  Button,
  DataTableView,
  Icon,
  Prose,
  QueryBar,
  Spinner,
  type DataTableCell,
  type DataTableColumn,
} from "../../../../components";
import { useThemeColors } from "../../../../theme/theme-context";
import { Box, Text, type BoxRenderable } from "../../../../ui";
import { truncateWithEllipsis } from "../../../../utils/text-wrap";
import {
  formatCellValue,
  rowSymbol,
  toolResultTables,
  type ASKGResultTable,
  type ASKGToolRow,
  type ASKGTurn,
} from "./model";
import type { JsonValue } from "./protocol";
import {
  describeToolGroup,
  describeToolRow,
  isScriptRow,
  type ToolDisplayContext,
  type ToolMark,
  type ToolRowView,
} from "./tool-display";

/** Undo a write; not `u`, which installs an app update whenever one is waiting. */
export const UNDO_KEY = "z";

/** More calls than this fold into one line once the answer is in. */
const GROUP_THRESHOLD = 3;

/** Selection id of a turn's folded calls, so the keyboard can land on the fold. */
export function toolGroupId(turnId: string): string {
  return `group:${turnId}`;
}

export function canUndo(row: ASKGToolRow): boolean {
  return !!row.undoToken && (!row.undo || row.undo.status === "available");
}

/**
 * The calls a turn lists. A script that ran is said by its calls' own rows and
 * by the fold; only one that failed or stopped needs a row of its own.
 */
function listedRows(turn: ASKGTurn): ASKGToolRow[] {
  return turn.tools.filter((row) => !(isScriptRow(row) && (row.status === "ok" || row.status === "partial")));
}

/** A finished turn with many calls reads as one line until it is opened. */
function isTurnFolded(turn: ASKGTurn, openGroups: ReadonlySet<string>): boolean {
  if (turn.status === "streaming") return false;
  const calls = turn.tools.filter((row) => !isScriptRow(row));
  return calls.length > GROUP_THRESHOLD && !openGroups.has(toolGroupId(turn.id));
}

/** What j/k walk in one turn: its fold line when folded, else the fold line (if any) and each row. */
export function turnTimelineIds(turn: ASKGTurn, openGroups: ReadonlySet<string>): string[] {
  if (turn.tools.length === 0) return [];
  const groupable = turn.status !== "streaming" && turn.tools.filter((row) => !isScriptRow(row)).length > GROUP_THRESHOLD;
  if (!groupable) return listedRows(turn).map((row) => row.toolCallId);
  if (isTurnFolded(turn, openGroups)) return [toolGroupId(turn.id)];
  return [toolGroupId(turn.id), ...listedRows(turn).map((row) => row.toolCallId)];
}

function ToolMarkView({ mark }: { mark: ToolMark }) {
  const colors = useThemeColors();
  switch (mark) {
    case "running":
      return <Spinner />;
    case "waiting":
      return <Icon name="warning" color={colors.warning} />;
    case "ok":
    case "partial":
      return <Icon name="check" color={colors.textMuted} />;
    case "failed":
      return <Icon name="close" color={colors.negative} />;
    case "stopped":
    case "declined":
      return <Icon name="close" color={colors.textMuted} />;
  }
}

function undoLabel(row: ASKGToolRow): string | null {
  if (row.undo?.status === "running") return "undoing…";
  if (row.undo?.status === "done") return "undone";
  if (row.undo?.status === "failed") return "undo failed";
  return row.undoToken ? "undo" : null;
}

/** Cells the row's fixed parts take: marker, gaps, meta and the mark. */
function fixedRowWidth(view: ToolRowView, indent: number): number {
  return indent + 2 + view.title.length + 3 + (view.meta ? view.meta.length + 2 : 0) + 2;
}

export function ToolTimelineRow({
  row,
  view,
  width,
  indent = 0,
  selected,
  expanded,
  selectedRowRef,
  onPress,
  onUndo,
}: {
  row: ASKGToolRow;
  view: ToolRowView;
  width: number;
  indent?: number;
  selected: boolean;
  expanded: boolean;
  /** Takes the row while it is selected, so the transcript can scroll to it. */
  selectedRowRef: (node: BoxRenderable | null) => void;
  onPress: () => void;
  onUndo: () => void;
}) {
  const colors = useThemeColors();
  const subjectWidth = Math.max(0, width - fixedRowWidth(view, indent));
  const subject = view.subject && subjectWidth >= 6 ? truncateWithEllipsis(view.subject, subjectWidth) : "";
  const undo = undoLabel(row);
  const failed = view.mark === "failed";
  const lineWidth = Math.max(10, width - indent - 2);
  const showDetails = expanded && (view.details.length > 0 || view.arguments.length > 0);
  return (
    <Box ref={selected ? selectedRowRef : undefined} flexDirection="column" paddingLeft={indent}>
      <ActionRow
        label={view.title}
        // Every row keeps the marker, so a running one lines up with the rest.
        expanded={expanded}
        active={selected}
        width={width - indent}
        onPress={onPress}
      >
        {subject ? <Text fg={colors.textDim}>{` ${subject}`}</Text> : null}
        <Box flexGrow={1} />
        {view.meta ? <Text fg={colors.textMuted}>{view.meta}</Text> : null}
        <ToolMarkView mark={view.mark} />
      </ActionRow>
      {view.line && !expanded ? (
        <Box paddingLeft={2} height={1} overflow="hidden">
          <Text fg={failed ? colors.textDim : colors.textMuted}>{truncateWithEllipsis(view.line, lineWidth)}</Text>
        </Box>
      ) : null}
      {showDetails ? (
        <Box flexDirection="column" paddingLeft={2}>
          {view.details.map((detail, index) => (
            <Prose key={index} text={detail} width={lineWidth} color={colors.textDim} figures={false} />
          ))}
          {view.arguments.length > 0 ? (
            <Prose
              text={view.arguments.map(({ label, value }) => `${label}: ${value}`).join(" · ")}
              width={lineWidth}
              color={colors.textMuted}
              figures={false}
            />
          ) : null}
        </Box>
      ) : null}
      {undo ? (
        <Box flexDirection="row" height={1} paddingLeft={2}>
          <Button
            label={undo}
            variant={row.undo?.status === "failed" ? "danger" : "ghost"}
            compact
            disabled={!!row.undo && row.undo.status !== "available"}
            shortcut={selected && canUndo(row) ? UNDO_KEY : undefined}
            onPress={onUndo}
          />
          {row.undo?.note ? <Text fg={colors.textMuted}>{`  ${row.undo.note}`}</Text> : null}
        </Box>
      ) : null}
    </Box>
  );
}

function ToolGroupRow({
  turn,
  width,
  open,
  selected,
  context,
  selectedRowRef,
  onPress,
}: {
  turn: ASKGTurn;
  width: number;
  open: boolean;
  selected: boolean;
  context: ToolDisplayContext;
  selectedRowRef: (node: BoxRenderable | null) => void;
  onPress: () => void;
}) {
  const colors = useThemeColors();
  const group = useMemo(() => describeToolGroup(turn.tools, context), [context, turn.tools]);
  const failed = group.failed > 0 ? `${group.failed} failed` : "";
  const labelWidth = Math.max(8, width - 4 - group.meta.length - (failed ? failed.length + 2 : 0) - 2);
  return (
    <Box ref={selected ? selectedRowRef : undefined} flexDirection="column">
      <ActionRow
        label={truncateWithEllipsis(group.label, labelWidth)}
        expanded={open}
        active={selected}
        width={width}
        onPress={onPress}
      >
        <Box flexGrow={1} />
        {failed ? <Text fg={colors.negative}>{failed}</Text> : null}
        <Text fg={colors.textMuted}>{group.meta}</Text>
      </ActionRow>
    </Box>
  );
}

/**
 * A turn's tool calls as a quiet timeline: one line per call, and a turn with
 * many calls folded into one line once the answer is in.
 */
export function TurnTools({
  turn,
  width,
  context,
  selectedId,
  expandedToolCallId,
  openGroups,
  selectedRowRef,
  onPressRow,
  onPressGroup,
  onUndo,
}: {
  turn: ASKGTurn;
  width: number;
  context: ToolDisplayContext;
  selectedId: string | null;
  expandedToolCallId: string | null;
  openGroups: ReadonlySet<string>;
  selectedRowRef: (node: BoxRenderable | null) => void;
  onPressRow: (toolCallId: string) => void;
  onPressGroup: (groupId: string) => void;
  onUndo: (toolCallId: string) => void;
}) {
  const ids = turnTimelineIds(turn, openGroups);
  if (ids.length === 0) return null;
  const groupId = toolGroupId(turn.id);
  const grouped = ids[0] === groupId;
  const folded = isTurnFolded(turn, openGroups);
  const rows = folded ? [] : listedRows(turn);
  return (
    <Box flexDirection="column" paddingTop={1}>
      {grouped ? (
        <ToolGroupRow
          turn={turn}
          width={width}
          open={!folded}
          selected={selectedId === groupId}
          context={context}
          selectedRowRef={selectedRowRef}
          onPress={() => onPressGroup(groupId)}
        />
      ) : null}
      {rows.map((row) => (
        <ToolTimelineRow
          key={row.toolCallId}
          row={row}
          view={describeToolRow(row, context)}
          width={width}
          indent={grouped ? 2 : 0}
          selected={row.toolCallId === selectedId}
          expanded={row.toolCallId === expandedToolCallId}
          selectedRowRef={selectedRowRef}
          onPress={() => onPressRow(row.toolCallId)}
          onUndo={() => onUndo(row.toolCallId)}
        />
      ))}
    </Box>
  );
}

/**
 * The rows behind an expanded call, under the transcript. The row above says
 * what was read and what is missing; this says it again only in a word, so the
 * table keeps the room.
 */
export function ToolResultDetail({
  row,
  view,
  width,
  height,
  focused,
  canOpenPane,
  openPaneShortcut,
  onOpenSymbol,
  onOpenPane,
}: {
  row: ASKGToolRow;
  view: ToolRowView;
  width: number;
  height: number;
  /** The rows have the keyboard: j/k walk them and Enter opens one. */
  focused: boolean;
  canOpenPane: boolean;
  openPaneShortcut?: string;
  onOpenSymbol: (symbol: string) => void;
  onOpenPane: () => void;
}) {
  const colors = useThemeColors();
  const tables = useMemo<ASKGResultTable[]>(() => toolResultTables(row.result), [row.result]);
  const [tableIndex, setTableIndex] = useState(0);
  const [rowIndex, setRowIndex] = useState(0);
  useEffect(() => {
    setTableIndex(0);
  }, [row.toolCallId]);
  useEffect(() => {
    setRowIndex(0);
  }, [row.toolCallId, tableIndex]);
  const table = tables[Math.min(tableIndex, tables.length - 1)] ?? null;

  const columns = useMemo<DataTableColumn[]>(() => (
    (table?.columns ?? []).map((column) => ({
      id: column.key,
      label: column.header,
      width: column.width ?? Math.max(column.header.length + 2, 10),
      align: column.align === "right" ? "right" : "left",
      flexGrow: 1,
    }))
  ), [table]);

  const renderCell = useCallback((
    item: Record<string, JsonValue>,
    column: DataTableColumn,
  ): DataTableCell => {
    const value = formatCellValue(item[column.id]);
    const symbol = rowSymbol(item);
    return {
      text: value,
      color: symbol && (column.id === "symbol" || column.id === "ticker")
        ? colors.textBright
        : colors.text,
    };
  }, [colors]);

  const headerHeight = 1 + (tables.length > 1 ? 1 : 0);
  const heading = [view.title, view.subject].filter(Boolean).join(" · ");
  return (
    <Box flexDirection="column" flexShrink={0} width={width} height={height}>
      <Box flexDirection="row" height={1} paddingX={1}>
        <Text fg={colors.textDim}>{truncateWithEllipsis(heading, Math.max(10, width - (canOpenPane ? 18 : 2) - view.meta.length - 2))}</Text>
        <Box flexGrow={1} />
        {view.meta ? <Text fg={colors.textMuted}>{`${view.meta}  `}</Text> : null}
        {canOpenPane ? (
          <Button label="Open pane" variant="ghost" compact shortcut={openPaneShortcut} onPress={onOpenPane} />
        ) : null}
      </Box>
      {tables.length > 1 ? (
        <QueryBar
          width={width}
          filters={[{
            id: "section",
            label: "Section",
            inline: true,
            value: String(tableIndex),
            options: tables.map((entry, index) => ({
              value: String(index),
              label: entry.title ?? `Section ${index + 1}`,
            })),
            onChange: (value: string) => setTableIndex(Number(value)),
          }]}
        />
      ) : null}
      {table && table.rows.length > 0 ? (
        <DataTableView<Record<string, JsonValue>>
          focused={focused}
          // A row cursor only while the rows have the keyboard; the pointer
          // opens a row as it always has.
          selection={focused
            ? { kind: "index", selectedIndex: rowIndex, onChange: (index) => setRowIndex(index) }
            : { kind: "none" }}
          rootWidth={width}
          rootHeight={Math.max(3, height - headerHeight)}
          columns={columns}
          items={table.rows}
          sortColumnId={null}
          sortDirection="asc"
          onHeaderClick={() => {}}
          getItemKey={(_item, index) => String(index)}
          renderCell={renderCell}
          onActivate={(item) => {
            const symbol = rowSymbol(item);
            if (symbol) onOpenSymbol(symbol);
          }}
          emptyStateTitle="No rows returned"
        />
      ) : null}
    </Box>
  );
}
