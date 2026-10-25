import type { DataTableColumn } from "../../../components";
import type { StateTone } from "../shared/research-cells";
import type { OpenFdaDataset, OpenFdaFilters } from "./types";

export type ColumnId =
  | "date" | "product" | "labeler" | "role" | "reactions" | "outcome"
  | "manufacturer" | "problems" | "event" | "firm" | "class" | "status" | "reason";
export type RecordColumn = DataTableColumn & { id: ColumnId };

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, Math.round(value)));

/**
 * Columns for one dataset at `width`. Names get a width of their own, so a
 * drug or a firm reads in full; the free text (reactions, device problems, a
 * recall's product) is the one column that grows, the same in the terminal,
 * which gives every spare cell to the first growing column, and the desktop.
 */
export function recordColumns(dataset: OpenFdaDataset, width: number): RecordColumn[] {
  const wide = width >= 76;
  const roomy = width >= 110;
  const date: RecordColumn = { id: "date", label: dataset === "recall" ? "Initiated" : "Received", width: 10, align: "left" };
  if (dataset === "drug") {
    return [
      date,
      { id: "product", label: "Drug", width: clamp(width * 0.25, 20, 34), minWidth: 20, align: "left", ...(wide ? {} : { flexGrow: 1 }) },
      ...(roomy ? [{ id: "labeler" as const, label: "Labeler", width: clamp(width * 0.13, 16, 24), minWidth: 16, align: "left" as const }] : []),
      ...(wide ? [
        { id: "role" as const, label: "Role", width: 11, align: "left" as const },
        { id: "reactions" as const, label: "Reactions", width: 16, align: "left" as const, flexGrow: 1 },
      ] : []),
      { id: "outcome", label: "Outcome", width: 11, align: "left" },
    ];
  }
  if (dataset === "device") {
    return [
      date,
      { id: "product", label: "Device", width: clamp(width * 0.22, 18, 34), minWidth: 18, align: "left", ...(roomy ? {} : { flexGrow: 1 }) },
      ...(wide ? [{ id: "manufacturer" as const, label: "Manufacturer", width: clamp(width * 0.16, 16, 26), minWidth: 16, align: "left" as const }] : []),
      { id: "event", label: "Event", width: 11, align: "left" },
      ...(roomy ? [{ id: "problems" as const, label: "Device problems", width: 20, align: "left" as const, flexGrow: 1 }] : []),
    ];
  }
  return [
    date,
    { id: "firm", label: "Firm", width: clamp(width * 0.18, 16, 28), minWidth: 16, align: "left", ...(wide ? {} : { flexGrow: 1 }) },
    { id: "class", label: "Class", width: 9, align: "left" },
    ...(wide ? [{ id: "status" as const, label: "Status", width: 10, align: "left" as const }] : []),
    ...(width >= 120 ? [{ id: "reason" as const, label: "Reason", width: clamp(width * 0.24, 24, 48), minWidth: 24, align: "left" as const }] : []),
    ...(wide ? [{ id: "product" as const, label: "Product", width: 20, align: "left" as const, flexGrow: 1 }] : []),
  ];
}

/**
 * How bad a record is, in the tone every research pane gives it: a death and
 * a Class I recall red, a serious report, an injury and a recall still under
 * way amber, the rest quiet. A drug the patient only happened to take beside
 * the suspect one is quiet too. The words stay, so the colour is never the
 * only signal.
 */
const TONES: Partial<Record<ColumnId, Record<string, StateTone>>> = {
  outcome: { Death: "negative", Serious: "warning", "Not serious": "muted" },
  role: { Suspect: "text", Interacting: "text", Concomitant: "muted" },
  event: { Death: "negative", Injury: "warning", Malfunction: "text", Other: "muted" },
  class: { "Class I": "negative", "Class II": "warning", "Class III": "text" },
  status: { Ongoing: "warning", Completed: "text", Terminated: "muted" },
};

export function recordTone(column: ColumnId, text: string): StateTone {
  return TONES[column]?.[text] ?? "text";
}

// --- Filters ---------------------------------------------------------------

export type FilterKey = "outcome" | "role" | "event" | "recallClass" | "status" | "range";
export type FilterState = Partial<Record<FilterKey, string>>;

export const FILTER_DEFAULT = "all";

const FILTER_LABELS: Record<FilterKey, string> = {
  outcome: "Outcome",
  role: "Role",
  event: "Event",
  recallClass: "Class",
  status: "Status",
  range: "Range",
};

const FILTER_OPTIONS: Record<FilterKey, ReadonlyArray<{ value: string; label: string }>> = {
  outcome: [
    { value: "all", label: "All" },
    { value: "death", label: "Death" },
    { value: "serious", label: "Serious" },
    { value: "not_serious", label: "Not serious" },
  ],
  role: [
    { value: "all", label: "All" },
    { value: "suspect", label: "Suspect" },
    { value: "concomitant", label: "Concomitant" },
    { value: "interacting", label: "Interacting" },
  ],
  event: [
    { value: "all", label: "All" },
    { value: "death", label: "Death" },
    { value: "injury", label: "Injury" },
    { value: "malfunction", label: "Malfunction" },
  ],
  recallClass: [
    { value: "all", label: "All" },
    { value: "1", label: "Class I" },
    { value: "2", label: "Class II" },
    { value: "3", label: "Class III" },
  ],
  status: [
    { value: "all", label: "All" },
    { value: "ongoing", label: "Ongoing" },
    { value: "completed", label: "Completed" },
    { value: "terminated", label: "Terminated" },
  ],
  range: [
    { value: "all", label: "Any date" },
    { value: "90", label: "90D" },
    { value: "365", label: "1Y" },
    { value: "1825", label: "5Y" },
  ],
};

/** The filters each dataset offers, in the order the query bar shows them. */
const DATASET_FILTERS: Record<OpenFdaDataset, FilterKey[]> = {
  drug: ["outcome", "role", "range"],
  device: ["event", "range"],
  recall: ["recallClass", "status", "range"],
};

const optionValue = (key: FilterKey, value: string | undefined): string =>
  FILTER_OPTIONS[key].some((option) => option.value === value) ? value! : FILTER_DEFAULT;

export function filterOptions(dataset: OpenFdaDataset, state: FilterState) {
  return DATASET_FILTERS[dataset].map((key) => ({
    key,
    label: FILTER_LABELS[key],
    value: optionValue(key, state[key]),
    options: FILTER_OPTIONS[key],
  }));
}

/** `YYYY-MM-DD`, `days` before `now`. */
function sinceDate(days: number, now: Date): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
}

/** What one dataset's request narrows by, from the pane's stored choices. */
export function activeFilters(dataset: OpenFdaDataset, state: FilterState, now: Date): OpenFdaFilters {
  const value = (key: FilterKey) => (DATASET_FILTERS[dataset].includes(key) ? optionValue(key, state[key]) : FILTER_DEFAULT);
  const range = value("range");
  return {
    outcome: value("outcome") as OpenFdaFilters["outcome"],
    role: value("role") as OpenFdaFilters["role"],
    event: value("event") as OpenFdaFilters["event"],
    recallClass: value("recallClass") as OpenFdaFilters["recallClass"],
    status: value("status") as OpenFdaFilters["status"],
    ...(range === FILTER_DEFAULT ? {} : { since: sinceDate(Number(range), now) }),
  };
}
