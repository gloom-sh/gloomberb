import { useEffect, useRef, useState } from "react";
import { priceColor, type ThemeColors } from "../../theme/colors";
import { useThemeColors } from "../../theme/theme-context";
import { useAppVisible } from "../../state/app/activity";
import { useAppSelector } from "../../state/app/context";
import { getSharedMarketDataCoordinator } from "../../market-data/coordinator";
import { t } from "../../i18n";
import { useQuoteEntry, useResolvedEntryValue } from "../../market-data/hooks";
import { useQuoteStreaming } from "../../state/hooks/quote-streaming";
import type { QuoteSubscriptionTarget } from "../../types/data-provider";
import { formatPercentRaw } from "../../utils/format";
import { formatMarketPrice, liveQuoteFormatOptions } from "../../market-data/market/format";
import { getSessionMoveDisplay, marketStateColor, marketStateCountdown, marketStateLabel } from "../../market-data/market/status";
import type { Quote } from "../../types/financials";

/**
 * SPY rides the shared feed. The snapshot poll only runs while the feed has
 * not delivered for this long: signed out, a dropped connection, or a build
 * without a streaming source.
 */
const SPY_FALLBACK_REFRESH_MS = 5 * 60_000;
/**
 * The header is always on screen but never the thing being read, so SPY ranks
 * as a visible monitor symbol with a low weight: panes the user is working in
 * win any per-plan cap on streamed symbols.
 */
const SPY_STREAM_TARGETS: QuoteSubscriptionTarget[] = [{
  symbol: "SPY",
  exchange: "",
  surface: "monitor",
  visible: true,
  weight: 20,
}];

export interface MarketSummary {
  baseCurrency: string;
  marketColor: string;
  /** Market state with its countdown, when the state has one. */
  marketLabel: string;
  /** Market state alone, for a header too narrow for the countdown. */
  marketLabelShort: string;
  spyColor: string;
  spyText: string;
}

export interface MarketSummaryFit {
  showBaseCurrency: boolean;
  showCountdown: boolean;
  showState: boolean;
  showSpy: boolean;
}

/**
 * Picks which parts of the cluster survive at a given width, ordered by how
 * much each can still change: SPY first, then the market-state label, then the
 * base currency, then the countdown suffix that widens the label. A narrowing
 * header therefore sheds the countdown, then the currency, then the state, and
 * keeps SPY longest. `countdownWidth` is what the suffix adds to the label.
 */
export function resolveMarketSummaryFit(options: {
  available: number;
  baseCurrencyWidth: number;
  countdownWidth: number;
  spyWidth: number;
  stateWidth: number;
}): MarketSummaryFit {
  let remaining = options.available;
  const take = (width: number): boolean => {
    if (width <= 0 || width > remaining) return false;
    remaining -= width;
    return true;
  };
  const showSpy = take(options.spyWidth);
  const showState = take(options.stateWidth);
  const showBaseCurrency = take(options.baseCurrencyWidth);
  const showCountdown = showState && take(options.countdownWidth);
  return { showBaseCurrency, showCountdown, showState, showSpy };
}

/**
 * SPY in the header's one slot, beside the market state: the live quote while
 * the regular session trades, and once it is over its close and the move to
 * it, as `ticker SPY` headlines them. While a pre-market or after-hours
 * session is open (PRE-MKT, AFTER-HRS) the slot is that session's print and
 * its move from the close, so the figure is the session the label names.
 */
export function spySummary(quote: Quote | null | undefined, colors: ThemeColors): Pick<MarketSummary, "spyColor" | "spyText"> {
  const display = getSessionMoveDisplay(quote);
  // Fixed decimals and a percent slot as wide as "+0.53%", so a streamed tick
  // never slides the market-state label or re-fits the cluster.
  return {
    spyColor: display?.change != null ? priceColor(display.change, colors) : colors.textDim,
    spyText: display
      ? `SPY ${formatMarketPrice(display.price, liveQuoteFormatOptions(quote, quote?.currency, "ETF"))} ${formatPercentRaw(display.changePercent).padStart(6)}`
      : "SPY —",
  };
}

export function useMarketSummary(): MarketSummary {
  const colors = useThemeColors();
  const appActive = useAppVisible();
  const baseCurrency = useAppSelector((state) => state.config.baseCurrency);
  const spyQuoteEntry = useQuoteEntry("SPY", null);
  const spyQuote = useResolvedEntryValue(spyQuoteEntry);
  const mktState = spyQuote?.marketState;
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!appActive || (mktState !== "PRE" && mktState !== "REGULAR")) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [appActive, mktState]);

  useQuoteStreaming(SPY_STREAM_TARGETS);
  const spyQuoteRef = useRef(spyQuote);
  spyQuoteRef.current = spyQuote;
  // Snapshot loads only while the feed is quiet. The first one shares its
  // request with the paint `useQuoteEntry` starts on mount.
  useEffect(() => {
    if (!appActive) return;
    const coordinator = getSharedMarketDataCoordinator();
    if (!coordinator) return;
    const topUp = () => {
      const quote = spyQuoteRef.current;
      const streamedAt = quote?.delivery === "stream" && quote.stale !== true ? quote.receivedAt ?? 0 : 0;
      if (Date.now() - streamedAt < SPY_FALLBACK_REFRESH_MS) return;
      void coordinator.loadQuote({ symbol: "SPY" }).catch(() => {});
    };
    topUp();
    const id = setInterval(topUp, SPY_FALLBACK_REFRESH_MS);
    return () => { clearInterval(id); };
  }, [appActive]);

  const { spyColor, spyText } = spySummary(spyQuote, colors);

  const mktCountdown = mktState ? marketStateCountdown(mktState, now) : null;
  const marketLabelShort = mktState ? t(marketStateLabel(mktState)) : "";
  const marketLabel = marketLabelShort && mktCountdown
    ? `${marketLabelShort} · ${mktCountdown}`
    : marketLabelShort;

  return {
    baseCurrency,
    marketColor: mktState ? marketStateColor(mktState, colors) : colors.textDim,
    marketLabel,
    marketLabelShort,
    spyColor,
    spyText,
  };
}
