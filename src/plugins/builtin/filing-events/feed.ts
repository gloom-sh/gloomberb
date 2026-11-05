import type { CloudFilingEventPayload } from "../../../api-client";
import { formatFilingDate } from "../../../utils/datetime-format";
import { wrapTextLines } from "../../../utils/text-wrap";

/** Every 8-K carries exhibits, so the label says nothing beside another one. */
const EXHIBITS_LABEL = "Exhibits";
/** Shown for a filing whose items EDGAR did not report. */
const UNCLASSIFIED_LABEL = "No item listed";
const BULLET_PREFIX = "• ";

export interface FilingEventPerson {
  name: string;
  detail: string;
}

export interface FilingEventEntry {
  id: string;
  filedLabel: string;
  /** "8-K", or "8-K/A" for an amendment, on every entry as a filing list names its forms. */
  form: string;
  itemsLabel: string;
  docUrl: string;
  material: boolean;
  headline: string | null;
  points: string[];
  people: FilingEventPerson[];
  /**
   * A blank row above it: an entry with a read under its row does, a filing
   * listed under ALSO FILED is one row of a table and does not.
   */
  spaced: boolean;
  /** Lines the entry occupies in the feed, its leading blank row included. */
  lines: number;
  /** First line of the entry in the feed, its leading blank row included. */
  top: number;
}

export interface FilingEventsSection {
  id: "news" | "also";
  title: string;
  entries: FilingEventEntry[];
}

export interface FilingEventsFeed {
  sections: FilingEventsSection[];
  /** Every entry in the order the selection walks them. */
  entries: FilingEventEntry[];
}

function formatCalendarDate(value: string | null | undefined): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) return null;
  return formatFilingDate(date);
}

/** The day EDGAR dated it; without one, the day of the acceptance instant, in UTC as filing days are. */
function formatFiled(event: CloudFilingEventPayload): string {
  return formatCalendarDate(event.filingDate) ?? formatFilingDate(event.filedAt);
}

function itemsLabel(event: CloudFilingEventPayload): string {
  const named = event.labels.filter((label) => label !== EXHIBITS_LABEL);
  const labels = named.length > 0 ? named : event.labels;
  return labels.join(" · ") || UNCLASSIFIED_LABEL;
}

type FilingPerson = CloudFilingEventPayload["people"][number];

/** Actions that end a role: what a move between two roles goes from. */
const LEAVING_ACTIONS = new Set(["left", "resigned", "resigned as director"]);

const effectiveLabel = (effective: string | null) => `effective ${formatCalendarDate(effective) ?? "—"}`;

/**
 * What happened to one person, on one line: a move from one role to another
 * reads `Chief Executive Officer → Executive Chair`, roles taken or left at
 * once are listed together, and a date every role shares is said once.
 */
function personDetail(changes: FilingPerson[]): string {
  const dates = new Set(changes.map((change) => change.effective ?? ""));
  const shared = dates.size === 1 ? changes[0]!.effective : null;
  const dated = (text: string, effective: string | null) =>
    dates.size > 1 && effective ? `${text}, ${effectiveLabel(effective)}` : text;
  const leaving = changes.filter((change) => LEAVING_ACTIONS.has(change.action));
  const taking = changes.filter((change) => !LEAVING_ACTIONS.has(change.action) && change.action !== "other");
  const other = changes.filter((change) => change.action === "other");
  const roles = (list: FilingPerson[]) => list.map((change) => dated(change.role, change.effective)).join(", ");
  const withAction = (list: FilingPerson[]) => list.map((change) => dated(`${change.role}, ${change.action}`, change.effective));
  const parts = leaving.length > 0 && taking.length > 0
    ? [`${roles(leaving)} → ${roles(taking)}`, ...withAction(other)]
    : withAction([...leaving, ...taking, ...other]);
  const text = parts.join("; ");
  return shared ? `${text}, ${effectiveLabel(shared)}` : text;
}

/** Each person named once, in the order the filing first names them. */
function filingPeople(people: FilingPerson[]): FilingEventPerson[] {
  const byName = new Map<string, { name: string; changes: FilingPerson[] }>();
  for (const person of people) {
    const key = person.name.trim().replace(/\s+/g, " ").toLowerCase();
    const entry = byName.get(key) ?? { name: person.name.trim(), changes: [] };
    entry.changes.push(person);
    byName.set(key, entry);
  }
  return [...byName.values()].map((entry) => ({ name: entry.name, detail: personDetail(entry.changes) }));
}

/** A filing the model read and had something to say about. */
function carriesNews(event: CloudFilingEventPayload): boolean {
  return event.read && (!!event.headline || !!event.summary);
}

function proseLines(text: string, width: number, prefix = ""): number {
  return wrapTextLines(text, Math.max(8, width - prefix.length)).length;
}

function buildEntry(
  event: CloudFilingEventPayload,
  proseWidth: number,
  detailed: boolean,
): Omit<FilingEventEntry, "top"> {
  const headline = detailed ? event.headline : null;
  const points = detailed && event.summary
    ? event.summary.split("\n").map((point) => point.trim()).filter(Boolean)
    : [];
  const people = detailed ? filingPeople(event.people) : [];
  // One blank row above a read entry, then the filed-and-items row, then whatever was read.
  let lines = detailed ? 2 : 1;
  if (headline) lines += proseLines(headline, proseWidth);
  for (const point of points) lines += proseLines(point, proseWidth, BULLET_PREFIX);
  for (const person of people) lines += proseLines(person.detail, proseWidth, `${person.name}  `);
  return {
    id: event.id,
    filedLabel: formatFiled(event),
    form: event.form?.trim().toUpperCase() || "8-K",
    itemsLabel: itemsLabel(event),
    docUrl: event.docUrl,
    material: event.material,
    headline,
    points,
    people,
    spaced: detailed,
    lines,
  };
}

/**
 * Splits the filings into the ones a model read and the rest, and measures each
 * entry so a moving selection can be scrolled into view. Filings arrive newest
 * first and stay in that order inside each group.
 */
export function buildFilingEventsFeed(
  events: CloudFilingEventPayload[],
  proseWidth: number,
): FilingEventsFeed {
  const news: Omit<FilingEventEntry, "top">[] = [];
  const also: Omit<FilingEventEntry, "top">[] = [];
  for (const event of events) {
    const detailed = carriesNews(event);
    (detailed ? news : also).push(buildEntry(event, proseWidth, detailed));
  }

  const sections: FilingEventsSection[] = [];
  const entries: FilingEventEntry[] = [];
  let top = 0;
  for (const [id, title, group] of [
    ["news", "WHAT HAPPENED", news],
    ["also", "ALSO FILED", also],
  ] as const) {
    if (group.length === 0) continue;
    // The first heading starts the feed; a later one sits under a blank row, matching an entry.
    top += sections.length === 0 ? 1 : 2;
    const placed = group.map((entry) => {
      const positioned = { ...entry, top };
      top += entry.lines;
      return positioned;
    });
    sections.push({ id, title, entries: placed });
    entries.push(...placed);
  }

  return { sections, entries };
}

/**
 * Scroll offset that brings an entry into view, mirroring how the shared list
 * follows its selection. An entry taller than the viewport is pinned to its
 * own top rather than its bottom, so its filed date stays readable.
 */
export function resolveFeedScrollTop({
  entry,
  scrollTop,
  viewportHeight,
}: {
  entry: FilingEventEntry | null;
  scrollTop: number;
  viewportHeight: number;
}): number {
  if (!entry || viewportHeight <= 0) return scrollTop;
  if (entry.top < scrollTop) return entry.top;
  const bottom = entry.top + entry.lines;
  if (bottom > scrollTop + viewportHeight) {
    return Math.min(entry.top, bottom - viewportHeight);
  }
  return scrollTop;
}
