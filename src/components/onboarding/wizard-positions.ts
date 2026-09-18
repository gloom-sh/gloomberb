import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PluginRegistry } from "../../plugins/registry";
import {
  addTickerToPortfolio,
  removeTickerFromPortfolio,
  resolveManualPositionCurrency,
  setManualPortfolioPosition,
} from "../../plugins/builtin/portfolio-list/mutations";
import { useAppDispatch, useAppSelector, useAppStateRef } from "../../state/app/context";
import { resolveTickerSearch, upsertTickerFromSearchResult, type ResolvedTickerSearch } from "../../tickers/search";
import type { Quote } from "../../types/financials";
import type { TickerRecord } from "../../types/ticker";
import { t } from "../../i18n";
import { debugLog } from "../../utils/debug-log";
import {
  getOnboardingPortfolioId,
  listOnboardingPositions,
  type OnboardingPositionRow,
} from "./wizard-model";

const onboardingLog = debugLog.createLogger("onboarding");
const PREVIEW_DEBOUNCE_MS = 300;
const SYMBOL_QUERY = /^[A-Z0-9][A-Z0-9.\-^=/\s]*$/;

export type PositionFieldId = "ticker" | "shares" | "avgCost";
export const POSITION_FIELDS: readonly PositionFieldId[] = ["ticker", "shares", "avgCost"];

export interface PositionDraft {
  ticker: string;
  shares: string;
  avgCost: string;
}

export type PositionPreview =
  | { status: "idle" }
  | { status: "checking"; query: string }
  | { status: "ready"; query: string; symbol: string; name: string; quote: Quote | null; duplicate: boolean }
  | { status: "missing"; query: string; message: string };

const EMPTY_DRAFT: PositionDraft = { ticker: "", shares: "", avgCost: "" };

export function normalizePositionQuery(value: string): string {
  return value.replace(/^\s*\$/, "").trim().toUpperCase().replace(/\s+/g, " ");
}

function isSymbolQuery(query: string): boolean {
  return query.length > 0 && query.length <= 32 && SYMBOL_QUERY.test(query);
}

function parseAmount(value: string): number | null {
  const trimmed = value.trim().replace(/,/g, "");
  if (!trimmed) return null;
  const amount = Number(trimmed);
  return Number.isFinite(amount) ? amount : Number.NaN;
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
  const draftRef = useRef(draft);
  draftRef.current = draft;

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
    let quote: Quote | null = stateRef.current.financials.get(resolved.symbol)?.quote ?? null;
    if (!quote) {
      try {
        const exchange = resolved.kind === "provider" ? resolved.result.exchange : resolved.ticker.metadata.exchange;
        quote = await pluginRegistry.marketData.getQuote(resolved.symbol, exchange);
      } catch {
        quote = null;
      }
    }
    if (quote) setFetchedQuotes((current) => ({ ...current, [resolved.symbol]: quote! }));
    return { resolved, ticker, quote, name: resolvedName(resolved, ticker) };
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
          duplicate: !!result.ticker?.metadata.portfolios.includes(portfolioId),
        });
      }).catch(() => {
        if (previewSeqRef.current === seq) {
          setPreview({ status: "missing", query, message: t("Ticker lookup failed") });
        }
      });
    }, PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [draft.ticker, portfolioId, resolveSymbol]);

  const setField = useCallback((field: PositionFieldId, value: string) => {
    setError(null);
    setDraft((current) => ({ ...current, [field]: field === "ticker" ? value.toUpperCase() : value }));
  }, []);

  const focusField = useCallback((index: number) => {
    setError(null);
    setFieldIdx(Math.max(0, Math.min(POSITION_FIELDS.length - 1, index)));
    onFieldEditing(true);
  }, [onFieldEditing]);

  const resetDraft = useCallback(() => {
    setDraft(EMPTY_DRAFT);
    setFieldIdx(0);
    setPreview({ status: "idle" });
  }, []);

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
    if (shares !== null && (Number.isNaN(shares) || shares <= 0)) {
      setFieldIdx(1);
      setError(t("Shares must be greater than 0."));
      return false;
    }
    const avgCost = parseAmount(current.avgCost);
    if (avgCost !== null && (Number.isNaN(avgCost) || avgCost < 0)) {
      setFieldIdx(2);
      setError(t("Average cost must be a number."));
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

      const portfolio = stateRef.current.config.portfolios.find((entry) => entry.id === portfolioId);
      let nextTicker: TickerRecord;
      if (shares === null) {
        nextTicker = addTickerToPortfolio(ticker, portfolioId).ticker;
      } else {
        const costBasis = avgCost ?? result.quote?.price;
        if (costBasis === undefined || costBasis === null || !Number.isFinite(costBasis)) {
          setFieldIdx(2);
          setError(t("No live price yet. Enter the average cost."));
          return false;
        }
        nextTicker = setManualPortfolioPosition(ticker, portfolioId, {
          shares,
          avgCost: costBasis,
          currency: resolveManualPositionCurrency(
            undefined,
            ticker,
            portfolio ?? { id: portfolioId, name: portfolioId, currency: stateRef.current.config.baseCurrency },
            stateRef.current.config.baseCurrency,
          ),
        }).ticker;
      }

      await pluginRegistry.tickerRepository.saveTicker(nextTicker);
      dispatch({ type: "UPDATE_TICKER", ticker: nextTicker });
      if (created) {
        pluginRegistry.events.emit("ticker:added", { symbol: nextTicker.metadata.ticker, ticker: nextTicker });
      }
      pluginRegistry.events.emit("command-bar:portfolio-membership-persisted", {
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
      const message = caught instanceof Error && caught.message.trim() ? caught.message.trim() : t("Could not add that position.");
      onboardingLog.error("Onboarding position failed", { query, error: message });
      setFieldIdx(0);
      setError(message);
      return false;
    } finally {
      setSubmitting(false);
    }
  }, [dispatch, pluginRegistry, portfolioId, resetDraft, resolveSymbol, stateRef, submitting]);

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
      if (shares !== null && (Number.isNaN(shares) || shares <= 0)) {
        setError(t("Shares must be greater than 0."));
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
    void addPosition();
  }, [addPosition, fieldIdx, submitting]);

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
    fieldIdx,
    preview,
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
