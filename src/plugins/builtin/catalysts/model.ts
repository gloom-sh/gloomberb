import type { CatalystEvent, CatalystFilters, CatalystType } from "../../../api-client/catalysts";
import type { DataTableColumn } from "../../../components";
import { publicTickerKey } from "../../../utils/exchanges";

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
    { id: "status", label: changes ? "Changed" : "Status", width: width < 110 ? 14 : 20, align: "left" },
    ...(width >= 145 ? [{ id: "agency", label: "Agency", width: 12, align: "left" as const }, { id: "country", label: "Country", width: 8, align: "left" as const }] : []),
  ];
}
export const changeValue = (value: unknown): string => value == null ? "--" : typeof value === "string" ? value : JSON.stringify(value);
export const catalystCell = (event: CatalystEvent, column: string, field: CatalystFilters["dateField"], changes: boolean): string => {
  switch (column) {
    case "date": return catalystDate(event, changes ? "observed" : field);
    case "basis": return catalystDateBasis(event, field);
    case "ticker": return catalystTickers(event) || "Unlinked";
    case "title": return event.title;
    case "type": return catalystLabel(event.type);
    case "status": return changes ? event.changes.map((c) => catalystLabel(c.field)).join(", ") || "First observed" : catalystLabel(event.status);
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
