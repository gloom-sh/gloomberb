import { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text, type InputRenderable } from "../../../../ui";
import { usePaneFooter } from "../../../../components";
import { InlineQuickAddRow } from "../../../../components/ui";
import { useShortcut } from "../../../../react/input";
import { isPlainKey } from "../../../../utils/keyboard";
import { useAppDispatch, useAppSelector } from "../../../../state/app/context";
import { useAppInputCapture } from "../../../../state/app/input-capture";
import { t, tf } from "../../../../i18n";
import { getSharedRegistry } from "../../../registry";
import { usePluginAppActions } from "../../../runtime";
import { isDialogOpen } from "../../../../ui/dialog-stack";
import { colors, priceColor } from "../../../../theme/colors";
import { formatPercentRaw } from "../../../../utils/format";
import { formatMarketPrice, quoteFormatOptions } from "../../../../market-data/market/format";
import { listingChoiceQuery, upsertTickerFromSearchResult } from "../../../../tickers/search";
import type { TickerRecord } from "../../../../types/ticker";
import { addTickerToPortfolio, addTickerToWatchlist } from "../../../../portfolio/mutations";
import { captureAttentionAction } from "../../../../telemetry/attention-counts";
import { publicTickerKey } from "../../../../utils/exchanges";
import { tickerChangeLine } from "../../../../tickers/ticker-changes";
import {
  createQuickAddListMemo,
  IDLE_VALIDATION,
  isPlausibleTickerQuery,
  exchangeLabelFromValidation,
  mayBeQuickAddList,
  normalizeQuickAddQuery,
  QUICK_ADD_LIST_MAX,
  QUICK_ADD_REFUSAL,
  readQuickAddEntries,
  resolveQuickAddList,
  resolveQuickAddValidation,
  tickerNameFromValidation,
  type QuickAddCollectionKind,
  type QuickAddEntryValidation,
  type QuickAddValidation,
} from "./resolution";

const QUICK_ADD_DEBOUNCE_MS = 300;
/** The pane key that opens the add row, as its footer hint shows it. */
export const QUICK_ADD_KEY = "a";

export type { QuickAddCollectionKind } from "./resolution";

function QuickAddPreview({
  validation,
  collectionKind,
  submitting,
  cleared,
}: {
  validation: QuickAddValidation;
  collectionKind: QuickAddCollectionKind;
  submitting: boolean;
  /** The field was emptied after the add failed: the line names what was typed. */
  cleared: boolean;
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
    return <Text fg={colors.textMuted}>{cleared ? `${validation.query}  ${t(validation.message)}` : t(validation.message)}</Text>;
  }

  if (validation.status === "choose") {
    return <Text fg={colors.textMuted}>{t("Multiple listings")}</Text>;
  }

  if (validation.status === "list") {
    // What Enter adds, then what it leaves out, in the order they were pasted.
    const { ready, left } = splitListEntries(validation.entries);
    const cut = listCutText(validation);
    return (
      <Box flexDirection="row" overflow="hidden">
        <Text fg={ready.length > 0 ? colors.textDim : colors.textMuted} flexShrink={0}>
          {ready.length === 0
            ? t("Nothing to add")
            // "of 3" says some are left out even where a narrow row cuts the reasons after it.
            : left.length > 0
              ? tf("Add {count} of {total}: {symbols}", { count: ready.length, total: validation.entries.length, symbols: ready.map((entry) => entry.symbol).join(" ") })
              : tf("Add {count}: {symbols}", { count: ready.length, symbols: ready.map((entry) => entry.symbol).join(" ") })}
        </Text>
        {cut ? <Text fg={colors.warning} flexShrink={0}>{`  ${cut}`}</Text> : null}
        {left.length > 0 ? <Text fg={colors.warning}>{`  ${listLeftOutText(left, collectionKind)}`}</Text> : null}
      </Box>
    );
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
    ? formatMarketPrice(quote.price, { ...quoteFormatOptions(quote, assetCategory), maxWidth: 12 })
    : "-";
  const changeValue = quote?.changePercent;
  const name = tickerNameFromValidation(validation);
  const exchange = exchangeLabelFromValidation(validation);
  const showSymbol = normalizeQuickAddQuery(validation.symbol) !== validation.query;
  const symbolPrefix = showSymbol ? `${validation.symbol} ` : "";
  // A symbol whose company moved on says where it went before it is added, ahead of the
  // name of what lists there now; the add notice prints the whole line.
  const change = validation.change?.kind === "moved" ? validation.change : null;
  const moved = change?.listed ? `${change.issuer ?? `the former ${change.symbol}`} trades as ${change.tradesAs}` : change?.note;

  return (
    <Box flexDirection="row" overflow="hidden">
      <Text fg={colors.textDim} flexShrink={0}>{`${symbolPrefix}${priceText} `}</Text>
      <Text fg={changeValue == null ? colors.textDim : priceColor(changeValue)} flexShrink={0}>
        {formatPercentRaw(changeValue)}
      </Text>
      {moved ? <Text fg={colors.warning} flexShrink={0}>{`  ${moved}`}</Text> : null}
      {name && (!change || change.listed) ? <Text fg={colors.textMuted}>{`  ${name}`}</Text> : null}
      {exchange && !change ? <Text fg={colors.textDim}>{`  ${exchange}`}</Text> : null}
    </Box>
  );
}

type ReadyEntry = Extract<QuickAddEntryValidation, { status: "ready" }>;

/** A list's entries Enter adds, and the others. */
function splitListEntries(entries: readonly QuickAddEntryValidation[]): { ready: ReadyEntry[]; left: QuickAddEntryValidation[] } {
  return {
    ready: entries.filter((entry): entry is ReadyEntry => entry.status === "ready"),
    left: entries.filter((entry) => entry.status !== "ready"),
  };
}

/** What a list leaves out and why: `not found: XYZ · already in Watchlist: AAPL · several listings: NET`. */
function listLeftOutText(left: readonly QuickAddEntryValidation[], collectionKind: QuickAddCollectionKind): string {
  const named = (status: QuickAddEntryValidation["status"][]) => left.filter((entry) => status.includes(entry.status))
    .map((entry) => entry.status === "duplicate" ? entry.symbol : entry.query);
  const parts: [string, string[]][] = [
    [t("not found"), named(["missing"])],
    [tf("already in {collection}", { collection: t(collectionKind === "portfolio" ? "Portfolio" : "Watchlist") }), named(["duplicate"])],
    [t("several listings"), named(["choose"])],
    [t("not looked up"), named(["error"])],
  ];
  return parts.filter(([, symbols]) => symbols.length > 0).map(([label, symbols]) => `${label}: ${symbols.join(" ")}`).join(" · ");
}

/** A paste longer than the row reads: `first 50 of 73 read`. */
function listCutText(list: Extract<QuickAddValidation, { status: "list" }>): string | null {
  return list.total ? tf("first {count} of {total} read", { count: QUICK_ADD_LIST_MAX, total: list.total }) : null;
}

/** The preview's phrase as a sentence of the toast. */
function asSentence(text: string): string {
  return `${text.charAt(0).toLocaleUpperCase()}${text.slice(1)}`;
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

  // A symbol with no listing leaves the field, so the next one typed replaces
  // it instead of running on (OMV.VIREP.MC); the line under it still says what
  // failed until something is typed.
  const keepFailureRef = useRef(false);
  // A list's entries as read and checked while it is edited, for this collection; a cleared row starts anew.
  const listMemoRef = useRef(createQuickAddListMemo());
  useEffect(() => { listMemoRef.current = createQuickAddListMemo(); }, [collectionId, collectionKind]);
  const resetInput = useCallback(() => {
    keepFailureRef.current = false;
    listMemoRef.current = createQuickAddListMemo();
    setInputValue("");
    // The field keeps its own text, cursor and scroll until told: an add that left them read the next symbol
    // scrolled by one ("+ SDTRY=X" for USDTRY=X).
    inputRef.current?.editBuffer?.setText?.("");
    inputRef.current?.setCursorOffset?.(0);
    setValidation(IDLE_VALIDATION);
  }, []);

  /** An add is done: the row closes, empty, and `a` opens it again. */
  const closeAfterAdd = useCallback(() => {
    resetInput();
    inputRef.current?.blur?.();
    setInputFocused(false);
  }, [resetInput]);

  const clearFailedInput = useCallback((failure: QuickAddValidation) => {
    keepFailureRef.current = true;
    validationSeqRef.current += 1;
    setInputValue("");
    // The focused field keeps its own text and cursor until told, as the chart composer's add field is.
    inputRef.current?.editBuffer?.setText?.("");
    inputRef.current?.setCursorOffset?.(0);
    setValidation(failure);
  }, []);

  // `NET:` is the command bar's venue dropdown. Choosing a row adds it here.
  const handOffListingChoice = useCallback((query: string) => {
    validationSeqRef.current += 1;
    if (!isDialogOpen()) {
      dispatch({
        type: "SET_COMMAND_BAR",
        open: true,
        query,
        launch: { kind: "add-listing", collectionId, collectionKind },
      });
    }
    resetInput();
    blurInput();
  }, [blurInput, collectionId, collectionKind, dispatch, resetInput]);

  useEffect(() => {
    onFocusChange?.(inputFocused && focused);
  }, [focused, inputFocused, onFocusChange]);

  useEffect(() => {
    if (!focused && inputFocused) {
      blurInput();
    }
  }, [blurInput, focused, inputFocused]);

  // Read when a lookup runs, so a quote tick does not look the typed symbol up again.
  const tickersRef = useRef(tickers);
  tickersRef.current = tickers;
  const financialsRef = useRef(financials);
  financialsRef.current = financials;
  const validateQuery = useCallback((query: string): Promise<QuickAddValidation> => {
    return resolveQuickAddValidation({
      query,
      collectionId,
      collectionKind,
      tickers: tickersRef.current,
      financials: financialsRef.current,
    });
  }, [collectionId, collectionKind]);
  // Words or a pasted list are read as `watchlist add` reads them, in the case typed; one symbol among them is
  // checked as one typed alone. An entry already read and checked is not looked up again at the next keystroke.
  const validateInput = useCallback(async (value: string): Promise<QuickAddValidation> => {
    const query = normalizeQuickAddQuery(value);
    if (!mayBeQuickAddList(value)) return validateQuery(query);
    const memo = listMemoRef.current;
    const { entries, total } = await readQuickAddEntries(value, memo);
    return resolveQuickAddList({
      query,
      entries,
      total,
      memo,
      collectionId,
      collectionKind,
      tickers: tickersRef.current,
      financials: financialsRef.current,
    });
  }, [collectionId, collectionKind, validateQuery]);

  useEffect(() => {
    const query = normalizeQuickAddQuery(inputValue);
    validationSeqRef.current += 1;
    const seq = validationSeqRef.current;

    if (!query) {
      if (!keepFailureRef.current) setValidation(IDLE_VALIDATION);
      return;
    }
    keepFailureRef.current = false;

    if (listingChoiceQuery(query)) {
      setValidation(IDLE_VALIDATION);
      const timeoutId = setTimeout(() => {
        if (validationSeqRef.current !== seq) return;
        handOffListingChoice(query);
      }, QUICK_ADD_DEBOUNCE_MS);
      return () => clearTimeout(timeoutId);
    }

    // A pasted list's separators are no symbol's: each entry is checked on its own.
    if (!mayBeQuickAddList(inputValue) && !isPlausibleTickerQuery(query)) {
      setValidation({ status: "missing", query, message: QUICK_ADD_REFUSAL });
      return;
    }

    setValidation({ status: "checking", query });
    const value = inputValue;
    const timeoutId = setTimeout(() => {
      void validateInput(value).then((result) => {
        if (validationSeqRef.current === seq) {
          setValidation(result);
        }
      });
    }, QUICK_ADD_DEBOUNCE_MS);

    return () => clearTimeout(timeoutId);
  }, [handOffListingChoice, inputValue, validateInput]);

  /** Adds one checked symbol; null when the collection already had it. */
  const addReady = useCallback(async (
    ready: Extract<QuickAddValidation, { status: "ready" | "duplicate" }>,
    recordAttention: ReturnType<typeof captureAttentionAction>,
  ): Promise<{ symbol: string; note: string | null } | null> => {
    const registry = getSharedRegistry();
    if (!registry) throw new Error("Ticker lookup unavailable.");
    let ticker: TickerRecord;
    let created = false;
    if (ready.resolved.kind === "local") {
      ticker = ready.resolved.ticker;
    } else {
      const result = await upsertTickerFromSearchResult(registry.tickerRepository, ready.resolved.result);
      ticker = result.ticker;
      created = result.created;
    }

    const result = collectionKind === "portfolio"
      ? addTickerToPortfolio(ticker, collectionId)
      : addTickerToWatchlist(ticker, collectionId);
    if (!result.changed) return null;

    await registry.tickerRepository.saveTicker(result.ticker);
    dispatch({ type: "UPDATE_TICKER", ticker: result.ticker });
    if (collectionKind === "watchlist") {
      recordAttention(publicTickerKey(result.ticker.metadata.ticker, result.ticker.metadata.exchange), "watchlist_add");
    }
    if (created) {
      registry.events.emit("ticker:added", {
        symbol: result.ticker.metadata.ticker,
        ticker: result.ticker,
      });
    }
    // As `watchlist add` prints it: FB now lists another security, Meta trades as META;
    // GOGL was Golden Ocean, now CMB.Tech's CMBT.
    return { symbol: result.ticker.metadata.ticker, note: tickerChangeLine(ready.change) ?? ready.formerIssuer?.note ?? null };
  }, [collectionId, collectionKind, dispatch]);

  /** A pasted list: every entry that checked is added, and one notice says what was and what was left out. */
  const submitList = useCallback(async (
    list: Extract<QuickAddValidation, { status: "list" }>,
    recordAttention: ReturnType<typeof captureAttentionAction>,
  ) => {
    const { ready, left } = splitListEntries(list.entries);
    const added: { symbol: string; note: string | null }[] = [];
    const already: string[] = [];
    for (const entry of ready) {
      const result = await addReady(entry, recordAttention);
      if (result) added.push(result);
      else already.push(entry.symbol);
    }
    if (added.length > 0) onAdded(added[added.length - 1]!.symbol);
    const cut = listCutText(list);
    const skipped = [
      ...cut ? [`${asSentence(cut)}.`] : [],
      ...already.length > 0 ? [tf("Already in {collection}: {symbols}.", { collection: collectionName, symbols: already.join(", ") })] : [],
      ...left.length > 0 ? [`${asSentence(listLeftOutText(left, collectionKind))}.`] : [],
    ];
    const notes = added.flatMap((entry) => entry.note ? [`${entry.note}.`] : []);
    notify({
      type: added.length === 0 ? "error" : skipped.length > 0 ? "info" : "success",
      body: [
        added.length > 0
          ? tf("Added {symbols} to {collection}.", { symbols: added.map((entry) => entry.symbol).join(", "), collection: collectionName })
          : t("Nothing added."),
        ...notes,
        ...skipped,
      ].join(" "),
    });
    // Something added, or nothing left to fix: done. Entries left out keep the row open on what to fix.
    if (added.length > 0 || left.length === 0) closeAfterAdd();
    else {
      setValidation(list);
      queueMicrotask(() => inputRef.current?.focus?.());
    }
  }, [addReady, closeAfterAdd, collectionKind, collectionName, notify, onAdded]);

  const submitInput = useCallback(async (submittedValue?: string) => {
    // Before any lookup: consent to count the add cannot be given after it.
    const recordAttention = captureAttentionAction();
    const value = submittedValue ?? inputValue;
    const query = normalizeQuickAddQuery(value);
    if (!query || submitting) return;
    if (listingChoiceQuery(query)) {
      handOffListingChoice(query);
      return;
    }

    setSubmitting(true);
    try {
      const currentValidation = (
        validation.query === query
        && (validation.status === "ready" || validation.status === "duplicate" || validation.status === "list")
      )
        ? validation
        : await validateInput(value);
      if (currentValidation.status === "list") {
        await submitList(currentValidation, recordAttention);
        return;
      }
      if (currentValidation.status === "choose") {
        handOffListingChoice(`${query}:`);
        return;
      }
      setValidation(currentValidation);

      if (currentValidation.status === "duplicate") {
        notify({
          type: "info",
          body: tf("{symbol} is already in {collection}.", {
            symbol: currentValidation.symbol,
            collection: collectionName,
          }),
        });
        closeAfterAdd();
        return;
      }
      if (currentValidation.status !== "ready") {
        const body = currentValidation.status === "idle"
          ? "Ticker symbol is required."
          : currentValidation.status === "checking"
            ? "Ticker lookup is still in progress."
            : currentValidation.message;
        notify({ type: "error", body });
        // Only a symbol nothing lists leaves the field. A lookup that failed (offline) keeps what was typed, to try again.
        if (currentValidation.status === "missing") clearFailedInput(currentValidation);
        return;
      }

      if (!getSharedRegistry()) {
        notify({ type: "error", body: t("Ticker lookup unavailable.") });
        return;
      }
      const added = await addReady(currentValidation, recordAttention);
      if (!added) {
        notify({
          type: "info",
          body: tf("{symbol} is already in {collection}.", {
            symbol: currentValidation.symbol,
            collection: collectionName,
          }),
        });
        closeAfterAdd();
        return;
      }

      onAdded(added.symbol);
      const body = tf("Added {symbol} to {collection}.", {
        symbol: added.symbol,
        collection: collectionName,
      });
      notify({ type: "success", body: added.note ? `${body} ${added.note}.` : body });
      closeAfterAdd();
    } catch {
      setValidation({ status: "error", query, message: "Ticker add failed" });
      notify({ type: "error", body: tf("Failed to add {symbol}.", { symbol: query }) });
    } finally {
      setSubmitting(false);
    }
  }, [
    addReady,
    clearFailedInput,
    closeAfterAdd,
    collectionName,
    handOffListingChoice,
    inputValue,
    notify,
    onAdded,
    submitList,
    submitting,
    validateInput,
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

    // `a` is the footer's hint below; `n` reaches the same row.
    if (isPlainKey(event, "a", "n")) {
      event.preventDefault?.();
      event.stopPropagation?.();
      focusInput();
    }
  }, { phase: "before", allowEditable: true });

  // The row shows only its placeholder, so the footer says which key reaches it.
  usePaneFooter("portfolio-list:quick-add", () => ({
    hints: inputFocused ? [] : [{ id: "add", key: QUICK_ADD_KEY, label: "dd", onPress: focusInput }],
  }), [focusInput, inputFocused]);

  return (
    <InlineQuickAddRow
      value={inputValue}
      active={inputFocused}
      paneFocused={focused}
      width={width}
      placeholder={t("ticker")}
      inputRef={inputRef}
      // A pasted column or sheet row is one line of its entries, each line and cell one (Apple Inc, VOD LN).
      joinPastedLines="list"
      onFocusRequest={focusInput}
      // As typed: a list is read in its case (Apple Inc is a name, AAPL MSFT symbols); a query is normalized.
      onChange={setInputValue}
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
          cleared={!inputValue}
        />
      )}
    />
  );
}
