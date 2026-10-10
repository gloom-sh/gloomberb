import { CLOUD_PLAN_KEY } from "../../shared/cloud-upgrade";
import { getCurrentPluginTarget } from "../../../current-target";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
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
  Divider,
  EmptyState,
  getPaneSidebarWidth,
  IconButton,
  MessageComposer,
  Prose,
  shouldShowPaneSidebar,
  Spinner,
  usePaneFooter,
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
import { useThemeColors } from "../../../../theme/theme-context";
import type { PaneProps } from "../../../../types/plugin";
import type { ContextMenuItem } from "../../../../types/context-menu";
import type { AppConfig } from "../../../../types/config";
import type { TickerRecord } from "../../../../types/ticker";
import { collectUniqueTickerSymbols } from "../../../../tickers/tokenizer";
import { countEscapeTowardClose } from "../../../../utils/double-escape-close";
import { isPlainKey } from "../../../../utils/keyboard";
import { truncateWithEllipsis, wrapTextLines } from "../../../../utils/text-wrap";
import { usePluginAppActions, usePluginTickerActions } from "../../../runtime";
import { usePlanAccess } from "../../../../api-client/plan-access";
import { SignInWall } from "../auth-actions";
import { afterLayout, revealInScrollBox } from "../../../../components/ui/reveal-in-scroll-box";
import { describePortfolioTab } from "../../analytics/portfolio-selection";
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
  formatCellValue,
  isTurnRunning,
  pendingConfirmation,
  toolResultTables,
  type ASKGConversationState,
  type ASKGToolRow,
  type ASKGTurn,
  type ASKGTurnFeedback,
} from "./model";
import type { ASKGFeedbackRating, ASKGFeedbackReason, JsonValue } from "./protocol";
import { describeToolRow, toolTitle, type ToolDisplayContext } from "./tool-display";
import {
  canUndo,
  ToolResultDetail,
  toolGroupId,
  TurnTools,
  turnTimelineIds,
  UNDO_KEY,
} from "./tool-timeline";

export const ASKG_PANE_ID = "askg";

const CLIENT_VERSION = "1";
const MIN_DETAIL_HEIGHT = 8;
/** The composer grows with the question up to this many lines, then scrolls. */
const MAX_COMPOSER_LINES = 6;
/** The daily allowance is news only once it runs low. */
const LOW_QUOTA = 20;

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

function previewLines(preview: JsonValue | undefined): string[] {
  if (preview == null) return [];
  if (typeof preview === "string") return preview.split("\n");
  if (typeof preview === "number" || typeof preview === "boolean") return [String(preview)];
  if (Array.isArray(preview)) return preview.map((entry) => formatCellValue(entry));
  return Object.entries(preview).map(([key, value]) => `${key}: ${formatCellValue(value)}`);
}

/** Upgrade from a Pro-only answer, on the key every Pro prompt uses. */
const UPGRADE_KEY = CLOUD_PLAN_KEY;

/**
 * Three questions a first look can send with one click, worded for what the
 * profile holds: a portfolio, a ticker on screen, a watchlist.
 */
function askgExampleQuestions({
  config,
  tickers,
  activeSymbol,
}: {
  config: Pick<AppConfig, "watchlists">;
  tickers: Iterable<TickerRecord>;
  activeSymbol: string | null;
}): string[] {
  let holding: string | null = null;
  let watched = false;
  for (const ticker of tickers) {
    if (!holding && ticker.metadata.positions.some((position) => position.shares !== 0)) holding = ticker.metadata.ticker;
    if (ticker.metadata.watchlists.length > 0) watched = true;
  }
  const symbol = activeSymbol ?? holding ?? "NVDA";
  // Short enough to read whole in a phone-wide pane.
  return [
    holding ? "How is my portfolio doing today?" : "What moved the market today?",
    `What moved ${symbol} today?`,
    holding
      ? "Which holdings report earnings this week?"
      : watched && config.watchlists.length > 0
        ? "Which watchlist names report this week?"
        : "What is on this week's economic calendar?",
  ];
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

/**
 * Exactly what the send carries. The answer goes as written, so whatever it
 * says about the person's holdings goes with it; the rows the tools returned
 * never do. A consent line must not promise less than what is sent.
 */
const SHARE_DISCLOSURE = "Sends your question, this answer as written (it can mention your holdings) and which tools ran, not the data they returned.";

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
  const colors = useThemeColors();
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
  const colors = useThemeColors();
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
        <Text fg={colors.warning} attributes={TextAttributes.BOLD}>{`Approve ${toolTitle(row.name)}?`}</Text>
        <Text fg={colors.textDim}>
          {`  changes ${tierLabel(row) ?? "data"}${row.argumentSummary ? ` · ${row.argumentSummary}` : ""}`}
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

/** The first look: what to ask, and three questions that ask themselves. */
function ASKGWelcome({
  examples,
  width,
  selectedIndex,
  onAsk,
}: {
  examples: string[];
  width: number;
  selectedIndex: number | null;
  onAsk: (question: string) => void;
}) {
  const { nativePaneChrome } = useUiCapabilities();
  return (
    <Box flexDirection="column" paddingTop={1}>
      <EmptyState
        title="Ask about your portfolio, a ticker or the market."
        hint="Gloom reads your panes and data to answer, and lists each source it used."
      />
      {/* The empty state's actions: each sends its question. A terminal
          button has no border, so a blank row keeps the three apart. */}
      <Box flexDirection="column" alignItems="flex-start" paddingTop={1} gap={nativePaneChrome ? 0.5 : 1}>
        {examples.map((question, index) => (
          <Button
            key={question}
            label={truncateWithEllipsis(question, Math.max(10, width - 4))}
            variant="ghost"
            active={selectedIndex === index}
            onPress={() => onAsk(question)}
          />
        ))}
      </Box>
    </Box>
  );
}

function TurnView({
  turn,
  width,
  latest,
  rateable,
  feedbackSelected,
  feedbackKeysShown,
  feedbackFollowUpOpen,
  selectedRowRef,
  catalog,
  openTicker,
  tools,
  onRetry,
  onUpgrade,
  onRate,
  onReason,
  onShare,
}: {
  turn: ASKGTurn;
  width: number;
  /** The last turn: its Retry and Upgrade answer the pane's keys. */
  latest: boolean;
  /** The answer shows the rating control. */
  rateable: boolean;
  /** The keyboard is on this answer's rating. */
  feedbackSelected: boolean;
  feedbackKeysShown: boolean;
  feedbackFollowUpOpen: boolean;
  selectedRowRef: (node: BoxRenderable | null) => void;
  catalog: ReturnType<typeof useInlineTickers>["catalog"];
  openTicker: (symbol: string) => void;
  /** The turn's tool timeline. */
  tools: ReactNode;
  onRetry: () => void;
  onUpgrade: () => void;
  onRate: (rating: ASKGFeedbackRating) => void;
  onReason: (reason: ASKGFeedbackReason) => void;
  onShare: () => void;
}) {
  const colors = useThemeColors();
  return (
    <Box flexDirection="column" paddingTop={1}>
      <Prose
        text={turn.prompt}
        width={width}
        color={colors.textBright}
        figures={false}
        attributes={TextAttributes.BOLD}
      />
      {tools}
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
          selected={feedbackSelected}
          selectedRowRef={selectedRowRef}
          onRate={onRate}
          onReason={onReason}
          onShare={onShare}
        />
      ) : null}
      {turn.status === "cancelled" ? (
        <Box flexDirection="row" paddingTop={1} gap={2}>
          <Text fg={colors.textMuted}>Stopped.</Text>
          {latest ? <Button label="Ask again" variant="ghost" compact shortcut="r" onPress={onRetry} /> : null}
        </Box>
      ) : null}
      {turn.error ? (
        <Box flexDirection="column" paddingTop={1}>
          {/* A failure that loses its tail tells the user nothing, so it wraps
              rather than running off the edge of the pane. */}
          <Prose
            text={describeASKGError(turn.error)}
            width={width}
            // Running out of questions is a state, said again in the footer, not a failure.
            color={turn.error.code === "daily_turn_cap" ? colors.textDim : colors.negative}
            figures={false}
          />
          {/* A row of its own, so the desktop draws a button rather than a bar. */}
          {turn.error.code === "tier_required" ? (
            <Box flexDirection="row" paddingTop={1}>
              <Button label="Upgrade to Pro" variant="primary" shortcut={latest ? UPGRADE_KEY : undefined} onPress={onUpgrade} />
            </Box>
          ) : canRetryASKGError(turn.error) ? (
            <Box flexDirection="row" paddingTop={1}>
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
  // A tool row or a turn's folded calls; j/k walk them.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expandedToolCallId, setExpandedToolCallId] = useState<string | null>(null);
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(() => new Set());
  // The answer whose thumbs down shows its reasons and the send action.
  const [feedbackFollowUpTurnId, setFeedbackFollowUpTurnId] = useState<string | null>(null);
  // The example question the keyboard is on while the pane is empty.
  const [exampleIndex, setExampleIndex] = useState<number | null>(null);
  const inputRef = useRef<TextareaRenderable | null>(null);
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const [queuedQuestion, setQueuedQuestion] = useState<string | null>(null);
  const queuedQuestionRef = useRef<string | null>(null);
  // The conversation list is a drawer: open only while it has the keyboard or
  // the pointer, so it never takes the left of the pane unasked.
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

  // Any stored conversation is worth going back to, including the only one
  // when it is not the one on screen. A pane too narrow for the list beside
  // the answer shows it in the answer's place until one is picked.
  const listRoom = conversations.conversations.length > 0 && height >= 8;
  const listBeside = shouldShowPaneSidebar(conversations.conversations.length, width, height, 1);
  const showSidebar = listRoom && sidebarFocused;
  const listCoversBody = showSidebar && !listBeside;
  const sidebarWidth = !showSidebar
    ? 0
    : listCoversBody
      ? width
      : getPaneSidebarWidth(width, !!nativePaneChrome, conversations.width);

  const running = isTurnRunning(state);
  const confirmation = pendingConfirmation(state);

  // Names the profile gives the ids tools take, so a row reads "Interactive
  // Brokers U1234567" rather than the id Gloom passed.
  const displayContext = useMemo<ToolDisplayContext>(() => ({
    collectionName: (id: string) => {
      const portfolio = config.portfolios.find((entry) => entry.id === id);
      if (portfolio) return describePortfolioTab(portfolio, config.brokerInstances);
      return config.watchlists.find((entry) => entry.id === id)?.name ?? null;
    },
    toolTitle: (name: string) => resolveToolPaneTarget(name)?.label ?? null,
  }), [config.brokerInstances, config.portfolios, config.watchlists]);

  // What j/k walk: each turn's tool rows (or their fold), then its answer's rating.
  const timelineIds = useMemo(
    () => state.turns.flatMap((turn) => [
      ...turnTimelineIds(turn, openGroups),
      ...(canRateTurn(state, turn) ? [answerStopId(turn.id)] : []),
    ]),
    [openGroups, state],
  );
  const toolRows = useMemo(
    () => state.turns.flatMap((turn) => turn.tools),
    [state.turns],
  );
  const expandedRow = useMemo(
    () => toolRows.find((row) => row.toolCallId === expandedToolCallId) ?? null,
    [expandedToolCallId, toolRows],
  );
  const selectedRow = toolRows.find((row) => row.toolCallId === selectedId) ?? null;
  const selectedGroupTurn = selectedId?.startsWith("group:")
    ? state.turns.find((turn) => toolGroupId(turn.id) === selectedId) ?? null
    : null;
  // The last question is the one a retry would repeat; an older failure is
  // already history the user moved past.
  const retryableTurn = useMemo(() => {
    const turn = activeTurn(state);
    if (!turn) return null;
    if (turn.status === "cancelled") return turn;
    if (turn.status !== "error" || !turn.error) return null;
    return canRetryASKGError(turn.error) ? turn : null;
  }, [state]);
  const needsUpgrade = useMemo(() => {
    const turn = activeTurn(state);
    return turn?.status === "error" && turn.error?.code === "tier_required";
  }, [state]);

  const examples = useMemo(() => {
    const appState = getAppStateRef.current();
    return askgExampleQuestions({
      config: appState.config,
      tickers: appState.tickers.values(),
      activeSymbol,
    });
  }, [activeSymbol, config.portfolios, config.watchlists]);

  const ask = useCallback((question: string) => {
    const trimmed = question.trim();
    if (!trimmed) return;
    void controller.ask(trimmed);
  }, [controller]);

  const focusInput = useCallback(() => {
    setInputFocused(true);
    setExampleIndex(null);
    setResultFocused(false);
    setSidebarFocused(false);
    setSidebarCursorId(null);
    dispatch({ type: "SET_INPUT_CAPTURED", captured: true });
    inputRef.current?.focus?.();
  }, [dispatch]);

  const blurInput = useCallback(() => {
    setInputFocused(false);
    dispatch({ type: "SET_INPUT_CAPTURED", captured: false });
  }, [dispatch]);

  const focusedRef = useRef(focused);
  focusedRef.current = focused;

  // Asking from anywhere but the composer (an example, Retry) hands the
  // keyboard back to it, so what is typed next is the follow-up and never a
  // string of shortcuts. A click on the desktop would otherwise leave the
  // keyboard on the button it pressed.
  const askAndCompose = useCallback((question: string) => {
    ask(question);
    if (focusedRef.current) focusInput();
  }, [ask, focusInput]);
  const retryAndCompose = useCallback((turnId: string) => {
    void controller.retryTurn(turnId);
    if (focusedRef.current) focusInput();
  }, [controller, focusInput]);

  const resetTimeline = useCallback(() => {
    setSelectedId(null);
    setExpandedToolCallId(null);
    setOpenGroups(new Set());
    setExampleIndex(null);
    setFeedbackFollowUpTurnId(null);
  }, []);

  const openConversation = useCallback(async (conversationId: string) => {
    setSidebarFocused(false);
    setSidebarCursorId(null);
    if (focusedRef.current) focusInput();
    if (conversationId === state.conversationId) return;
    const conversation = await apiClient.askg.loadConversation(conversationId);
    // A row the sidebar still shows may be gone; the refresh drops it.
    if (!conversation) {
      void askgConversationListStore.refresh();
      return;
    }
    resetTimeline();
    controller.openConversation(conversation);
  }, [controller, focusInput, resetTimeline, state.conversationId]);

  const newConversation = useCallback(() => {
    resetTimeline();
    askgConversationListStore.rememberOpen(null);
    controller.startConversation();
    if (focusedRef.current) focusInput();
  }, [controller, focusInput, resetTimeline]);

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
    if (conversationId === state.conversationId) {
      resetTimeline();
      controller.startConversation();
    }
    void askgConversationListStore.delete(conversationId);
    return true;
  }, [controller, conversations.conversations, dialog, resetTimeline, state.conversationId]);

  // Typing lands in the composer as soon as the pane has the keyboard: when it
  // opens, when it is focused again, once the account is ready. Only this
  // pane's own focus moves it, so no other pane loses the keyboard.
  const keyboardReady = focused && planAccess.emailVerified;
  const wasReadyRef = useRef(false);
  useEffect(() => {
    const gained = keyboardReady && !wasReadyRef.current;
    wasReadyRef.current = keyboardReady;
    if (gained && !confirmation) focusInput();
  }, [confirmation, focusInput, keyboardReady]);

  useEffect(() => {
    if (!focused && inputFocused) blurInput();
  }, [blurInput, focused, inputFocused]);

  useEffect(() => () => {
    dispatch({ type: "SET_INPUT_CAPTURED", captured: false });
  }, [dispatch]);

  // A question typed at the command bar, either opening this pane or landing
  // in the conversation already open here.
  useEffect(() => subscribeASKGQuestions((question) => {
    queuedQuestionRef.current = question;
    setQueuedQuestion(question);
  }), []);

  useEffect(() => {
    // The restored cloud session arrives after the first render, so a question
    // that beat it waits instead of being dropped.
    if (!queuedQuestion || !planAccess.emailVerified) return;
    setQueuedQuestion(null);
    queuedQuestionRef.current = null;
    ask(queuedQuestion);
  }, [ask, planAccess.emailVerified, queuedQuestion]);

  // Closing the pane is two Escs away, so the conversation it showed comes
  // back with the next one this session opens. A question typed with the
  // command that opened it starts a new one instead.
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current || !planAccess.emailVerified) return;
    restoredRef.current = true;
    const remembered = askgConversationListStore.rememberedOpen();
    if (!remembered || queuedQuestionRef.current || controller.getState().turns.length > 0) return;
    void apiClient.askg.loadConversation(remembered).then((conversation) => {
      const current = controller.getState();
      if (!conversation || current.turns.length > 0 || current.conversationId) return;
      controller.openConversation(conversation);
    }).catch(() => {});
  }, [controller, planAccess.emailVerified]);

  useEffect(() => {
    if (state.conversationId) askgConversationListStore.rememberOpen(state.conversationId);
  }, [state.conversationId]);

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
    if (!listRoom && sidebarFocused) {
      setSidebarFocused(false);
      setSidebarCursorId(null);
    }
  }, [listRoom, sidebarFocused]);

  const readDraft = useCallback(
    () => inputRef.current?.editBuffer.getText() ?? inputValue,
    [inputValue],
  );

  // The question stays in the composer while Gloom answers, and goes once it
  // is asked; the composer keeps the keyboard for the next one.
  const submitInput = useCallback(() => {
    const trimmed = readDraft().trim();
    if (!trimmed || isTurnRunning(controller.getState())) return;
    setInputValue("");
    inputRef.current?.editBuffer.setText?.("");
    resetTimeline();
    ask(trimmed);
  }, [ask, controller, readDraft, resetTimeline]);

  // The terminal textarea reports edits only through `onContentChange`, and
  // the composer grows with what it holds, so the pane binds whichever
  // textarea is mounted after each render.
  const boundTextareaRef = useRef<TextareaRenderable | null>(null);
  useLayoutEffect(() => {
    const textarea = inputRef.current;
    const bound = boundTextareaRef.current;
    if (textarea === bound) return;
    if (bound) bound.onContentChange = undefined;
    boundTextareaRef.current = textarea;
    if (!textarea) return;
    textarea.onContentChange = () => setInputValue(textarea.editBuffer.getText());
  });
  useLayoutEffect(() => () => {
    const bound = boundTextareaRef.current;
    boundTextareaRef.current = null;
    if (bound) bound.onContentChange = undefined;
  }, []);

  const toggleExpanded = useCallback((toolCallId: string) => {
    setExpandedToolCallId((current) => (current === toolCallId ? null : toolCallId));
  }, []);
  useEffect(() => {
    if (!expandedToolCallId) setResultFocused(false);
  }, [expandedToolCallId]);

  const toggleGroup = useCallback((groupId: string) => {
    setOpenGroups((current) => {
      const next = new Set(current);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }, []);

  const moveSelection = useCallback((direction: -1 | 1) => {
    if (timelineIds.length === 0) return;
    const index = timelineIds.indexOf(selectedId ?? "");
    // Selection starts at the newest row: that is the answer being read.
    const nextIndex = index < 0
      ? timelineIds.length - 1
      : (index + direction + timelineIds.length) % timelineIds.length;
    setSelectedId(timelineIds[nextIndex] ?? null);
  }, [selectedId, timelineIds]);

  // The selected row follows the keyboard into view in a long conversation.
  const selectedRowNodeRef = useRef<BoxRenderable | null>(null);
  const selectedRowRef = useCallback((node: BoxRenderable | null) => {
    selectedRowNodeRef.current = node;
  }, []);
  useEffect(() => {
    if (!selectedId) return;
    return afterLayout(() => revealInScrollBox(scrollRef.current, selectedRowNodeRef.current));
  }, [expandedToolCallId, feedbackFollowUpTurnId, openGroups, selectedId]);

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
  // typed into the composer instead; once it is answered the composer has it back.
  const hadConfirmationRef = useRef(false);
  useEffect(() => {
    const had = hadConfirmationRef.current;
    hadConfirmationRef.current = !!confirmation;
    if (confirmation && inputFocused) blurInput();
    if (had && !confirmation && focusedRef.current) focusInput();
  }, [blurInput, confirmation, focusInput, inputFocused]);

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
    if (!listRoom) return;
    if (inputFocused) blurInput();
    setResultFocused(false);
    setSidebarFocused(true);
    // The list opens on the conversation on screen, else on the newest one.
    setSidebarCursorId(state.conversationId ?? conversations.conversations[0]?.id ?? null);
  }, [blurInput, conversations.conversations, inputFocused, listRoom, state.conversationId]);

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

  // The answer `g` and `b` rate: the one the keyboard is on (its rating, its
  // tool rows or their fold), else the newest answer, which is the one being read.
  const feedbackTarget = useMemo<ASKGTurn | null>(() => {
    if (selectedId) {
      const turn = state.turns.find((entry) => (
        selectedId === answerStopId(entry.id)
        || selectedId === toolGroupId(entry.id)
        || entry.tools.some((row) => row.toolCallId === selectedId)
      ));
      if (turn) return canRateTurn(state, turn) ? turn : null;
    }
    return state.turns.findLast((turn) => canRateTurn(state, turn)) ?? null;
  }, [selectedId, state]);
  // Open until the thumb changes, the answer is sent, or Esc.
  const feedbackFollowUp = useMemo<ASKGTurn | null>(() => {
    const turn = state.turns.find((entry) => entry.id === feedbackFollowUpTurnId);
    return turn && canRateTurn(state, turn) && turn.feedback?.rating === "down" && !turn.feedback.shared
      ? turn
      : null;
  }, [feedbackFollowUpTurnId, state]);

  // A second thumbs down on the same answer opens or closes its reasons, so
  // they are always one press away and never in the way. A thumbs down hands
  // the keyboard to the answer, so its reasons answer 1 to 4 straight away.
  const rateAnswer = useCallback((turn: ASKGTurn, rating: ASKGFeedbackRating) => {
    setSelectedId(answerStopId(turn.id));
    const current = turn.feedback?.rating ?? null;
    if (rating === "down") {
      if (inputFocused) blurInput();
      setFeedbackFollowUpTurnId((open) => (current === "down" && open === turn.id ? null : turn.id));
    } else {
      setFeedbackFollowUpTurnId((open) => (open === turn.id ? null : open));
      if (inputFocused) inputRef.current?.focus?.();
    }
    if (current === rating) return;
    void controller.rateAnswer(turn.id, rating);
  }, [blurInput, controller, inputFocused]);
  const chooseFeedbackReason = useCallback((turn: ASKGTurn, reason: ASKGFeedbackReason) => {
    if (inputFocused) inputRef.current?.focus?.();
    if (turn.feedback?.reason === reason) return;
    void controller.chooseFeedbackReason(turn.id, reason);
  }, [controller, inputFocused]);
  const shareAnswer = useCallback((turn: ASKGTurn) => {
    if (inputFocused) inputRef.current?.focus?.();
    void controller.shareAnswer(turn.id);
  }, [controller, inputFocused]);

  const expandedTables = useMemo(() => toolResultTables(expandedRow?.result), [expandedRow?.result]);
  const expandedHasRows = expandedTables.some((table) => table.rows.length > 0);
  // The panel is as tall as its longest table needs (divider, heading, the
  // section bar, column header and rows), up to half the pane.
  const expandedNeed = 3 + (expandedTables.length > 1 ? 1 : 0)
    + Math.max(0, ...expandedTables.map((table) => table.rows.length));
  const confirmationHeight = confirmation ? confirmationBlockHeight(confirmation) : 0;
  const draftLines = useMemo(() => {
    const textWidth = Math.max(8, width - sidebarWidth - (nativePaneChrome ? 6 : 5));
    return Math.min(MAX_COMPOSER_LINES, Math.max(1, wrapTextLines(inputValue, textWidth).length));
  }, [inputValue, nativePaneChrome, sidebarWidth, width]);
  const composerHeight = nativePaneChrome ? draftLines + 2 : draftLines;
  const composerBlockHeight = nativePaneChrome ? composerHeight : composerHeight + 2;
  // The conversation keeps a readable slice no matter what else is open.
  const detailBudget = height - composerBlockHeight - confirmationHeight - 6;
  const detailHeight = expandedRow && expandedHasRows && detailBudget >= MIN_DETAIL_HEIGHT
    ? Math.min(Math.floor(height / 2), detailBudget, Math.max(MIN_DETAIL_HEIGHT, expandedNeed))
    : 0;
  const resultActive = resultFocused && !!expandedRow && detailHeight > 0 && !inputFocused && !showSidebar;
  // `o` opens the pane of the result the rows belong to, else the selected row's.
  const paneRow = resultActive ? expandedRow : selectedRow;
  const canOpenPane = !!paneRow && !!resolveToolPaneTarget(paneRow.name);
  const expandTarget = resultActive ? expandedRow : selectedRow;

  const toggleResult = useCallback((row: ASKGToolRow) => {
    const expanding = expandedToolCallId !== row.toolCallId;
    toggleExpanded(row.toolCallId);
    setResultFocused(expanding && toolResultTables(row.result).some((table) => table.rows.length > 0));
  }, [expandedToolCallId, toggleExpanded]);

  // A click opens or closes a row without taking the keyboard from the
  // composer: the next thing typed is still the follow-up.
  const pressRow = useCallback((toolCallId: string) => {
    setSelectedId(toolCallId);
    toggleExpanded(toolCallId);
    if (inputFocused) inputRef.current?.focus?.();
  }, [inputFocused, toggleExpanded]);
  const pressGroup = useCallback((groupId: string) => {
    setSelectedId(groupId);
    toggleGroup(groupId);
    if (inputFocused) inputRef.current?.focus?.();
  }, [inputFocused, toggleGroup]);

  // Leaves the composer for the timeline, on the newest row (or the last example).
  const enterTimeline = useCallback(() => {
    blurInput();
    if (state.turns.length === 0) {
      setExampleIndex(examples.length - 1);
      return;
    }
    if (!selectedId && timelineIds.length > 0) setSelectedId(timelineIds[timelineIds.length - 1] ?? null);
  }, [blurInput, examples.length, selectedId, state.turns.length, timelineIds]);

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
    if (showSidebar) {
      if (isPlainKey(event, "escape", "right")) {
        consume();
        leaveSidebar();
        focusInput();
      } else if (isPlainKey(event, "enter", "return")) {
        consume();
        const target = sidebarTargetId;
        leaveSidebar();
        if (target) void openConversation(target);
        else focusInput();
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
      const empty = !readDraft().trim();
      if (isPlainKey(event, "escape")) {
        consume();
        // Leaving an empty composer counts toward a double-Esc close; a draft does not.
        if (empty) countEscapeTowardClose(event);
        blurInput();
        return;
      }
      if (empty && isPlainKey(event, "up")) {
        consume();
        enterTimeline();
        return;
      }
      if (empty && isPlainKey(event, "left") && listRoom) {
        consume();
        focusSidebar();
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
    if (state.turns.length === 0) {
      if (isPlainKey(event, "j", "down")) {
        consume();
        setExampleIndex((index) => (index === null || index >= examples.length - 1 ? null : index + 1));
        if (exampleIndex === examples.length - 1) focusInput();
        return;
      }
      if (isPlainKey(event, "k", "up")) {
        consume();
        setExampleIndex((index) => (index === null ? examples.length - 1 : Math.max(0, index - 1)));
        return;
      }
      if (isPlainKey(event, "enter", "return") && exampleIndex !== null) {
        consume();
        const question = examples[exampleIndex];
        setExampleIndex(null);
        if (question) askAndCompose(question);
        return;
      }
    }
    if (isPlainKey(event, "escape") && (selectedId || exampleIndex !== null)) {
      consume();
      setSelectedId(null);
      setExampleIndex(null);
      return;
    }
    if (isPlainKey(event, "left") && listRoom) {
      consume();
      focusSidebar();
      return;
    }
    if (isPlainKey(event, "enter", "return")) {
      consume();
      focusInput();
      return;
    }
    // With tool rows the arrows walk them; without, they scroll the answer.
    if (isPlainKey(event, "j", "down") && timelineIds.length > 0) {
      consume();
      moveSelection(1);
      return;
    }
    if (isPlainKey(event, "k", "up") && timelineIds.length > 0) {
      consume();
      moveSelection(-1);
      return;
    }
    if (isPlainKey(event, "x") && selectedGroupTurn && !resultActive) {
      consume();
      toggleGroup(toolGroupId(selectedGroupTurn.id));
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
    if (isPlainKey(event, "n") && state.turns.length > 0 && !confirmation) {
      consume();
      newConversation();
      return;
    }
    if (event.name === UPGRADE_KEY && !event.ctrl && !event.meta && !event.alt && needsUpgrade) {
      consume();
      upgrade();
      return;
    }
    if (isPlainKey(event, "r") && retryableTurn) {
      consume();
      retryAndCompose(retryableTurn.id);
      return;
    }
    if (isPlainKey(event, "c") && running) {
      consume();
      controller.cancel();
    }
  }, { allowEditable: true });

  // Hints follow the keyboard: the composer keeps only the conversation's own
  // actions (each one also a click), the sidebar its list keys, and the
  // timeline everything else.
  const hints = useMemo<PaneHint[]>(() => {
    const list: PaneHint[] = [];
    if (!planAccess.emailVerified) return list;
    if (confirmation) {
      list.push(
        { id: "approve", key: "y", label: "es approve", title: "Approve", onPress: () => controller.resolveConfirmation(confirmation.toolCallId, true) },
        { id: "decline", key: "n", label: "o decline", title: "Decline", onPress: () => controller.resolveConfirmation(confirmation.toolCallId, false) },
      );
    }
    if (showSidebar) {
      // While a write waits, n answers it.
      if (!confirmation) list.push({ id: "new", key: "n", label: "ew conversation", onPress: () => { leaveSidebar(); newConversation(); } });
      if (sidebarTargetId) list.push({ id: "delete", key: "d", label: "elete", onPress: deleteSidebarConversation });
      return list;
    }
    if (running) list.push({ id: "cancel", key: "c", label: "ancel", title: "Stop Answer", onPress: () => controller.cancel() });
    if (retryableTurn) list.push({ id: "retry", key: "r", label: retryableTurn.status === "cancelled" ? " ask again" : "etry", title: "Ask Again", onPress: () => retryAndCompose(retryableTurn.id) });
    if (needsUpgrade) list.push({ id: "upgrade", key: UPGRADE_KEY, label: "upgrade", title: "Upgrade to Pro", onPress: upgrade });
    if (!inputFocused) {
      if (resultActive) list.push({ id: "result-back", key: "Esc", label: "timeline", title: "Back to Timeline", onPress: () => setResultFocused(false) });
      if (selectedGroupTurn && !resultActive) {
        const open = openGroups.has(toolGroupId(selectedGroupTurn.id));
        list.push({
          id: "expand",
          key: "x",
          label: open ? " fold calls" : " show calls",
          title: open ? "Fold Calls" : "Show Calls",
          onPress: () => toggleGroup(toolGroupId(selectedGroupTurn.id)),
        });
      } else if (expandTarget) {
        const expanded = expandTarget.toolCallId === expandedToolCallId;
        list.push({
          id: "expand",
          key: "x",
          label: expanded ? " collapse" : "pand",
          title: expanded ? "Collapse Row" : "Expand Row",
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
    }
    if (state.turns.length > 0 && !confirmation) list.push({ id: "new", key: "n", label: "ew", title: "New Conversation", onPress: newConversation });
    if (listRoom) list.push({ id: "conversations", key: "←", label: " conversations", title: "Conversations", onPress: focusSidebar });
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
    listRoom,
    needsUpgrade,
    newConversation,
    openGroups,
    openPaneForTool,
    paneRow,
    rateAnswer,
    resultActive,
    retryAndCompose,
    retryableTurn,
    running,
    selectedGroupTurn,
    selectedRow,
    shareAnswer,
    showSidebar,
    sidebarTargetId,
    state.turns.length,
    toggleGroup,
    toggleResult,
    upgrade,
  ]);

  const quota = state.limits && state.limits.turnsRemainingToday >= 0
    ? state.limits.turnsRemainingToday
    : null;
  usePaneFooter(`askg:${paneId}`, () => ({
    info: [
      ...(running
        ? [{ id: "streaming", parts: [{ text: "Answering", tone: "muted" as const }] }]
        : []),
      ...(confirmation
        ? [{ id: "confirm", parts: [{ text: "Waiting for approval", tone: "warning" as const }] }]
        : []),
      // The answer that hit the cap already says so.
      ...(quota !== null && quota <= LOW_QUOTA && activeTurn(state)?.error?.code !== "daily_turn_cap"
        ? [{
          id: "quota",
          parts: [{
            text: quota === 0 ? "No questions left today" : `${quota} ${quota === 1 ? "question" : "questions"} left today`,
            tone: quota === 0 ? "warning" as const : "muted" as const,
          }],
        }]
        : []),
    ],
    hints,
    menu: state.turns.length === 0 && planAccess.emailVerified
      ? examples.map((question, index): ContextMenuItem => ({
        id: `example-${index}`,
        label: `Ask: ${question}`,
        onSelect: () => askAndCompose(question),
      }))
      : [],
  }), [askAndCompose, confirmation, examples, hints, planAccess.emailVerified, quota, running, state]);

  if (!planAccess.emailVerified) {
    return (
      <SignInWall
        placement="gp-signin"
        action="ask questions about anything on screen"
        needsVerification={planAccess.signedIn}
      />
    );
  }

  const bodyWidth = listCoversBody ? width : Math.max(24, width - sidebarWidth);
  const contentWidth = Math.max(24, bodyWidth - (nativePaneChrome ? 2 : 4));
  const lastTurnId = activeTurn(state)?.id ?? null;
  const placeholder = running
    ? "Gloom is answering…"
    : state.turns.length > 0
      ? "Ask a follow-up…"
      : "Ask Gloom a question…";

  return (
    <Box
      flexDirection="row"
      width={nativePaneChrome ? "100%" : width}
      height={nativePaneChrome ? "100%" : height}
      overflow="hidden"
    >
      {showSidebar ? (
        <ASKGConversationSidebar
          activeConversationId={sidebarCursorId ?? state.conversationId}
          width={sidebarWidth}
          paneWidth={width}
          height={height}
          focused={focused}
          keyboardFocused={focused}
          onSelect={(conversationId) => void openConversation(conversationId)}
          onFocusRequest={() => {
            if (inputFocused) blurInput();
            setResultFocused(false);
            setSidebarFocused(true);
          }}
          onNewConversation={() => {
            leaveSidebar();
            newConversation();
          }}
          onDelete={(conversationId) => void deleteConversation(conversationId)}
        />
      ) : null}

      <Box
        visible={!listCoversBody}
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
          <ASKGWelcome
            examples={examples}
            width={contentWidth}
            selectedIndex={inputFocused ? null : exampleIndex}
            onAsk={askAndCompose}
          />
        ) : state.turns.map((turn) => (
          <TurnView
            key={turn.id}
            turn={turn}
            width={contentWidth}
            latest={turn.id === lastTurnId}
            rateable={canRateTurn(state, turn)}
            feedbackSelected={selectedId === answerStopId(turn.id)}
            feedbackKeysShown={focused && !inputFocused && !showSidebar && feedbackTarget?.id === turn.id}
            feedbackFollowUpOpen={feedbackFollowUp?.id === turn.id}
            selectedRowRef={selectedRowRef}
            catalog={catalog}
            openTicker={openTicker}
            tools={(
              <TurnTools
                turn={turn}
                width={contentWidth}
                context={displayContext}
                selectedId={selectedId}
                expandedToolCallId={expandedToolCallId}
                openGroups={openGroups}
                selectedRowRef={selectedRowRef}
                onPressRow={pressRow}
                onPressGroup={pressGroup}
                onUndo={(toolCallId) => void controller.undo(toolCallId)}
              />
            )}
            onRetry={() => retryAndCompose(turn.id)}
            onUpgrade={upgrade}
            // The controls keep their press from the column behind them, so
            // they close the list themselves.
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
        <Box flexDirection="column" flexShrink={0}>
          <Divider />
          <ToolResultDetail
            row={expandedRow}
            view={describeToolRow(expandedRow, displayContext)}
            width={nativePaneChrome ? bodyWidth : bodyWidth - 2}
            height={detailHeight - 1}
            focused={focused && resultActive}
            canOpenPane={!!resolveToolPaneTarget(expandedRow.name)}
            openPaneShortcut={paneRow?.toolCallId === expandedRow.toolCallId && canOpenPane ? "o" : undefined}
            onOpenSymbol={openSymbol}
            onOpenPane={() => openPaneForTool(expandedRow)}
          />
        </Box>
      ) : null}

      <MessageComposer
        inputRef={inputRef}
        initialValue={inputValue}
        focused={inputFocused && focused}
        placeholder={placeholder}
        width="100%"
        height={composerHeight}
        terminalPrefix=" > "
        terminalBottomInset={nativePaneChrome ? 0 : 1}
        onFocusRequest={focusInput}
        onInput={setInputValue}
        keyBindings={[
          { name: "return", action: "submit" },
          { name: "linefeed", action: "submit" },
          { name: "return", shift: true, action: "newline" },
          { name: "linefeed", shift: true, action: "newline" },
        ]}
        onSubmit={submitInput}
        wrapText
      />
      </Box>
    </Box>
  );
}
