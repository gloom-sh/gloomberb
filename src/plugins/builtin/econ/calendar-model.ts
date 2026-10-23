import { createPluginCache } from "../../../data/plugin-cache";
import type { DataTableColumn } from "../../../components";
import { colors } from "../../../theme/colors";
import { displayWidth } from "../../../utils/format";
import { fetchEconCalendar } from "./calendar-source";
import type { EconEvent, EconImpact } from "./types";

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
 * names the zone, as `gloomberb econ` prints it; local time would move a 23:00
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
 * When the calendar stops short of a week past `windowStart`, the time of its
 * last event; null when it reaches that far or lists nothing.
 */
export function shortCalendarEnd(events: readonly EconEvent[], windowStart: number): Date | null {
  let last: Date | null = null;
  for (const event of events) {
    if (!last || event.date.getTime() > last.getTime()) last = event.date;
  }
  return last && last.getTime() < windowStart + MIN_DAYS_LISTED_AHEAD * 86_400_000 ? last : null;
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
      regionNames = null;
    }
  }
  if (!regionNames) return /^[A-Z]{2}$/.test(code);
  try {
    // ZZ is CLDR's "Unknown Region".
    return code !== "ZZ" && regionNames.of(code) !== undefined;
  } catch {
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

/** "No scheduled releases for MX in this window", or for MX or ZA. */
export function noScheduledReleasesMessage(countries: readonly string[]): string {
  const named = countries.length > 1 ? `${countries.slice(0, -1).join(", ")} or ${countries.at(-1)}` : countries.join("");
  return `No scheduled releases for ${named} in this window.`;
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
 * untimed decision would fall due at midnight UTC, so they are never waited on.
 */
export function pendingHighImpactPrints(events: readonly EconEvent[], now: number): EconEvent[] {
  return events.filter((event) => {
    if (event.impact !== "high" || event.actual || event.kind) return false;
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
  for (const event of events) width = Math.max(width, Math.min(MAX_VALUE_WIDTH, displayWidth(event[key] ?? "")));
  return width;
}

function parseNumeric(value: string | null): number | null {
  if (!value) return null;
  const cleaned = value.replace(/[%,KMBTkmbts]/g, "").trim();
  const n = parseFloat(cleaned);
  return isNaN(n) ? null : n;
}

export function actualColor(actual: string | null, forecast: string | null): string {
  const a = parseNumeric(actual);
  const f = parseNumeric(forecast);
  if (a === null || f === null) return colors.text;
  if (a > f) return colors.positive;
  if (a < f) return colors.negative;
  return colors.text;
}
