import { liveCompanyQuestion } from "./company-name-hint";
import { movedSymbolLine, parseListingArg, type ListingDeps } from "./listing-arg";
import { requireQuotedListing, type QuotedListing } from "./quote-answer";
import {
  bareListingNote,
  describeListingFate,
  listingChangeLine,
  loadListingFate,
  noLongerTradingNote,
  SUCCESSOR_CHANGE_WAIT_MS,
} from "../tickers/listing-fate";
import { startTickerChangeLookup } from "../tickers/ticker-changes";
import { logFailure } from "../utils/log-failure";

/**
 * Why an alert was refused for what was typed, with what to type instead as
 * `details`. `reason` says it without the refusal, for a form that checks
 * the symbol before anything is added.
 */
export class AlertListingRefusal extends Error {
  readonly reason: string;

  constructor(message: string, readonly details?: string, reason?: string) {
    super(message);
    this.name = "AlertListingRefusal";
    this.reason = reason ?? message;
  }
}

export interface AlertListingOptions {
  /** The command that adds the alert on another symbol (`gloom alerts add XYZ above 80`); none in the app. */
  retry?: (symbol: string) => string | null;
  now?: number;
}

/**
 * The listing an alert follows, read as `quote` reads the symbol: the same
 * resolver (a company's name such as "Singtel" is Z74:SGX), and what `quote`
 * says of what became of it. Every place an alert is added goes through here:
 * `gloom alerts add`, ALRT's Add Alert and SA.
 *
 * - A listing that no longer trades is refused, since nothing would ever
 *   check it: DBS, the silver fund delisted in 2023, asks after D05:SGX (DBS
 *   Group Holdings); SQ, which last traded before Block became XYZ, names XYZ.
 * - A symbol its company left for another that something new trades under is
 *   kept, saying so: FB is a fund now, and Meta trades as META.
 *
 * Throws `AlertListingRefusal` with why.
 */
export interface AlertListing extends QuotedListing {
  /** What became of the symbol, also among `notes`: FB's line, saying Meta trades as META. */
  fate: string[];
}

export async function resolveAlertListing(
  typed: string,
  exchange: string | null | undefined,
  deps: ListingDeps,
  options: AlertListingOptions = {},
): Promise<AlertListing> {
  const fail = (message: string, details?: string): never => {
    throw new AlertListingRefusal(message, details);
  };
  const quoted = await requireQuotedListing(typed, exchange, deps, { fail }, "alerts add");
  // What became of the symbol is a note beside the alert; a lookup that fails leaves the alert as `quote` reads it.
  const fate = await alertListingNotes(quoted, typed, exchange, deps, options).catch((error: unknown) => {
    if (error instanceof AlertListingRefusal) throw error;
    return logFailure("cli.alert-listing", "Read what became of an alert's symbol failed", [] as string[])(error);
  });
  return { ...quoted, notes: [...quoted.notes, ...fate], fate };
}

async function alertListingNotes(
  { listing, quote }: QuotedListing,
  typed: string,
  exchange: string | null | undefined,
  deps: ListingDeps,
  { retry, now = Date.now() }: AlertListingOptions,
): Promise<string[]> {
  // A bare symbol read on a listing abroad (Z74 -> SGX) is not the US symbol the changes are of.
  const fate = bareListingNote(listing, quote)
    ? describeListingFate(listing, quote, null, now)
    : await loadListingFate(listing, deps.dataProvider, {
      quote,
      changes: startTickerChangeLookup(deps.dataProvider, listing.symbol, listing.exchange),
      graceMs: SUCCESSOR_CHANGE_WAIT_MS,
    });
  const stopped = noLongerTradingNote(`${listing.symbol}${quote.name ? ` (${quote.name})` : ""}`, quote, now);
  if (stopped) {
    const named = !!parseListingArg(typed, exchange).exchange;
    const pointer = fate.moved
      ? movedSymbolLine(fate.moved, retry?.(fate.moved.tradesAs) ?? null)
      : named ? null : await liveCompanyQuestion(typed, deps, now);
    throw new AlertListingRefusal(`${stopped}, so no alert was added.`, pointer ?? undefined, `${stopped}.`);
  }
  const changed = listingChangeLine(fate);
  return changed ? [changed] : [];
}
