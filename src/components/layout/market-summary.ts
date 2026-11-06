import { useEffect, useMemo, useRef, useState } from "react";
import { priceColor, type ThemeColors } from "../../theme/colors";
import { useThemeColors } from "../../theme/theme-context";
import { useAppVisible } from "../../state/app/activity";
import { useAppSelector } from "../../state/app/context";
import { getSharedMarketDataCoordinator, resolveEntryValue } from "../../market-data/coordinator";
import { tf } from "../../i18n";
import { useQuoteEntries } from "../../market-data/hooks";
import { buildQuoteKey } from "../../market-data/selectors";
import type { QueryEntry } from "../../market-data/result-types";
import type { InstrumentRef } from "../../market-data/request-types";
import { useQuoteStreaming } from "../../state/hooks/quote-streaming";
import type { QuoteSubscriptionTarget } from "../../types/data-provider";
import { displayWidth, formatPercentRaw } from "../../utils/format";
import { formatMarketPriceWithCurrency, liveQuoteFormatOptions } from "../../market-data/market/format";
import { exchangeShortName, getSessionMoveDisplay, marketStateColor } from "../../market-data/market/status";
import { resolveHeaderMarket, systemTimeZone, type HeaderMarketTarget } from "../../market-data/market/header-market";
import { venueSessionNow, type VenueSessionNow, type VenueSessionPhase } from "../../market-data/market/venue-session";
import { isAlwaysOpenExchange } from "../../market-data/market/freshness";
import { classifyInstrumentType } from "../../tickers/instrument-kind";
import { canonicalExchange } from "../../utils/exchanges";
import { timeZoneLabel, zonedDateKey, zonedDateTimeParts } from "../../utils/zoned-date-time";
import type { MarketState, Quote } from "../../types/financials";
import { useDelayedMarkMinutes } from "../ui/delayed-mark";
import { logFailure } from "../../utils/log-failure";

/**
 * The header's quote rides the shared feed. The snapshot poll only runs
 * while the feed has not delivered for this long: signed out, a dropped
 * connection, or a build without a streaming source.
 */
const QUOTE_FALLBACK_REFRESH_MS = 5 * 60_000;
/**
 * The header is always on screen but never the thing being read, so its
 * quote ranks as a visible monitor symbol with a low weight: panes the user
 * is working in win any per-plan cap on streamed symbols.
 */
const QUOTE_STREAM_WEIGHT = 20;
const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 24 * 60 * MS_PER_MINUTE;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
/** A level or price this large reads in whole units in the strip: `S&P 500 6,843`, `BTC $75,686`. */
const WHOLE_UNITS_FROM = 1_000;

export interface MarketSummary {
  /** The market's venue and where its day stands (`NYSE closed`), empty when it trades around the clock. */
  marketLabel: string;
  /** When that changes, read on the venue's clock (`opens 9:30 ET`, `2h10 left`); null when nothing says. */
  marketDetail: string | null;
  marketColor: string;
  /** What the quote is: a benchmark's name (`S&P 500`), or a listing's symbol. */
  quoteLabel: string;
  /** The level or price and its move (`6,843 +0.20%`), `—` until a quote arrives. */
  quoteText: string;
  /** `quoteText` without its move, for a header too narrow for both. */
  quotePriceText: string;
  quoteColor: string;
  /**
   * Minutes the quote is late for this account (signed out or free), drawn as the delayed
   * mark beside it; null when live, and while the status bar's delayed note says it for the app.
   */
  quoteDelayMinutes: number | null;
}

export interface MarketSummaryFit {
  showQuote: boolean;
  /** The quote keeps its move; false when it gave the move up to stay. */
  showQuoteMove: boolean;
  /** The exchange's state; never without the quote it is the state of. */
  showState: boolean;
  /** The opening time or countdown after the state; never without it. */
  showDetail: boolean;
}

/**
 * Picks which parts of the cluster survive at a given width, ordered by how
 * much each can still change: the quote first, then the market state, then
 * the detail (the opening time or countdown) that widens the state. A
 * narrowing header therefore sheds the detail, then the state, and keeps the
 * quote longest, giving up its move before it gives way. Each width includes
 * the gap after its part; `detailWidth` is what the detail adds to the state,
 * and `quoteMoveWidth` what the move adds to the quote.
 */
export function resolveMarketSummaryFit(options: {
  available: number;
  quoteWidth: number;
  quoteMoveWidth: number;
  stateWidth: number;
  detailWidth: number;
}): MarketSummaryFit {
  let remaining = options.available;
  const take = (width: number): boolean => {
    if (width <= 0 || width > remaining) return false;
    remaining -= width;
    return true;
  };
  const showQuoteMove = take(options.quoteWidth);
  const showQuote = showQuoteMove || (options.quoteMoveWidth > 0 && take(options.quoteWidth - options.quoteMoveWidth));
  const showState = showQuote && take(options.stateWidth);
  const showDetail = showState && take(options.detailWidth);
  return { showQuote, showQuoteMove: showQuote && showQuoteMove, showState, showDetail };
}

/** A quote the strip can show: one with a price. Anything else is no answer, and a benchmark falls back to its listing. */
function isUsableHeaderQuote(quote: Quote | null | undefined): quote is Quote {
  return !!quote && Number.isFinite(quote.price) && quote.price > 0;
}

/**
 * The price the strip shows: an index level or a coin above a thousand in
 * whole units (`6,843`, `$75,686`), anything else as its quote line writes
 * it, with its currency's sign and its instrument's fixed decimals, so a
 * streamed tick never slides the cluster.
 */
function headerPriceText(quote: Quote, price: number): string {
  const options = liveQuoteFormatOptions(quote, quote.currency, "ETF");
  const kind = classifyInstrumentType(quote.instrumentType);
  const whole = (kind === "index" || kind === "crypto") && Math.abs(price) >= WHOLE_UNITS_FROM;
  return whole
    ? formatMarketPriceWithCurrency(Math.round(price), quote.currency || "USD", { ...options, fixedFractionDigits: 0 })
    : formatMarketPriceWithCurrency(price, quote.currency || "USD", options);
}

/**
 * The quote in the header's one slot: the live price while its session
 * trades, its close and the move to it once it is over, and the open
 * pre-market or after-hours print with its move from the close while one is
 * on, as `ticker` headlines them. A percent slot as wide as "+0.53%" keeps a
 * tick from sliding the market state.
 */
export function headerQuoteSummary(
  quote: Quote | null | undefined,
  colors: ThemeColors,
): Pick<MarketSummary, "quoteColor" | "quotePriceText" | "quoteText"> {
  const display = isUsableHeaderQuote(quote) ? getSessionMoveDisplay(quote) : null;
  if (!quote || !display || !Number.isFinite(display.price)) return { quoteColor: colors.textDim, quotePriceText: "—", quoteText: "—" };
  const quotePriceText = headerPriceText(quote, display.price);
  return {
    quoteColor: display.change != null ? priceColor(display.change, colors) : colors.textDim,
    quotePriceText,
    quoteText: `${quotePriceText} ${formatPercentRaw(display.changePercent).padStart(6)}`,
  };
}

/** Time left in a session, to the minute, rounded up: `2h10`, `2h`, `45m`. */
function formatSessionCountdown(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / MS_PER_MINUTE));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h${String(rest).padStart(2, "0")}` : `${hours}h`;
}

/**
 * When the venue opens, on its own clock: `9:30 ET` within the next day,
 * `Mon 9:30 ET` further out, `24 Feb 9:30 HKT` a week or more away.
 */
function venueOpenText(at: number, now: number, timeZone: string): string {
  const days = Math.round((Date.parse(`${zonedDateKey(at, timeZone)}T00:00:00Z`) - Date.parse(`${zonedDateKey(now, timeZone)}T00:00:00Z`)) / MS_PER_DAY);
  const { year, month, day, hour, minute } = zonedDateTimeParts(at, timeZone);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const date = days < 2 ? "" : days < 7 ? `${WEEKDAYS[weekday]} ` : `${day} ${MONTHS[month - 1]} `;
  return `${date}${hour}:${String(minute).padStart(2, "0")} ${timeZoneLabel(timeZone)}`;
}

const PHASE_LABELS: Record<VenueSessionPhase, string> = {
  open: "{venue} open",
  lunch: "{venue} lunch",
  "pre-market": "{venue} pre-market",
  "after-hours": "{venue} after-hours",
  closed: "{venue} closed",
  holiday: "{venue} holiday",
};

/** The market state each phase is coloured as: the regular session's, an extended session's, a closed one's. */
const PHASE_STATES: Record<VenueSessionPhase, MarketState> = {
  open: "REGULAR",
  lunch: "PRE",
  "pre-market": "PRE",
  "after-hours": "POST",
  closed: "CLOSED",
  holiday: "CLOSED",
};

/**
 * The strip's market state, named by its venue and read from the venue's own
 * hours and holidays: `NYSE closed · opens 9:30 ET`, `HKEX open · 2h10 left`,
 * `HKEX lunch · reopens 13:00 HKT`, `NYSE holiday · opens Fri 9:30 ET`.
 */
function venueSessionLabel(venue: string, session: VenueSessionNow, now: number): { label: string; detail: string | null } {
  const label = tf(PHASE_LABELS[session.phase], { venue });
  if (session.phase === "open") {
    return { label, detail: session.closesAt != null ? tf("{time} left", { time: formatSessionCountdown(session.closesAt - now) }) : null };
  }
  if (session.opensAt == null) return { label, detail: null };
  const time = venueOpenText(session.opensAt, now, session.timeZone);
  return { label, detail: tf(session.phase === "lunch" ? "reopens {time}" : "opens {time}", { time }) };
}

/** A phase from the state a quote reports, for a venue whose hours the app does not know. */
function quotedPhase(state: MarketState | undefined): VenueSessionPhase | null {
  switch (state) {
    case "REGULAR": return "open";
    case "PRE": return "pre-market";
    case "POST": return "after-hours";
    case "PREPRE":
    case "POSTPOST":
    case "CLOSED": return "closed";
    default: return null;
  }
}

/**
 * Where the header's market stands: its venue's calendar when the app knows
 * its hours (a benchmark's venue, or the venue a picked listing trades on),
 * otherwise the state its quote reports, without a time. Nothing for a
 * market that trades around the clock.
 */
export function headerMarketState(
  target: Pick<HeaderMarketTarget, "venue" | "exchange">,
  quote: Quote | null | undefined,
  now: number,
  colors: ThemeColors,
): Pick<MarketSummary, "marketColor" | "marketDetail" | "marketLabel"> {
  const venue = target.venue
    ?? canonicalExchange(quote?.listingExchangeName || quote?.exchangeName || target.exchange);
  const none = { marketColor: colors.textDim, marketDetail: null, marketLabel: "" };
  if (!venue || isAlwaysOpenExchange(venue)) return none;
  const session = venueSessionNow(venue, now);
  if (session) {
    const { label, detail } = venueSessionLabel(venue, session, now);
    return { marketColor: marketStateColor(PHASE_STATES[session.phase], colors), marketDetail: detail, marketLabel: label };
  }
  const phase = quotedPhase(quote?.marketState);
  if (!phase) return none;
  const name = exchangeShortName(quote?.listingExchangeName || quote?.exchangeName, quote?.fullExchangeName) || venue;
  return { marketColor: marketStateColor(PHASE_STATES[phase], colors), marketDetail: null, marketLabel: tf(PHASE_LABELS[phase], { venue: name }) };
}

/** Cells the cluster's parts take, each with the gap after it, as `resolveMarketSummaryFit` reads them. */
export function marketSummaryWidths(summary: MarketSummary, delayedMarkWidth: number): {
  quoteWidth: number;
  quoteMoveWidth: number;
  stateWidth: number;
  detailWidth: number;
} {
  const mark = summary.quoteDelayMinutes != null ? delayedMarkWidth + 1 : 0;
  return {
    quoteWidth: displayWidth(summary.quoteLabel) + 1 + displayWidth(summary.quoteText) + 1 + mark,
    quoteMoveWidth: displayWidth(summary.quoteText) - displayWidth(summary.quotePriceText),
    stateWidth: summary.marketLabel ? displayWidth(summary.marketLabel) + 1 : 0,
    detailWidth: summary.marketDetail ? displayWidth(` · ${summary.marketDetail}`) : 0,
  };
}

function quoteEntryAnswered(entry: QueryEntry<Quote> | null | undefined): boolean {
  return !!entry && (entry.phase === "ready" || entry.phase === "error");
}

function usableEntryQuote(entry: QueryEntry<Quote> | null | undefined): Quote | null {
  const quote = entry ? resolveEntryValue(entry) : null;
  return isUsableHeaderQuote(quote) ? quote : null;
}

/** The market's local minute, so its countdown and state turn over on the minute. */
function useMinuteClock(active: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      const at = Date.now();
      // Back from hidden, the clock catches up; within the same minute nothing renders.
      setNow((previous) => Math.floor(previous / MS_PER_MINUTE) === Math.floor(at / MS_PER_MINUTE) ? previous : at);
      timer = setTimeout(tick, MS_PER_MINUTE - (at % MS_PER_MINUTE) + 50);
    };
    tick();
    return () => { if (timer) clearTimeout(timer); };
  }, [active]);
  return now;
}

export function useMarketSummary(): MarketSummary {
  const colors = useThemeColors();
  const appActive = useAppVisible();
  const choice = useAppSelector((state) => state.config.headerMarket);
  const target = useMemo(() => resolveHeaderMarket(choice, systemTimeZone()), [choice]);
  const instruments = useMemo<InstrumentRef[]>(() => [
    { symbol: target.symbol, exchange: target.exchange },
    ...(target.fallback ? [{ symbol: target.fallback.symbol, exchange: target.fallback.exchange }] : []),
  ], [target]);
  const entries = useQuoteEntries(instruments);
  const primaryQuote = usableEntryQuote(entries.get(buildQuoteKey(instruments[0]!)));
  // A benchmark this account or source has no usable quote for follows the listing that tracks it, and
  // shows it under its own symbol once that has a price; until then the benchmark's name stays, with no price.
  const fallingBack = !!target.fallback && !primaryQuote && quoteEntryAnswered(entries.get(buildQuoteKey(instruments[0]!)));
  const instrument = fallingBack ? instruments[1]! : instruments[0]!;
  const fallbackQuote = fallingBack ? usableEntryQuote(entries.get(buildQuoteKey(instrument))) : null;
  const quote = fallbackQuote ?? primaryQuote;
  const now = useMinuteClock(appActive);

  const streamTargets = useMemo<QuoteSubscriptionTarget[]>(() => [{
    symbol: instrument.symbol,
    exchange: instrument.exchange ?? "",
    surface: "monitor",
    visible: true,
    weight: QUOTE_STREAM_WEIGHT,
  }], [instrument.symbol, instrument.exchange]);
  useQuoteStreaming(streamTargets);
  const quoteRef = useRef(quote);
  quoteRef.current = quote;
  // Snapshot loads only while the feed is quiet, and once for each market the strip turns to.
  useEffect(() => {
    if (!appActive) return;
    const coordinator = getSharedMarketDataCoordinator();
    if (!coordinator) return;
    const topUp = () => {
      const current = quoteRef.current;
      const streamedAt = current?.delivery === "stream" && current.stale !== true ? current.receivedAt ?? 0 : 0;
      if (Date.now() - streamedAt < QUOTE_FALLBACK_REFRESH_MS) return;
      void coordinator.loadQuote({ symbol: instrument.symbol, exchange: instrument.exchange })
        .catch(logFailure("layout.market-summary", "Refresh header market quote failed"));
    };
    topUp();
    const id = setInterval(topUp, QUOTE_FALLBACK_REFRESH_MS);
    return () => { clearInterval(id); };
  }, [appActive, instrument.symbol, instrument.exchange]);

  const { quoteColor, quotePriceText, quoteText } = headerQuoteSummary(quote, colors);
  const quoteDelayMinutes = useDelayedMarkMinutes(quote);
  const state = headerMarketState(target, quote, now, colors);

  return {
    ...state,
    quoteLabel: fallbackQuote ? target.fallback!.label : target.label,
    quoteColor,
    quotePriceText,
    quoteText,
    quoteDelayMinutes,
  };
}
