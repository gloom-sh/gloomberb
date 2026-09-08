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
  type ScrollBoxRenderable,
  type TextareaRenderable,
} from "../../../../ui";
import {
  Button,
  DataTableView,
  EmptyState,
  MessageComposer,
  SegmentedControl,
  Spinner,
  usePaneFooter,
  type DataTableCell,
  type DataTableColumn,
} from "../../../../components";
import { MarkdownText } from "../../../../components/markdown-text";
import { useShortcut } from "../../../../react/input";
import {
  useAppDispatch,
  useAppSelector,
} from "../../../../state/app/context";
import { useInlineTickers } from "../../../../state/hooks/inline-tickers";
import { useRemoteControlHandler } from "../../../../remote/app-host";
import { colors } from "../../../../theme/colors";
import type { PaneProps } from "../../../../types/plugin";
import { truncateWithEllipsis } from "../../../../utils/text-wrap";
import { usePluginAppActions, usePluginTickerActions } from "../../../runtime";
import { usePlanAccess } from "../../shared/plan-access";
import { ASKGSessionController, type ASKGControllerManifest } from "./controller";
import {
  createASKGRendererToolExecutor,
  loadASKGClientManifest,
  resolveToolPaneTarget,
} from "./host";
import { subscribeASKGQuestions } from "./pending-question";
import {
  activeTurn,
  describeASKGError,
  describeToolStatus,
  formatCellValue,
  isTurnRunning,
  pendingConfirmation,
  rowSymbol,
  toolResultTables,
  type ASKGConversationState,
  type ASKGResultTable,
  type ASKGToolRow,
  type ASKGTurn,
} from "./model";
import type { JsonValue } from "./protocol";

export const ASKG_PANE_ID = "askg";

const CLIENT_VERSION = "1";
const MIN_DETAIL_HEIGHT = 8;

function clientKind(nativePaneChrome: boolean): "tui" | "desktop" | "web" {
  if (!nativePaneChrome) return "tui";
  return typeof location !== "undefined" && location.protocol.startsWith("http") ? "web" : "desktop";
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

function ToolTimelineRow({
  row,
  width,
  selected,
  expanded,
  onSelect,
  onToggle,
  onUndo,
}: {
  row: ASKGToolRow;
  width: number;
  selected: boolean;
  expanded: boolean;
  onSelect: () => void;
  onToggle: () => void;
  onUndo: () => void;
}) {
  const hasRows = row.result !== undefined;
  const marker = hasRows ? (expanded ? "▾" : "▸") : "·";
  const tier = tierLabel(row);
  const status = describeToolStatus(row);
  const undoLabel = row.undo?.status === "running"
    ? "undoing…"
    : row.undo?.status === "done"
      ? "undone"
      : row.undo?.status === "failed"
        ? "undo failed"
        : row.undoToken
          ? "undo"
          : null;
  const trailing = ` ${status}${row.origin === "server" ? " · Gloom" : ""}`;
  const summaryWidth = Math.max(
    6,
    width - marker.length - row.name.length - trailing.length - (tier ? tier.length + 3 : 0) - 4,
  );

  return (
    <Box flexDirection="column">
      <Box
        flexDirection="row"
        height={1}
        backgroundColor={selected ? colors.panel : undefined}
        onMouseDown={() => {
          onSelect();
          onToggle();
        }}
        style={{ cursor: "pointer" }}
      >
        <Text fg={selected ? colors.textBright : colors.textDim}>{`${marker} `}</Text>
        <Text fg={colors.textBright}>{row.name}</Text>
        {row.argumentSummary ? (
          <Text fg={colors.textDim}>{`  ${truncateWithEllipsis(row.argumentSummary, summaryWidth)}`}</Text>
        ) : null}
        <Box flexGrow={1} />
        {tier ? <Text fg={colors.warning}>{`${tier}  `}</Text> : null}
        {row.status === "running" || row.status === "pending" ? (
          <Spinner label={status} />
        ) : (
          <Text fg={statusColor(row)}>{status}</Text>
        )}
        {row.origin === "server" ? <Text fg={colors.textMuted}> · Gloom</Text> : null}
      </Box>
      {undoLabel ? (
        <Box flexDirection="row" height={1} paddingLeft={2}>
          <Text
            fg={row.undo?.status === "failed" ? colors.negative : colors.textBright}
            onMouseDown={() => {
              if (row.undo?.status === "available" || !row.undo) onUndo();
            }}
            style={{ cursor: "pointer" }}
          >
            {undoLabel}
          </Text>
          {row.undo?.note ? <Text fg={colors.textMuted}>{`  ${row.undo.note}`}</Text> : null}
        </Box>
      ) : null}
      {row.note && row.status !== "ok" ? (
        <Box paddingLeft={2}>
          <Text fg={statusColor(row)}>{truncateWithEllipsis(row.note, Math.max(10, width - 3))}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

/** Rows the confirmation block reserves for the dry run preview. */
const MAX_PREVIEW_LINES = 4;

export function confirmationBlockHeight(row: ASKGToolRow): number {
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
  onOpenSymbol,
  onOpenPane,
}: {
  row: ASKGToolRow;
  width: number;
  height: number;
  focused: boolean;
  onOpenSymbol: (symbol: string) => void;
  onOpenPane: () => void;
}) {
  const tables = useMemo<ASKGResultTable[]>(() => toolResultTables(row.result), [row.result]);
  const [tableIndex, setTableIndex] = useState(0);
  useEffect(() => {
    setTableIndex(0);
  }, [row.toolCallId]);
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
          <Text fg={colors.textBright} onMouseDown={onOpenPane} style={{ cursor: "pointer" }}>
            open pane
          </Text>
        ) : null}
      </Box>
      {tables.length > 1 ? (
        <Box height={1} paddingX={1}>
          <SegmentedControl
            options={tables.map((entry, index) => ({
              value: String(index),
              label: entry.title ?? `Section ${index + 1}`,
            }))}
            value={String(tableIndex)}
            onChange={(value) => setTableIndex(Number(value))}
          />
        </Box>
      ) : null}
      {table && table.rows.length > 0 ? (
        <DataTableView<Record<string, JsonValue>>
          focused={focused}
          selection={{ kind: "none" }}
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
  selectedToolCallId,
  expandedToolCallId,
  catalog,
  openTicker,
  onSelectTool,
  onToggleTool,
  onUndo,
  onUpgrade,
}: {
  turn: ASKGTurn;
  width: number;
  selectedToolCallId: string | null;
  expandedToolCallId: string | null;
  catalog: ReturnType<typeof useInlineTickers>["catalog"];
  openTicker: (symbol: string) => void;
  onSelectTool: (toolCallId: string) => void;
  onToggleTool: (toolCallId: string) => void;
  onUndo: (toolCallId: string) => void;
  onUpgrade: () => void;
}) {
  return (
    <Box flexDirection="column" paddingTop={1}>
      <Text fg={colors.textBright} attributes={TextAttributes.BOLD}>{turn.prompt}</Text>
      {turn.tools.length > 0 ? (
        <Box flexDirection="column" paddingTop={1}>
          {turn.tools.map((row) => (
            <ToolTimelineRow
              key={row.toolCallId}
              row={row}
              width={width}
              selected={row.toolCallId === selectedToolCallId}
              expanded={row.toolCallId === expandedToolCallId}
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
      {turn.error ? (
        <Box flexDirection="column" paddingTop={1}>
          <Text fg={colors.negative}>{describeASKGError(turn.error)}</Text>
          {turn.error.code === "tier_required" ? (
            <Box paddingTop={1}>
              <Button label="Upgrade to Pro" variant="primary" onPress={onUpgrade} />
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
  const config = useAppSelector((state) => state.config);
  const activeSymbol = useAppSelector((state) => state.recentTickers[0] ?? null);
  const { pinTicker } = usePluginTickerActions();
  const { createPaneFromTemplate, showPane, openCommandBar } = usePluginAppActions();

  const configRef = useRef(config);
  configRef.current = config;
  const remoteHandlerRef = useRef(remoteHandler);
  remoteHandlerRef.current = remoteHandler;
  const contextRef = useRef({ symbol: activeSymbol, paneId });
  contextRef.current = { symbol: activeSymbol, paneId };

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
      });
    },
    client: { kind: clientKind(!!nativePaneChrome), version: CLIENT_VERSION },
    getContext: () => ({
      ...(contextRef.current.symbol ? { symbol: contextRef.current.symbol } : {}),
      paneId: contextRef.current.paneId,
    }),
  }), [nativePaneChrome]);

  useEffect(() => () => controller.dispose(), [controller]);

  const state: ASKGConversationState = useSyncExternalStore(
    useCallback((listener) => controller.subscribe(listener), [controller]),
    useCallback(() => controller.getState(), [controller]),
    useCallback(() => controller.getState(), [controller]),
  );

  const [inputValue, setInputValue] = useState("");
  const [inputFocused, setInputFocused] = useState(false);
  const [selectedToolCallId, setSelectedToolCallId] = useState<string | null>(null);
  const [expandedToolCallId, setExpandedToolCallId] = useState<string | null>(null);
  const inputRef = useRef<TextareaRenderable | null>(null);
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const [queuedQuestion, setQueuedQuestion] = useState<string | null>(null);

  const running = isTurnRunning(state);
  const confirmation = pendingConfirmation(state);
  const timelineRows = useMemo(
    () => state.turns.flatMap((turn) => turn.tools),
    [state.turns],
  );
  const expandedRow = useMemo(
    () => timelineRows.find((row) => row.toolCallId === expandedToolCallId) ?? null,
    [expandedToolCallId, timelineRows],
  );

  const ask = useCallback((question: string) => {
    const trimmed = question.trim();
    if (!trimmed) return;
    void controller.ask(trimmed);
  }, [controller]);

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

  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll?.viewport) return;
    scroll.scrollTo({ x: 0, y: Math.max(0, scroll.scrollHeight - scroll.viewport.height) });
  }, [state.turns]);

  const submitInput = useCallback(() => {
    const value = inputRef.current?.editBuffer.getText() ?? inputValue;
    const trimmed = value.trim();
    if (!trimmed) return;
    setInputValue("");
    inputRef.current?.editBuffer.setText?.("");
    ask(trimmed);
  }, [ask, inputValue]);

  const toggleExpanded = useCallback((toolCallId: string) => {
    setExpandedToolCallId((current) => (current === toolCallId ? null : toolCallId));
  }, []);

  const moveSelection = useCallback((direction: -1 | 1) => {
    if (timelineRows.length === 0) return;
    const index = timelineRows.findIndex((row) => row.toolCallId === selectedToolCallId);
    // Selection starts at the newest row: that is the answer being read.
    const nextIndex = index < 0
      ? timelineRows.length - 1
      : (index + direction + timelineRows.length) % timelineRows.length;
    setSelectedToolCallId(timelineRows[nextIndex]?.toolCallId ?? null);
  }, [selectedToolCallId, timelineRows]);

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

  useShortcut((event) => {
    if (!focused) return;
    if (confirmation) {
      if (event.name === "y") {
        controller.resolveConfirmation(confirmation.toolCallId, true);
        return;
      }
      if (event.name === "n" || event.name === "escape") {
        controller.resolveConfirmation(confirmation.toolCallId, false);
        return;
      }
    }
    if (inputFocused) {
      if (event.name === "escape") blurInput();
      return;
    }
    if (event.name === "enter" || event.name === "return") {
      focusInput();
      return;
    }
    if (event.name === "j" || event.name === "down") {
      moveSelection(1);
      return;
    }
    if (event.name === "k" || event.name === "up") {
      moveSelection(-1);
      return;
    }
    const selected = timelineRows.find((row) => row.toolCallId === selectedToolCallId) ?? null;
    if (event.name === "x" && selected) {
      toggleExpanded(selected.toolCallId);
      return;
    }
    if (event.name === "o" && selected) {
      openPaneForTool(selected);
      return;
    }
    if (event.name === "u" && selected?.undoToken) {
      void controller.undo(selected.toolCallId);
      return;
    }
    if (event.name === "c" && running) controller.cancel();
  }, { allowEditable: true });

  const answerTexts = useMemo(
    () => state.turns.map((turn) => turn.answer).filter(Boolean),
    [state.turns],
  );
  const { catalog, openTicker } = useInlineTickers(answerTexts);

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
    hints: [
      ...(confirmation
        ? [
          { id: "approve", key: "y", label: "es approve", onPress: () => controller.resolveConfirmation(confirmation.toolCallId, true) },
          { id: "decline", key: "n", label: "o decline", onPress: () => controller.resolveConfirmation(confirmation.toolCallId, false) },
        ]
        : []),
      ...(running
        ? [{ id: "cancel", key: "c", label: "ancel", onPress: () => controller.cancel() }]
        : []),
      ...(selectedToolCallId
        ? [{ id: "expand", key: "x", label: "pand rows", onPress: () => toggleExpanded(selectedToolCallId) }]
        : []),
    ],
  }), [confirmation, controller, running, selectedToolCallId, state.limits, toggleExpanded]);

  if (!planAccess.emailVerified) {
    return (
      <Box flexDirection="column" paddingX={1} paddingTop={1}>
        <EmptyState
          title="Ask Gloom needs a verified Gloom Cloud account."
          hint="Sign in, then ask questions about any pane in the terminal."
        />
        <Box paddingTop={1}>
          <Button
            label="Sign in"
            variant="primary"
            shortcut="s"
            onPress={() => openCommandBar("Sign In")}
          />
        </Box>
      </Box>
    );
  }

  const contentWidth = Math.max(24, width - (nativePaneChrome ? 2 : 4));
  const composerHeight = nativePaneChrome ? 3 : 2;
  const confirmationHeight = confirmation ? confirmationBlockHeight(confirmation) : 0;
  // The conversation keeps a readable slice no matter what else is open.
  const detailBudget = height - composerHeight - confirmationHeight - 6;
  const detailHeight = expandedRow && detailBudget >= MIN_DETAIL_HEIGHT
    ? Math.min(Math.floor(height / 2), detailBudget)
    : 0;

  return (
    <Box
      flexDirection="column"
      width={nativePaneChrome ? "100%" : width}
      height={nativePaneChrome ? "100%" : height}
      overflow="hidden"
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
            selectedToolCallId={selectedToolCallId}
            expandedToolCallId={expandedToolCallId}
            catalog={catalog}
            openTicker={openTicker}
            onSelectTool={setSelectedToolCallId}
            onToggleTool={toggleExpanded}
            onUndo={(toolCallId) => void controller.undo(toolCallId)}
            onUpgrade={() => openCommandBar("Upgrade to Pro")}
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
          focused={focused && !inputFocused}
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
  );
}
