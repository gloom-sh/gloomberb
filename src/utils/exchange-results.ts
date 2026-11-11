import type { ExchangeAnnouncementsPayload } from "../api-client/exchange-announcements";
import { settleWithin } from "./async-deadline";
import { parsePublicTickerKey } from "./exchanges";
import { logFailure } from "./log-failure";
import { nonUsSecListingVenue } from "./sec";

/**
 * An HKEX company's statements set against its HKEXnews announcements, which
 * `fundamentals`, FA and the reverse DCF cite as US statements cite their
 * 10-Q: when the latest period's figures were first published, and what came
 * out after them.
 */

/** A results announcement or business update on HKEXnews, as a statement report cites it. */
interface ResultsAnnouncement {
  kind: "annual results" | "interim results" | "quarterly results" | "business update";
  headline: string;
  /** The day it was released in Hong Kong, YYYY-MM-DD. */
  announced: string;
  url: string;
}

/**
 * The announcement that released the latest period's results, which is when
 * its figures were first published, and what was released after it, whose
 * figures the statements do not have: the newest results announcement, and
 * a business update newer than that.
 */
export interface ExchangeResults {
  publisher: "HKEXnews";
  latest: (ResultsAnnouncement & { date: string }) | null;
  newer: ResultsAnnouncement[];
}

const RESULTS_TYPES: Readonly<Record<string, ResultsAnnouncement["kind"]>> = {
  "Final Results": "annual results",
  "Interim Results": "interim results",
  "Quarterly Results": "quarterly results",
};
const BUSINESS_UPDATE_TYPE = "Other - Business Update";
// The listing rules give three months for annual results and two for interim; a late one still counts.
const RESULTS_WINDOW_DAYS = 120;
const HONG_KONG_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Hong_Kong", year: "numeric", month: "2-digit", day: "2-digit" });
/** Results announcements a report reads: a company buying back shares files a return a day, so a year's results need the latest 100. */
export const RESULTS_ANNOUNCEMENT_LIMIT = 100;
/** How long a report waits for the announcements before it goes without their lines. */
export const EXCHANGE_RESULTS_BUDGET_MS = 4_000;

function resultsKind(types: readonly string[]): ResultsAnnouncement["kind"] | null {
  // An annual results announcement that also updates the business is the results.
  for (const type of types) if (RESULTS_TYPES[type]) return RESULTS_TYPES[type]!;
  return types.includes(BUSINESS_UPDATE_TYPE) ? "business update" : null;
}

/**
 * The results announcements behind an HKEX company's latest statement period
 * (`latestPeriod`, YYYY-MM-DD): the first results announcement within 120
 * days after the period ends; and released after that one, the newest
 * results announcement and a business update newer than it. Null without a
 * latest period.
 */
export function matchExchangeResults(
  latestPeriod: string | null | undefined,
  announcements: ExchangeAnnouncementsPayload["announcements"],
): ExchangeResults | null {
  if (!latestPeriod || !/^\d{4}-\d{2}-\d{2}$/.test(latestPeriod)) return null;
  const cited = announcements.flatMap((item): ResultsAnnouncement[] => {
    const kind = resultsKind(item.types);
    const time = Date.parse(item.date);
    return kind && Number.isFinite(time)
      ? [{ kind, headline: item.headline, announced: HONG_KONG_DAY.format(time), url: item.url }]
      : [];
  }).sort((left, right) => left.announced.localeCompare(right.announced));
  const windowEnd = new Date(Date.parse(`${latestPeriod}T00:00:00Z`) + RESULTS_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
  const own = cited.find((item) => item.kind !== "business update" && item.announced > latestPeriod && item.announced <= windowEnd);
  const later = cited.filter((item) => item !== own && item.announced > (own?.announced ?? latestPeriod));
  const results = later.filter((item) => item.kind !== "business update").at(-1);
  const update = later.filter((item) => item.kind === "business update" && item.announced > (results?.announced ?? "")).at(-1);
  return {
    publisher: "HKEXnews",
    latest: own ? { date: latestPeriod, ...own } : null,
    newer: [results, update].filter((item): item is ResultsAnnouncement => !!item),
  };
}

const RESULTS_PERIOD: Readonly<Record<ResultsAnnouncement["kind"], string>> = {
  "annual results": "annual period",
  "interim results": "half year",
  "quarterly results": "quarter",
  "business update": "period",
};

/**
 * "Latest half year 2026-06-30, interim results announced 2026-08-20
 * (HKEXnews)." and what came out after it, as US statements name their 10-Q
 * and a newer 8-K.
 */
export function exchangeResultsNotes(results: ExchangeResults): string[] {
  const { latest, newer, publisher } = results;
  const kind = (text: string) => `${text[0]!.toUpperCase()}${text.slice(1)}`;
  return [
    ...latest ? [`Latest ${RESULTS_PERIOD[latest.kind]} ${latest.date}, ${latest.kind} announced ${latest.announced} (${publisher}).`] : [],
    ...newer.map((item) => item.kind === "business update"
      ? `Business update announced ${item.announced} (${publisher}), after the latest statements: "${item.headline}".`
      : `${kind(item.kind)} announced ${item.announced} (${publisher}); their statements are not in yet.`),
  ];
}

/**
 * "interim results announced 2026-08-20 (HKEXnews)": the announcement a
 * period's figures were published in, where it is the latest period's; null
 * for any other period.
 */
export function exchangeResultsSource(results: ExchangeResults | null | undefined, period: string | null | undefined): string | null {
  const latest = results?.latest;
  return latest && period && latest.date === period.slice(0, 10) ? `${latest.kind} announced ${latest.announced} (${results.publisher})` : null;
}

/** Reads a listing's HKEXnews announcements, newest first: Gloom Cloud in the app, a fake in tests. */
export type ExchangeAnnouncementsReader = (listing: { symbol: string; exchange: string }) => Promise<ExchangeAnnouncementsPayload>;

/**
 * An HKEX listing's results announcements for its latest statement period,
 * read within 4 s; null for any other listing, without a period, or when the
 * read fails or runs past that, so a report never waits on HKEXnews.
 */
export function loadExchangeResults(
  read: ExchangeAnnouncementsReader | undefined,
  listing: { symbol: string; exchange?: string | null },
  latestPeriod: string | null | undefined,
): Promise<ExchangeResults | null> {
  const venue = nonUsSecListingVenue(listing.symbol, listing.exchange ?? undefined);
  if (!read || !latestPeriod || venue !== "HKEX") return Promise.resolve(null);
  const code = parsePublicTickerKey(listing.symbol).symbol.replace(/\.HK$/i, "");
  return settleWithin(read({ symbol: code, exchange: venue })
    .then((payload) => matchExchangeResults(latestPeriod, payload.announcements))
    .catch(logFailure("exchange-results", "Reading the HKEXnews announcements failed", null)), EXCHANGE_RESULTS_BUDGET_MS);
}
