#!/usr/bin/env bun
/**
 * The release days MDAY ships with, src/plugins/builtin/macro-day/release-table.ts,
 * rewritten from the publishers' archives. The app reads newer days from the
 * server; this table is what it falls back on.
 *
 *   bun run macro-releases:update          read the archives and rewrite the table
 *   bun run macro-releases:update --check  fail when the table ends more than
 *                                          MACRO_RELEASES_STALE_DAYS before today
 *
 * scripts/bump-version.sh runs the check, so a release cannot ship an old
 * table unnoticed. GLOOM_ALLOW_STALE_MACRO_RELEASES=1 lets one through.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { MACRO_RELEASE_TABLE } from "../src/plugins/builtin/macro-day/release-table";
import {
  US_MACRO_EVENT_KINDS, MACRO_RELEASE_SOURCES, MACRO_RELEASES_STALE_DAYS, macroReleasesBehind, type UsMacroEventKind,
} from "../src/plugins/builtin/macro-day/releases";
import { zonedDateTimeParts } from "../src/utils/zoned-date-time";

const TABLE_PATH = join(import.meta.dir, "../src/plugins/builtin/macro-day/release-table.ts");
const FIRST_YEAR = 2021;
/** The longest wait between two releases of one kind on record is 76 days (payrolls through the 2025 shutdown). */
const MAX_SILENCE_DAYS = 120;
/** BLS releases come out at 8:30 ET and FOMC statements at 14:00 ET; a read after 17:00 ET covers its own day. */
const DAY_COMPLETE_HOUR = 17;
/** BLS refuses readers that do not name themselves with a contact address. */
const USER_AGENT = "Gloomberb/1.0 (+https://gloom.sh; hello@gloom.sh)";
/** The page of each BLS release's newest edition, which BLS archives some days after it is out. */
const BLS_CURRENT_EDITIONS = {
  cpi: "https://www.bls.gov/news.release/cpi.nr0.htm",
  jobs: "https://www.bls.gov/news.release/empsit.nr0.htm",
} as const;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const COMMENTS: Record<UsMacroEventKind, string> = {
  cpi: "BLS Consumer Price Index, 8:30 ET.",
  jobs: "BLS Employment Situation (nonfarm payrolls), 8:30 ET.",
  fomc: "FOMC statement days (the meeting's last day), 14:00 ET. The August 2025 notation vote is not a meeting.",
};

const DAY_MS = 86_400_000;
const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
const withoutComments = (html: string) => html.replace(/<!--[\s\S]*?-->/g, "");
const sortedDates = (dates: Iterable<string>) => [...new Set(dates)].sort();

/** Each published release is linked as /news.release/archives/<name>_MMDDYYYY.htm; the next ones wait in an HTML comment. */
function parseBlsArchive(html: string, name: "cpi" | "empsit"): string[] {
  const link = new RegExp(`href="/news\\.release/archives/${name}_(\\d{2})(\\d{2})(\\d{4})\\.htm"`, "g");
  return sortedDates([...withoutComments(html).matchAll(link)].map(([, month, day, year]) => `${year}-${month}-${day}`));
}

/**
 * A current edition carries its release date at once, as "embargoed until 8:30 a.m. (ET) Wednesday,
 * October 14, 2026". Only that form counts, and only when the weekday fits the date; else null, never a guess.
 */
function parseBlsCurrentEdition(html: string): string | null {
  const match = new RegExp(
    `embargoed\\s+until[^<]{0,200}?\\b(${WEEKDAYS.join("|")}),\\s+(${MONTHS.join("|")})\\s+(\\d{1,2}),\\s+(\\d{4})\\b`,
  ).exec(withoutComments(html));
  if (!match) return null;
  const [, weekday, month, day, year] = match;
  const date = new Date(Date.UTC(Number(year), MONTHS.indexOf(month!), Number(day)));
  return date.getUTCFullYear() === Number(year) && date.getUTCMonth() === MONTHS.indexOf(month!)
    && date.getUTCDate() === Number(day) && WEEKDAYS[date.getUTCDay()] === weekday
    ? date.toISOString().slice(0, 10)
    : null;
}

/** A held meeting links its statement, dated in the link; notation votes and unscheduled meetings say so in the date cell. */
function parseFomcStatements(html: string): string[] {
  const rows = withoutComments(html).split(/<div class="[^"]*\bfomc-meeting"/).slice(1);
  return sortedDates(rows.flatMap((row) => {
    const dateCell = /fomc-meeting__date[^>]*>([^<]*)</.exec(row)?.[1] ?? "";
    const statement = /<strong>Statement:<\/strong>[\s\S]*?\/newsevents\/pressreleases\/monetary(\d{4})(\d{2})(\d{2})a\.htm/.exec(row);
    return statement && !dateCell.includes("(") ? [`${statement[1]}-${statement[2]}-${statement[3]}`] : [];
  }));
}

async function download(url: string): Promise<string> {
  const response = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "text/html" }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response.text();
}

function tableDates(kind: UsMacroEventKind): string[] {
  return Object.entries(MACRO_RELEASE_TABLE.days[kind]).flatMap(([year, days]) => days.map((day) => `${year}-${day}`));
}

function render(checkedAt: string, coveredThrough: string, days: Record<UsMacroEventKind, string[]>): string {
  const kinds = US_MACRO_EVENT_KINDS.map((kind) => {
    const years = new Map<string, string[]>();
    for (const date of days[kind]) years.set(date.slice(0, 4), [...years.get(date.slice(0, 4)) ?? [], date.slice(5)]);
    const lines = [...years].map(([year, list]) => `      ${year}: [${list.map((day) => `"${day}"`).join(", ")}],`);
    return [`    // ${COMMENTS[kind]}`, `    ${kind}: {`, ...lines, "    },"].join("\n");
  });
  return `// Generated by scripts/update-macro-releases.ts from the publishers' archives
// (bun run macro-releases:update). Dates are New York calendar days.
export const MACRO_RELEASE_TABLE: {
  checkedAt: string;
  coveredThrough: string;
  days: Record<"cpi" | "jobs" | "fomc", Record<number, readonly string[]>>;
} = {
  checkedAt: "${checkedAt}",
  /** The last day the lists are complete for: later sessions are left out, release day or not. */
  coveredThrough: "${coveredThrough}",
  days: {
${kinds.join("\n")}
  },
};
`;
}

function check(): void {
  const { coveredThrough } = MACRO_RELEASE_TABLE;
  const behind = macroReleasesBehind(coveredThrough);
  if (behind <= MACRO_RELEASES_STALE_DAYS) {
    console.log(`MDAY release days run through ${coveredThrough}, ${behind} day${behind === 1 ? "" : "s"} ago.`);
    return;
  }
  const message = `MDAY release days end ${coveredThrough}, ${behind} days ago (limit ${MACRO_RELEASES_STALE_DAYS}).`
    + " Run `bun run macro-releases:update`, merge the change, then release.";
  if (process.env.GLOOM_ALLOW_STALE_MACRO_RELEASES === "1") {
    console.warn(`warning: ${message} Releasing anyway (GLOOM_ALLOW_STALE_MACRO_RELEASES=1).`);
    return;
  }
  console.error(`error: ${message} GLOOM_ALLOW_STALE_MACRO_RELEASES=1 releases anyway.`);
  process.exit(1);
}

async function update(): Promise<void> {
  const now = Date.now();
  const clock = zonedDateTimeParts(now, "America/New_York");
  const checkedAt = `${clock.year}-${String(clock.month).padStart(2, "0")}-${String(clock.day).padStart(2, "0")}`;
  let coveredThrough = clock.hour >= DAY_COMPLETE_HOUR ? checkedAt : addDays(checkedAt, -1);
  const [cpi, jobs, fomc] = await Promise.all(US_MACRO_EVENT_KINDS.map((kind) => download(MACRO_RELEASE_SOURCES[kind])));
  const read: Record<UsMacroEventKind, string[]> = {
    cpi: parseBlsArchive(cpi!, "cpi"), jobs: parseBlsArchive(jobs!, "empsit"), fomc: parseFomcStatements(fomc!),
  };
  const problems: string[] = [];
  // The archives lag the release, so a current edition's date is added to its archive. Where that edition
  // cannot be read or parsed, the archive only vouches for days through its own last release: coveredThrough
  // stops there instead of counting a release it may be missing as a normal day.
  for (const kind of ["cpi", "jobs"] as const) {
    const embargo = await download(BLS_CURRENT_EDITIONS[kind]).then(parseBlsCurrentEdition, () => null);
    if (embargo) {
      read[kind].push(embargo);
      continue;
    }
    console.warn(`warning: ${BLS_CURRENT_EDITIONS[kind]} gave no release date.`);
    const last = read[kind].at(-1);
    if (last && last < coveredThrough) coveredThrough = last;
  }
  if (coveredThrough < MACRO_RELEASE_TABLE.coveredThrough) {
    problems.push(`the table covers through ${MACRO_RELEASE_TABLE.coveredThrough}, the readable pages only through ${coveredThrough}`);
  }
  const days = {} as Record<UsMacroEventKind, string[]>;
  for (const kind of US_MACRO_EVENT_KINDS) {
    const published = read[kind].filter((date) => date >= `${FIRST_YEAR}-01-01` && date <= coveredThrough);
    const known = tableDates(kind);
    // An archive never takes a release back. The Fed's calendar keeps five years, so days before
    // its first are kept from the table; a known day missing inside its span means the page changed.
    const first = published[0];
    const missing = known.filter((date) => first && date >= first && !published.includes(date));
    if (missing.length) problems.push(`${MACRO_RELEASE_SOURCES[kind]} no longer lists ${missing.join(", ")}`);
    const latest = published.at(-1);
    if (!latest || latest < addDays(coveredThrough, -MAX_SILENCE_DAYS)) {
      problems.push(`${MACRO_RELEASE_SOURCES[kind]} lists no release since ${latest ?? `${FIRST_YEAR}-01-01`}`);
    }
    days[kind] = sortedDates([...known.filter((date) => !first || date < first), ...published]);
    const added = days[kind].filter((date) => !known.includes(date));
    console.log(`${kind}: ${days[kind].length} days, last ${days[kind].at(-1)}${added.length ? `, added ${added.join(", ")}` : ""}`);
  }
  if (problems.length) {
    console.error(`error: the table was left as it is.\n${problems.map((problem) => `  ${problem}`).join("\n")}`);
    process.exit(1);
  }
  writeFileSync(TABLE_PATH, render(checkedAt, coveredThrough, days));
  console.log(`Covered through ${coveredThrough} (checked ${checkedAt}).`);
}

if (process.argv.includes("--check")) check();
else await update();
