import { parsePublicTickerKey } from "../../../utils/exchanges";
import { futuresGenericCaption, futuresGenericListing } from "../../../utils/futures-generic";
import type { BacktestHistory } from "./client";
import { runBacktest, type BacktestOptions, type BacktestResult } from "./engine";
import type { BacktestBar, Rule } from "./rules";

/** Which served sessions a run tests. */
export interface BacktestWindowOptions {
  /** Last session tested (YYYY-MM-DD), so a run can be repeated exactly; null runs through the newest. */
  end?: string | null;
  /** Keep a session still forming. Left out by default: its close moves until the day ends. */
  includePartial?: boolean;
}

/** Dates listed in full up to this many; a longer list names its first and last few and counts the rest. */
const LISTED_DATES = 6;

/** `2020-04-20`, `2020-04-20 and 2020-04-21`, or `2020-04-20, 2020-04-21, 2020-04-22, 9 more and 2021-01-04`. */
export function listDates(dates: readonly string[]): string {
  const items = dates.length <= LISTED_DATES
    ? [...dates]
    : [...dates.slice(0, 3), `${dates.length - 5} more`, ...dates.slice(-2)];
  return items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items.at(-1)}` : items[0] ?? "";
}

/** A run over a loaded history, as `runHistoryBacktest` returns it. */
export interface HistoryBacktestResult extends BacktestResult {
  /**
   * Running it again gives the same answer: it has an end no later than the
   * newest complete session served. Without one, or with one still to come,
   * later sessions change it.
   */
  repeatable: boolean;
}

/**
 * The bars a run tests, and a warning for every served session it leaves out
 * other than after `end`: closes the curve cannot run through, named by date,
 * and a session still forming, which is left out unless asked for so the
 * newest complete session ends the run and a repeat gives the same answer.
 * An end after the newest complete session is warned too: sessions still to
 * come up to it change the run until it has passed.
 */
export function backtestWindow(
  history: Pick<BacktestHistory, "bars" | "skippedDates" | "undatedSkipped">,
  options: BacktestWindowOptions = {},
): { bars: BacktestBar[]; warnings: string[]; repeatable: boolean } {
  const end = options.end?.trim() || null;
  const inWindow = end ? history.bars.filter((bar) => bar.date <= end) : history.bars;
  if (end && inWindow.length === 0 && history.bars.length > 0) {
    throw new Error(`No daily sessions on or before ${end}: the history starts ${history.bars[0]!.date}.`);
  }
  const warnings: string[] = [];
  const skipped = end ? history.skippedDates.filter((date) => date <= end) : history.skippedDates;
  if (skipped.length > 0) {
    warnings.push(`${skipped.length} ${skipped.length === 1 ? "session" : "sessions"} without a positive close`
      + ` ${skipped.length === 1 ? "was" : "were"} left out: ${listDates(skipped)}.`);
  }
  if (history.undatedSkipped > 0) {
    warnings.push(`${history.undatedSkipped} price ${history.undatedSkipped === 1 ? "point" : "points"} without a date ${history.undatedSkipped === 1 ? "was" : "were"} left out.`);
  }
  const forming = inWindow.filter((bar) => bar.partial);
  const bars = forming.length === 0 || options.includePartial ? inWindow : inWindow.filter((bar) => !bar.partial);
  const through = bars.at(-1)?.date;
  if (forming.length > 0) {
    const dates = listDates(forming.map((bar) => bar.date));
    warnings.push(options.includePartial
      ? `${dates} ${forming.length === 1 ? "is" : "are"} still forming (partial) and kept: the last close is the latest price, so the results move until the session ends.`
      : `${dates} ${forming.length === 1 ? "is" : "are"} still forming (partial) and left out`
        + `${through ? `: the test runs through ${through}, the last complete session` : ""}.`);
  }
  const newestComplete = history.bars.findLast((bar) => !bar.partial)?.date;
  const repeatable = !!end && !!newestComplete && end <= newestComplete;
  if (end && !repeatable && through) {
    warnings.push(`The end date ${end} is after the newest complete session, so the run ends at ${through}`
      + ` and is not repeatable until ${end} has passed.`);
  }
  return { bars, warnings, repeatable };
}

/** The run over a loaded history: its window's bars, then the engine, every left-out session warned first. */
export function runHistoryBacktest(
  history: Pick<BacktestHistory, "bars" | "skippedDates" | "undatedSkipped">,
  entry: Rule,
  exit: Rule,
  options: BacktestOptions & BacktestWindowOptions,
): HistoryBacktestResult {
  const window = backtestWindow(history, options);
  const result = runBacktest(window.bars, entry, exit, options);
  return { ...result, warnings: [...window.warnings, ...result.warnings], repeatable: window.repeatable };
}

/**
 * What a futures continuation is, said wherever its backtest is read: a
 * continuous symbol (CL=F) rolls front months by volume, a generic (CL2F5R)
 * by its rule, and unless adjusted each roll is a jump between two contracts'
 * prices that the returns include. Null for anything else, a dated contract included.
 */
export function continuationNote(symbol: string, exchange?: string | null): string | null {
  const key = parsePublicTickerKey(symbol);
  if (/^[A-Z0-9]{1,6}=F$/.test(key.symbol)) {
    return `${key.symbol} is a rolled front-month continuation, not one contract: it moves to the next contract as that one`
      + " becomes the most active, and each roll shows in the returns as a jump between the two contracts' prices.";
  }
  const generic = futuresGenericListing(symbol, exchange ?? key.exchange);
  if (!generic) return null;
  const caption = futuresGenericCaption(generic).slice(generic.ticker.length).trim();
  const rolls = generic.adjust === "none"
    ? "each roll shows in the returns as a jump between the two contracts' prices"
    : `prices before each roll are ${generic.adjust} adjusted, so they are not prices that traded`;
  return `${generic.ticker} is a rolled ${generic.position === 1 ? "front-month " : ""}continuation (${caption}), not one contract: ${rolls}.`;
}
