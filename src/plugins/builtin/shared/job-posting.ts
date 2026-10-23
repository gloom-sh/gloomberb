import type { CloudJobsPostingDetail } from "../../../api-client/types";
import { formatShortDate } from "../../../utils/datetime-format";
import { formatCompact, formatNumber } from "../../../utils/format";
import { humanLabel } from "./research-cells";

/**
 * One job posting read by a person: its place, when it was posted, its pay
 * and its hours, in words. Shared by JOBS and HIRE's posting detail. A value
 * the careers system did not give is left out, never shown as a dash or
 * "Unknown".
 */

/** "$120k–150k", "$45–52/h", "£60k"; empty when the posting has no pay. */
export function formatSalaryRange(
  min: number | null,
  max: number | null,
  currency: string | null,
  period: string | null,
): string {
  if (min == null && max == null) return "";
  const symbol = currency === "USD" ? "$" : currency === "EUR" ? "€" : currency === "GBP" ? "£" : currency ? `${currency} ` : "";
  const fmt = (value: number) => (period === "hour" ? formatNumber(value, 0) : formatCompact(value));
  const range = min != null && max != null && min !== max
    ? `${symbol}${fmt(min)}–${fmt(max)}`
    : `${symbol}${fmt((min ?? max)!)}`;
  return period === "hour" ? `${range}/h` : period === "month" ? `${range}/mo` : range;
}

const countryNames = new Intl.DisplayNames(["en"], { type: "region" });

/** A country code as its name: "AU" as "Australia". */
export function countryName(code: string | null | undefined): string | null {
  if (!code || !/^[A-Z]{2}$/.test(code)) return null;
  try {
    return countryNames.of(code) ?? null;
  } catch {
    return null;
  }
}

/**
 * Where the role is, in words: the posting's location with its country named
 * ("Paris, FR" as "Paris, France"), the country when the location does not end
 * with it, and "Remote" when the role is remote and the location does not say
 * so. A list of places ("Austin, TX; Denver, CO") stays as written.
 */
export function postingPlace(posting: { location: string | null; country: string | null; remote: boolean | null }): string | null {
  const location = posting.location?.trim() || null;
  const name = countryName(posting.country);
  let place = location;
  if (location && !location.includes(";")) {
    const parts = location.split(/\s*,\s*/);
    const last = parts.at(-1) ?? "";
    const lastName = /^[A-Z]{2}$/.test(last) && parts.length > 1 ? countryName(last) : null;
    // A trailing code names the country only when it is the posting's own ("…, CA" may be California).
    if (lastName && last === posting.country) place = [...parts.slice(0, -1), lastName].join(", ");
    else if (name && last.toLowerCase() !== name.toLowerCase() && last !== posting.country) place = `${location}, ${name}`;
  } else if (!location) place = name;
  const remote = posting.remote && !/remote/i.test(place ?? "") ? "Remote" : null;
  return [place, remote].filter(Boolean).join(" · ") || null;
}

/** "Oct 3, 2026"; "about Oct 3, 2026" or "Oct 3, 2026 or earlier" when the careers system's date is not exact. */
function postedText(postedAt: string | null | undefined, precision?: string | null): string | null {
  if (!postedAt) return null;
  const date = formatShortDate(postedAt.slice(0, 10), { utc: true, fallback: "" });
  if (!date) return null;
  return precision === "floor" ? `${date} or earlier` : precision === "approximate" ? `about ${date}` : date;
}

/** schema.org's employment types, in words. */
const EMPLOYMENT: Record<string, string> = {
  FULL_TIME: "Full time", PART_TIME: "Part time", CONTRACTOR: "Contract", TEMPORARY: "Temporary",
  INTERN: "Internship", PER_DIEM: "Per diem", VOLUNTEER: "Volunteer",
};

/** "Full time" for FULL_TIME or full_time; a careers system's own word ("CDI", "Vollzeit") as written. Nothing for "other" or "unavailable". */
export function employmentText(value: string | null | undefined): string | null {
  const text = value?.trim();
  if (!text || /^(?:other|unknown|unavailable|n\/?a|none)$/i.test(text)) return null;
  const known = EMPLOYMENT[text.toUpperCase().replace(/[\s-]+/g, "_")];
  if (known) return known;
  return /^[A-Z_]+$/.test(text) && text.includes("_") ? humanLabel(text) : text;
}

/**
 * A title the careers system never gave: `Job <id>`, an id alone, or the
 * words of the posting's address. A reader is shown "Untitled role" instead.
 */
function isPlaceholderTitle(title: string | null | undefined, externalId?: string | null): boolean {
  const text = title?.trim() ?? "";
  if (!text) return true;
  if (/^job\s+\S*\d\S*$/i.test(text) || /^[A-Z]{0,4}[-_]?\d{3,}$/i.test(text)) return true;
  if (externalId && (text === externalId || text === `Job ${externalId}`)) return true;
  // Bytes still percent-encoded: the address's words, not the role's title.
  return /%[0-9A-F]{2}/i.test(text);
}

/** The posting's title as the careers system wrote it, or "Untitled role" for one it never gave. */
export function postingTitle(title: string | null | undefined, externalId?: string | null): string {
  return isPlaceholderTitle(title, externalId) ? "Untitled role" : title!;
}

/**
 * A posting's description as words: the markdown marks some careers systems
 * write (Starbucks' "#### Basic Qualifications", "**Pay**") taken off, so a
 * heading reads as a heading line and bold as its words.
 */
export function descriptionText(text: string | null | undefined): string | null {
  if (!text) return null;
  return text.replace(/^[ \t]*#{1,6}[ \t]+(?=\S)/gm, "").replace(/\*\*([^*\n]+)\*\*/g, "$1").replace(/__([^_\n]+)__/g, "$1");
}

export interface PostingFact {
  label: string;
  value: string;
}

/** A posting's facts, in the order a reader wants them; only those the posting has. */
export function postingFacts(posting: CloudJobsPostingDetail): PostingFact[] {
  const facts: Array<[string, string | null]> = [
    ["Place", postingPlace(posting)],
    ["Posted", postedText(posting.postedAt, posting.postedPrecision)],
    ["Pay", formatSalaryRange(posting.salaryMin, posting.salaryMax, posting.salaryCurrency, posting.salaryPeriod) || null],
    ["Hours", employmentText(posting.employmentType)],
    ["Closed", posting.closedAt ? postedText(posting.closedAt) : null],
  ];
  return facts.filter((fact): fact is [string, string] => !!fact[1]).map(([label, value]) => ({ label, value }));
}
