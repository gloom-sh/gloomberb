import type { CatalystEvent, CatalystFilters, CatalystType } from "../../../api-client/catalysts";
import type { DataTableColumn } from "../../../components";
import { publicTickerKey } from "../../../utils/exchanges";
import { humanLabel } from "../shared/research-cells";

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
export function catalystColumns(width: number, changes: boolean, litigation: boolean): DataTableColumn[] {
  return [
    { id: "date", label: changes ? "Observed (UTC)" : "Date", width: changes ? 16 : 10, align: "left" },
    ...(!changes ? [{ id: "basis", label: "Date basis", width: 10, align: "left" as const }] : []),
    ...(!litigation ? [{ id: "ticker", label: "Ticker", width: width < 110 ? 12 : 14, align: "left" as const }] : []),
    { id: "title", label: litigation ? "Case / docket" : "Event", width: 30, flexGrow: 1, align: "left" },
    ...(width >= 115 ? [{ id: "type", label: "Type", width: 13, align: "left" as const }] : []),
    { id: "status", label: changes ? "Change" : "Status", width: changes ? width < 110 ? 22 : 34 : width < 110 ? 14 : 20, align: "left" },
    ...(width >= 145 ? [{ id: "agency", label: "Agency", width: 12, align: "left" as const }, { id: "country", label: "Country", width: 8, align: "left" as const }] : []),
  ];
}
function changeValue(value: unknown): string {
  if (value == null) return "--";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) return value.map(changeValue).join(", ") || "None";
  if (typeof value === "object") return Object.entries(value).map(([key, part]) => `${humanLabel(key)}: ${changeValue(part)}`).join("; ") || "None";
  return String(value);
}
type Party = CatalystEvent["parties"][number];
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
    case "title": return event.title;
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
