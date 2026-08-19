import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Box, ScrollBox, Text, TextAttributes, useUiCapabilities } from "../../../../ui";
import type { InputRenderable, ScrollBoxRenderable, TextareaRenderable } from "../../../../ui";
import { MarkdownText } from "../../../../components/markdown-text";
import {
  getPaneSidebarWidth,
  Button,
  MessageComposer,
  PaneSidebar,
  PaneSidebarAction,
  PaneSidebarRow,
  shouldShowPaneSidebar,
  Spinner,
  usePaneFooter,
} from "../../../../components";
import { useShortcut } from "../../../../react/input";
import { resolveTickerForPane, useAppDispatch, useAppSelector, usePaneInstance } from "../../../../state/app/context";
import { useInlineTickers } from "../../../../state/hooks/inline-tickers";
import type { PaneProps } from "../../../../types/plugin";
import { colors } from "../../../../theme/colors";
import { truncateWithEllipsis } from "../../../../utils/text-wrap";
import {
  usePluginAppActions,
  usePluginConfigState,
  usePluginPaneState,
  usePluginState,
} from "../../../runtime";
import { buildTickerAiContext } from "../ticker-context";
import type { AiAgentHistoryMessage } from "../agent-history";
import { resolveDefaultAiProviderId, type AiProvider } from "../providers";
import { useAiRuntimeProviders } from "../use-runtime-providers";
import {
  formatAiRunnerSelection,
  isAiProviderReady,
  modelIdAfterAiProviderChange,
  normalizeAiModelId,
  resolveReadyAiRunnerDefault,
  supportsAiRunOutputMode,
} from "../runner-selection";
import { checkAiProviderStatus, isAiRunCancelled, runAiPrompt } from "../runner";
import { AiRunnerSelector } from "../runner-selector";
import {
  AI_DEFAULT_MODEL_SETTING_KEY,
  AI_DEFAULT_PROVIDER_SETTING_KEY,
  resolveAiPaneSelection,
} from "../pane-settings";
import {
  EMPTY_LOCAL_AGENT_WORKSPACE,
  appendLocalAgentMessages,
  appendLocalAgentTranscript,
  buildLocalAgentRequestPrompt,
  buildLocalAgentTranscript,
  createLocalAgentThread,
  normalizeLocalAgentWorkspace,
  removeLocalAgentMessages,
  type LocalAgentAttachmentPayload,
  type LocalAgentWorkspaceState,
} from "./model";

export const LOCAL_AGENT_WORKSPACE_STATE_KEY = "local-agent-workspace";
export const LOCAL_AGENT_WORKSPACE_SCHEMA_VERSION = 1;

function providerLabel(providerId: string): string {
  if (providerId === "anthropic") return "Claude";
  if (providerId === "claude") return "Claude";
  if (providerId === "google") return "Google Gemini";
  if (providerId === "gemini") return "Gemini";
  if (providerId === "openai-codex") return "OpenAI";
  if (providerId === "codex") return "OpenAI";
  if (providerId === "openai") return "OpenAI API";
  if (providerId === "github-copilot") return "GitHub Copilot";
  if (providerId === "xai") return "xAI / Grok";
  if (providerId === "openrouter") return "OpenRouter";
  if (providerId === "opencode") return "OpenCode";
  if (providerId === "pi") return "Pi";
  return providerId;
}

function providerPrerequisite(provider: AiProvider): string {
  if (isAiProviderReady(provider)) return `${provider.name} is ready.`;
  return `${provider.name} is not connected. Open settings to sign in or configure access.`;
}

function WorkspaceProviderChooser({
  providers,
  selectedIndex,
  checkingProviderId,
  statusMessage,
  modelId,
  modelInputRef,
  modelFocused,
  onSelectIndex,
  onModelChange,
  onModelFocusRequest,
  onModelBlur,
  onConfigure,
}: {
  providers: AiProvider[];
  selectedIndex: number;
  checkingProviderId: string | null;
  statusMessage: string | null;
  modelId: string;
  modelInputRef: RefObject<InputRenderable | null>;
  modelFocused: boolean;
  onSelectIndex: (index: number) => void;
  onModelChange: (modelId: string) => void;
  onModelFocusRequest: () => void;
  onModelBlur: () => void;
  onConfigure: () => void;
}) {
  const selectedProvider = providers[selectedIndex] ?? providers[0] ?? null;
  return (
    <Box flexDirection="column" paddingX={1} paddingTop={1} flexGrow={1}>
      <Text fg={colors.textBright} attributes={TextAttributes.BOLD}>Choose an AI provider</Text>
      <Text fg={colors.textDim}>Provider and model are fixed for this thread. Create another thread to switch.</Text>
      <Box height={1} />
      {statusMessage && <Text fg={colors.warning}>{statusMessage}</Text>}
      <AiRunnerSelector
        providers={providers}
        providerId={selectedProvider?.id ?? ""}
        modelId={modelId}
        description={selectedProvider ? (
          <Text fg={isAiProviderReady(selectedProvider) ? colors.textDim : colors.warning}>
            {checkingProviderId === selectedProvider.id
              ? "Checking account…"
              : providerPrerequisite(selectedProvider)}
          </Text>
        ) : null}
        onProviderChange={(providerId) => {
          const index = providers.findIndex((provider) => provider.id === providerId);
          if (index >= 0) onSelectIndex(index);
        }}
        onModelChange={onModelChange}
        modelInputRef={modelInputRef}
        modelFocused={modelFocused}
        onModelFocusRequest={onModelFocusRequest}
        onModelBlur={onModelBlur}
        modelHint="Press m to choose from the Pi model catalog."
      />
      {selectedProvider && !isAiProviderReady(selectedProvider) && (
        <Box paddingTop={1}>
          <Button
            label={`Configure ${selectedProvider.name}`}
            variant="primary"
            shortcut="s"
            onPress={onConfigure}
          />
        </Box>
      )}
      <Box height={1} />
      <Text fg={colors.textMuted}>↑/↓ provider · m model · Enter create · s settings · Esc return to threads</Text>
    </Box>
  );
}

export function LocalAgentWorkspacePane({ paneId, focused, width, height }: PaneProps) {
  const { nativePaneChrome } = useUiCapabilities();
  const dispatch = useAppDispatch();
  const paneInstance = usePaneInstance();
  const { openPaneSettings } = usePluginAppActions();
  const providers = useAiRuntimeProviders();
  const workspaceProviders = useMemo(
    () => providers.filter((provider) => supportsAiRunOutputMode(provider, "structured")),
    [providers],
  );
  const fallbackProviderId = resolveDefaultAiProviderId(workspaceProviders);
  const [defaultProviderId] = usePluginConfigState<string>(
    AI_DEFAULT_PROVIDER_SETTING_KEY,
    fallbackProviderId,
  );
  const [defaultModelId] = usePluginConfigState<string>(AI_DEFAULT_MODEL_SETTING_KEY, "");
  const workspaceDefaults = resolveReadyAiRunnerDefault(
    workspaceProviders,
    defaultProviderId,
    defaultModelId,
  );
  const workspaceDefaultProviderId = workspaceDefaults.providerId;
  const preferredProviderIndex = Math.max(
    0,
    workspaceProviders.findIndex((provider) => provider.id === workspaceDefaultProviderId),
  );
  const workspaceDefaultModelId = workspaceDefaults.modelId ?? "";
  const [persistedWorkspace, setPersistedWorkspace] = usePluginState<LocalAgentWorkspaceState>(
    LOCAL_AGENT_WORKSPACE_STATE_KEY,
    EMPTY_LOCAL_AGENT_WORKSPACE,
    { schemaVersion: LOCAL_AGENT_WORKSPACE_SCHEMA_VERSION },
  );
  const workspace = useMemo(() => normalizeLocalAgentWorkspace(persistedWorkspace), [persistedWorkspace]);
  const requestedNewThreadId = typeof paneInstance?.params?.newThreadId === "string"
    ? paneInstance.params.newThreadId.trim()
    : "";
  const pendingNewThreadId = requestedNewThreadId
    && !workspace.threads.some((thread) => thread.id === requestedNewThreadId)
    ? requestedNewThreadId
    : null;
  const [paneThreadId, setPaneThreadId] = usePluginPaneState<string | null>("activeThreadId", null);
  const activeThread = workspace.threads.find((thread) => thread.id === paneThreadId)
    ?? workspace.threads.find((thread) => thread.id === workspace.activeThreadId)
    ?? null;
  const activeSelection = useMemo(() => resolveAiPaneSelection({
    settings: paneInstance?.settings,
    savedProviderId: activeThread?.providerId,
    savedModelId: activeThread?.modelId,
    defaultProviderId: workspaceDefaultProviderId,
    defaultModelId: workspaceDefaultModelId,
  }), [activeThread?.modelId, activeThread?.providerId, paneInstance?.settings, workspaceDefaultModelId, workspaceDefaultProviderId]);
  const activeThreadProviderSupported = activeThread
    ? providers.some((provider) => provider.id === activeThread.providerId)
    : true;
  const [creating, setCreating] = useState(() => (
    workspace.threads.length === 0 || pendingNewThreadId !== null
  ));
  const [selectedProviderIndex, setSelectedProviderIndex] = useState(preferredProviderIndex);
  const providerSelectionTouchedRef = useRef(false);
  const [modelId, setModelId] = useState(workspaceDefaultModelId);
  const [modelInputFocused, setModelInputFocused] = useState(false);
  const [checkingProviderId, setCheckingProviderId] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [inputFocused, setInputFocused] = useState(false);
  const [inputValue, setInputValue] = useState("");
  const [attachments, setAttachments] = useState<LocalAgentAttachmentPayload[]>([]);
  const [runningMessageId, setRunningMessageId] = useState<string | null>(null);
  const [streamingOutput, setStreamingOutput] = useState("");
  const inputRef = useRef<TextareaRenderable | null>(null);
  const modelInputRef = useRef<InputRenderable | null>(null);
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const runRef = useRef<{
    controller: ReturnType<typeof runAiPrompt>;
    threadId: string;
    assistantMessageId: string;
  } | null>(null);
  const busyRef = useRef(false);
  const seededRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    if (!paneThreadId && activeThread) setPaneThreadId(activeThread.id);
  }, [activeThread, paneThreadId, setPaneThreadId]);

  const previousSymbol = useAppSelector((state) => {
    const previous = state.previousFocusedPaneId
      ? resolveTickerForPane(state, state.previousFocusedPaneId)
      : null;
    return previous ?? state.recentTickers[0] ?? null;
  });
  const selectedTicker = useAppSelector((state) => previousSymbol ? state.tickers.get(previousSymbol) ?? null : null);
  const selectedFinancials = useAppSelector((state) => previousSymbol ? state.financials.get(previousSymbol) ?? null : null);
  const baseCurrency = useAppSelector((state) => state.config.baseCurrency);
  const exchangeRates = useAppSelector((state) => state.exchangeRates);

  const updateWorkspace = useCallback((updater: (current: LocalAgentWorkspaceState) => LocalAgentWorkspaceState) => {
    setPersistedWorkspace((current) => updater(normalizeLocalAgentWorkspace(current)));
  }, [setPersistedWorkspace]);

  const clearDraft = useCallback(() => {
    setInputValue("");
    inputRef.current?.editBuffer.setText?.("");
    setAttachments([]);
  }, []);

  const beginCreateThread = useCallback(() => {
    providerSelectionTouchedRef.current = false;
    setSelectedProviderIndex(preferredProviderIndex);
    setModelId(workspaceDefaultModelId);
    setCreating(true);
  }, [preferredProviderIndex, workspaceDefaultModelId]);

  const selectProviderForCreation = useCallback((index: number) => {
    const provider = workspaceProviders[index];
    if (!provider) return;
    providerSelectionTouchedRef.current = true;
    setSelectedProviderIndex(index);
    setModelId(modelIdAfterAiProviderChange(
      provider.id,
      workspaceDefaultProviderId,
      workspaceDefaultModelId,
    ));
  }, [workspaceDefaultModelId, workspaceDefaultProviderId, workspaceProviders]);

  useEffect(() => {
    if (!creating || providerSelectionTouchedRef.current) return;
    setSelectedProviderIndex(preferredProviderIndex);
  }, [creating, preferredProviderIndex]);

  const openConfiguration = useCallback(() => {
    openPaneSettings(paneId);
  }, [openPaneSettings, paneId]);

  const focusModelInput = useCallback(() => {
    setModelInputFocused(true);
    dispatch({ type: "SET_INPUT_CAPTURED", captured: true });
    modelInputRef.current?.focus?.();
  }, [dispatch]);

  const blurModelInput = useCallback(() => {
    setModelInputFocused(false);
    dispatch({ type: "SET_INPUT_CAPTURED", captured: false });
  }, [dispatch]);

  const createThread = useCallback(async (provider: AiProvider, modelOverride = "", threadId?: string) => {
    if (busyRef.current || runRef.current) return;
    blurModelInput();
    busyRef.current = true;
    setCheckingProviderId(provider.id);
    setStatusMessage(null);
    try {
      const status = await checkAiProviderStatus(provider);
      if (!mountedRef.current) return;
      if (!status.available || (!status.authenticated && !status.inconclusive)) {
        setStatusMessage(status.message ?? `${provider.name} is not ready.`);
        return;
      }
      if (status.inconclusive) {
        setStatusMessage(status.message ?? `Couldn't verify ${provider.name} sign-in; attempting anyway.`);
      }
      const nextThreadId = threadId ?? crypto.randomUUID();
      updateWorkspace((current) => createLocalAgentThread(
        current,
        provider.id,
        {
          id: nextThreadId,
          modelId: normalizeAiModelId(modelOverride),
          providerLabel: provider.name,
        },
      ));
      setPaneThreadId(nextThreadId);
      clearDraft();
      setModelId("");
      setCreating(false);
    } catch (error) {
      if (mountedRef.current) {
        setStatusMessage(error instanceof Error ? error.message : `${provider.name} status check failed.`);
      }
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setCheckingProviderId(null);
    }
  }, [blurModelInput, clearDraft, setPaneThreadId, updateWorkspace]);

  useEffect(() => {
    if (seededRef.current) return;
    seededRef.current = true;
    const providerId = paneInstance?.params?.providerId;
    const threadId = paneInstance?.params?.threadId;
    const provider = providers.find((entry) => entry.id === providerId);
    const providerIndex = workspaceProviders.findIndex((entry) => entry.id === providerId);
    if (provider && typeof threadId === "string") {
      if (providerIndex >= 0) setSelectedProviderIndex(providerIndex);
      const seededModelId = normalizeAiModelId(paneInstance?.params?.modelId) ?? "";
      setModelId(seededModelId);
      if (workspace.threads.some((thread) => thread.id === threadId)) {
        setPaneThreadId(threadId);
        setCreating(false);
      } else {
        void createThread(provider, seededModelId, threadId);
      }
    }
  }, [createThread, paneInstance?.params?.modelId, paneInstance?.params?.providerId, paneInstance?.params?.threadId, providers, setPaneThreadId, workspace.threads, workspaceProviders]);

  useEffect(() => {
    if (!focused) return;
    const scroll = scrollRef.current;
    if (!scroll?.viewport || !activeThread?.messages.length) return;
    scroll.scrollTo({ x: 0, y: Math.max(0, scroll.scrollHeight - scroll.viewport.height) });
  }, [activeThread?.messages, focused]);

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

  useEffect(() => {
    if (!focused && modelInputFocused) blurModelInput();
  }, [blurModelInput, focused, modelInputFocused]);

  const cycleThread = useCallback((direction: -1 | 1) => {
    if (!activeThread || busyRef.current || workspace.threads.length < 2) return;
    const currentIndex = workspace.threads.findIndex((thread) => thread.id === activeThread.id);
    const nextIndex = (currentIndex + direction + workspace.threads.length) % workspace.threads.length;
    const nextThread = workspace.threads[nextIndex];
    if (!nextThread) return;
    setPaneThreadId(nextThread.id);
    clearDraft();
    setStatusMessage(null);
  }, [activeThread, clearDraft, setPaneThreadId, workspace.threads]);

  const attachSelectedTicker = useCallback(() => {
    if (!selectedTicker || !previousSymbol) {
      setStatusMessage("Select a ticker in another pane before attaching context.");
      return;
    }
    const content = buildTickerAiContext(selectedTicker, selectedFinancials, baseCurrency, exchangeRates);
    const attachment: LocalAgentAttachmentPayload = {
      id: `ticker:${previousSymbol}:${Date.now()}`,
      kind: "ticker",
      label: `Ticker ${previousSymbol}`,
      preview: content.split("\n").slice(0, 4).join(" · "),
      content,
    };
    setAttachments([attachment]);
    setStatusMessage(null);
  }, [baseCurrency, exchangeRates, previousSymbol, selectedFinancials, selectedTicker]);

  const removeAttachments = useCallback(() => {
    setAttachments([]);
  }, []);

  const cancelRun = useCallback(() => {
    runRef.current?.controller.cancel();
  }, []);

  const sendMessage = useCallback(async (text: string) => {
    if (!activeThread || runRef.current || busyRef.current) return;
    if (!activeThreadProviderSupported) {
      setStatusMessage(
        `This ${providerLabel(activeThread.providerId)} thread is read-only because its provider is no longer supported. Create a new thread to continue.`,
      );
      return;
    }
    const provider = providers.find((entry) => entry.id === activeSelection.providerId);
    if (!provider) {
      setStatusMessage("This thread's AI provider is no longer configured.");
      return;
    }

    busyRef.current = true;
    setCheckingProviderId(provider.id);
    try {
      const providerStatus = await checkAiProviderStatus(provider);
      if (!mountedRef.current) return;
      if (!providerStatus.available || (!providerStatus.authenticated && !providerStatus.inconclusive)) {
        setStatusMessage(providerStatus.message ?? `${provider.name} is not ready.`);
        busyRef.current = false;
        return;
      }
    } catch (error) {
      if (mountedRef.current) {
        setStatusMessage(error instanceof Error ? error.message : `${provider.name} status check failed.`);
      }
      busyRef.current = false;
      return;
    } finally {
      if (mountedRef.current) setCheckingProviderId(null);
    }

    const now = Date.now();
    const userMessageId = crypto.randomUUID();
    const assistantMessageId = crypto.randomUUID();
    const attachmentMetadata = attachments.map(({ content: _content, ...metadata }) => metadata);
    const prompt = buildLocalAgentRequestPrompt(text, attachments);
    const priorAgentMessages = buildLocalAgentTranscript(activeThread);
    const transcriptPrefix = activeThread.agentMessages.length > 0
      ? []
      : priorAgentMessages;
    updateWorkspace((current) => appendLocalAgentMessages(current, activeThread.id, [{
      id: userMessageId,
      role: "user",
      content: text,
      createdAt: now,
      attachments: attachmentMetadata,
    }]));
    setInputValue("");
    inputRef.current?.editBuffer.setText?.("");
    setAttachments([]);
    setStatusMessage(null);
    setRunningMessageId(assistantMessageId);
    setStreamingOutput("");

    let streamedOutput = "";
    let completedAgentMessages: AiAgentHistoryMessage[] = [];
    try {
      const controller = runAiPrompt({
        providerId: provider.id,
        prompt,
        agentMessages: priorAgentMessages,
        modelId: activeSelection.modelId ?? undefined,
        outputMode: "structured",
        onChunk: (output) => {
          if (!mountedRef.current) return;
          streamedOutput = output;
          setStreamingOutput(streamedOutput);
        },
        onAgentMessages: (messages) => {
          completedAgentMessages = messages;
        },
      });
      runRef.current = { controller, threadId: activeThread.id, assistantMessageId };
      const output = await controller.done;
      if (!mountedRef.current) return;
      setRunningMessageId(null);
      setStreamingOutput("");
      const transcriptDelta = completedAgentMessages.length
        ? completedAgentMessages
        : [
            { role: "user" as const, content: prompt },
            {
              role: "assistant" as const,
              content: [{ type: "text" as const, text: output }],
            },
          ];
      updateWorkspace((current) => appendLocalAgentTranscript(
        appendLocalAgentMessages(current, activeThread.id, [{
          id: assistantMessageId,
          role: "assistant",
          content: output,
          createdAt: Date.now(),
          status: "complete",
        }]),
        activeThread.id,
        [...transcriptPrefix, ...transcriptDelta],
      ));
    } catch (error) {
      if (isAiRunCancelled(error)) {
        updateWorkspace((current) => appendLocalAgentTranscript(
          appendLocalAgentMessages(current, activeThread.id, [{
            id: assistantMessageId,
            role: "assistant",
            content: streamedOutput || "Cancelled before a response was received.",
            createdAt: Date.now(),
            status: "cancelled",
          }]),
          activeThread.id,
          [...transcriptPrefix, { role: "user", content: prompt }],
        ));
      } else if (!streamedOutput) {
        updateWorkspace((current) => removeLocalAgentMessages(
          current,
          activeThread.id,
          [userMessageId],
        ));
        if (mountedRef.current) {
          setInputValue(text);
          inputRef.current?.editBuffer.setText?.(text);
          setAttachments(attachments);
          setStatusMessage(error instanceof Error ? error.message : `${provider.name} failed to start.`);
        }
      } else {
        const message = error instanceof Error ? error.message : `${provider.name} failed.`;
        updateWorkspace((current) => appendLocalAgentTranscript(
          appendLocalAgentMessages(current, activeThread.id, [{
            id: assistantMessageId,
            role: "assistant",
            content: `${streamedOutput}\n\nError: ${message}`,
            createdAt: Date.now(),
            status: "error",
          }]),
          activeThread.id,
          [...transcriptPrefix, { role: "user", content: prompt }],
        ));
        if (mountedRef.current) setStatusMessage(message);
      }
    } finally {
      runRef.current = null;
      busyRef.current = false;
      if (mountedRef.current) {
        setRunningMessageId(null);
        setStreamingOutput("");
      }
    }
  }, [activeSelection.modelId, activeSelection.providerId, activeThread, activeThreadProviderSupported, attachments, providers, updateWorkspace]);

  const submitInput = useCallback(() => {
    const value = inputRef.current?.editBuffer.getText() ?? inputValue;
    const trimmed = value.trim();
    if (trimmed) void sendMessage(trimmed);
  }, [inputValue, sendMessage]);

  useShortcut((event) => {
    if (!focused) return;
    const isEnter = event.name === "enter" || event.name === "return";
    if (inputFocused) {
      if (event.name === "escape") blurInput();
      return;
    }
    if (creating) {
      if (modelInputFocused) {
        if (event.name === "escape") {
          event.stopPropagation?.();
          event.preventDefault?.();
          blurModelInput();
        }
        return;
      }
      if (event.name === "escape" && workspace.threads.length > 0) setCreating(false);
      if (event.name === "m") {
        event.stopPropagation?.();
        event.preventDefault?.();
        focusModelInput();
        return;
      }
      if (event.name === "s") {
        event.stopPropagation?.();
        event.preventDefault?.();
        openConfiguration();
        return;
      }
      if (workspaceProviders.length === 0) return;
      if (event.name === "up") {
        selectProviderForCreation(
          (selectedProviderIndex - 1 + workspaceProviders.length) % workspaceProviders.length,
        );
      }
      if (event.name === "down") {
        selectProviderForCreation((selectedProviderIndex + 1) % workspaceProviders.length);
      }
      const selectedProvider = workspaceProviders[selectedProviderIndex];
      if (isEnter && selectedProvider) {
        void createThread(selectedProvider, modelId, pendingNewThreadId ?? undefined);
      }
      return;
    }
    if (isEnter && activeThreadProviderSupported) focusInput();
    if (event.name === "n" && !busyRef.current) {
      beginCreateThread();
    }
    if (event.name === "a" && activeThreadProviderSupported) attachSelectedTicker();
    if (event.name === "x" && activeThreadProviderSupported) removeAttachments();
    if (event.name === "c" && runRef.current) cancelRun();
    if (event.name === "[") cycleThread(-1);
    if (event.name === "]") cycleThread(1);
  }, { allowEditable: true });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      busyRef.current = false;
      runRef.current?.controller.cancel();
      dispatch({ type: "SET_INPUT_CAPTURED", captured: false });
    };
  }, [dispatch]);

  usePaneFooter("local-agent-workspace", () => ({
    info: runningMessageId
      ? [{ id: "running", parts: [{ text: "Streaming reply", tone: "positive" as const, bold: true }] }]
      : checkingProviderId
        ? [{ id: "checking", parts: [{ text: "Checking account", tone: "muted" as const }] }]
        : statusMessage
          ? [{ id: "error", parts: [{ text: statusMessage, tone: "warning" as const }] }]
          : [],
    hints: creating
      ? [{
          id: "settings",
          key: "s",
          label: "ettings",
          onPress: openConfiguration,
        }]
      : [],
  }), [checkingProviderId, creating, openConfiguration, runningMessageId, statusMessage]);

  const messageText = activeThread?.messages.map((message) => message.content) ?? [];
  const { catalog, openTicker } = useInlineTickers(messageText);

  if (workspaceProviders.length === 0 && !activeThread) {
    return (
      <Box flexDirection="column" paddingX={1} paddingTop={1}>
        <Text fg={colors.warning}>No supported AI providers are available.</Text>
        <Text fg={colors.textDim}>Open pane settings to review AI provider configuration.</Text>
        <Box paddingTop={1}>
          <Button label="Open AI settings" variant="primary" shortcut="s" onPress={openConfiguration} />
        </Box>
      </Box>
    );
  }

  if (creating || !activeThread) {
    return (
      <WorkspaceProviderChooser
        providers={workspaceProviders}
        selectedIndex={selectedProviderIndex}
        checkingProviderId={checkingProviderId}
        statusMessage={statusMessage}
        modelId={modelId}
        modelInputRef={modelInputRef}
        modelFocused={modelInputFocused && focused}
        onSelectIndex={selectProviderForCreation}
        onModelChange={setModelId}
        onModelFocusRequest={focusModelInput}
        onModelBlur={blurModelInput}
        onConfigure={openConfiguration}
      />
    );
  }

  const showSidebar = shouldShowPaneSidebar(workspace.threads.length, width, height, 1);
  const sidebarWidth = showSidebar ? getPaneSidebarWidth(width, !!nativePaneChrome) : 0;
  const contentWidth = Math.max(20, width - sidebarWidth - (nativePaneChrome ? 0 : 2));
  // Separators, prev/next arrows, and "+ New" take about 30 cells on top of the
  // provider/model label.
  const narrowHeaderTitleWidth = Math.max(
    6,
    contentWidth - 30 - formatAiRunnerSelection(
      providerLabel(activeThreadProviderSupported ? activeSelection.providerId : activeThread.providerId),
      activeThreadProviderSupported ? activeSelection.modelId : activeThread.modelId,
    ).length,
  );
  const composerHeight = nativePaneChrome ? 3 : 2;

  return (
    <Box flexDirection="row" width={nativePaneChrome ? "100%" : width} height={nativePaneChrome ? "100%" : height} overflow="hidden">
      {showSidebar && (
        <PaneSidebar width={sidebarWidth} height={height} focused={focused}>
          {({ backgroundColor, listWidth }) => (
            <>
              <Box height={1} width={listWidth} paddingLeft={1} flexDirection="row" backgroundColor={backgroundColor}>
                <Text fg={colors.textDim}>Threads</Text>
                <Box flexGrow={1} />
                <PaneSidebarAction
                  width={5}
                  ariaLabel="Create AI thread"
                  disabled={busyRef.current}
                  onPress={() => {
                    beginCreateThread();
                  }}
                >
                  {({ foregroundColor, onMouseDown }) => (
                    <Text fg={foregroundColor} onMouseDown={onMouseDown}>+ New</Text>
                  )}
                </PaneSidebarAction>
              </Box>
              <ScrollBox flexGrow={1} scrollY focusable={false}>
                {workspace.threads.map((thread) => {
                  const selected = thread.id === activeThread.id;
                  const supported = providers.some((provider) => provider.id === thread.providerId);
                  return (
                    <PaneSidebarRow
                      key={thread.id}
                      active={selected}
                      disabled={busyRef.current}
                      height={2}
                      ariaLabel={`Open AI thread ${thread.title}`}
                      onSelect={() => {
                        setPaneThreadId(thread.id);
                        clearDraft();
                        setStatusMessage(null);
                      }}
                    >
                      {({ foregroundColor, onMouseDown }) => (
                        <Box flexDirection="column" width={listWidth} paddingX={1} onMouseDown={onMouseDown}>
                          <Text fg={foregroundColor} attributes={selected ? TextAttributes.BOLD : 0} onMouseDown={onMouseDown}>
                            {truncateWithEllipsis(thread.title, Math.max(listWidth - 2, 1))}
                          </Text>
                          <Text fg={selected ? foregroundColor : colors.textMuted} onMouseDown={onMouseDown}>
                            {truncateWithEllipsis(
                              `${formatAiRunnerSelection(providerLabel(thread.providerId), thread.modelId)}${supported ? "" : " · unsupported"}`,
                              Math.max(listWidth - 2, 1),
                            )}
                          </Text>
                        </Box>
                      )}
                    </PaneSidebarRow>
                  );
                })}
              </ScrollBox>
            </>
          )}
        </PaneSidebar>
      )}

      <Box flexDirection="column" flexGrow={1} minWidth={0} overflow="hidden">
        <Box height={1} paddingX={1} flexDirection="row" overflow="hidden">
          <Text fg={colors.positive} attributes={TextAttributes.BOLD}>
            {formatAiRunnerSelection(
              providerLabel(activeThreadProviderSupported ? activeSelection.providerId : activeThread.providerId),
              activeThreadProviderSupported ? activeSelection.modelId : activeThread.modelId,
            )}
          </Text>
          <Text fg={colors.textDim}> · persistent thread</Text>
          {!showSidebar && (
            <>
              <Text fg={colors.textDim}> · </Text>
              <Text fg={colors.textBright} onMouseDown={() => cycleThread(-1)} style={{ cursor: "pointer" }}>‹ </Text>
              {/* Truncated so a long title cannot push the prev, next, and New
                  controls off the single header row. */}
              <Text fg={colors.text}>{truncateWithEllipsis(activeThread.title, narrowHeaderTitleWidth)}</Text>
              <Text fg={colors.textBright} onMouseDown={() => cycleThread(1)} style={{ cursor: "pointer" }}> ›</Text>
              <Text fg={colors.textBright} onMouseDown={() => { if (!busyRef.current) beginCreateThread(); }} style={{ cursor: "pointer" }}>  + New</Text>
            </>
          )}
        </Box>

        {!activeThreadProviderSupported && (
          <Box paddingX={1}>
            <Text fg={colors.warning}>
              This legacy thread is read-only because {providerLabel(activeThread.providerId)} is no longer supported. Create a new thread to continue.
            </Text>
          </Box>
        )}

        <ScrollBox ref={scrollRef} flexGrow={1} minHeight={0} scrollY focusable={false} paddingX={1}>
          {activeThread.messages.length === 0 ? (
            <Box flexDirection="column" paddingTop={1}>
              <Text fg={colors.textDim}>Start a research conversation. No financial context is attached automatically.</Text>
              <Text fg={colors.textMuted}>Press a to attach the selected ticker, then review the preview before sending.</Text>
            </Box>
          ) : activeThread.messages.map((message) => (
            <Box key={message.id} flexDirection="column" paddingTop={1}>
              <Text
                fg={message.role === "user" ? colors.textBright : colors.positive}
                attributes={TextAttributes.BOLD}
              >
                {message.role === "user"
                  ? "You"
                  : providerLabel(activeThreadProviderSupported ? activeSelection.providerId : activeThread.providerId)}
                {message.id === runningMessageId ? " · streaming" : message.status === "cancelled" ? " · cancelled" : ""}
              </Text>
              {message.attachments?.map((attachment) => (
                <Text key={attachment.id} fg={colors.warning}>Attached: {attachment.label}</Text>
              ))}
              {message.content ? (
                <MarkdownText
                  text={message.content}
                  lineWidth={contentWidth}
                  catalog={catalog}
                  textColor={colors.text}
                  openTicker={openTicker}
                />
              ) : message.id === runningMessageId ? (
                <Spinner label="Waiting for provider…" />
              ) : null}
            </Box>
          ))}
          {runningMessageId && (
            <Box flexDirection="column" paddingTop={1}>
              <Text fg={colors.positive} attributes={TextAttributes.BOLD}>
                {providerLabel(activeThreadProviderSupported ? activeSelection.providerId : activeThread.providerId)} · streaming
              </Text>
              {streamingOutput ? (
                <MarkdownText
                  text={streamingOutput}
                  lineWidth={contentWidth}
                  catalog={catalog}
                  textColor={colors.text}
                  openTicker={openTicker}
                />
              ) : (
                <Spinner label="Waiting for provider…" />
              )}
            </Box>
          )}
        </ScrollBox>

        {statusMessage && (
          <Box paddingX={1}><Text fg={colors.warning}>{statusMessage}</Text></Box>
        )}
        {activeThreadProviderSupported ? (
          <>
            <Box flexDirection="column" paddingX={1}>
              {attachments.map((attachment) => (
                <Box key={attachment.id} flexDirection="column" backgroundColor={colors.panel} paddingX={1}>
                  <Box flexDirection="row">
                    <Text fg={colors.warning} attributes={TextAttributes.BOLD}>Attached: {attachment.label}</Text>
                    <Box flexGrow={1} />
                    <Text fg={colors.textBright} onMouseDown={removeAttachments} style={{ cursor: "pointer" }}>Remove</Text>
                  </Box>
                  <ScrollBox height={Math.min(8, Math.max(3, height - 12))} scrollY focusable={false}>
                    <Text fg={colors.textDim}>{attachment.content}</Text>
                  </ScrollBox>
                </Box>
              ))}
              <Box height={1} flexDirection="row">
                <Text fg={colors.textBright} onMouseDown={attachSelectedTicker} style={{ cursor: "pointer" }}>
                  {attachments.length > 0 ? "Replace context" : `Attach ${previousSymbol ? previousSymbol : "selected ticker"}`}
                </Text>
                {runningMessageId && (
                  <Text fg={colors.warning} onMouseDown={cancelRun} style={{ cursor: "pointer" }}>  Cancel</Text>
                )}
              </Box>
            </Box>
            <MessageComposer
              inputRef={inputRef}
              initialValue={inputValue}
              focused={inputFocused && focused}
              placeholder={`Message ${providerLabel(activeSelection.providerId)}…`}
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
          </>
        ) : (
          <Box height={composerHeight} paddingX={1}>
            <Text fg={colors.textMuted}>Read-only legacy history</Text>
          </Box>
        )}
      </Box>
    </Box>
  );
}
