import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PluginRegistry } from "../../plugins/registry";
import {
  addTickerToPortfolio,
  adoptFirstPositionCurrency,
  hasOpenPortfolioPositions,
  removeTickerFromPortfolio,
  resolveManualPositionCurrency,
  setManualPortfolioPosition,
  validatePositionShares,
  type PositionQuantityLabel,
} from "../../portfolio/mutations";
import { isFuturesTicker } from "../../portfolio/futures-positions";
import { loadFuturesEntrySize } from "../../portfolio/futures-terms";
import { useAppDispatch, useAppSelector, useAppStateRef } from "../../state/app/context";
import { saveConfigImmediately } from "../../state/config-save-scheduler";
import { resolveTickerSearch, upsertTickerFromSearchResult, type ResolvedTickerSearch } from "../../tickers/search";
import type { Quote } from "../../types/financials";
import type { TickerRecord } from "../../types/ticker";
import { t } from "../../i18n";
import { isProviderBusy } from "../../sources/provider-errors";
import { debugLog } from "../../utils/debug-log";
import { ambiguousNumberMessage, parseTypedNumber } from "../../utils/decimal-comma";
import {
  getOnboardingPortfolioId,
  listOnboardingPositions,
  type OnboardingPositionRow,
} from "./wizard-model";

const onboardingLog = debugLog.createLogger("onboarding");
const PREVIEW_DEBOUNCE_MS = 300;
const SYMBOL_QUERY = /^[A-Z0-9][A-Z0-9.\-^=/\s]*$/;

export type PositionFieldId = "ticker" | "shares" | "avgCost" | "currency";
export const POSITION_FIELDS: readonly PositionFieldId[] = ["ticker", "shares", "avgCost", "currency"];

export interface PositionDraft {
  ticker: string;
  shares: string;
  avgCost: string;
  /** Prefilled with the listing's currency; blank falls back like the AP form. */
  currency: string;
}

export type PositionPreview =
  | { status: "idle" }
  | { status: "checking"; query: string }
  | {
    status: "ready"; query: string; symbol: string; name: string; quote: Quote | null; currency: string; duplicate: boolean;
    /** A future: its size counts contracts. */
    contracts: boolean;
  }
  | { status: "missing"; query: string; message: string };

const EMPTY_DRAFT: PositionDraft = { ticker: "", shares: "", avgCost: "", currency: "" };

function normalizePositionQuery(value: string): string {
  return value.replace(/^\s*\$/, "").trim().toUpperCase().replace(/\s+/g, " ");
}

function isSymbolQuery(query: string): boolean {
  return query.length > 0 && query.length <= 32 && SYMBOL_QUERY.test(query);
}

/** A typed share count or cost as positions read everywhere (18,50 is 18.5, 1.234,5 is 1234.5, 123.456 as written): null when empty, NaN when it is no number. */
function parseAmount(value: string): number | null {
  if (!value.trim()) return null;
  const read = parseTypedNumber(value);
  return read.kind === "number" ? read.value : Number.NaN;
}

/** The error for an amount that reads two ways (1,234), naming both readings; null for any other. */
function ambiguousAmount(value: string, label: string): string | null {
  const read = parseTypedNumber(value);
  return read.kind === "ambiguous" ? `${label} ${ambiguousNumberMessage(value, read)}.` : null;
}

/** The listing's own currency as its quote or the search knows it; empty when neither does. */
function instrumentCurrency(resolved: ResolvedTickerSearch, quote: Quote | null): string {
  const listed = resolved.kind === "provider"
    ? resolved.result.currency || resolved.result.brokerContract?.currency
    : resolved.ticker.metadata.currency;
  return (quote?.currency || listed || "").trim();
}

/** Whether the typed listing is a future, by its saved record or what the search says it is. */
function resolvedIsFuture(resolved: ResolvedTickerSearch, ticker: TickerRecord | null): boolean {
  if (ticker) return isFuturesTicker(ticker);
  return resolved.kind === "local"
    ? isFuturesTicker(resolved.ticker)
    : isFuturesTicker({ metadata: { ticker: resolved.symbol, assetCategory: resolved.result.type } });
}

function resolvedName(resolved: ResolvedTickerSearch, ticker: TickerRecord | null): string {
  if (ticker?.metadata.name) return ticker.metadata.name;
  return resolved.kind === "provider" ? resolved.result.name : "";
}

/**
 * Owns the add-a-position form of the portfolio step: the draft, the live
 * preview of the typed symbol, and the write into the manual portfolio. Rows
 * are read back from app state, so the list is exactly what the Portfolio pane
 * behind the modal shows.
 */
export function useOnboardingPositions({
  pluginRegistry,
  onFieldEditing,
}: {
  pluginRegistry: PluginRegistry;
  onFieldEditing: (editing: boolean) => void;
}) {
  const dispatch = useAppDispatch();
  const stateRef = useAppStateRef();
  const tickers = useAppSelector((state) => state.tickers);
  const financials = useAppSelector((state) => state.financials);
  const portfolioId = useAppSelector((state) => getOnboardingPortfolioId(state.config));
  const [draft, setDraft] = useState<PositionDraft>(EMPTY_DRAFT);
  const [fieldIdx, setFieldIdx] = useState(0);
  const [preview, setPreview] = useState<PositionPreview>({ status: "idle" });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fetchedQuotes, setFetchedQuotes] = useState<Record<string, Quote>>({});
  const previewSeqRef = useRef(0);
  // Once the user types a currency, a resolved ticker no longer prefills it.
  const currencyEditedRef = useRef(false);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const fallbackCurrency = useAppSelector((state) => (
    state.config.portfolios.find((portfolio) => portfolio.id === portfolioId)?.currency
      || state.config.baseCurrency
      || "USD"
  ));

  const positions = useMemo(
    () => listOnboardingPositions(
      tickers.values(),
      portfolioId,
      (symbol) => financials.get(symbol)?.quote ?? fetchedQuotes[symbol],
    ),
    [fetchedQuotes, financials, portfolioId, tickers],
  );

  const resolveSymbol = useCallback(async (query: string) => {
    const resolved = await resolveTickerSearch({
      query,
      activeTicker: null,
      tickers: stateRef.current.tickers,
      dataProvider: pluginRegistry.marketData,
    });
    if (!resolved) return null;
    const ticker = resolved.kind === "local" ? resolved.ticker : (stateRef.current.tickers.get(resolved.symbol) ?? null);
    let quote: Quote | null = stateRef.current.financials.get(resolved.symbol)?.quote
      ?? (resolved.kind === "provider" ? resolved.quote : null) ?? null;
    if (!quote) {
      try {
        const exchange = resolved.kind === "provider" ? resolved.result.exchange : resolved.ticker.metadata.exchange;
        quote = await pluginRegistry.marketData.getQuote(resolved.symbol, exchange);
      } catch {
        quote = null;
      }
    }
    if (quote) setFetchedQuotes((current) => ({ ...current, [resolved.symbol]: quote! }));
    return { resolved, ticker, quote, name: resolvedName(resolved, ticker), currency: instrumentCurrency(resolved, quote) };
  }, [pluginRegistry.marketData, stateRef]);

  // Live preview of the symbol being typed: company name and last price, or
  // why it will not resolve. Debounced so every keystroke does not hit search.
  useEffect(() => {
    const query = normalizePositionQuery(draft.ticker);
    previewSeqRef.current += 1;
    const seq = previewSeqRef.current;
    if (!query) {
      setPreview({ status: "idle" });
      return;
    }
    if (!isSymbolQuery(query)) {
      setPreview({ status: "missing", query, message: t("Use a ticker symbol") });
      return;
    }
    setPreview({ status: "checking", query });
    const timer = setTimeout(() => {
      void resolveSymbol(query).then((result) => {
        if (previewSeqRef.current !== seq) return;
        if (!result) {
          setPreview({ status: "missing", query, message: t("No exact ticker match") });
          return;
        }
        setPreview({
          status: "ready",
          query,
          symbol: result.resolved.symbol,
          name: result.name,
          quote: result.quote,
          currency: result.currency,
          duplicate: !!result.ticker?.metadata.portfolios.includes(portfolioId),
          contracts: resolvedIsFuture(result.resolved, result.ticker),
        });
        if (!currencyEditedRef.current) {
          setDraft((current) => ({ ...current, currency: result.currency.toUpperCase() }));
        }
      }).catch((error: unknown) => {
        if (previewSeqRef.current === seq) {
          setPreview({ status: "missing", query, message: isProviderBusy(error) ? t("Search is busy") : t("Ticker lookup failed") });
        }
      });
    }, PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [draft.ticker, portfolioId, resolveSymbol]);

  const setField = useCallback((field: PositionFieldId, value: string) => {
    setError(null);
    const nextValue = field === "ticker" || field === "currency" ? value.toUpperCase() : value;
    // The input echoes a prefill back; only a different value is the user's.
    if (field === "currency" && nextValue !== draftRef.current.currency) currencyEditedRef.current = true;
    setDraft((current) => {
      if (current[field] === nextValue) return current;
      const next = { ...current, [field]: nextValue };
      // Another ticker's prefill would no longer be its currency.
      if (field === "ticker" && !currencyEditedRef.current) next.currency = "";
      return next;
    });
  }, []);

  const focusField = useCallback((index: number) => {
    setError(null);
    setFieldIdx(Math.max(0, Math.min(POSITION_FIELDS.length - 1, index)));
    onFieldEditing(true);
  }, [onFieldEditing]);

  const resetDraft = useCallback(() => {
    currencyEditedRef.current = false;
    setDraft(EMPTY_DRAFT);
    setFieldIdx(0);
    setPreview({ status: "idle" });
  }, []);

  // A future's size counts contracts: the field and its messages say so once the symbol resolves to one.
  const quantityLabel: PositionQuantityLabel = preview.status === "ready" && preview.contracts ? "Contracts" : "Shares";

  const addPosition = useCallback(async (): Promise<boolean> => {
    if (submitting) return false;
    const current = draftRef.current;
    const query = normalizePositionQuery(current.ticker);
    if (!query) {
      setFieldIdx(0);
      setError(t("Enter a ticker symbol."));
      return false;
    }
    const shares = parseAmount(current.shares);
    const sharesError = shares === null ? null : validatePositionShares(shares, quantityLabel);
    if (sharesError) {
      setFieldIdx(1);
      setError(ambiguousAmount(current.shares, quantityLabel) ?? t(sharesError));
      return false;
    }
    const avgCost = parseAmount(current.avgCost);
    if (avgCost !== null && (Number.isNaN(avgCost) || avgCost < 0)) {
      setFieldIdx(2);
      setError(ambiguousAmount(current.avgCost, "Average cost") ?? t("Average cost must be a number."));
      return false;
    }

    setSubmitting(true);
    setError(null);
    try {
      const result = await resolveSymbol(query);
      if (!result) {
        setFieldIdx(0);
        setError(t("No exact ticker match."));
        return false;
      }
      let ticker: TickerRecord;
      let created = false;
      if (result.resolved.kind === "local") {
        ticker = result.resolved.ticker;
      } else {
        const upserted = await upsertTickerFromSearchResult(pluginRegistry.tickerRepository, result.resolved.result);
        ticker = upserted.ticker;
        created = upserted.created;
      }

      // A Helsinki listing is a euro holding: the instrument's currency comes
      // before the portfolio's and the base currency, as in the AP form.
      const listingCurrency = instrumentCurrency(result.resolved, result.quote);
      if (listingCurrency && !ticker.metadata.currency) {
        ticker = { ...ticker, metadata: { ...ticker.metadata, currency: listingCurrency } };
      }
      const portfolio = stateRef.current.config.portfolios.find((entry) => entry.id === portfolioId);
      let nextTicker: TickerRecord;
      let positionCurrency: string | null = null;
      if (shares === null) {
        nextTicker = addTickerToPortfolio(ticker, portfolioId).ticker;
      } else {
        const costBasis = avgCost ?? result.quote?.price;
        if (costBasis === undefined || costBasis === null || !Number.isFinite(costBasis)) {
          setFieldIdx(2);
          setError(t("No live price yet. Enter the average cost."));
          return false;
        }
        positionCurrency = resolveManualPositionCurrency(
          current.currency.trim() || listingCurrency || undefined,
          ticker,
          portfolio ?? { id: portfolioId, name: portfolioId, currency: stateRef.current.config.baseCurrency },
          stateRef.current.config.baseCurrency,
        );
        // A future is entered in contracts, sized by its terms.
        const size = await loadFuturesEntrySize(ticker);
        nextTicker = setManualPortfolioPosition(ticker, portfolioId, {
          shares,
          avgCost: costBasis,
          currency: positionCurrency,
          ...(size ? { multiplier: size.multiplier } : {}),
        }).ticker;
      }

      const firstPosition = !hasOpenPortfolioPositions(portfolioId, stateRef.current.tickers.values());
      await pluginRegistry.tickerRepository.saveTicker(nextTicker);
      dispatch({ type: "UPDATE_TICKER", ticker: nextTicker });
      const adopted = positionCurrency && firstPosition
        ? adoptFirstPositionCurrency(stateRef.current.config, portfolioId, positionCurrency)
        : null;
      if (adopted) {
        dispatch({ type: "SET_CONFIG", config: adopted });
        await saveConfigImmediately(adopted);
      }
      if (created) {
        pluginRegistry.events.emit("ticker:added", { symbol: nextTicker.metadata.ticker, ticker: nextTicker });
      }
      pluginRegistry.events.emit("host:portfolio-ticker-saved", {
        symbol: nextTicker.metadata.ticker,
        portfolioId,
      });
      onboardingLog.info("Onboarding position saved", {
        symbol: nextTicker.metadata.ticker,
        shares,
        priced: avgCost !== null || !!result.quote,
      });
      resetDraft();
      return true;
    } catch (caught) {
      const message = isProviderBusy(caught) ? t("Search is busy, try again in a moment.")
        : caught instanceof Error && caught.message.trim() ? caught.message.trim() : t("Could not add that position.");
      onboardingLog.error("Onboarding position failed", { query, error: message });
      setFieldIdx(0);
      setError(message);
      return false;
    } finally {
      setSubmitting(false);
    }
  }, [dispatch, pluginRegistry, portfolioId, quantityLabel, resetDraft, resolveSymbol, stateRef, submitting]);

  /** Enter inside the form: move to the next field, or save from the last one. */
  const submitField = useCallback(() => {
    if (submitting) return;
    const current = draftRef.current;
    if (fieldIdx === 0) {
      if (!normalizePositionQuery(current.ticker)) {
        setError(t("Enter a ticker symbol."));
        return;
      }
      setError(null);
      setFieldIdx(1);
      return;
    }
    if (fieldIdx === 1) {
      const shares = parseAmount(current.shares);
      const sharesError = shares === null ? null : validatePositionShares(shares, quantityLabel);
      if (sharesError) {
        setError(ambiguousAmount(current.shares, quantityLabel) ?? t(sharesError));
        return;
      }
      setError(null);
      // Following without a holding needs no cost basis.
      if (shares === null) {
        void addPosition();
        return;
      }
      setFieldIdx(2);
      return;
    }
    if (fieldIdx === 2) {
      const avgCost = parseAmount(current.avgCost);
      if (avgCost !== null && (Number.isNaN(avgCost) || avgCost < 0)) {
        setError(ambiguousAmount(current.avgCost, "Average cost") ?? t("Average cost must be a number."));
        return;
      }
      setError(null);
      setFieldIdx(3);
      return;
    }
    void addPosition();
  }, [addPosition, fieldIdx, quantityLabel, submitting]);

  const removePosition = useCallback(async (symbol: string) => {
    const ticker = stateRef.current.tickers.get(symbol);
    if (!ticker) return;
    const result = removeTickerFromPortfolio(ticker, portfolioId);
    if (!result.changed) return;
    await pluginRegistry.tickerRepository.saveTicker(result.ticker);
    dispatch({ type: "UPDATE_TICKER", ticker: result.ticker });
  }, [dispatch, pluginRegistry.tickerRepository, portfolioId, stateRef]);

  return {
    portfolioId,
    positions,
    draft,
    /** What a blank Currency saves: the listing's currency, else the portfolio's. */
    blankCurrency: (preview.status === "ready" && preview.currency ? preview.currency : fallbackCurrency).toUpperCase(),
    fieldIdx,
    preview,
    /** What the size field counts: Contracts for a future, else Shares. */
    quantityLabel,
    submitting,
    error,
    setField,
    focusField,
    setFieldIdx,
    submitField,
    addPosition,
    removePosition,
    resetDraft,
  };
}

export type OnboardingPositionsState = ReturnType<typeof useOnboardingPositions>;
export type { OnboardingPositionRow };
