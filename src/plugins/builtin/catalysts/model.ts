import type { CatalystEvent, CatalystFilters, CatalystResponse, CatalystType } from "../../../api-client/catalysts";
import type { DataTableColumn } from "../../../components";
import { publicTickerKey } from "../../../utils/exchanges";
import { humanLabel, type StateTone } from "../shared/research-cells";

export const CATALYST_TABS = [{ value: "calendar", label: "Calendar" }, { value: "changes", label: "Changes" }] as const;
export type CatalystTab = typeof CATALYST_TABS[number]["value"];
export const catalystTab = (value: unknown): CatalystTab => value === "changes" ? "changes" : "calendar";
export const catalystAgency = (value: string) => value === "ClinicalTrials.gov" ? "NIH registry" : value;
export const catalystLabel = (value: string) => value === "pdufa" ? "PDUFA" : value.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase());
export const catalystSymbol = (event: CatalystEvent): string | null => {
  const party = event.parties.find((party) => party.ticker);
  return party?.ticker ? publicTickerKey(party.ticker, party.exchange ?? undefined) : null;
};
export const catalystTickers = (event: CatalystEvent) => [...new Set(event.parties.filter((p) => p.ticker).map((p) => publicTickerKey(p.ticker!, p.exchange ?? undefined)))].join(", ");
export const catalystDate = (event: CatalystEvent, field: CatalystFilters["dateField"] = "any"): string => {
  if (field === "observed") return event.observedAt.slice(0, 16).replace("T", " ");
  const key = field === "announced" || field === "effective" || field === "deadline" ? field
    : event.deadlineDate ? "deadline" : event.effectiveDate ? "effective" : "announced";
  const value = event[`${key}Date`];
  if (!value) return "--";
  return value.slice(0, event.datePrecision[key] === "year" ? 4 : event.datePrecision[key] === "month" ? 7 : 10);
};
type FitColumn = DataTableColumn & { min?: number };

/** Cells a table needs for `columns`: a gap after each, both edge paddings and the scrollbar. */
const tableNeed = (columns: readonly FitColumn[]) => columns.reduce((sum, column) => sum + column.width + 1, 3);

/**
 * The columns that fit `width`. The wide-only columns go first, then every
 * column gives up its slack down to `min`, then the date basis and the
 * parties go; date, ticker, event and status always stay.
 */
function fitColumns(columns: FitColumn[], width: number): DataTableColumn[] {
  let kept = columns;
  const drop = (id: string) => { if (tableNeed(kept) > width) kept = kept.filter((column) => column.id !== id); };
  for (const id of ["country", "agency", "type"]) drop(id);
  if (tableNeed(kept) > width) kept = kept.map((column) => ({ ...column, width: column.min ?? column.width }));
  for (const id of ["basis", "parties"]) drop(id);
  return kept.map(({ min: _min, ...column }) => column);
}

export function catalystColumns(width: number, changes: boolean, litigation: boolean): DataTableColumn[] {
  return fitColumns([
    { id: "date", label: changes ? "Observed (UTC)" : "Date", width: changes ? 16 : 10, align: "left" },
    ...(!changes ? [{ id: "basis", label: "Date basis", width: 10, align: "left" as const }] : []),
    ...(!litigation ? [{ id: "ticker", label: "Ticker", width: width < 110 ? 12 : 14, min: 10, align: "left" as const }] : []),
    // The entity the event is about, which the title alone buries.
    { id: "parties", label: "Parties", width: Math.max(16, Math.min(28, Math.round(width * 0.16))), min: 14, align: "left" },
    { id: "title", label: litigation ? "Case / docket" : "Event", width: 30, min: 20, flexGrow: 1, align: "left" },
    { id: "type", label: "Type", width: 13, align: "left" },
    { id: "status", label: changes ? "Change" : "Status", width: changes ? width < 110 ? 22 : 34 : width < 110 ? 14 : 20, min: changes ? 18 : 14, align: "left" },
    { id: "agency", label: "Agency", width: 12, align: "left" },
    { id: "country", label: "Country", width: 8, align: "left" },
  ], width);
}

type Party = CatalystEvent["parties"][number];

/** Legal forms dropped from a party in a cell: `Vertex Pharmaceuticals Incorporated` reads `Vertex Pharmaceuticals`. */
const LEGAL_FORM = /(?:,?\s+(?:inc|incorporated|corp|corporation|co|company|llc|l\.l\.c|ltd|limited|plc|p\.l\.c|lp|l\.p|ag|sa|s\.a|se|nv|n\.v|bv|b\.v|a\/s|as|ab|asa|oyj|spa|s\.p\.a|gmbh|kgaa|holdings?)\.?)+$/i;
const shortPartyName = (name: string) => name.trim().replace(LEGAL_FORM, "").trim() || name.trim();

/**
 * Federal Register titles name the filer before the action: `Self-Regulatory
 * Organizations; Cboe EDGA Exchange, Inc.; Notice of Filing...` and
 * `Dominion Energy South Carolina, Inc.; Notice of Application...`. The
 * service records no parties for these, so the cell reads the filer from the
 * title, and the event from the rest of it.
 */
const SRO_TITLE = /^Self-Regulatory Organizations;\s*([^;]+?);\s*(.+)$/;
const FILER_TITLE = /^([^;]+?(?:Inc\.|LLC|L\.L\.C\.|Corporation|Corp\.|Company|Ltd\.?|L\.P\.|LP));\s*(.+)$/;
function titleFiler(event: Pick<CatalystEvent, "parties" | "title">): { name: string; rest: string } | null {
  if (event.parties.length > 0) return null;
  const match = SRO_TITLE.exec(event.title) ?? FILER_TITLE.exec(event.title);
  return match ? { name: match[1]!.trim(), rest: match[2]!.trim() } : null;
}

/** The parties a row names, the ones linked to a listing first, so the ticker beside them is the first one's. */
export function catalystParties(event: Pick<CatalystEvent, "parties" | "title">): string {
  const parties = [...event.parties].sort((a, b) => Number(!a.ticker) - Number(!b.ticker));
  const names = [...new Set(parties.map((party) => shortPartyName(party.name)))];
  if (!names.length) {
    const filer = titleFiler(event);
    return filer ? shortPartyName(filer.name) : "--";
  }
  return names.length > 1 ? `${names[0]} +${names.length - 1}` : names[0]!;
}

/**
 * A status in the tone of what it means for the company: a refusal, a
 * complete response letter, a withdrawal or a charge red, an approval or a
 * cleared review green, a proposal or a decision still pending amber, a trial
 * under way in the accent, and a plain notice quiet. The words stay.
 */
const STATUS_TONES: Array<[RegExp, StateTone]> = [
  [/early termination granted|investigation closed/, "positive"],
  [/not available|no longer available|complete response|\bcrl\b|refused|revoked|withdrawn|terminated|suspended|guilty|convict|charges|lapsed|expired|sanctions/, "negative"],
  [/approved|authori[sz]ed|^available$|^completed$/, "positive"],
  [/proposed|pending|re-examination|appeal|^settlement announced/, "warning"],
  [/recruiting|enrolling|^active|^ongoing$/, "accent"],
  [/^(notice|rule|published|presidential document)$/, "muted"],
];
export function catalystStatusTone(status: string): StateTone {
  const text = humanLabel(status).toLowerCase();
  return STATUS_TONES.find(([pattern]) => pattern.test(text))?.[1] ?? "text";
}

/** Event types: the adverse ones amber, the binary decisions in the accent, routine rulemaking quiet. */
const TYPE_TONES: Record<CatalystType, StateTone> = {
  litigation: "warning", antitrust: "warning", recall: "warning", sanctions: "warning", export_control: "warning", tariff: "warning",
  pdufa: "accent", advisory: "accent", approval: "accent", clinical: "text",
  regulatory: "muted", rulemaking: "muted",
};
export const catalystTypeTone = (type: CatalystType): StateTone => TYPE_TONES[type] ?? "text";
function changeValue(value: unknown): string {
  if (value == null) return "--";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) return value.map(changeValue).join(", ") || "None";
  if (typeof value === "object") return Object.entries(value).map(([key, part]) => `${humanLabel(key)}: ${changeValue(part)}`).join("; ") || "None";
  return String(value);
}
function partyList(value: unknown): Party[] | null {
  return Array.isArray(value) && value.every((item) => item && typeof item === "object" && typeof item.name === "string"
    && (item.ticker === null || typeof item.ticker === "string")) ? value as Party[] : null;
}
const partyKey = (party: Party) => JSON.stringify([party.name, party.role ?? ""]);
const partyLink = (party: Party) => party.ticker
  ? `${publicTickerKey(party.ticker, party.exchange ?? undefined)}${Number.isFinite(party.confidence) ? ` (${Math.round(party.confidence * 100)}%)` : ""}` : "Unlinked";
/** Compare named parties before rendering so unchanged collaborators do not hide a new issuer link. */
export function catalystChangeText(change: CatalystEvent["changes"][number]): string {
  if (change.field === "parties") {
    const before = partyList(change.before), after = partyList(change.after);
    if (before && after) {
      const old = new Map(before.map((party) => [partyKey(party), party]));
      const next = new Map(after.map((party) => [partyKey(party), party]));
      const changes = [...new Set([...old.keys(), ...next.keys()])].flatMap((key) => {
        const from = old.get(key), to = next.get(key), party = to ?? from!;
        const label = `${party.name}${party.role ? ` (${party.role})` : ""}`;
        if (!from) return [`${label}: added, ${partyLink(to!)}`];
        if (!to) return [`${label}: removed, ${partyLink(from)}`];
        if (partyLink(from) !== partyLink(to)) return [`${partyLink(from)} → ${partyLink(to)}: ${label}`];
        if (JSON.stringify(from) !== JSON.stringify(to)) return [`Link evidence updated: ${label}`];
        return [];
      });
      return changes.join("; ") || "Parties reordered";
    }
    return "Parties updated";
  }
  const field = humanLabel(change.field.replace(/^metadata\./, "").replace(/Date$/, ""));
  return `${field}: ${changeValue(change.before)} → ${changeValue(change.after)}`;
}
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/** The calendar groups by the month of the date it shows; the change feed by the day a change was observed. */
export function catalystSection(event: CatalystEvent, field: CatalystFilters["dateField"], changes: boolean): string {
  if (changes) return event.observedAt.slice(0, 10);
  const date = catalystDate(event, field);
  if (date === "--") return "Undated";
  return /^\d{4}-\d{2}/.test(date) ? `${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}` : date;
}
/** The first change in words, before and after: `Deadline 2027-03-01 → 2027-04-01`. */
function changeSummary(event: CatalystEvent): string {
  const [first, ...rest] = event.changes;
  if (!first) return "First observed";
  return `${catalystChangeText(first)}${rest.length ? ` +${rest.length}` : ""}`;
}
export const catalystCell = (event: CatalystEvent, column: string, field: CatalystFilters["dateField"], changes: boolean): string => {
  switch (column) {
    case "date": return catalystDate(event, changes ? "observed" : field);
    case "basis": return catalystDateBasis(event, field);
    case "ticker": return catalystTickers(event) || "Unlinked";
    case "parties": return catalystParties(event);
    // A filer read from the title is in the Parties column; the event is the rest.
    case "title": return titleFiler(event)?.rest ?? event.title;
    case "type": return catalystLabel(event.type);
    case "status": return changes ? changeSummary(event) : humanLabel(event.status);
    case "agency": return catalystAgency(event.agency);
    case "country": return event.country ?? event.jurisdiction;
    default: return "";
  }
};
export function catalystQuery(options: Record<string, unknown>, symbol?: string, litigation = false): CatalystFilters {
  return {
    ...(symbol ? { symbol } : {}), ...(litigation ? { litigation: true } : {}),
    ...Object.fromEntries(["agency", "country", "sector", "status", "search", "from", "to"].flatMap((key) => typeof options[key] === "string" && options[key] ? [[key, options[key]]] : [])),
    ...(options.type ? { type: options.type as CatalystType } : {}),
    ...(options.tab !== "changes" && (options.upcoming === true || options.upcoming === "true") ? { upcoming: true } : {}),
    ...(options.tab === "changes" ? { changed: true, dateField: "observed" as const } : { dateField: (options.dateField as CatalystFilters["dateField"]) ?? "any" }),
  };
}

const FILTER_KEYS = ["type", "agency", "country", "sector", "status", "source", "search", "from", "to", "upcoming"] as const;

/**
 * Why a list is empty: a filter the reader set, or nothing linked to the
 * company. Litigation also says which court dockets are not collected, since
 * an empty list there otherwise reads as a company with no cases.
 */
export function catalystEmptyTitle(data: Pick<CatalystResponse, "coverage"> | null | undefined, query: CatalystFilters, changes: boolean): string {
  if (data?.coverage.totalEvents === 0) return "Catalyst history is collecting.";
  if (changes) return "No observed status or date changes match.";
  const filtered = FILTER_KEYS.some((key) => !!query[key]) || (query.dateField ?? "any") !== "any";
  if (filtered || !query.symbol) return "No events match these filters.";
  if (!query.litigation) return `No events linked to ${query.symbol} yet.`;
  const courts = [...new Set(data?.coverage.sources.filter((source) => !source.enabled && /court/i.test(source.agency)).map((source) => `${source.jurisdiction} court dockets`) ?? [])];
  return `No cases linked to ${query.symbol}.${courts.length ? ` ${courts.join(" and ")} are not collected yet, so only agency and regulator actions show.` : ""}`;
}

export function catalystDateBasis(event: CatalystEvent, field: CatalystFilters["dateField"] = "any"): string {
  const basis = field === "any" || !field ? event.deadlineDate ? "deadline" : event.effectiveDate ? "effective" : event.announcedDate ? "announced" : "undated" : field;
  const meaning = String(event.metadata?.[`${basis}Meaning`] ?? event.metadata?.[`${basis}DateMeaning`] ?? "");
  if (/primary completion/i.test(meaning)) return "Completion";
  if (/comment/i.test(meaning)) return "Comments";
  if (/meeting/i.test(meaning)) return "Meeting";
  return catalystLabel(basis);
}
export function catalystFacts(event: CatalystEvent): Array<{ label: string; value: string }> {
  const metadata = event.metadata ?? {};
  const facts: Array<{ label: string; value: string }> = [];
  const add = (label: string, value: unknown) => { if (typeof value === "string" && value.trim()) facts.push({ label, value }); };
  const date = (value: unknown) => typeof value === "string" ? value : value && typeof value === "object" && "date" in value ? String(value.date) : "";
  if (event.type === "clinical") {
    add("Trial ID", metadata.nctId);
    if (Array.isArray(metadata.phases)) add("Phase", metadata.phases.join(", ").replaceAll("PHASE", "Phase "));
    if (typeof metadata.enrollment === "number" && Number.isFinite(metadata.enrollment)) add("Enrollment", `${metadata.enrollment.toLocaleString("en-US")} participants${typeof metadata.enrollmentType === "string" ? ` · ${metadata.enrollmentType.toLowerCase()}` : ""}`);
    const completion = metadata.primaryCompletion;
    if (completion && typeof completion === "object") add("Completion basis", "type" in completion ? String(completion.type).toLowerCase() : "");
    if (typeof metadata.hasResults === "boolean") add("Results", metadata.hasResults ? `Posted${date(metadata.resultsPosted) ? ` ${date(metadata.resultsPosted)}` : ""}` : "Not posted");
    if (Array.isArray(metadata.conditions)) add("Conditions", metadata.conditions.filter((value) => typeof value === "string").join(", "));
    if (Array.isArray(metadata.countries)) add("Study countries", metadata.countries.filter((value) => typeof value === "string").join(", "));
  }
  for (const [key, label] of [["court", "Court"], ["caseNumber", "Case number"], ["caseCaption", "Case caption"], ["administrativeFileNumber", "Admin file"], ["litigationReleaseNumber", "Release number"]]) add(label!, metadata[key!]);
  return facts;
}
