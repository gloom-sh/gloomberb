import { createPluginCache } from "../../../data/plugin-cache";
import type { DataTableColumn } from "../../../components";
import { colors } from "../../../theme/colors";
import { displayWidth, MISSING_VALUE } from "../../../utils/format";
import { fetchEconCalendar } from "./calendar-source";
import { figureWithCurrency, parseEconFigure } from "./figures";
import { resolveFredMapping } from "./fred-series-map";
import { STATS } from "../econ-statistics/stats";
import { hasNoReleaseTime, isAllDayEvent, type EconEvent, type EconImpact } from "./types";

const CACHE_KIND = "calendar";
const CACHE_KEY = "global";
const CACHE_SOURCE = "gloomberb-cloud";
const CACHE_SCHEMA_VERSION = 1;
const CACHE_POLICY = {
  staleMs: 15 * 60 * 1000,
  expireMs: 2 * 24 * 60 * 60 * 1000,
} as const;

export type ImpactFilter = "high" | "medium" | "low" | "all";
/**
 * A region the pane cycles through, or countries by their ISO codes, comma
 * separated (`econ --country MX,BR,ZA`); a list matches any of its parts.
 */
export type CountryFilter = "all" | "US" | "G7" | "EU" | (string & {});

export const FILTER_CYCLE: ImpactFilter[] = ["all", "high", "medium", "low"];
/**
 * Where a calendar nobody has filtered opens. Most rows are low-impact
 * releases few people follow; the high-impact ones still fill a few a day.
 * A filter the user picked is saved with the pane and wins.
 */
export const DEFAULT_IMPACT_FILTER: ImpactFilter = "high";
export const COUNTRY_CYCLE: CountryFilter[] = ["all", "US", "G7", "EU"];

/** The seven members plus the EU, which attends every summit. */
const G7_COUNTRIES = new Set(["US", "GB", "FR", "DE", "IT", "JP", "CA", "EU"]);

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

export type DisplayRow =
  | { kind: "separator"; key: string; label: string }
  | { kind: "now"; key: string }
  | { kind: "event"; key: string; event: EconEvent; eventIdx: number };

type EconCalendarColumnId =
  | "time"
  | "readerTime"
  | "impact"
  | "country"
  | "event"
  | "actual"
  | "forecast"
  | "prior";
export type EconCalendarColumn = DataTableColumn & { id: EconCalendarColumnId };

type PersistedEconEvent = Omit<EconEvent, "date"> & { date: string };
export type EconCalendarCacheEntry = { data: EconEvent[]; fetchedAt: number; stale: boolean };

const cache = createPluginCache<EconEvent[], PersistedEconEvent[]>({
  kind: CACHE_KIND, source: CACHE_SOURCE, schemaVersion: CACHE_SCHEMA_VERSION, policy: CACHE_POLICY,
  encode: serializeEvents, decode: deserializeEvents,
});
export const attachEconCalendarPersistence = cache.attach;
export const resetEconCalendarPersistence = cache.reset;

/** Words rather than dots: a three-wide column has no room for a legend. */
export function impactIndicator(impact: EconImpact): { text: string; color: string } {
  switch (impact) {
    case "high":
      return { text: "HIGH", color: colors.negative };
    case "medium":
      return { text: "MED", color: colors.warning };
    case "low":
      return { text: "LOW", color: colors.textDim };
  }
}

/** The UTC day of an instant, so a release sits under the same day on every machine. */
export function dateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * The release's UTC clock time. Rows group by UTC day and the column header
 * names the zone, as `gloom econ` prints it; local time would move a 23:00
 * UTC release under another day and read differently on every machine.
 */
export function timeLabel(d: Date): string {
  return d.toISOString().slice(11, 16);
}

/** The zone the calendar's times and days are in, for the column header. */
export const CALENDAR_TIME_ZONE_LABEL = "UTC";

/** "Fri Oct 9", the UTC day the calendar groups an instant under. */
export function shortDayLabel(d: Date): string {
  return `${DAY_NAMES[d.getUTCDay()]!} ${MONTH_NAMES[d.getUTCMonth()]!} ${d.getUTCDate()}`;
}

export function dayLabel(d: Date, today: Date): string {
  const dk = dateKey(d);
  const todayKey = dateKey(today);
  const dayMs = 24 * 60 * 60 * 1000;
  const yesterday = dateKey(new Date(today.getTime() - dayMs));
  const tomorrow = dateKey(new Date(today.getTime() + dayMs));

  const suffix = shortDayLabel(d);

  if (dk === todayKey) return `TODAY · ${suffix}`;
  if (dk === tomorrow) return `TOMORROW · ${suffix}`;
  if (dk === yesterday) return `YESTERDAY · ${suffix}`;
  return suffix;
}

/**
 * The calendar runs two weeks ahead. One that lists nothing a week past the
 * start of the window (today, or a later first day asked for) stops short,
 * as a feed that ends with its own week does, and says where it stops rather
 * than reading as a quiet week.
 */
const MIN_DAYS_LISTED_AHEAD = 7;

/**
 * The last UTC day the calendar lists releases for, YYYY-MM-DD, as Gloom Cloud
 * says it: on the calendar from a day (`served`), or on each central bank's
 * next decision it lists past the end (`listedThrough`). From a server that
 * says neither, which lists nothing past the end, the day of the last event.
 * Null when it lists nothing.
 */
export function listingEnd(
  events: readonly Pick<EconEvent, "date" | "listedThrough">[],
  served?: string | null,
): string | null {
  const said = served ?? events.find((event) => event.listedThrough)?.listedThrough;
  if (said && /^\d{4}-\d{2}-\d{2}$/.test(said)) return said;
  let last: Date | null = null;
  for (const event of events) {
    if (!last || event.date.getTime() > last.getTime()) last = event.date;
  }
  return last ? dateKey(last) : null;
}

/**
 * When the listing (`listingEnd`) stops short of a week past `windowStart`,
 * its last day; null when it reaches that far or lists nothing.
 */
export function shortCalendarEnd(
  events: readonly Pick<EconEvent, "date" | "listedThrough">[],
  windowStart: number,
  served?: string | null,
): string | null {
  const end = listingEnd(events, served);
  return end && Date.parse(`${end}T00:00:00Z`) + 86_400_000 <= windowStart + MIN_DAYS_LISTED_AHEAD * 86_400_000 ? end : null;
}

/**
 * Whether a row is one Gloom Cloud lists past the end of the listing: a
 * central bank's next decision, or a country's next CPI release as its
 * statistics office schedules it.
 */
export function pastReleaseListing(event: Pick<EconEvent, "pastListing">): boolean {
  return event.pastListing === true;
}

/**
 * What the rows past the listing's end are, among `events`, for the note that
 * says where it ends: each bank's next decision, each country's next CPI
 * release, or both; null when none is past it. `short` for a footer.
 */
export function pastListingRows(events: readonly Pick<EconEvent, "pastListing" | "kind">[], short = false): string | null {
  const past = events.filter(pastReleaseListing);
  const decisions = past.some((event) => event.kind !== "statistics-release");
  const releases = past.some((event) => event.kind === "statistics-release");
  const decision = short ? "each bank's next decision" : "each central bank's next decision";
  const release = short ? "each country's next CPI" : "each country's next CPI release, as its statistics office schedules it";
  return decisions && releases ? `${decision} and ${release}` : decisions ? decision : releases ? release : null;
}

/**
 * Events (already in time order; `eventIdx` indexes them) under a header per
 * UTC day, with NOW before the first event still to come. When that event is
 * on a later day, NOW sits above that day's header, since the present is still
 * on the earlier day.
 */
export function calendarDisplayRows(sorted: readonly EconEvent[], now: number): DisplayRow[] {
  const today = new Date(now);
  const todayKey = dateKey(today);
  const hasPast = sorted.some((event) => event.date.getTime() <= now);
  let nowPending = hasPast && sorted.some((event) => event.date.getTime() > now);
  const rows: DisplayRow[] = [];
  let lastDateKey = "";
  sorted.forEach((event, eventIdx) => {
    const key = dateKey(event.date);
    const upcoming = nowPending && event.date.getTime() > now;
    if (upcoming && key !== todayKey) {
      rows.push({ kind: "now", key: "now" });
      nowPending = false;
    }
    if (key !== lastDateKey) {
      lastDateKey = key;
      rows.push({ kind: "separator", key: `separator-${key}`, label: dayLabel(event.date, today) });
    }
    if (upcoming && nowPending) {
      rows.push({ kind: "now", key: "now" });
      nowPending = false;
    }
    rows.push({ kind: "event", key: `event-${event.id}-${eventIdx}`, event, eventIdx });
  });
  return rows;
}

/**
 * Each level selects exactly its own events. "At least this impact" made the
 * lowest level identical to "all", which read as a broken filter.
 */
export function matchesImpact(event: EconEvent, filter: ImpactFilter): boolean {
  return filter === "all" || event.impact === filter;
}

/**
 * The releases of the region that the High filter, where the calendar opens,
 * leaves out (most PMIs among them), for the footer and a report of the pane
 * to count with the way to list them. None under All, and none under Medium
 * or Low, which a reader picks to list one level.
 */
export function lowerImpactHidden(events: readonly EconEvent[], impact: ImpactFilter, country: CountryFilter): number {
  if (impact !== "high") return 0;
  return events.filter((event) => event.impact !== "high" && matchesCountry(event, country)).length;
}

const IMPACT_WORDS: Record<Exclude<ImpactFilter, "all">, string> = {
  high: "high-impact",
  medium: "medium-impact",
  low: "low-impact",
};

/**
 * What an empty list says when the filters, not the calendar, emptied it:
 * "No high-impact US events listed". Null with no filter set.
 */
export function filteredEmptyTitle(impact: ImpactFilter, country: CountryFilter): string | null {
  if (impact === "all" && country === "all") return null;
  const words = [impact === "all" ? null : IMPACT_WORDS[impact], country === "all" ? null : country.split(",").join(", ")];
  return `No ${words.filter(Boolean).join(" ")} events listed`;
}

function matchesOneCountry(country: string, filter: string): boolean {
  if (filter === "all") return true;
  if (filter === "G7") return G7_COUNTRIES.has(country);
  return country === filter;
}

/**
 * The euro area's members by the word a national release's title starts
 * with ("German Ifo Business Climate"). Both feeds list such a release under
 * EU: the week feed by its currency, with the member's adjective in front of
 * the title, and Gloom Cloud writes the release calendar's members the same
 * way. Each word names exactly one member.
 */
const EURO_AREA_MEMBERS: Readonly<Record<string, string>> = {
  Austrian: "AT", Belgian: "BE", Croatian: "HR", Cypriot: "CY", Dutch: "NL", Estonian: "EE", Finnish: "FI",
  French: "FR", German: "DE", Greek: "GR", Irish: "IE", Italian: "IT", Latvian: "LV", Lithuanian: "LT",
  Luxembourgish: "LU", Maltese: "MT", Portuguese: "PT", Slovak: "SK", Slovenian: "SI", Spanish: "ES",
};

/**
 * The member state an EU row is a national release of ("German Ifo Business
 * Climate" is DE), by the adjective its title starts with; null for a
 * release of the whole euro area (ECB, euro area CPI) and for any other row.
 */
function euroAreaMember(event: Pick<EconEvent, "country" | "event">): string | null {
  if (event.country !== "EU") return null;
  const word = /^([A-Z][a-z]+) /.exec(event.event)?.[1];
  return word ? EURO_AREA_MEMBERS[word] ?? null : null;
}

/** The country a row is for, as the calendar shows it: a national euro-area release's member, otherwise its own. */
export function eventCountry(event: Pick<EconEvent, "country" | "event">): string {
  return euroAreaMember(event) ?? event.country;
}

/** What the feeds call the Fed's rate decision. */
const FED_RATE_DECISION_NAMES = new Set(["federal funds rate", "fed interest rate decision"]);
/** A figure that is a range (3.75-4.00%) rather than one level. */
const RANGE_FIGURE = /\d\s*[-\u2013]\s*\d/;
const FED_FUNDS_UPPER_BOUND = "Federal Funds Rate (upper bound)";

/**
 * A row's name as the calendar shows it. The Fed's decision is figured as one
 * level, the top of the target range (4.00% for 3.75-4.00%), so it is named
 * for that bound rather than read as the range or the effective rate; a row
 * whose figures are the range keeps the feed's name. Whatever matches rows by
 * name (alerts, the FRED history) reads the feed's own, `event.event`.
 */
export function econEventName(event: Pick<EconEvent, "country" | "event" | "actual" | "forecast" | "prior">): string {
  if ((event.country !== "US" && event.country !== "USD") || !FED_RATE_DECISION_NAMES.has(event.event.trim().toLowerCase())) return event.event;
  return [event.actual, event.forecast, event.prior].some((figure) => !!figure && RANGE_FIGURE.test(figure)) ? event.event : FED_FUNDS_UPPER_BOUND;
}

/** Letters and digits only, lower case: "Non-Farm" and "nonfarm" read alike. */
const compactName = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "");

/** Words an initialism leaves out: the U.S. Department of Agriculture is USDA. */
const INITIALISM_SKIPS = new Set(["of", "the", "and", "for", "on", "in"]);

/**
 * The ways a row's publisher is written, compacted: its name, its initials
 * ("usda" for the U.S. Department of Agriculture, "bls" for the Bureau of
 * Labor Statistics) and the name of its site (usda.gov).
 */
function publisherNames(source: EconEvent["source"]): string[] {
  if (!source?.name?.trim()) return [];
  const initials = source.name.split(/[\s.,&/()-]+/).filter((word) => word && !INITIALISM_SKIPS.has(word.toLowerCase()))
    .map((word) => word[0]!).join("");
  let site = "";
  try {
    site = source.url ? new URL(source.url).hostname.replace(/^www\./i, "").split(".")[0] ?? "" : "";
  } catch {
    // Intentional ignore: a publisher's address that does not parse leaves its name and initials.
  }
  return [source.name, initials, site].map(compactName).filter(Boolean);
}

/** ECST's names for each FRED series it charts, compacted: PAYEMS is Nonfarm Payrolls, nfp and the jobs report. */
let statNames: ReadonlyMap<string, readonly string[]> | null = null;

function statNamesOf(seriesId: string): readonly string[] {
  statNames ??= STATS.reduce((names, stat) => names.set(stat.seriesId,
    [...names.get(stat.seriesId) ?? [], ...[stat.label, ...stat.aliases ?? [], ...stat.keywords ?? []].map(compactName).filter(Boolean)]),
  new Map<string, string[]>());
  return statNames.get(seriesId) ?? [];
}

/** The FRED series ECST names by each of its labels and aliases, compacted: `nonfarmpayrolls` is PAYEMS. */
let statSeries: ReadonlyMap<string, string> | null = null;

/**
 * The FRED series a calendar row is a release of, when one is known: its
 * name as the series map reads it (Non-Farm Employment Change is PAYEMS),
 * else a US row named as ECST names a series (Non Farm Payrolls, one feed's
 * name for the same release). One release listed under two names is one
 * series. Null for any other row.
 */
export function eventSeriesId(event: Pick<EconEvent, "country" | "event">): string | null {
  const mapped = resolveFredMapping(event.event, event.country)?.seriesId;
  if (mapped) return mapped;
  if (eventCountry(event) !== "US") return null;
  statSeries ??= new Map(STATS.flatMap((stat) => [stat.label, ...stat.aliases ?? []].map((name) => [compactName(name), stat.seriesId] as const)));
  return statSeries.get(compactName(event.event)) ?? null;
}

/**
 * The names a row is searched by, compacted: the feed's own and the one the
 * calendar shows, then what ECST calls the series the release is of
 * (Non-Farm Employment Change is also nonfarm payrolls, nfp and the jobs report).
 */
export function eventSearchNames(event: Pick<EconEvent, "country" | "event" | "actual" | "forecast" | "prior">): string[] {
  const series = resolveFredMapping(event.event, event.country)?.seriesId;
  const policy = POLICY_DECISION.test(event.event) ? policyRateNames(event.country) : [];
  return [...[event.event, econEventName(event)].map(compactName), ...series ? statNamesOf(series) : [], ...policy];
}

/** A central bank's decision or fixing, under the titles the calendar gives them. */
const POLICY_DECISION = /interest rate decision|rate decision|loan prime rate|policy rate|cash rate|bank rate|funds rate|deposit facility rate|selic|repo rate|key rate/i;

/**
 * The names people give a bank's policy rate and its committee, so `--search
 * selic` finds the Copom's decision and `--search banxico` Banxico's: by the
 * calendar's country, with the names every bank's decision answers to.
 */
const POLICY_RATE_NAMES: Readonly<Record<string, readonly string[]>> = {
  US: ["fed funds", "federal funds", "FOMC", "Federal Reserve"],
  EU: ["ECB", "deposit rate", "deposit facility", "refi rate"],
  GB: ["Bank Rate", "BoE", "MPC"],
  JP: ["BoJ", "Bank of Japan"],
  CA: ["BoC", "overnight rate"],
  AU: ["RBA", "cash rate"],
  NZ: ["RBNZ", "OCR", "official cash rate"],
  CH: ["SNB"],
  CN: ["LPR", "loan prime rate", "PBoC"],
  IN: ["RBI", "repo rate"],
  ID: ["BI rate", "Bank Indonesia"],
  KR: ["BoK", "base rate"],
  BR: ["Selic", "Copom", "Banco Central do Brasil", "BCB"],
  MX: ["Banxico", "Banco de Mexico", "tasa objetivo", "target rate"],
  RU: ["key rate", "Bank of Russia", "CBR"],
  TR: ["CBRT", "TCMB", "one-week repo"],
  ZA: ["SARB", "repo rate"],
  NO: ["Norges Bank", "sight deposit rate"],
  SE: ["Riksbank"],
};
const ANY_POLICY_RATE = ["policy rate", "rate decision", "interest rate", "central bank", "monetary policy"];

function policyRateNames(country: string): string[] {
  return [...POLICY_RATE_NAMES[country.toUpperCase()] ?? [], ...ANY_POLICY_RATE].map(compactName);
}

const nameWords = (text: string) => text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
/** Words of many banks' names that name none alone: "bank" is the BoE's, the BoJ's and three more. */
const SHARED_NAME_WORDS = new Set(["bank", "of", "de", "do", "rate", "central"]);

/**
 * The decisions a search for a bank's own names means, for an empty answer to
 * say: `selic` is Brazil's Copom decision. Every word of the query must be a
 * whole word of one of the bank's names, or the name run together (`fedfunds`):
 * `cbr` is the Bank of Russia's and not the CBRT's, and words many names share
 * name none alone (`bank`, SHARED_NAME_WORDS). Only the
 * banks of the countries the calendar lists (`countries`, as --country reads).
 * Empty for a query no bank's names hold, and for the names every bank's
 * decision answers to (a query of those already lists them).
 */
export function policyDecisionsNamed(query: string, countries: CountryFilter = "all"): Array<{ country: string; event: string }> {
  const words = nameWords(query);
  if (words.every((word) => SHARED_NAME_WORDS.has(word))) return [];
  return Object.entries(POLICY_RATE_NAMES).flatMap(([country, names]) => {
    const event = POLICY_DECISION_TITLES[country] ?? "Interest Rate Decision";
    if (!matchesCountry({ country, event }, countries)) return [];
    const named = names.some((name) => {
      const parts = nameWords(name);
      return words.every((word) => parts.includes(word) || word === compactName(name));
    });
    return named ? [{ country, event }] : [];
  });
}

/** How the calendar titles each bank's decision (China's is its LPR fixing). */
const POLICY_DECISION_TITLES: Readonly<Record<string, string>> = {
  US: "Fed Interest Rate Decision", EU: "ECB Interest Rate Decision", GB: "BoE Interest Rate Decision", JP: "BoJ Interest Rate Decision",
  CA: "BoC Interest Rate Decision", AU: "RBA Interest Rate Decision", NZ: "RBNZ Interest Rate Decision", CH: "SNB Interest Rate Decision",
  CN: "1-y Loan Prime Rate", IN: "RBI Interest Rate Decision", ID: "BI Interest Rate Decision", KR: "BoK Interest Rate Decision",
  BR: "Copom Interest Rate Decision", MX: "Banxico Interest Rate Decision", RU: "Bank of Russia Interest Rate Decision",
  TR: "CBRT Interest Rate Decision", ZA: "SARB Interest Rate Decision", NO: "Norges Bank Interest Rate Decision", SE: "Riksbank Interest Rate Decision",
};

/**
 * Whether a row carries every word of `query` in one of its names or its
 * publisher's, case, spaces and hyphens aside: `nonfarm` finds Non Farm
 * Payrolls and Non-Farm Employment Change, `nfp` and `jobs report` the
 * latter by ECST's names for it, `fed funds` the Federal Funds Rate, and
 * `usda` every row the U.S. Department of Agriculture publishes.
 */
export function matchesEventSearch(event: Pick<EconEvent, "country" | "event" | "actual" | "forecast" | "prior" | "source">, query: string): boolean {
  const words = query.split(/\s+/).map(compactName).filter(Boolean);
  if (words.length === 0) return true;
  const names = eventSearchNames(event);
  const publisher = publisherNames(event.source);
  return names.some((name) => words.every((word) => name.includes(word) || publisher.some((text) => text.includes(word))));
}

/**
 * A release still to come that has a prior and no forecast: the consensus is
 * not in yet, which the calendar draws as a dash.
 */
export function awaitsConsensus(event: Pick<EconEvent, "actual" | "forecast" | "prior">): boolean {
  return !event.actual?.trim() && !event.forecast?.trim() && !!event.prior?.trim();
}

/** How long past its time a release with no figure reads as awaiting one: a day, after which the calendar shows the gap as it is. */
const AWAITING_FIGURE_MS = 24 * 60 * 60_000;

/** Release times fall on the five-minute grid; a feed lists a release whose time is not yet set off it (China's New Loans at 09:03 UTC). */
const RELEASE_GRID_MS = 5 * 60_000;

/**
 * Whether a release is past its time with no actual while a figure is due
 * (it has a forecast or a prior): out at its publisher, not in yet here. A
 * speech or a meeting has no figure to wait for, a bank that states no time
 * has no time to be past, and a tentative time (off the five-minute grid) is
 * no time the figure was due at.
 */
export function awaitsFigure(
  event: Pick<EconEvent, "actual" | "forecast" | "prior" | "date" | "time" | "timeNote">,
  now: number,
): boolean {
  if (event.actual?.trim() || (!event.forecast?.trim() && !event.prior?.trim()) || hasNoReleaseTime(event)) return false;
  if (event.date.getTime() % RELEASE_GRID_MS !== 0) return false;
  const late = now - event.date.getTime();
  return late >= 0 && late < AWAITING_FIGURE_MS;
}

/** How long a figure is awaited past its release time before the row says the source has none. */
const FIGURE_WAIT_MS = 2 * 60 * 60_000;
/**
 * How long past its release time a row waits for its own figure even once
 * another row of the release has one: a source fills a release's rows a
 * few minutes apart.
 */
const SIBLING_FIGURE_WAIT_MS = 15 * 60_000;

/**
 * A release's figure that is not in, of a row awaitsFigure holds: `awaiting`
 * while it may still come, `none` once the source has none to give, which is
 * two hours after its time, or from 15 minutes after it when another row of
 * the same release (same time and publisher) has its figure. The MBA's 5/1
 * ARM and 15-year rates waited all day beside the 30-year rate the same
 * release had filled. Null when no figure is awaited.
 */
export function figureGap(
  event: Pick<EconEvent, "actual" | "forecast" | "prior" | "date" | "time" | "timeNote" | "country" | "source">,
  now: number,
  calendar: readonly Pick<EconEvent, "actual" | "date" | "country" | "source">[] = [],
): "awaiting" | "none" | null {
  if (!awaitsFigure(event, now)) return null;
  const since = now - event.date.getTime();
  if (since >= FIGURE_WAIT_MS) return "none";
  if (since < SIBLING_FIGURE_WAIT_MS) return "awaiting";
  const publisher = event.source?.name?.trim();
  const releaseIn = !!publisher && calendar.some((row) => row !== event && !!row.actual?.trim()
    && row.date.getTime() === event.date.getTime() && row.country === event.country && row.source?.name?.trim() === publisher);
  return releaseIn ? "none" : "awaiting";
}

/** What a release awaiting its figure says in place of it: "due 07:00 UTC, awaiting figure". */
export function awaitingFigureText(event: Pick<EconEvent, "date">): string {
  return `due ${timeLabel(event.date)} ${CALENDAR_TIME_ZONE_LABEL}, awaiting figure`;
}

/** What a release whose source has no figure says in place of it. */
export const NO_FIGURE_TEXT = "no figure from the source";

/** What a row with a figure gap (figureGap) says in place of the figure. */
export function figureGapText(event: Pick<EconEvent, "date">, gap: "awaiting" | "none"): string {
  return gap === "none" ? NO_FIGURE_TEXT : awaitingFigureText(event);
}

/** The ACTUAL cell of a release awaiting its figure, where the whole text has no room; the row's time is beside it. */
export const AWAITING_FIGURE_CELL = "awaiting";

/** The ACTUAL cell of a release whose source has no figure; the footer says it whole. */
export const NO_FIGURE_CELL = "no figure";

/** What a dash under Forecast means on a row still to come. */
export const NO_CONSENSUS_NOTE = `${MISSING_VALUE} forecast = no consensus yet`;

/** What the dash under Time means on a bank's decision whose calendar gives the day and not the time, from its note. */
export function noTimeNote(timeNote: string): string {
  return `${MISSING_VALUE} time = ${timeNote.charAt(0).toLowerCase()}${timeNote.slice(1).replace(/\.$/, "")}`;
}

/** A national euro-area release matches EU (and G7, as EU) and its own member's code. */
export function matchesCountry(event: Pick<EconEvent, "country" | "event">, filter: CountryFilter): boolean {
  const member = euroAreaMember(event);
  return filter.split(",").some((part) => matchesOneCountry(event.country, part) || (member !== null && member === part));
}

/** What people type for a country whose ISO code is another. */
const COUNTRY_ALIASES: Readonly<Record<string, string>> = { UK: "GB" };

let regionNames: Intl.DisplayNames | null | undefined;

/** An ISO 3166 country (or the EU) the runtime can name; any two letters when it names none. */
function isCountryCode(code: string): boolean {
  if (regionNames === undefined) {
    try {
      regionNames = new Intl.DisplayNames(["en"], { type: "region", fallback: "none" });
    } catch {
      // Intentional ignore: a runtime without region names accepts any two-letter code instead.
      regionNames = null;
    }
  }
  if (!regionNames) return /^[A-Z]{2}$/.test(code);
  try {
    // ZZ is CLDR's "Unknown Region".
    return code !== "ZZ" && regionNames.of(code) !== undefined;
  } catch {
    // Intentional ignore: a code the runtime's region names reject is no country code.
    return false;
  }
}

export const COUNTRY_FILTER_HINT = `Use ${COUNTRY_CYCLE.join(", ")}, or two-letter country codes such as MX, or several as MX,BR,ZA.`;

/**
 * A country filter as typed: the pane's regions and ISO country codes, any
 * case, comma separated (`mx, br`, `G7,MX`, `UK` for GB). The filter as the
 * pane stores it (`MX,BR`), or why it is not one.
 */
export function parseCountryFilter(text: string): { filter: CountryFilter } | { error: string } {
  const parts: string[] = [];
  for (const token of text.split(/[\s,]+/).filter(Boolean)) {
    const region = COUNTRY_CYCLE.find((candidate) => candidate.toLowerCase() === token.toLowerCase());
    const upper = token.toUpperCase();
    const code = region ?? COUNTRY_ALIASES[upper] ?? (/^[A-Z]{2}$/.test(upper) && isCountryCode(upper) ? upper : null);
    if (!code) return { error: `Unknown country "${token}".` };
    if (!parts.includes(code)) parts.push(code);
  }
  if (parts.length === 0) return { error: "No country given." };
  return { filter: parts.includes("all") ? "all" : parts.join(",") };
}

/** The countries a filter names one by one (MX and BR in `G7,MX,BR`), leaving out the regions. */
function filterCountries(filter: CountryFilter): string[] {
  return filter.split(",").filter((part) => !(COUNTRY_CYCLE as readonly string[]).includes(part));
}

/**
 * Countries the filter names that no event in `events` is for, so a list
 * says which of them has nothing scheduled instead of reading as a quiet week
 * (or as a country the terminal does not know).
 */
export function countriesWithoutEvents(filter: CountryFilter, events: ReadonlyArray<Pick<EconEvent, "country" | "event">>): string[] {
  const listed = new Set(events.flatMap((event) => [event.country, euroAreaMember(event) ?? event.country]));
  return filterCountries(filter).filter((country) => !listed.has(country));
}

/**
 * "No scheduled releases for MX in this window", or for MX or ZA; with the
 * day the listing ends, where it does ("; releases are listed through 2026-11-20").
 */
export function noScheduledReleasesMessage(countries: readonly string[], listedThrough?: string | null): string {
  const named = countries.length > 1 ? `${countries.slice(0, -1).join(", ")} or ${countries.at(-1)}` : countries.join("");
  return `No scheduled releases for ${named} in this window${listedThrough ? `; releases are listed through ${listedThrough}` : ""}.`;
}

/**
 * How long after its release time a high-impact print is still news: the
 * calendar is asked for it this long, and a print that turns up later is
 * recorded without a toast.
 */
export const PRINT_PENDING_MS = 20 * 60 * 1000;

/**
 * High-impact releases whose time has come in the last {@link PRINT_PENDING_MS}
 * and that have no actual yet. Rows Gloom Cloud adds from a bank's or a
 * statistics office's calendar (`kind`) never get an actual, and a bank's
 * untimed decision would fall due at midnight UTC, so they are never waited
 * on; nor is an all-day event (an election), which prints nothing.
 */
export function pendingHighImpactPrints(events: readonly EconEvent[], now: number): EconEvent[] {
  return events.filter((event) => {
    if (event.impact !== "high" || event.actual || event.kind || isAllDayEvent(event)) return false;
    const releasedFor = now - event.date.getTime();
    return releasedFor >= 0 && releasedFor <= PRINT_PENDING_MS;
  });
}

export function hasPendingHighImpactPrint(events: readonly EconEvent[], now: number): boolean {
  return pendingHighImpactPrints(events, now).length > 0;
}

/** High-impact rows that were blank in `previous` and have an actual in `next`. */
export function landedHighImpactPrints(
  previous: ReadonlyMap<string, string | null>,
  next: readonly EconEvent[],
): EconEvent[] {
  return next.filter((event) => {
    if (event.impact !== "high" || !event.actual || !previous.has(event.id)) return false;
    return !previous.get(event.id);
  });
}

export function formatStaleness(fetchedAt: number, now: number): string {
  const elapsed = now - fetchedAt;
  if (elapsed < 60_000) return "updated just now";
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return `updated ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `updated ${hours}h ago`;
}

function serializeEvents(events: EconEvent[]): PersistedEconEvent[] {
  return events.map((event) => ({
    ...event,
    date: event.date.toISOString(),
  }));
}

function deserializeEvents(events: PersistedEconEvent[]): EconEvent[] {
  return events
    .map((event) => ({
      ...event,
      date: new Date(event.date),
    }))
    .filter((event) => !Number.isNaN(event.date.getTime()));
}

export function getCalendarCache(options?: { allowExpired?: boolean }): EconCalendarCacheEntry | null {
  return cache.get(CACHE_KEY, options);
}

export function subscribeCalendar(listener: () => void): () => void {
  return cache.subscribe(CACHE_KEY, listener);
}

export interface EconCalendarLoadResult extends EconCalendarCacheEntry {
  /** `stale-fallback`: the copy an earlier read saved, answering because its refresh failed. */
  source?: "cache" | "network" | "stale-fallback";
  refreshError?: string;
}

export function loadCalendar(
  force = false,
  loader: () => Promise<EconEvent[]> = fetchEconCalendar,
): Promise<EconCalendarLoadResult> {
  return cache.load(CACHE_KEY, loader, { force });
}

/** The widest a value column grows: "-3.061M bbl" and "0.034M b/d" whole. */
const MAX_VALUE_WIDTH = 12;

/**
 * A value column as wide as the widest figure shown, from its usual width up
 * to MAX_VALUE_WIDTH, so an energy row keeps its unit (77 Bcf, -3.061M bbl).
 */
export function valueColumnWidth(events: readonly EconEvent[], key: "actual" | "forecast" | "prior", base: number): number {
  let width = base;
  for (const event of events) width = Math.max(width, Math.min(MAX_VALUE_WIDTH, displayWidth(figureWithCurrency(event[key], event.currency) ?? "")));
  return width;
}

export function actualColor(actual: string | null, forecast: string | null): string {
  const a = parseEconFigure(actual)?.value ?? null;
  const f = parseEconFigure(forecast)?.value ?? null;
  if (a === null || f === null) return colors.text;
  if (a > f) return colors.positive;
  if (a < f) return colors.negative;
  return colors.text;
}
