import { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text, type InputRenderable } from "../../../../ui";
import { InlineQuickAddRow } from "../../../../components/ui";
import { useShortcut } from "../../../../react/input";
import { useAppDispatch, useAppSelector } from "../../../../state/app/context";
import { useAppInputCapture } from "../../../../state/app/input-capture";
import { t, tf } from "../../../../i18n";
import { getSharedRegistry } from "../../../registry";
import { usePluginAppActions } from "../../../runtime";
import { colors, priceColor } from "../../../../theme/colors";
import { formatPercentRaw } from "../../../../utils/format";
import { formatMarketPrice } from "../../../../market-data/market/format";
import { upsertTickerFromSearchResult } from "../../../../tickers/search";
import type { TickerRecord } from "../../../../types/ticker";
import { addTickerToPortfolio, addTickerToWatchlist } from "../mutations";
import {
  IDLE_VALIDATION,
  isPlausibleTickerQuery,
  normalizeQuickAddQuery,
  resolveQuickAddValidation,
  tickerNameFromValidation,
  type QuickAddCollectionKind,
  type QuickAddValidation,
} from "./resolution";

const QUICK_ADD_DEBOUNCE_MS = 300;

export type { QuickAddCollectionKind } from "./resolution";

function QuickAddPreview({
  validation,
  collectionKind,
  submitting,
}: {
  validation: QuickAddValidation;
  collectionKind: QuickAddCollectionKind;
  submitting: boolean;
}) {
  if (submitting) {
    return <Text fg={colors.textDim}>{t("adding...")}</Text>;
  }

  if (validation.status === "idle") {
    return <Text fg={colors.textMuted}> </Text>;
  }

  if (validation.status === "checking") {
    return <Text fg={colors.textDim}>{tf("{query} checking...", { query: validation.query })}</Text>;
  }

  if (validation.status === "missing" || validation.status === "error") {
    return <Text fg={colors.textMuted}>{t(validation.message)}</Text>;
  }

  if (validation.status === "duplicate") {
    return <Text fg={colors.textMuted}>{tf("{symbol} already in {collection}", {
      symbol: validation.symbol,
      collection: t(collectionKind === "portfolio" ? "Portfolio" : "Watchlist"),
    })}</Text>;
  }

  const quote = validation.quote;
  const assetCategory = validation.ticker?.metadata.assetCategory
    ?? (validation.resolved.kind === "provider" ? validation.resolved.result.type : undefined);
  const priceText = quote?.price != null
    ? formatMarketPrice(quote.price, { assetCategory, maxWidth: 12 })
    : "-";
  const changeValue = quote?.changePercent;
  const name = tickerNameFromValidation(validation);
  const showSymbol = normalizeQuickAddQuery(validation.symbol) !== validation.query;
  const symbolPrefix = showSymbol ? `${validation.symbol} ` : "";

  return (
    <Box flexDirection="row" overflow="hidden">
      <Text fg={colors.textDim}>{`${symbolPrefix}${priceText} `}</Text>
      <Text fg={changeValue == null ? colors.textDim : priceColor(changeValue)}>
        {formatPercentRaw(changeValue)}
      </Text>
      {name ? <Text fg={colors.textMuted}>{`  ${name}`}</Text> : null}
    </Box>
  );
}

export function QuickAddTickerInput({
  collectionId,
  collectionKind,
  collectionName,
  focused,
  width,
  onAdded,
  onFocusChange,
}: {
  collectionId: string;
  collectionKind: QuickAddCollectionKind;
  collectionName: string;
  focused: boolean;
  width: number;
  onAdded: (symbol: string) => void;
  onFocusChange?: (focused: boolean) => void;
}) {
  const dispatch = useAppDispatch();
  const { notify } = usePluginAppActions();
  const tickers = useAppSelector((state) => state.tickers);
  const financials = useAppSelector((state) => state.financials);
  const inputRef = useRef<InputRenderable | null>(null);
  const validationSeqRef = useRef(0);
  const [inputFocused, setInputFocused] = useState(false);
  const [inputValue, setInputValue] = useState("");
  const [validation, setValidation] = useState<QuickAddValidation>(IDLE_VALIDATION);
  const [submitting, setSubmitting] = useState(false);
  useAppInputCapture(inputFocused && focused);

  const focusInput = useCallback(() => {
    if (!focused) return;
    setInputFocused(true);
    queueMicrotask(() => inputRef.current?.focus?.());
  }, [focused]);

  const blurInput = useCallback(() => {
    setInputFocused(false);
  }, []);

  const resetInput = useCallback(() => {
    setInputValue("");
    setValidation(IDLE_VALIDATION);
  }, []);

  useEffect(() => {
    onFocusChange?.(inputFocused && focused);
  }, [focused, inputFocused, onFocusChange]);

  useEffect(() => {
    if (!focused && inputFocused) {
      blurInput();
    }
  }, [blurInput, focused, inputFocused]);

  const validateQuery = useCallback((query: string): Promise<QuickAddValidation> => {
    return resolveQuickAddValidation({
      query,
      collectionId,
      collectionKind,
      tickers,
      financials,
    });
  }, [collectionId, collectionKind, financials, tickers]);

  useEffect(() => {
    const query = normalizeQuickAddQuery(inputValue);
    validationSeqRef.current += 1;
    const seq = validationSeqRef.current;

    if (!query) {
      setValidation(IDLE_VALIDATION);
      return;
    }

    if (!isPlausibleTickerQuery(query)) {
      setValidation({ status: "missing", query, message: "Use a ticker symbol" });
      return;
    }

    setValidation({ status: "checking", query });
    const timeoutId = setTimeout(() => {
      void validateQuery(query).then((result) => {
        if (validationSeqRef.current === seq) {
          setValidation(result);
        }
      });
    }, QUICK_ADD_DEBOUNCE_MS);

    return () => clearTimeout(timeoutId);
  }, [inputValue, validateQuery]);

  const submitInput = useCallback(async (submittedValue?: string) => {
    const query = normalizeQuickAddQuery(submittedValue ?? inputValue);
    if (!query || submitting) return;

    setSubmitting(true);
    try {
      const currentValidation = (
        validation.query === query
        && (validation.status === "ready" || validation.status === "duplicate")
      )
        ? validation
        : await validateQuery(query);
      setValidation(currentValidation);

      if (currentValidation.status === "duplicate") {
        notify({
          type: "info",
          body: tf("{symbol} is already in {collection}.", {
            symbol: currentValidation.symbol,
            collection: collectionName,
          }),
        });
        return;
      }
      if (currentValidation.status !== "ready") {
        const body = currentValidation.status === "idle"
          ? "Ticker symbol is required."
          : currentValidation.status === "checking"
            ? "Ticker lookup is still in progress."
            : currentValidation.message;
        notify({ type: "error", body });
        return;
      }

      const registry = getSharedRegistry();
      if (!registry) {
        notify({ type: "error", body: t("Ticker lookup unavailable.") });
        return;
      }

      let ticker: TickerRecord;
      let created = false;
      if (currentValidation.resolved.kind === "local") {
        ticker = currentValidation.resolved.ticker;
      } else {
        const result = await upsertTickerFromSearchResult(registry.tickerRepository, currentValidation.resolved.result);
        ticker = result.ticker;
        created = result.created;
      }

      const result = collectionKind === "portfolio"
        ? addTickerToPortfolio(ticker, collectionId)
        : addTickerToWatchlist(ticker, collectionId);

      if (!result.changed) {
        notify({
          type: "info",
          body: tf("{symbol} is already in {collection}.", {
            symbol: ticker.metadata.ticker,
            collection: collectionName,
          }),
        });
        return;
      }

      await registry.tickerRepository.saveTicker(result.ticker);
      dispatch({ type: "UPDATE_TICKER", ticker: result.ticker });
      if (created) {
        registry.events.emit("ticker:added", {
          symbol: result.ticker.metadata.ticker,
          ticker: result.ticker,
        });
      }

      onAdded(result.ticker.metadata.ticker);
      notify({
        type: "success",
        body: tf("Added {symbol} to {collection}.", {
          symbol: result.ticker.metadata.ticker,
          collection: collectionName,
        }),
      });
      resetInput();
      queueMicrotask(() => inputRef.current?.focus?.());
    } catch {
      setValidation({ status: "error", query, message: "Ticker add failed" });
      notify({ type: "error", body: tf("Failed to add {symbol}.", { symbol: query }) });
    } finally {
      setSubmitting(false);
    }
  }, [
    collectionId,
    collectionKind,
    collectionName,
    dispatch,
    inputValue,
    notify,
    onAdded,
    resetInput,
    submitting,
    validateQuery,
    validation,
  ]);

  useShortcut((event) => {
    if (!focused) return;

    if (inputFocused) {
      if (event.name === "escape") {
        event.preventDefault?.();
        event.stopPropagation?.();
        resetInput();
        blurInput();
      }
      return;
    }

    if (event.targetEditable) return;

    if ((event.name === "a" || event.name === "n") && !event.ctrl && !event.meta && !event.super) {
      event.preventDefault?.();
      event.stopPropagation?.();
      focusInput();
    }
  }, { phase: "before", allowEditable: true });

  return (
    <InlineQuickAddRow
      value={inputValue}
      active={inputFocused}
      paneFocused={focused}
      width={width}
      placeholder={t("ticker")}
      inputRef={inputRef}
      onFocusRequest={focusInput}
      onChange={(value) => setInputValue(value.toUpperCase())}
      onSubmit={(value) => { void submitInput(value); }}
      onFocus={() => setInputFocused(true)}
      onBlur={blurInput}
      onCancel={() => {
        inputRef.current?.blur?.();
        resetInput();
        blurInput();
      }}
      preview={(
        <QuickAddPreview
          validation={validation}
          collectionKind={collectionKind}
          submitting={submitting}
        />
      )}
    />
  );
}
