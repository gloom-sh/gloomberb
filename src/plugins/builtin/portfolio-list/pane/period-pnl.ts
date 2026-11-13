import { formatShortDate } from "../../../../utils/datetime-format";
import { useEffect, useMemo, useRef, useState } from "react";
import { apiClient } from "../../../../api-client";
import type { PortfolioFuturesTerms } from "../../../../portfolio/futures-positions";
import type { PeriodPnlRow } from "../../../../portfolio/period-pnl";
import type { Quote, TickerFinancials } from "../../../../types/financials";
import type { TickerRecord } from "../../../../types/ticker";
import { errorMessage } from "../../../../utils/errors";
import { readPriceWindow, type PriceWindow } from "../../../../utils/price-window";
import { useAssetData } from "../../../runtime";
import { loadPeriodPnl, periodBoughtText, periodUnpricedText, type LoadedPeriodPnl } from "../period-pnl";

export interface PanePeriodPnl {
  window: PriceWindow | null;
  /** The dates did not read as a window, or the closes did not load. */
  error: string | null;
  /** Null while the closes load. */
  result: LoadedPeriodPnl | null;
  rows: ReadonlyMap<string, PeriodPnlRow>;
  pending: boolean;
  /** Moves whenever `rows` does. */
  version: number;
}

const NO_ROWS: ReadonlyMap<string, PeriodPnlRow> = new Map();

const dayMonth = (day: string) => formatShortDate(day, { year: false, utc: true });

/** The day every priced row shares at one end, else the window's own date. */
function sharedDay(result: LoadedPeriodPnl, end: "start" | "end", fallback: string): string {
  const days = new Set(result.rows.flatMap((row) => row[end] ? [row[end]!.day] : []));
  return days.size === 1 ? [...days][0]! : fallback;
}

/** The header's P&L label over a period, from close to close: `P&L 23 Oct–30 Oct`. */
export function periodPnlLabel(period: PanePeriodPnl): string {
  if (!period.window) return "P&L";
  const start = period.result ? sharedDay(period.result, "start", period.window.from) : period.window.from;
  const end = period.result ? sharedDay(period.result, "end", period.window.to) : period.window.to;
  return `P&L ${dayMonth(start)}–${dayMonth(end)}`;
}

/** The FX line under the rows (`FX (HKD)`), so they add up to the header's total; null when every holding is in the book's currency. */
export function periodFxLine(result: LoadedPeriodPnl | null): { currencies: string; pnl: number; contribution: number | null } | null {
  const currencies = [...new Set((result?.rows ?? []).flatMap((row) => row.rates ? [row.rates.currency] : []))];
  return result && currencies.length ? { currencies: currencies.join(", "), pnl: result.fx, contribution: result.fxContribution } : null;
}

/** What the period's P&L leaves out or could not read, and the holdings bought inside it, for the pane's notices. */
export function periodPnlNotices(period: PanePeriodPnl | null): string[] {
  if (!period) return [];
  if (period.error) return [`P&L period: ${period.error}`];
  if (!period.result) return [];
  return [periodUnpricedText(period.result), periodBoughtText(period.result)].filter((notice): notice is string => !!notice);
}

/** The pane's P&L From and To as `portfolio show --from --to` reads them, or why they do not read. */
function readPanePeriod(from: string, to: string, now = new Date()): { window: PriceWindow | null; error: string | null } {
  if (!from) return { window: null, error: null };
  try {
    return { window: readPriceWindow(from, to || undefined, now, undefined, { from: "P&L From", to: "P&L To" }), error: null };
  } catch (error) {
    return { window: null, error: errorMessage(error) };
  }
}

/**
 * The PF pane's P&L over a period: each holding's closes before and in the
 * window, read once per window and set of holdings, as `portfolio show
 * --from` reads them. Null for P&L since cost (no P&L From).
 */
export function usePanePeriodPnl({ from, to, enabled, portfolioId, tickers, currency, futures, futuresVersion, financialsMap, snapshot }: {
  from: string;
  to: string;
  enabled: boolean;
  portfolioId: string;
  tickers: readonly TickerRecord[];
  currency: string;
  futures: ReadonlyMap<string, PortfolioFuturesTerms>;
  futuresVersion: number;
  financialsMap: ReadonlyMap<string, TickerFinancials>;
  /** The reading already made for this window (a capture's, from the report): nothing is loaded. */
  snapshot?: LoadedPeriodPnl | null;
}): PanePeriodPnl | null {
  const provider = useAssetData();
  const { window, error: windowError } = useMemo(() => readPanePeriod(enabled ? from : "", to), [enabled, from, to]);
  // The holdings, their quantities and the currency each is priced in (its quote's, once it arrives): a quote tick does
  // not read the closes again, but a quote that changes a holding's currency does, so pence are never read as pounds.
  const holdings = useMemo(() => tickers.flatMap((ticker) => {
    const shares = ticker.metadata.positions.filter((position) => position.portfolio === portfolioId).reduce((sum, position) => sum + position.shares, 0);
    const priced = financialsMap.get(ticker.metadata.ticker)?.quote?.currency || ticker.metadata.currency || "";
    return shares ? [`${ticker.metadata.ticker}:${shares}:${priced}`] : [];
  }).sort().join(","), [financialsMap, portfolioId, tickers]);
  const given = snapshot && window && snapshot.window.from === window.from && snapshot.window.to === window.to ? snapshot : null;
  const key = window && !given ? `${portfolioId}|${currency}|${window.from}|${window.to}|${holdings}|${futuresVersion}` : "";
  const inputs = useRef({ tickers, futures, financialsMap });
  inputs.current = { tickers, futures, financialsMap };
  const [state, setState] = useState<{ key: string; result: LoadedPeriodPnl | null; error: string | null; version: number }>({ key: "", result: null, error: null, version: 0 });

  useEffect(() => {
    if (!key || !window || !provider) return;
    let cancelled = false;
    const { tickers: held, futures: terms, financialsMap: financials } = inputs.current;
    const quotes = new Map<string, Quote | undefined>(held.map((ticker) => [ticker.metadata.ticker, financials.get(ticker.metadata.ticker)?.quote]));
    void loadPeriodPnl({ tickers: held, portfolioId, currency, window, provider, fxHistory: apiClient, quotes, futures: terms })
      .then((result) => { if (!cancelled) setState((last) => ({ key, result, error: null, version: last.version + 1 })); },
        (error: unknown) => { if (!cancelled) setState((last) => ({ key, result: null, error: errorMessage(error), version: last.version + 1 })); });
    return () => { cancelled = true; };
  }, [currency, key, portfolioId, provider, window]);

  return useMemo(() => {
    if (!enabled || (!window && !windowError)) return null;
    if (given) return { window, error: null, result: given, rows: new Map(given.rows.map((row) => [row.symbol, row])), pending: false, version: 1 };
    const settled = state.key === key && !!key;
    const result = settled ? state.result : null;
    return {
      window,
      error: windowError ?? (settled ? state.error : null) ?? (provider ? null : "Market data unavailable"),
      result,
      rows: result ? new Map(result.rows.map((row) => [row.symbol, row])) : NO_ROWS,
      pending: !!window && !!provider && !settled,
      version: settled ? state.version : 0,
    };
  }, [enabled, given, key, provider, state, window, windowError]);
}
