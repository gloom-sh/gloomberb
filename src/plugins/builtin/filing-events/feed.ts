import type { CloudFilingEventPayload } from "../../../api-client";
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
  itemsLabel: string;
  docUrl: string;
  material: boolean;
  headline: string | null;
  points: string[];
  people: FilingEventPerson[];
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
  summaryLine: string;
  sections: FilingEventsSection[];
  /** Every entry in the order the selection walks them. */
  entries: FilingEventEntry[];
}

function formatFiled(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "2-digit",
    year: "2-digit",
  });
}

function itemsLabel(event: CloudFilingEventPayload): string {
  const named = event.labels.filter((label) => label !== EXHIBITS_LABEL);
  const labels = named.length > 0 ? named : event.labels;
  return labels.join(" · ") || UNCLASSIFIED_LABEL;
}

function personDetail(person: CloudFilingEventPayload["people"][number]): string {
  return [
    person.role,
    person.action,
    person.effective ? `effective ${formatFiled(person.effective)}` : null,
  ].filter(Boolean).join(", ");
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
  const people = detailed
    ? event.people.map((person) => ({ name: person.name, detail: personDetail(person) }))
    : [];
  // One blank row above, then the filed-and-items row, then whatever was read.
  let lines = 2;
  if (headline) lines += proseLines(headline, proseWidth);
  for (const point of points) lines += proseLines(point, proseWidth, BULLET_PREFIX);
  for (const person of people) lines += proseLines(person.detail, proseWidth, `${person.name}  `);
  return {
    id: event.id,
    filedLabel: formatFiled(event.filedAt),
    itemsLabel: itemsLabel(event),
    docUrl: event.docUrl,
    material: event.material,
    headline,
    points,
    people,
    lines,
  };
}

function summaryLine(events: CloudFilingEventPayload[], newsCount: number): string {
  const oldest = events[events.length - 1];
  const since = oldest ? ` since ${formatFiled(oldest.filedAt)}` : "";
  const news = newsCount === 0
    ? "none carry news"
    : newsCount === 1
      ? "1 carries news"
      : `${newsCount} carry news`;
  return `${events.length} filing${events.length === 1 ? "" : "s"}${since}  ·  ${news}`;
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
    // The heading sits on its own row under a blank one, matching an entry.
    top += 2;
    const placed = group.map((entry) => {
      const positioned = { ...entry, top };
      top += entry.lines;
      return positioned;
    });
    sections.push({ id, title, entries: placed });
    entries.push(...placed);
  }

  return { summaryLine: summaryLine(events, news.length), sections, entries };
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
