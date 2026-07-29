import { Box, ScrollBox, Text, useUiCapabilities } from "../../../ui";
import { useRef, useEffect, useState, useCallback, type SetStateAction } from "react";
import { useShortcut } from "../../../react/input";
import { TextAttributes } from "../../../ui";
import { type ScrollBoxRenderable, type TextareaRenderable } from "../../../ui";
import type { TickerResearchTabProps } from "../../../types/plugin";
import { useAppSelector, usePaneTicker } from "../../../state/app/context";
import { useFxRatesMap } from "../../../market-data/hooks";
import { usePluginConfigState, usePluginState } from "../../runtime";
import { useInlineTickers } from "../../../state/hooks/inline-tickers";
import { MarkdownText } from "../../../components/markdown-text";
import { getMessageComposerBlockHeight, MessageComposer, Spinner, usePaneFooter } from "../../../components";
import { colors } from "../../../theme/colors";
import { t } from "../../../i18n";
import { buildTickerAiContext } from "./ticker-context";
import {
  migrateLegacyAiProviderId,
  resolveDefaultAiProviderId,
} from "./providers";
import { runAiPrompt, type AiConversationMessage } from "./runner";
import { isAiProviderReady, resolveReadyAiRunnerDefault } from "./runner-selection";
import {
  AI_DEFAULT_MODEL_SETTING_KEY,
  AI_DEFAULT_PROVIDER_SETTING_KEY,
} from "./pane-settings";
import { useAiRuntimeProviders } from "./use-runtime-providers";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  loading?: boolean;
}

interface PersistedConversation {
  updatedAt: number;
  messages: ChatMessage[];
}

const ASK_AI_HISTORY_LIMIT = 40;
const ASK_AI_RETENTION_MS = 90 * 24 * 60 * 60_000;
const chatHistories = new Map<string, ChatMessage[]>();
const LEGACY_HISTORY_PROVIDER_IDS: Readonly<Record<string, string>> = {
  anthropic: "claude",
  "openai-codex": "codex",
  google: "gemini",
};

function sameMessages(left: readonly ChatMessage[], right: readonly ChatMessage[]): boolean {
  return left.length === right.length && left.every((message, index) => {
    const other = right[index];
    if (!other) return false;
    return message.role === other.role
      && message.content === other.content
      && message.loading === other.loading;
  });
}

function historyKeyFor(providerId: string, symbol: string): string {
  return `conversation:${providerId}:${symbol}`;
}

export function __setAskAiHistoryForTests(symbol: string, messages: ChatMessage[]): void {
  chatHistories.set(historyKeyFor("anthropic", symbol), messages);
  chatHistories.set(historyKeyFor("claude", symbol), messages);
  chatHistories.set(symbol, messages);
}

export function __resetAskAiHistoryForTests(): void {
  chatHistories.clear();
}

function completedConversation(messages: readonly ChatMessage[]): AiConversationMessage[] {
  const completed: AiConversationMessage[] = [];
  let pendingUser: AiConversationMessage | null = null;

  for (const message of messages) {
    if (message.loading || !message.content.trim()) continue;
    if (message.role === "user") {
      pendingUser = { role: "user", content: message.content };
      continue;
    }
    if (!pendingUser || message.content.startsWith("Error:")) {
      pendingUser = null;
      continue;
    }
    completed.push(pendingUser, { role: "assistant", content: message.content });
    pendingUser = null;
  }

  return completed;
}

export function AskAiResearchTab({ width, height, focused, onCapture }: TickerResearchTabProps) {
  const { nativePaneChrome } = useUiCapabilities();
  const baseCurrency = useAppSelector((state) => state.config.baseCurrency);
  const cachedExchangeRates = useAppSelector((state) => state.exchangeRates);
  const { ticker, financials } = usePaneTicker();
  const exchangeRates = useFxRatesMap([
    baseCurrency,
    ticker?.metadata.currency,
    financials?.quote?.currency,
    ...(ticker?.metadata.positions.map((position) => position.currency) ?? []),
  ]);
  const effectiveExchangeRates = exchangeRates.size > 1 || cachedExchangeRates.size === 0
    ? exchangeRates
    : cachedExchangeRates;
  const providers = useAiRuntimeProviders();
  const fallbackProviderId = resolveDefaultAiProviderId(providers);
  const [configuredDefaultProviderId] = usePluginConfigState<string>(
    AI_DEFAULT_PROVIDER_SETTING_KEY,
    fallbackProviderId,
  );
  const [configuredDefaultModelId] = usePluginConfigState<string>(AI_DEFAULT_MODEL_SETTING_KEY, "");
  const defaults = resolveReadyAiRunnerDefault(
    providers,
    configuredDefaultProviderId,
    configuredDefaultModelId,
  );
  const defaultProviderId = defaults.providerId;
  const [providerId, setProviderId] = usePluginState<string>("providerId", defaultProviderId);
  const canonicalProviderId = migrateLegacyAiProviderId(providerId);
  const [conversationMessagesByKey, setConversationMessagesByKey] = useState<Record<string, ChatMessage[]>>({});
  const [inputFocused, setInputFocused] = useState(false);
  const [inputValue, setInputValue] = useState("");
  const inputRef = useRef<TextareaRenderable>(null);
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  const runRef = useRef<ReturnType<typeof runAiPrompt> | null>(null);
  const availableProviders = providers.filter(isAiProviderReady);
  const currentProvider = availableProviders.find((provider) => provider.id === canonicalProviderId)
    ?? availableProviders.find((provider) => provider.id === defaultProviderId)
    ?? availableProviders[0];
  const currentModelId = currentProvider?.id === defaultProviderId
    ? defaults.modelId
    : null;

  const tickerSymbol = ticker?.metadata.ticker ?? null;
  const conversationKey = tickerSymbol && currentProvider
    ? `conversation:${currentProvider.id}:${tickerSymbol}`
    : "__conversation:none__";
  const historyKey = tickerSymbol && currentProvider ? historyKeyFor(currentProvider.id, tickerSymbol) : null;
  const legacyHistoryProviderId = currentProvider
    ? LEGACY_HISTORY_PROVIDER_IDS[currentProvider.id]
    : null;
  const legacyConversationKey = tickerSymbol && legacyHistoryProviderId
    ? historyKeyFor(legacyHistoryProviderId, tickerSymbol)
    : "__conversation:legacy:none__";
  const messages = conversationMessagesByKey[conversationKey] ?? [];
  const setMessages = useCallback((nextValue: SetStateAction<ChatMessage[]>) => {
    setConversationMessagesByKey((previous) => {
      const previousMessages = previous[conversationKey] ?? [];
      const nextMessages = typeof nextValue === "function"
        ? (nextValue as (value: ChatMessage[]) => ChatMessage[])(previousMessages)
        : nextValue;
      if (sameMessages(previousMessages, nextMessages)) return previous;
      return { ...previous, [conversationKey]: nextMessages };
    });
  }, [conversationKey]);
  const [persistedConversation, setPersistedConversation] = usePluginState<PersistedConversation | null>(
    conversationKey,
    null,
    { schemaVersion: 1 },
  );
  const [legacyPersistedConversation] = usePluginState<PersistedConversation | null>(
    legacyConversationKey,
    null,
    { schemaVersion: 1 },
  );

  useEffect(() => {
    if (providerId !== canonicalProviderId) setProviderId(canonicalProviderId);
  }, [canonicalProviderId, providerId, setProviderId]);

  useEffect(() => {
    if (!tickerSymbol) {
      setConversationMessagesByKey((previous) => {
        const previousMessages = previous[conversationKey] ?? [];
        return previousMessages.length === 0 ? previous : { ...previous, [conversationKey]: [] };
      });
      return;
    }

    const currentPersisted = persistedConversation
      ?? (
        legacyPersistedConversation
        && Date.now() - legacyPersistedConversation.updatedAt <= ASK_AI_RETENTION_MS
          ? legacyPersistedConversation
          : null
      );
    if (historyKey && currentPersisted && Date.now() - currentPersisted.updatedAt <= ASK_AI_RETENTION_MS) {
      chatHistories.set(historyKey, currentPersisted.messages);
      if (!persistedConversation && legacyPersistedConversation) {
        setPersistedConversation(legacyPersistedConversation);
      }
    }

    const legacyHistoryKey = legacyHistoryProviderId
      ? historyKeyFor(legacyHistoryProviderId, tickerSymbol)
      : null;
    const nextMessages = (historyKey ? chatHistories.get(historyKey) : null)
      ?? (legacyHistoryKey ? chatHistories.get(legacyHistoryKey) : null)
      ?? chatHistories.get(tickerSymbol)
      ?? [];
    setConversationMessagesByKey((previous) => {
      const previousMessages = previous[conversationKey] ?? [];
      return sameMessages(previousMessages, nextMessages) ? previous : { ...previous, [conversationKey]: nextMessages };
    });
  }, [
    conversationKey,
    historyKey,
    legacyHistoryProviderId,
    legacyPersistedConversation,
    persistedConversation,
    setPersistedConversation,
    tickerSymbol,
  ]);

  useEffect(() => {
    if (!tickerSymbol || !currentProvider || !historyKey || messages.length === 0) return;
    const hasLoading = messages.some((message) => message.loading);
    if (hasLoading) {
      chatHistories.set(historyKey, messages);
      return;
    }
    const trimmed = messages.slice(-ASK_AI_HISTORY_LIMIT);
    chatHistories.set(historyKey, trimmed);
    if (persistedConversation && sameMessages(persistedConversation.messages, trimmed)) return;
    setPersistedConversation({
      updatedAt: Date.now(),
      messages: trimmed,
    });
  }, [currentProvider, historyKey, messages, persistedConversation, setPersistedConversation, tickerSymbol]);

  useEffect(() => {
    const sb = scrollRef.current;
    if (!sb?.viewport || messages.length === 0) return;
    sb.scrollTo({ x: 0, y: Math.max(0, sb.scrollHeight - sb.viewport.height) });
  }, [messages, focused]);

  const cycleProvider = useCallback(() => {
    if (availableProviders.length <= 1) return;
    setProviderId((current) => {
      const currentIndex = availableProviders.findIndex((provider) => provider.id === current);
      const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % availableProviders.length : 0;
      return availableProviders[nextIndex]?.id ?? current;
    });
  }, [availableProviders, setProviderId]);

  const focusInput = useCallback(() => {
    setInputFocused(true);
    onCapture(true);
    inputRef.current?.focus?.();
  }, [onCapture]);

  const blurInput = useCallback(() => {
    setInputFocused(false);
    onCapture(false);
  }, [onCapture]);

  const sendMessage = useCallback(async (text: string) => {
    if (!ticker || !currentProvider?.available || runRef.current) return;

    const userMessage: ChatMessage = { role: "user", content: text };
    const assistantMessage: ChatMessage = { role: "assistant", content: "", loading: true };

    setMessages((previous) => [...previous, userMessage, assistantMessage]);

    const context = buildTickerAiContext(
      ticker,
      financials,
      baseCurrency,
      effectiveExchangeRates,
    );
    const prompt = `You are a financial analyst assistant. Here is the current financial data for the company being discussed:\n\n${context}\n\nUser question: ${text}`;

    try {
      const run = runAiPrompt({
        providerId: currentProvider.id,
        prompt,
        messages: completedConversation(messages),
        modelId: currentModelId ?? undefined,
        onChunk: (output) => {
          setMessages((previous) => {
            const updated = [...previous];
            updated[updated.length - 1] = { role: "assistant", content: output, loading: true };
            return updated;
          });
        },
      });
      runRef.current = run;
      const output = await run.done;
      setMessages((previous) => {
        const updated = [...previous];
        updated[updated.length - 1] = {
          role: "assistant",
          content: output,
          loading: false,
        };
        return updated;
      });
    } catch (error: any) {
      setMessages((previous) => {
        const updated = [...previous];
        updated[updated.length - 1] = {
          role: "assistant",
          content: `Error: ${error?.message || "AI request failed"}`,
          loading: false,
        };
        return updated;
      });
    } finally {
      runRef.current = null;
    }
  }, [baseCurrency, currentModelId, currentProvider, effectiveExchangeRates, financials, messages, ticker]);

  const submitInput = useCallback(() => {
    const currentValue = inputRef.current?.editBuffer.getText() ?? inputValue;
    const trimmed = currentValue.trim();
    if (!trimmed) return;
    void sendMessage(trimmed);
    setInputValue("");
    inputRef.current?.editBuffer.setText?.("");
  }, [inputValue, sendMessage]);

  useShortcut((event) => {
    if (!focused) return;

    const isEnter = event.name === "enter" || event.name === "return";
    if (!inputFocused) {
      if (isEnter) {
        focusInput();
        return;
      }
      if (event.name === "t" || event.name === "T") {
        cycleProvider();
      }
      return;
    }

    if (event.name === "escape") {
      blurInput();
    }
  }, { allowEditable: true });

  useEffect(() => () => {
    runRef.current?.cancel();
  }, []);

  const { catalog, openTicker } = useInlineTickers(messages.map((message) => message.content));
  const thinking = messages.some((message) => message.loading);

  usePaneFooter("ask-ai", () => ({
    info: thinking
      ? [{ id: "thinking", parts: [{ text: "Thinking…", tone: "muted" as const }] }]
      : [],
    hints: [],
  }), [thinking]);

  if (!ticker) return <Text fg={colors.textDim}>{t("Select a ticker to ask AI.")}</Text>;

  if (availableProviders.length === 0) {
    return (
      <Box flexDirection="column" paddingX={1} flexGrow={1}>
        <Text fg={colors.textDim}>{t("No AI providers are ready.")}</Text>
        <Box height={1} />
        <Text fg={colors.text}>
          {t("Open any AI pane's settings to connect an account.")}
        </Text>
      </Box>
    );
  }

  const contentWidth = Math.max(width - 2, 0);
  const composerHeight = nativePaneChrome ? 2 : 1;
  const terminalFooterClearance = nativePaneChrome ? 0 : 1;
  const composerBlockHeight = getMessageComposerBlockHeight({
    height: composerHeight,
    nativePaneChrome,
    terminalBottomInset: terminalFooterClearance,
  });
  const chatHeight = nativePaneChrome ? undefined : Math.max(height - composerBlockHeight, 0);
  const layoutHeight = nativePaneChrome ? "100%" : height;
  const nativeFillStyle = nativePaneChrome ? { minHeight: 0 } : undefined;

  return (
    <Box
      flexDirection="column"
      paddingX={nativePaneChrome ? 0 : 1}
      height={layoutHeight}
      flexGrow={nativePaneChrome ? 1 : undefined}
      overflow="hidden"
      style={nativeFillStyle}
    >
      {(nativePaneChrome || (chatHeight ?? 0) > 0) && (
        <ScrollBox
          ref={scrollRef}
          height={nativePaneChrome ? undefined : chatHeight}
          flexGrow={nativePaneChrome ? 1 : undefined}
          scrollY
          style={nativeFillStyle}
        >
          <Box
            flexDirection="column"
            paddingX={nativePaneChrome ? 1 : 0}
            style={nativeFillStyle}
          >
            {messages.length === 0 ? (
              <Box paddingTop={1}>
                <Text fg={colors.textDim}>
                  {t("Ask questions about {ticker}. Financial data will be included as context.").replace("{ticker}", ticker.metadata.ticker)}
                </Text>
              </Box>
            ) : (
              messages.map((message, index) => (
                <Box key={index} flexDirection="column" paddingTop={index > 0 ? 1 : 0}>
                  <Box height={1}>
                    <Text
                      attributes={TextAttributes.BOLD}
                      fg={message.role === "user" ? colors.textBright : colors.positive}
                    >
                      {message.role === "user" ? t("You") : currentProvider?.name || t("AI")}
                      {message.loading ? ` (${t("thinking...")})` : ""}
                    </Text>
                  </Box>
                  <Box>
                    {message.content ? (
                      <MarkdownText
                        text={message.content}
                        lineWidth={contentWidth}
                        catalog={catalog}
                        textColor={colors.text}
                        openTicker={openTicker}
                      />
                    ) : message.loading ? (
                      <Spinner label={t("Generating...")} />
                    ) : (
                      <Text fg={colors.text}>{""}</Text>
                    )}
                  </Box>
                </Box>
              ))
            )}
          </Box>
        </ScrollBox>
      )}

      <MessageComposer
        inputRef={inputRef}
        initialValue={inputValue}
        focused={inputFocused && focused}
        placeholder={t("Ask a question...")}
        terminalPrefix=" > "
        terminalBottomInset={terminalFooterClearance}
        width={nativePaneChrome ? "100%" : contentWidth}
        height={composerHeight}
        onFocusRequest={focusInput}
        onInput={(value) => setInputValue(value)}
        keyBindings={[
          { name: "return", action: "submit" },
          { name: "linefeed", action: "submit" },
        ]}
        onSubmit={submitInput}
        wrapText={nativePaneChrome}
      />
    </Box>
  );
}
