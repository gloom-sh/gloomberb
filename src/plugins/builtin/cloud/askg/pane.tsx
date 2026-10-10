import { CLOUD_PLAN_KEY } from "../../shared/cloud-upgrade";
import { ActionRow } from "../../../../components/ui/action-row";
import { getCurrentPluginTarget } from "../../../current-target";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { apiClient } from "../../../../api-client";
import {
  Box,
  ScrollBox,
  Text,
  TextAttributes,
  useUiCapabilities,
  type BoxRenderable,
  type ScrollBoxRenderable,
  type TextareaRenderable,
} from "../../../../ui";
import {
  Button,
  ChoiceDialog,
  DataTableView,
  EmptyState,
  getPaneSidebarWidth,
  IconButton,
  MessageComposer,
  Prose,
  QueryBar,
  shouldShowPaneSidebar,
  Spinner,
  usePaneFooter,
  type DataTableCell,
  type DataTableColumn,
  type PaneHint,
} from "../../../../components";
import { MarkdownText } from "../../../../components/markdown-text";
import { useShortcut } from "../../../../react/input";
import {
  useAppDispatch,
  useAppGetState,
  useAppSelector,
  usePaneAppConfig,
} from "../../../../state/app/context";
import { useInlineTickers } from "../../../../state/hooks/inline-tickers";
import { useRemoteControlHandler } from "../../../../remote/app-host";
import { colors } from "../../../../theme/colors";
import type { PaneProps } from "../../../../types/plugin";
import { collectUniqueTickerSymbols } from "../../../../tickers/tokenizer";
import { countEscapeTowardClose } from "../../../../utils/double-escape-close";
import { isPlainKey } from "../../../../utils/keyboard";
import { truncateWithEllipsis } from "../../../../utils/text-wrap";
import { usePluginAppActions, usePluginTickerActions } from "../../../runtime";
import { usePlanAccess } from "../../../../api-client/plan-access";
import { SignInWall } from "../auth-actions";
import { afterLayout, revealInScrollBox } from "../../../../components/ui/reveal-in-scroll-box";
import { ASKGSessionController, type ASKGControllerManifest } from "./controller";
import {
  createASKGRendererToolExecutor,
  loadASKGClientManifest,
  resolveToolPaneTarget,
} from "./host";
import {
  askgConversationLabel,
  askgConversationListStore,
} from "./conversation-store";
import { confirmDialog } from "../../../../components/ui/confirm-dialog";
import { useDialog, type PromptContext } from "../../../../ui/dialog";
import { subscribeASKGQuestions } from "./pending-question";
import { buildASKGUserData } from "./user-data";
import { ASKGConversationSidebar } from "./sidebar";
import { ASKGUndoManager } from "./undo";
import {
  activeTurn,
  canRateTurn,
  canRetryASKGError,
  describeASKGError,
  describeToolStatus,
  formatCellValue,
  isTurnRunning,
  pendingConfirmation,
  rowSymbol,
  toolResultTables,
  toolRowHeadline,
  type ASKGConversationState,
  type ASKGResultTable,
  type ASKGToolRow,
  type ASKGTurn,
  type ASKGTurnFeedback,
} from "./model";
import type { ASKGFeedbackRating, ASKGFeedbackReason, JsonValue } from "./protocol";

export const ASKG_PANE_ID = "askg";

const CLIENT_VERSION = "1";
const MIN_DETAIL_HEIGHT = 8;

function clientKind(): "tui" | "desktop" | "web" {
  const target = getCurrentPluginTarget();
  return target === "web" || target === "desktop" ? target : "tui";
}

function tierLabel(row: ASKGToolRow): string | null {
  if (row.writeTier === "read") return null;
  if (row.writeTier === "ui-write") return "layout";
  if (row.writeTier === "user-data") return "your data";
  return "broker";
}

function statusColor(row: ASKGToolRow): string {
  switch (row.status) {
    case "ok":
      return colors.textDim;
    case "partial":
    case "awaiting-confirmation":
      return colors.warning;
    case "error":
    case "timeout":
      return colors.negative;
    case "denied":
    case "cancelled":
      return colors.textMuted;
    default:
      return colors.textDim;
  }
}

function previewLines(preview: JsonValue | undefined): string[] {
  if (preview == null) return [];
  if (typeof preview === "string") return preview.split("\n");
  if (typeof preview === "number" || typeof preview === "boolean") return [String(preview)];
  if (Array.isArray(preview)) return preview.map((entry) => formatCellValue(entry));
  return Object.entries(preview).map(([key, value]) => `${key}: ${formatCellValue(value)}`);
}

/** Undo a write; not `u`, which installs an app update whenever one is waiting. */
const UNDO_KEY = "z";

/** Upgrade from a Pro-only answer, on the key every Pro prompt uses. */
const UPGRADE_KEY = CLOUD_PLAN_KEY;

function canUndo(row: ASKGToolRow): boolean {
  return !!row.undoToken && (!row.undo || row.undo.status === "available");
}

/** Rate the answer the keyboard is on: the selected one, else the latest. */
const GOOD_ANSWER_KEY = "g";
const BAD_ANSWER_KEY = "b";
/** Send the answer a thumbs down is open on. */
const SHARE_ANSWER_KEY = "s";

/** `hint` is the footer's short form; the row and the pane menu say it in full. */
const FEEDBACK_REASONS: ReadonlyArray<{ reason: ASKGFeedbackReason; label: string; hint: string; title: string; key: string }> = [
  { reason: "wrong", label: "Wrong", hint: "wrong", title: "Reason: Wrong", key: "1" },
  { reason: "slow", label: "Too slow", hint: "slow", title: "Reason: Too Slow", key: "2" },
  { reason: "missing_data", label: "Missing data", hint: "missing", title: "Reason: Missing Data", key: "3" },
  { reason: "other", label: "Other", hint: "other", title: "Reason: Other", key: "4" },
];

/** Exactly what the send carries, and what it never does. */
const SHARE_DISCLOSURE = "Sends your question, this answer and which tools ran. Never your account data, positions or tool results.";

/** True when the only thing that changed between two transcripts is a rating. */
function onlyFeedbackChanged(previous: readonly ASKGTurn[], next: readonly ASKGTurn[]): boolean {
  if (previous === next || previous.length !== next.length) return false;
  return previous.every((turn, index) => {
    const other = next[index];
    if (!other) return false;
    if (turn === other) return true;
    const { feedback: _before, ...rest } = turn;
    const { feedback: _after, ...otherRest } = other;
    return (Object.keys(rest) as Array<keyof typeof rest>).every((key) => rest[key] === otherRest[key]);
  });
}

/** The timeline stop an answer's rating sits on, beside the tool rows. */
function answerStopId(turnId: string): string {
  return `answer:${turnId}`;
}

/**
 * The rating under a finished answer: two quiet thumbs, and after a thumbs
 * down the reasons and the one action that sends the answer, with a line that
 * says what goes and what never does. Keys show beside the thumbs on the
 * answer the keyboard would rate.
 */
function AnswerFeedback({
  feedback,
  width,
  keysShown,
  followUpOpen,
  selected,
  selectedRowRef,
  onRate,
  onReason,
  onShare,
}: {
  feedback: ASKGTurnFeedback | undefined;
  width: number;
  /** This is the answer `g` and `b` rate. */
  keysShown: boolean;
  followUpOpen: boolean;
  selected: boolean;
  selectedRowRef: (node: BoxRenderable | null) => void;
  onRate: (rating: ASKGFeedbackRating) => void;
  onReason: (reason: ASKGFeedbackReason) => void;
  onShare: () => void;
}) {
  const rating = feedback?.rating ?? null;
  const sharing = feedback?.pending === "share";
  return (
    <Box ref={selected ? selectedRowRef : undefined} flexDirection="column" paddingTop={1}>
      <Box flexDirection="row" height={1} alignItems="center">
        <IconButton
          icon="thumbs-up"
          label="Good answer"
          shortcut={keysShown ? GOOD_ANSWER_KEY : undefined}
          pressed={rating === "up"}
          onPress={() => onRate("up")}
        />
        {keysShown ? <Text fg={colors.textMuted}>{`${GOOD_ANSWER_KEY} `}</Text> : null}
        <IconButton
          icon="thumbs-down"
          label="Bad answer"
          shortcut={keysShown ? BAD_ANSWER_KEY : undefined}
          pressed={rating === "down"}
          onPress={() => onRate("down")}
        />
        {keysShown ? <Text fg={colors.textMuted}>{BAD_ANSWER_KEY}</Text> : null}
        {feedback?.shared ? <Text fg={colors.textMuted}>{"  Sent to Gloom"}</Text> : null}
      </Box>
      {followUpOpen ? (
        <Box flexDirection="column" paddingLeft={1}>
          <Box flexDirection="row" flexWrap="wrap">
            {FEEDBACK_REASONS.map((entry) => (
              <Box key={entry.reason} flexDirection="row" height={1} marginRight={2}>
                <Button
                  label={entry.label}
                  variant="ghost"
                  compact
                  active={feedback?.reason === entry.reason}
                  shortcut={entry.key}
                  onPress={() => onReason(entry.reason)}
                />
              </Box>
            ))}
          </Box>
          <Box flexDirection="row" height={1}>
            <Button
              label={sharing ? "Sending\u2026" : "Send this answer to Gloom"}
              variant="secondary"
              compact
              disabled={sharing}
              shortcut={SHARE_ANSWER_KEY}
              onPress={onShare}
            />
          </Box>
          <Prose
            text={feedback?.shareFailed ? "Could not send: Gloom no longer has this answer." : SHARE_DISCLOSURE}
            width={Math.max(10, width - 1)}
            color={colors.textMuted}
            figures={false}
          />
        </Box>
      ) : null}
    </Box>
  );
}

export function ToolTimelineRow({
  row,
  width,
  selected,
  expanded,
  selectedRowRef,
  onSelect,
  onToggle,
  onUndo,
}: {
  row: ASKGToolRow;
  width: number;
  selected: boolean;
  expanded: boolean;
  /** Takes the row while it is selected, so the transcript can scroll to it. */
  selectedRowRef: (node: BoxRenderable | null) => void;
  onSelect: () => void;
  onToggle: () => void;
  onUndo: () => void;
}) {
  const hasRows = row.result !== undefined;
  const marker = hasRows ? (expanded ? "▾" : "▸") : "·";
  const tier = tierLabel(row);
  const status = describeToolStatus(row);
  const { label, summary } = toolRowHeadline(row);
  const undoLabel = row.undo?.status === "running"
    ? "undoing…"
    : row.undo?.status === "done"
      ? "undone"
      : row.undo?.status === "failed"
        ? "undo failed"
        : row.undoToken
          ? "undo"
          : null;
  // The row lays its parts out with a one-cell gap between each: marker, name,
  // "  " + summary, spacer, tier, status, server mark. A summary that leaves no
  // room for them pushes the row onto two lines, over the note below it.
  const parts = [marker, label, "  ", "", ...(tier ? [`${tier}  `] : []), status, ...(row.origin === "server" ? [" · Gloom"] : [])];
  const fixedWidth = parts.reduce((total, part) => total + part.length, 0) + parts.length;
  const summaryWidth = Math.max(6, width - fixedWidth);

  return (
    <Box ref={selected ? selectedRowRef : undefined} flexDirection="column">
      <ActionRow
        label={label}
        expanded={hasRows ? expanded : undefined}
        active={selected}
        width={width}
        onPress={() => { onSelect(); onToggle(); }}
      >
        {summary ? (
          <Text fg={colors.textDim}>{`  ${truncateWithEllipsis(summary, summaryWidth)}`}</Text>
        ) : null}
        <Box flexGrow={1} />
        {tier ? <Text fg={row.writeTier === "ui-write" ? colors.textMuted : colors.warning}>{`${tier}  `}</Text> : null}
        {row.status === "running" || row.status === "pending" ? (
          <Spinner label={status} />
        ) : (
          <Text fg={statusColor(row)}>{status}</Text>
        )}
        {row.origin === "server" ? <Text fg={colors.textMuted}> · Gloom</Text> : null}
      </ActionRow>
      {undoLabel ? (
        <Box flexDirection="row" height={1} paddingLeft={2}>
          <Button
            label={undoLabel}
            variant={row.undo?.status === "failed" ? "danger" : "ghost"}
            compact
            disabled={!!row.undo && row.undo.status !== "available"}
            shortcut={selected && canUndo(row) ? UNDO_KEY : undefined}
            onPress={onUndo}
          />
          {row.undo?.note ? <Text fg={colors.textMuted}>{`  ${row.undo.note}`}</Text> : null}
        </Box>
      ) : null}
      {row.note && row.status !== "ok" ? (
        <Box flexDirection="column" paddingLeft={2}>
          <Prose
            text={row.note}
            width={Math.max(10, width - 3)}
            color={statusColor(row)}
            figures={false}
          />
        </Box>
      ) : null}
    </Box>
  );
}

/** Rows the confirmation block reserves for the dry run preview. */
const MAX_PREVIEW_LINES = 4;

function confirmationBlockHeight(row: ASKGToolRow): number {
  return 3 + Math.min(MAX_PREVIEW_LINES, previewLines(row.preview).length);
}

function ConfirmationPrompt({
  row,
  width,
  onApprove,
  onDecline,
}: {
  row: ASKGToolRow;
  width: number;
  onApprove: () => void;
  onDecline: () => void;
}) {
  const lines = previewLines(row.preview).slice(0, MAX_PREVIEW_LINES);
  return (
    <Box
      flexDirection="column"
      flexShrink={0}
      paddingX={1}
      height={confirmationBlockHeight(row)}
      backgroundColor={colors.panel}
    >
      <Box flexDirection="row" height={1}>
        <Text fg={colors.warning} attributes={TextAttributes.BOLD}>{`Approve ${row.name}?`}</Text>
        <Text fg={colors.textDim}>
          {`  writes ${tierLabel(row) ?? "data"}${row.argumentSummary ? ` · ${row.argumentSummary}` : ""}`}
        </Text>
      </Box>
      {lines.map((line, index) => (
        <Box key={index} height={1}>
          <Text fg={colors.text}>{truncateWithEllipsis(line, Math.max(10, width - 2))}</Text>
        </Box>
      ))}
      <Box flexDirection="row" height={2} paddingTop={1}>
        <Button label="Approve" variant="primary" shortcut="y" onPress={onApprove} />
        <Box width={2} />
        <Button label="Decline" shortcut="n" onPress={onDecline} />
      </Box>
    </Box>
  );
}

function ToolResultDetail({
  row,
  width,
  height,
  focused,
  openPaneShortcut,
  onOpenSymbol,
  onOpenPane,
}: {
  row: ASKGToolRow;
  width: number;
  height: number;
  /** The rows have the keyboard: j/k walk them and Enter opens one. */
  focused: boolean;
  openPaneShortcut?: string;
  onOpenSymbol: (symbol: string) => void;
  onOpenPane: () => void;
}) {
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
  const paneTarget = useMemo(() => resolveToolPaneTarget(row.name), [row.name]);

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
  }, []);

  const headerHeight = 1 + (tables.length > 1 ? 1 : 0);
  // The timeline row above already names the tool and its arguments, so the
  // detail header carries what the row cannot: shape, size, and cost.
  const metadata = [
    table?.title,
    row.rowCount !== undefined ? `${row.rowCount} ${row.rowCount === 1 ? "row" : "rows"}` : null,
    row.elapsedMs !== undefined ? `${row.elapsedMs}ms` : null,
    row.truncated ? "truncated" : null,
  ].filter(Boolean).join(" · ");
  return (
    <Box flexDirection="column" flexShrink={0} width={width} height={height}>
      <Box flexDirection="row" height={1} paddingX={1}>
        <Text fg={colors.textDim}>
          {truncateWithEllipsis(metadata, Math.max(10, width - 16))}
        </Text>
        <Box flexGrow={1} />
        {paneTarget ? (
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
      ) : (
        <Box paddingX={1}>
          <Text fg={colors.textMuted}>{row.note ?? "This tool returned no rows."}</Text>
        </Box>
      )}
    </Box>
  );
}

function TurnView({
  turn,
  width,
  selectedStopId,
  expandedToolCallId,
  selectedRowRef,
  latest,
  rateable,
  feedbackKeysShown,
  feedbackFollowUpOpen,
  catalog,
  openTicker,
  onSelectTool,
  onToggleTool,
  onUndo,
  onRetry,
  onUpgrade,
  onRate,
  onReason,
  onShare,
}: {
  turn: ASKGTurn;
  width: number;
  /** A tool call id, or the answer's own stop. */
  selectedStopId: string | null;
  expandedToolCallId: string | null;
  selectedRowRef: (node: BoxRenderable | null) => void;
  /** The last turn: its Retry and Upgrade answer the pane's keys. */
  latest: boolean;
  /** The answer shows the rating control. */
  rateable: boolean;
  feedbackKeysShown: boolean;
  feedbackFollowUpOpen: boolean;
  catalog: ReturnType<typeof useInlineTickers>["catalog"];
  openTicker: (symbol: string) => void;
  onSelectTool: (toolCallId: string) => void;
  onToggleTool: (toolCallId: string) => void;
  onUndo: (toolCallId: string) => void;
  onRetry: () => void;
  onUpgrade: () => void;
  onRate: (rating: ASKGFeedbackRating) => void;
  onReason: (reason: ASKGFeedbackReason) => void;
  onShare: () => void;
}) {
  return (
    <Box flexDirection="column" paddingTop={1}>
      <Prose
        text={turn.prompt}
        width={width}
        color={colors.textBright}
        figures={false}
        attributes={TextAttributes.BOLD}
      />
      {turn.tools.length > 0 ? (
        <Box flexDirection="column" paddingTop={1}>
          {turn.tools.map((row) => (
            <ToolTimelineRow
              key={row.toolCallId}
              row={row}
              width={width}
              selected={row.toolCallId === selectedStopId}
              expanded={row.toolCallId === expandedToolCallId}
              selectedRowRef={selectedRowRef}
              onSelect={() => onSelectTool(row.toolCallId)}
              onToggle={() => onToggleTool(row.toolCallId)}
              onUndo={() => onUndo(row.toolCallId)}
            />
          ))}
        </Box>
      ) : null}
      {turn.answer ? (
        <Box paddingTop={1}>
          <MarkdownText
            text={turn.answer}
            lineWidth={width}
            catalog={catalog}
            textColor={colors.text}
            openTicker={openTicker}
          />
        </Box>
      ) : turn.status === "streaming" && turn.tools.length === 0 ? (
        <Box paddingTop={1}><Spinner label="Gloom is thinking…" /></Box>
      ) : null}
      {rateable ? (
        <AnswerFeedback
          feedback={turn.feedback}
          width={width}
          keysShown={feedbackKeysShown}
          followUpOpen={feedbackFollowUpOpen}
          selected={selectedStopId === answerStopId(turn.id)}
          selectedRowRef={selectedRowRef}
          onRate={onRate}
          onReason={onReason}
          onShare={onShare}
        />
      ) : null}
      {turn.error ? (
        <Box flexDirection="column" paddingTop={1}>
          {/* A failure that loses its tail tells the user nothing, so it wraps
              rather than running off the edge of the pane. */}
          <Prose
            text={describeASKGError(turn.error)}
            width={width}
            color={colors.negative}
            figures={false}
          />
          {turn.error.code === "tier_required" ? (
            <Box paddingTop={1}>
              <Button label="Upgrade to Pro" variant="primary" shortcut={latest ? UPGRADE_KEY : undefined} onPress={onUpgrade} />
            </Box>
          ) : canRetryASKGError(turn.error) ? (
            <Box paddingTop={1}>
              <Button label="Retry" variant="primary" shortcut={latest ? "r" : undefined} onPress={onRetry} />
            </Box>
          ) : null}
        </Box>
      ) : null}
    </Box>
  );
}

export function ASKGPane({ paneId, focused, width, height }: PaneProps) {
  const { nativePaneChrome } = useUiCapabilities();
  const dispatch = useAppDispatch();
  const planAccess = usePlanAccess();
  const remoteHandler = useRemoteControlHandler();
  const config = usePaneAppConfig();
  const activeSymbol = useAppSelector((state) => state.recentTickers[0] ?? null);
  const { pinTicker } = usePluginTickerActions();
  const { createPaneFromTemplate, showPane, openCommandBar } = usePluginAppActions();
  const dialog = useDialog();

  const configRef = useRef(config);
  configRef.current = config;
  const remoteHandlerRef = useRef(remoteHandler);
  remoteHandlerRef.current = remoteHandler;
  const contextRef = useRef({ symbol: activeSymbol, paneId });
  contextRef.current = { symbol: activeSymbol, paneId };
  // Read when a question is sent, so portfolio and ticker changes do not re-render the pane.
  const getAppState = useAppGetState();
  const getAppStateRef = useRef(getAppState);
  getAppStateRef.current = getAppState;

  // Each call and each undo gets a fresh executor, so the tokens live here:
  // an executor's own manager would forget them as soon as its call returned.
  const undoManager = useMemo(() => new ASKGUndoManager((request) => {
    const handler = remoteHandlerRef.current;
    if (!handler) return Promise.reject(new Error("This window cannot undo tool calls."));
    return handler(request);
  }), []);

  const controller = useMemo(() => new ASKGSessionController({
    transport: apiClient.askg,
    loadManifest: () => loadASKGClientManifest(),
    getExecutor: (manifest: ASKGControllerManifest) => {
      const handler = remoteHandlerRef.current;
      if (!handler) return null;
      return createASKGRendererToolExecutor({
        config: configRef.current,
        remoteHandler: handler,
        manifest: {
          tools: manifest.tools,
          manifestHash: manifest.manifestHash,
          skipped: [],
        },
        undoManager,
      });
    },
    client: { kind: clientKind(), version: CLIENT_VERSION },
    getContext: () => {
      const state = getAppStateRef.current();
      const userData = buildASKGUserData({
        config: state.config,
        brokerAccounts: state.brokerAccounts,
        tickers: state.tickers.values(),
      });
      return {
        ...(contextRef.current.symbol ? { symbol: contextRef.current.symbol } : {}),
        paneId: contextRef.current.paneId,
        ...(userData ? { userData } : {}),
      };
    },
  }), [undoManager]);

  useEffect(() => () => controller.dispose(), [controller]);

  const state: ASKGConversationState = useSyncExternalStore(
    useCallback((listener) => controller.subscribe(listener), [controller]),
    useCallback(() => controller.getState(), [controller]),
    useCallback(() => controller.getState(), [controller]),
  );

  const [inputValue, setInputValue] = useState("");
  const [inputFocused, setInputFocused] = useState(false);
  // A tool row's call id, or an answer's rating (`answerStopId`).
  const [selectedStopId, setSelectedStopId] = useState<string | null>(null);
  const [expandedToolCallId, setExpandedToolCallId] = useState<string | null>(null);
  // The answer whose thumbs down shows its reasons and the send action.
  const [feedbackFollowUpTurnId, setFeedbackFollowUpTurnId] = useState<string | null>(null);
  const inputRef = useRef<TextareaRenderable | null>(null);
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const [queuedQuestion, setQueuedQuestion] = useState<string | null>(null);
  const [sidebarFocused, setSidebarFocused] = useState(false);
  // The row the keyboard is on while the sidebar has focus. Arrows move it and
  // Enter opens it, so walking the list does not load a transcript per keypress.
  const [sidebarCursorId, setSidebarCursorId] = useState<string | null>(null);
  // The expanded result's rows have the keyboard: j/k walk them and Enter
  // opens one. x moves in, Esc comes back to the timeline.
  const [resultFocused, setResultFocused] = useState(false);

  const conversations = useSyncExternalStore(
    useCallback((listener) => askgConversationListStore.subscribe(listener), []),
    useCallback(() => askgConversationListStore.getSnapshot(), []),
    useCallback(() => askgConversationListStore.getSnapshot(), []),
  );

  useEffect(() => {
    if (!planAccess.emailVerified) return;
    askgConversationListStore.useTransport(apiClient.askg);
    askgConversationListStore.ensureLoaded();
  }, [planAccess.emailVerified]);

  // The same gate chat uses: at least two things to switch between, in a pane
  // wide enough to spare the width. One conversation is the one on screen.
  const showSidebar = shouldShowPaneSidebar(
    conversations.conversations.length,
    width,
    height,
  );
  const sidebarWidth = showSidebar
    ? getPaneSidebarWidth(width, !!nativePaneChrome, conversations.width)
    : 0;

  const running = isTurnRunning(state);
  const confirmation = pendingConfirmation(state);
  const timelineRows = useMemo(
    () => state.turns.flatMap((turn) => turn.tools),
    [state.turns],
  );
  // What j/k walk: each turn's tool rows, then its answer's rating.
  const timelineStops = useMemo(
    () => state.turns.flatMap((turn) => [
      ...turn.tools.map((row) => ({ id: row.toolCallId, turnId: turn.id, row })),
      ...(canRateTurn(state, turn) ? [{ id: answerStopId(turn.id), turnId: turn.id, row: null }] : []),
    ]),
    [state],
  );
  const expandedRow = useMemo(
    () => timelineRows.find((row) => row.toolCallId === expandedToolCallId) ?? null,
    [expandedToolCallId, timelineRows],
  );
  // The last question is the one a retry would repeat; an older failure is
  // already history the user moved past.
  const retryableTurn = useMemo(() => {
    const turn = activeTurn(state);
    if (!turn || turn.status !== "error" || !turn.error) return null;
    return canRetryASKGError(turn.error) ? turn : null;
  }, [state]);
  const needsUpgrade = useMemo(() => {
    const turn = activeTurn(state);
    return turn?.status === "error" && turn.error?.code === "tier_required";
  }, [state]);

  const ask = useCallback((question: string) => {
    const trimmed = question.trim();
    if (!trimmed) return;
    void controller.ask(trimmed);
  }, [controller]);

  const openConversation = useCallback(async (conversationId: string) => {
    if (conversationId === state.conversationId) return;
    const conversation = await apiClient.askg.loadConversation(conversationId);
    // A row the sidebar still shows may be gone; the refresh drops it.
    if (!conversation) {
      void askgConversationListStore.refresh();
      return;
    }
    setSelectedStopId(null);
    setExpandedToolCallId(null);
    setFeedbackFollowUpTurnId(null);
    controller.openConversation(conversation);
  }, [controller, state.conversationId]);

  const newConversation = useCallback(() => {
    setSelectedStopId(null);
    setExpandedToolCallId(null);
    setFeedbackFollowUpTurnId(null);
    controller.startConversation();
  }, [controller]);

  // A transcript has no undo, so it is never one click from gone.
  const deleteConversation = useCallback(async (conversationId: string): Promise<boolean> => {
    const row = conversations.conversations.find(
      (conversation) => conversation.id === conversationId,
    );
    const label = row ? askgConversationLabel(row) : "this conversation";
    const confirmed = await confirmDialog(dialog, {
      title: "Delete conversation",
      body: [`Delete "${label}"? This cannot be undone.`],
      confirmLabel: "Delete conversation",
      width: 48,
    });
    if (!confirmed) return false;
    if (conversationId === state.conversationId) controller.startConversation();
    void askgConversationListStore.delete(conversationId);
    return true;
  }, [controller, conversations.conversations, dialog, state.conversationId]);

  const focusInput = useCallback(() => {
    setInputFocused(true);
    dispatch({ type: "SET_INPUT_CAPTURED", captured: true });
    inputRef.current?.focus?.();
  }, [dispatch]);

  const blurInput = useCallback(() => {
    setInputFocused(false);
    dispatch({ type: "SET_INPUT_CAPTURED", captured: false });
  }, [dispatch]);

  useEffect(() => {
    if (!focused && inputFocused) blurInput();
  }, [blurInput, focused, inputFocused]);

  useEffect(() => () => {
    dispatch({ type: "SET_INPUT_CAPTURED", captured: false });
  }, [dispatch]);

  // A question typed at the command bar, either opening this pane or landing
  // in the conversation already open here.
  useEffect(() => subscribeASKGQuestions(setQueuedQuestion), []);

  useEffect(() => {
    // The restored cloud session arrives after the first render, so a question
    // that beat it waits instead of being dropped.
    if (!queuedQuestion || !planAccess.emailVerified) return;
    setQueuedQuestion(null);
    ask(queuedQuestion);
  }, [ask, planAccess.emailVerified, queuedQuestion]);

  // A rating changes a turn but not what was said, so it leaves the view on
  // the answer being rated instead of pulling it to the newest one.
  const scrolledTurnsRef = useRef(state.turns);
  useEffect(() => {
    const previous = scrolledTurnsRef.current;
    scrolledTurnsRef.current = state.turns;
    if (onlyFeedbackChanged(previous, state.turns)) return;
    const scroll = scrollRef.current;
    if (!scroll?.viewport) return;
    scroll.scrollTo({ x: 0, y: Math.max(0, scroll.scrollHeight - scroll.viewport.height) });
  }, [state.turns]);

  // A conversation the platform just opened belongs in the sidebar straight
  // away, titled by the question that opened it.
  useEffect(() => {
    if (!state.conversationId) return;
    const first = state.turns[0];
    askgConversationListStore.note(
      state.conversationId,
      first?.prompt?.trim() ? first.prompt : null,
    );
  }, [state.conversationId]);

  // The stored title and message count only settle once the turn is recorded,
  // so the list is reread exactly when one finishes.
  const wasRunningRef = useRef(false);
  useEffect(() => {
    const finished = wasRunningRef.current && !running;
    wasRunningRef.current = running;
    if (finished) void askgConversationListStore.refresh();
  }, [running]);

  // A list that shrank below the point of switching leaves nothing to focus.
  useEffect(() => {
    if (!showSidebar && sidebarFocused) {
      setSidebarFocused(false);
      setSidebarCursorId(null);
    }
  }, [showSidebar, sidebarFocused]);

  // The answer that follows a question owns the keyboard (cancel, the tool
  // rows, retry), so sending leaves the composer; Enter comes back to it.
  const submitInput = useCallback(() => {
    const value = inputRef.current?.editBuffer.getText() ?? inputValue;
    const trimmed = value.trim();
    if (!trimmed) return;
    setInputValue("");
    inputRef.current?.editBuffer.setText?.("");
    blurInput();
    ask(trimmed);
  }, [ask, blurInput, inputValue]);

  const toggleExpanded = useCallback((toolCallId: string) => {
    setExpandedToolCallId((current) => (current === toolCallId ? null : toolCallId));
  }, []);
  useEffect(() => {
    if (!expandedToolCallId) setResultFocused(false);
  }, [expandedToolCallId]);

  const moveSelection = useCallback((direction: -1 | 1) => {
    if (timelineStops.length === 0) return;
    const index = timelineStops.findIndex((stop) => stop.id === selectedStopId);
    // Selection starts at the newest row: that is the answer being read.
    const nextIndex = index < 0
      ? timelineStops.length - 1
      : (index + direction + timelineStops.length) % timelineStops.length;
    setSelectedStopId(timelineStops[nextIndex]?.id ?? null);
  }, [selectedStopId, timelineStops]);

  // The selected row follows the keyboard into view in a long conversation.
  const selectedRowNodeRef = useRef<BoxRenderable | null>(null);
  const selectedRowRef = useCallback((node: BoxRenderable | null) => {
    selectedRowNodeRef.current = node;
  }, []);
  useEffect(() => {
    if (!selectedStopId) return;
    return afterLayout(() => revealInScrollBox(scrollRef.current, selectedRowNodeRef.current));
  }, [selectedStopId, feedbackFollowUpTurnId]);

  const openPaneForTool = useCallback((row: ASKGToolRow) => {
    const target = resolveToolPaneTarget(row.name);
    if (!target) return;
    if (target.templateId) {
      createPaneFromTemplate(target.templateId, row.argumentSummary
        ? { arg: row.argumentSummary.split(" · ")[0] }
        : undefined);
      return;
    }
    showPane(target.paneId);
  }, [createPaneFromTemplate, showPane]);

  const openSymbol = useCallback((symbol: string) => {
    pinTicker(symbol, { floating: true });
  }, [pinTicker]);

  // A write waiting on the user owns the keyboard, so the answer never gets
  // typed into the composer instead.
  useEffect(() => {
    if (confirmation && inputFocused) blurInput();
  }, [blurInput, confirmation, inputFocused]);

  const leaveSidebar = useCallback(() => {
    setSidebarFocused(false);
    setSidebarCursorId(null);
  }, []);

  const moveSidebarCursor = useCallback((direction: -1 | 1) => {
    const rows = conversations.conversations;
    if (rows.length === 0) return;
    const index = rows.findIndex((row) => row.id === sidebarCursorId);
    const nextIndex = index < 0
      ? 0
      : (index + direction + rows.length) % rows.length;
    setSidebarCursorId(rows[nextIndex]?.id ?? null);
  }, [conversations.conversations, sidebarCursorId]);

  const focusSidebar = useCallback(() => {
    setResultFocused(false);
    setSidebarFocused(true);
    setSidebarCursorId(state.conversationId);
  }, [state.conversationId]);

  // The row the sidebar's keyboard is on, or the open conversation.
  const sidebarTargetId = sidebarCursorId ?? state.conversationId;
  const deleteSidebarConversation = useCallback(() => {
    const rows = conversations.conversations;
    const index = rows.findIndex((row) => row.id === sidebarTargetId);
    if (index < 0 || !sidebarTargetId) return;
    // The cursor stays on the list: the row after, or the one before the last.
    const neighbor = rows[index + 1]?.id ?? rows[index - 1]?.id ?? null;
    void deleteConversation(sidebarTargetId).then((deleted) => {
      if (deleted) setSidebarCursorId(neighbor);
    });
  }, [conversations.conversations, deleteConversation, sidebarTargetId]);


  const answerTexts = useMemo(
    () => state.turns.map((turn) => turn.answer).filter(Boolean),
    [state.turns],
  );
  const { catalog, openTicker } = useInlineTickers(answerTexts, { badgeQuotes: true });
  // Ticker badges in the answer open on click; `t` lists the latest answer's.
  const answerTickers = useMemo(() => {
    const latest = [...state.turns].reverse().find((turn) => turn.answer)?.answer;
    return latest
      ? collectUniqueTickerSymbols([latest]).filter((symbol) => catalog[symbol]?.status !== "missing")
      : [];
  }, [catalog, state.turns]);
  const chooseAnswerTicker = useCallback(async () => {
    if (answerTickers.length === 0) return;
    const symbol = await dialog.prompt<string>({
      closeOnClickOutside: true,
      content: (context: unknown) => (
        <ChoiceDialog
          {...(context as PromptContext<string>)}
          title="Tickers in the answer"
          choices={answerTickers.map((entry) => ({
            id: entry,
            label: entry,
            description: catalog[entry]?.ticker?.metadata.name,
          }))}
        />
      ),
    }).catch(() => undefined);
    if (symbol) openTicker(symbol);
  }, [answerTickers, catalog, dialog, openTicker]);

  const upgrade = useCallback(() => openCommandBar("Upgrade to Pro"), [openCommandBar]);

  const selectedRow = timelineRows.find((row) => row.toolCallId === selectedStopId) ?? null;

  // The answer `g` and `b` rate: the selected one, or the answer of the
  // selected tool row, else the newest answer, which is the one being read.
  const feedbackTarget = useMemo<ASKGTurn | null>(() => {
    const stop = timelineStops.find((entry) => entry.id === selectedStopId);
    if (stop) {
      const turn = state.turns.find((entry) => entry.id === stop.turnId);
      return turn && canRateTurn(state, turn) ? turn : null;
    }
    return state.turns.findLast((turn) => canRateTurn(state, turn)) ?? null;
  }, [selectedStopId, state, timelineStops]);
  // Open until the thumb changes, the answer is sent, or Esc.
  const feedbackFollowUp = useMemo<ASKGTurn | null>(() => {
    const turn = state.turns.find((entry) => entry.id === feedbackFollowUpTurnId);
    return turn && canRateTurn(state, turn) && turn.feedback?.rating === "down" && !turn.feedback.shared
      ? turn
      : null;
  }, [feedbackFollowUpTurnId, state]);

  // A second thumbs down on the same answer opens or closes its reasons, so
  // they are always one press away and never in the way. Rating moves the
  // keyboard to the answer, which also scrolls its reasons into view.
  const rateAnswer = useCallback((turn: ASKGTurn, rating: ASKGFeedbackRating) => {
    setSelectedStopId(answerStopId(turn.id));
    const current = turn.feedback?.rating ?? null;
    if (rating === "down") {
      setFeedbackFollowUpTurnId((open) => (current === "down" && open === turn.id ? null : turn.id));
    } else {
      setFeedbackFollowUpTurnId((open) => (open === turn.id ? null : open));
    }
    if (current === rating) return;
    void controller.rateAnswer(turn.id, rating);
  }, [controller]);
  const chooseFeedbackReason = useCallback((turn: ASKGTurn, reason: ASKGFeedbackReason) => {
    if (turn.feedback?.reason === reason) return;
    void controller.chooseFeedbackReason(turn.id, reason);
  }, [controller]);
  const shareAnswer = useCallback((turn: ASKGTurn) => {
    void controller.shareAnswer(turn.id);
  }, [controller]);
  const confirmationHeight = confirmation ? confirmationBlockHeight(confirmation) : 0;
  const composerHeight = nativePaneChrome ? 3 : 2;
  // The conversation keeps a readable slice no matter what else is open.
  const detailBudget = height - composerHeight - confirmationHeight - 6;
  const detailHeight = expandedRow && detailBudget >= MIN_DETAIL_HEIGHT
    ? Math.min(Math.floor(height / 2), detailBudget)
    : 0;
  const resultActive = resultFocused && !!expandedRow && detailHeight > 0 && !inputFocused && !(sidebarFocused && showSidebar);
  // `o` opens the pane of the result the rows belong to, else the selected row's.
  const paneRow = resultActive ? expandedRow : selectedRow;
  const canOpenPane = !!paneRow && !!resolveToolPaneTarget(paneRow.name);
  const expandTarget = resultActive ? expandedRow : selectedRow;

  const toggleResult = useCallback((row: ASKGToolRow) => {
    const expanding = expandedToolCallId !== row.toolCallId;
    toggleExpanded(row.toolCallId);
    setResultFocused(expanding && toolResultTables(row.result).some((table) => table.rows.length > 0));
  }, [expandedToolCallId, toggleExpanded]);

  useShortcut((event) => {
    // Behind the sign-in wall the keys are the wall's (Enter logs in).
    if (!focused || !planAccess.emailVerified) return;
    const consume = () => {
      event.preventDefault();
      event.stopPropagation();
    };
    if (confirmation) {
      if (isPlainKey(event, "y")) {
        consume();
        controller.resolveConfirmation(confirmation.toolCallId, true);
        return;
      }
      if (isPlainKey(event, "n", "escape")) {
        consume();
        controller.resolveConfirmation(confirmation.toolCallId, false);
        return;
      }
    }
    // The sidebar owns the keyboard while it has focus, so the same arrows
    // that walk the tool timeline walk the conversation list instead.
    if (sidebarFocused && showSidebar) {
      if (isPlainKey(event, "escape", "right")) {
        consume();
        leaveSidebar();
      } else if (isPlainKey(event, "enter", "return")) {
        consume();
        const target = sidebarTargetId;
        leaveSidebar();
        if (target) void openConversation(target);
      } else if (isPlainKey(event, "j", "down")) {
        consume();
        moveSidebarCursor(1);
      } else if (isPlainKey(event, "k", "up")) {
        consume();
        moveSidebarCursor(-1);
      } else if (isPlainKey(event, "n")) {
        consume();
        leaveSidebar();
        newConversation();
      } else if (isPlainKey(event, "d", "delete")) {
        consume();
        deleteSidebarConversation();
      }
      // `<` and `>` fall through to the sidebar kit, which resizes it.
      return;
    }
    if (inputFocused) {
      if (isPlainKey(event, "escape")) {
        consume();
        // Leaving an empty composer counts toward a double-Esc close; a draft does not.
        const value = inputRef.current?.editBuffer.getText() ?? inputValue;
        if (!value.trim()) countEscapeTowardClose(event);
        blurInput();
      }
      return;
    }
    if (resultActive) {
      if (isPlainKey(event, "escape")) {
        consume();
        setResultFocused(false);
        return;
      }
      // The result table walks and opens its own rows.
      if (isPlainKey(event, "j", "k", "up", "down", "enter", "return", "home", "end", "pageup", "pagedown")) return;
    }
    if (feedbackFollowUp) {
      if (isPlainKey(event, "escape")) {
        consume();
        setFeedbackFollowUpTurnId(null);
        return;
      }
      const reason = FEEDBACK_REASONS.find((entry) => isPlainKey(event, entry.key));
      if (reason) {
        consume();
        chooseFeedbackReason(feedbackFollowUp, reason.reason);
        return;
      }
      if (isPlainKey(event, SHARE_ANSWER_KEY)) {
        consume();
        shareAnswer(feedbackFollowUp);
        return;
      }
    }
    if (isPlainKey(event, GOOD_ANSWER_KEY, BAD_ANSWER_KEY) && feedbackTarget) {
      consume();
      rateAnswer(feedbackTarget, event.name === GOOD_ANSWER_KEY ? "up" : "down");
      return;
    }
    if (isPlainKey(event, "left") && showSidebar) {
      consume();
      focusSidebar();
      return;
    }
    if (isPlainKey(event, "enter", "return")) {
      consume();
      focusInput();
      return;
    }
    // With tool rows or rateable answers the arrows walk them; without, they
    // scroll the answer.
    if (isPlainKey(event, "j", "down") && timelineStops.length > 0) {
      consume();
      moveSelection(1);
      return;
    }
    if (isPlainKey(event, "k", "up") && timelineStops.length > 0) {
      consume();
      moveSelection(-1);
      return;
    }
    if (isPlainKey(event, "x") && expandTarget) {
      consume();
      toggleResult(expandTarget);
      return;
    }
    if (isPlainKey(event, "o") && paneRow && canOpenPane) {
      consume();
      openPaneForTool(paneRow);
      return;
    }
    if (isPlainKey(event, UNDO_KEY) && selectedRow && canUndo(selectedRow)) {
      consume();
      void controller.undo(selectedRow.toolCallId);
      return;
    }
    if (isPlainKey(event, "t") && answerTickers.length > 0) {
      consume();
      void chooseAnswerTicker();
      return;
    }
    if (event.name === UPGRADE_KEY && !event.ctrl && !event.meta && !event.alt && needsUpgrade) {
      consume();
      upgrade();
      return;
    }
    if (isPlainKey(event, "r") && retryableTurn) {
      consume();
      void controller.retryTurn(retryableTurn.id);
      return;
    }
    if (isPlainKey(event, "c") && running) {
      consume();
      controller.cancel();
    }
  }, { allowEditable: true });


  // Hints name only what the current focus takes: the composer takes letters,
  // the sidebar its own list keys, and the timeline everything else.
  const hints = useMemo<PaneHint[]>(() => {
    const list: PaneHint[] = [];
    if (!planAccess.emailVerified) return list;
    if (confirmation) {
      list.push(
        { id: "approve", key: "y", label: "es approve", title: "Approve", onPress: () => controller.resolveConfirmation(confirmation.toolCallId, true) },
        { id: "decline", key: "n", label: "o decline", title: "Decline", onPress: () => controller.resolveConfirmation(confirmation.toolCallId, false) },
      );
    }
    if (inputFocused) return list;
    if (showSidebar && sidebarFocused) {
      // While a write waits, n answers it.
      if (!confirmation) list.push({ id: "new", key: "n", label: "ew conversation", onPress: () => { leaveSidebar(); newConversation(); } });
      if (sidebarTargetId) list.push({ id: "delete", key: "d", label: "elete", onPress: deleteSidebarConversation });
      return list;
    }
    if (running) list.push({ id: "cancel", key: "c", label: "ancel", onPress: () => controller.cancel() });
    if (retryableTurn) list.push({ id: "retry", key: "r", label: "etry", onPress: () => void controller.retryTurn(retryableTurn.id) });
    if (needsUpgrade) list.push({ id: "upgrade", key: UPGRADE_KEY, label: "upgrade", title: "Upgrade to Pro", onPress: upgrade });
    if (resultActive) list.push({ id: "result-back", key: "Esc", label: "timeline", title: "Back to Timeline", onPress: () => setResultFocused(false) });
    if (expandTarget) {
      const expanded = expandTarget.toolCallId === expandedToolCallId;
      list.push({
        id: "expand",
        key: "x",
        label: expanded ? " collapse" : "pand rows",
        title: expanded ? "Collapse Rows" : "Expand Rows",
        onPress: () => toggleResult(expandTarget),
      });
    }
    if (paneRow && canOpenPane) list.push({ id: "open-pane", key: "o", label: "pen pane", onPress: () => openPaneForTool(paneRow) });
    if (selectedRow && canUndo(selectedRow)) {
      list.push({ id: "undo", key: UNDO_KEY, label: " undo", title: "Undo", onPress: () => void controller.undo(selectedRow.toolCallId) });
    }
    // An open thumbs down takes the keys for its reasons and the send; the
    // thumbs keep working, they just leave the footer room for these.
    if (feedbackFollowUp) {
      for (const entry of FEEDBACK_REASONS) {
        list.push({
          id: `feedback-${entry.reason}`,
          key: entry.key,
          label: entry.hint,
          title: entry.title,
          onPress: () => chooseFeedbackReason(feedbackFollowUp, entry.reason),
        });
      }
      list.push({ id: "feedback-share", key: SHARE_ANSWER_KEY, label: "end", title: "Send This Answer to Gloom", onPress: () => shareAnswer(feedbackFollowUp) });
    } else if (feedbackTarget) {
      list.push(
        { id: "feedback-good", key: GOOD_ANSWER_KEY, label: "ood", title: "Good Answer", onPress: () => rateAnswer(feedbackTarget, "up") },
        { id: "feedback-bad", key: BAD_ANSWER_KEY, label: "ad", title: "Bad Answer", onPress: () => rateAnswer(feedbackTarget, "down") },
      );
    }
    if (answerTickers.length > 0) list.push({ id: "tickers", key: "t", label: "ickers", onPress: () => void chooseAnswerTicker() });
    if (showSidebar) list.push({ id: "conversations", key: "←", label: " conversations", onPress: focusSidebar });
    return list;
  }, [
    planAccess.emailVerified,
    answerTickers.length,
    canOpenPane,
    chooseAnswerTicker,
    chooseFeedbackReason,
    confirmation,
    controller,
    deleteSidebarConversation,
    expandTarget,
    expandedToolCallId,
    feedbackFollowUp,
    feedbackTarget,
    focusSidebar,
    inputFocused,
    leaveSidebar,
    needsUpgrade,
    newConversation,
    openPaneForTool,
    paneRow,
    rateAnswer,
    resultActive,
    retryableTurn,
    running,
    selectedRow,
    shareAnswer,
    showSidebar,
    sidebarFocused,
    sidebarTargetId,
    toggleResult,
    upgrade,
  ]);

  usePaneFooter(`askg:${paneId}`, () => ({
    info: [
      ...(running
        ? [{ id: "streaming", parts: [{ text: "Streaming", tone: "positive" as const, bold: true }] }]
        : []),
      ...(confirmation
        ? [{ id: "confirm", parts: [{ text: "Waiting for approval", tone: "warning" as const }] }]
        : []),
      ...(state.limits && state.limits.turnsRemainingToday >= 0 && !running
        ? [{
          id: "quota",
          parts: [{
            text: `${state.limits.turnsRemainingToday} questions left today`,
            tone: "muted" as const,
          }],
        }]
        : []),
    ],
    hints,
  }), [confirmation, hints, running, state.limits]);

  if (!planAccess.emailVerified) {
    return (
      <SignInWall
        placement="gp-signin"
        action="ask questions about any pane in the terminal"
        needsVerification={planAccess.signedIn}
      />
    );
  }

  const bodyWidth = Math.max(24, width - sidebarWidth);
  const contentWidth = Math.max(24, bodyWidth - (nativePaneChrome ? 2 : 4));
  const lastTurnId = activeTurn(state)?.id ?? null;

  return (
    <Box
      flexDirection="row"
      width={nativePaneChrome ? "100%" : width}
      height={nativePaneChrome ? "100%" : height}
      overflow="hidden"
    >
      {showSidebar ? (
        <ASKGConversationSidebar
          activeConversationId={
            sidebarFocused ? sidebarCursorId ?? state.conversationId : state.conversationId
          }
          width={sidebarWidth}
          paneWidth={width}
          height={height}
          focused={focused}
          keyboardFocused={focused && sidebarFocused}
          onSelect={(conversationId) => void openConversation(conversationId)}
          onFocusRequest={() => {
            if (inputFocused) blurInput();
            setResultFocused(false);
            setSidebarFocused(true);
          }}
          onNewConversation={newConversation}
          onDelete={(conversationId) => void deleteConversation(conversationId)}
        />
      ) : null}

      <Box
        flexDirection="column"
        width={nativePaneChrome ? undefined : bodyWidth}
        height={nativePaneChrome ? "100%" : height}
        flexGrow={nativePaneChrome ? 1 : undefined}
        // Without shrink the column takes the width of its longest line, so a
        // tool note ran past the pane's edge on desktop instead of wrapping.
        flexShrink={nativePaneChrome ? 1 : undefined}
        minWidth={0}
        overflow="hidden"
        onMouseDown={() => setSidebarFocused(false)}
      >
      <ScrollBox ref={scrollRef} flexGrow={1} minHeight={0} scrollY focusable={false} paddingX={1}>
        {state.turns.length === 0 ? (
          <EmptyState
            title="Ask about anything on screen."
            hint="Gloom reads your panes to answer, and shows every tool it used."
          />
        ) : state.turns.map((turn) => (
          <TurnView
            key={turn.id}
            turn={turn}
            width={contentWidth}
            selectedStopId={selectedStopId}
            expandedToolCallId={expandedToolCallId}
            selectedRowRef={selectedRowRef}
            latest={turn.id === lastTurnId}
            rateable={canRateTurn(state, turn)}
            feedbackKeysShown={focused && !inputFocused && !(sidebarFocused && showSidebar) && feedbackTarget?.id === turn.id}
            feedbackFollowUpOpen={feedbackFollowUp?.id === turn.id}
            catalog={catalog}
            openTicker={openTicker}
            onSelectTool={setSelectedStopId}
            onToggleTool={toggleExpanded}
            onUndo={(toolCallId) => void controller.undo(toolCallId)}
            onRetry={() => void controller.retryTurn(turn.id)}
            onUpgrade={upgrade}
            // The controls keep their press from the column behind them, so
            // they hand the keyboard back to the answer themselves.
            onRate={(rating) => {
              leaveSidebar();
              rateAnswer(turn, rating);
            }}
            onReason={(reason) => {
              leaveSidebar();
              chooseFeedbackReason(turn, reason);
            }}
            onShare={() => {
              leaveSidebar();
              shareAnswer(turn);
            }}
          />
        ))}
      </ScrollBox>

      {confirmation ? (
        <ConfirmationPrompt
          row={confirmation}
          width={contentWidth}
          onApprove={() => controller.resolveConfirmation(confirmation.toolCallId, true)}
          onDecline={() => controller.resolveConfirmation(confirmation.toolCallId, false)}
        />
      ) : null}

      {expandedRow && detailHeight > 0 ? (
        <ToolResultDetail
          row={expandedRow}
          width={nativePaneChrome ? width : width - 2}
          height={detailHeight}
          focused={focused && resultActive}
          openPaneShortcut={paneRow?.toolCallId === expandedRow.toolCallId && canOpenPane ? "o" : undefined}
          onOpenSymbol={openSymbol}
          onOpenPane={() => openPaneForTool(expandedRow)}
        />
      ) : null}

      <MessageComposer
        inputRef={inputRef}
        initialValue={inputValue}
        focused={inputFocused && focused}
        placeholder={activeTurn(state) && running ? "Gloom is answering…" : "Ask Gloom a question…"}
        width="100%"
        height={composerHeight}
        terminalPrefix=" > "
        terminalBottomInset={nativePaneChrome ? 0 : 1}
        onFocusRequest={focusInput}
        onInput={setInputValue}
        keyBindings={[
          { name: "return", action: "submit" },
          { name: "linefeed", action: "submit" },
        ]}
        onSubmit={submitInput}
        wrapText
      />
      </Box>
    </Box>
  );
}
