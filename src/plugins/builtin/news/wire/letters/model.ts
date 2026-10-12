import type { DataTableColumn, SelectButtonOption } from "../../../../../components";
import type { Letter, LetterKind } from "../../../../../api-client/letters";

export const LETTER_KIND_LABELS: Record<LetterKind, string> = {
  shareholder_letter: "Letter",
  memo: "Memo",
  commentary: "Commentary",
  annual_report: "Annual report",
};

export const ALL_KINDS = "all";

export const LETTER_KIND_OPTIONS: SelectButtonOption[] = [
  { value: ALL_KINDS, label: "All" },
  ...(Object.entries(LETTER_KIND_LABELS) as [LetterKind, string][]).map(([value, label]) => ({ value, label })),
];

/** The kind a saved filter names, or null for all of them (also for a value an older build saved). */
export function letterKindFilter(value: string): LetterKind | null {
  return value in LETTER_KIND_LABELS ? value as LetterKind : null;
}

type LetterColumnId = "date" | "entity" | "title" | "kind";
export type LetterColumn = DataTableColumn & { id: LetterColumnId };

/** The kind column goes first when the pane is narrow, then the entity. */
export function letterColumns(width: number): LetterColumn[] {
  return [
    { id: "date", label: "Date", width: 10, align: "left" },
    ...(width >= 56 ? [{ id: "entity" as const, label: "From", width: 26, align: "left" as const }] : []),
    { id: "title", label: "Title", width: 20, align: "left", flexGrow: 1 },
    ...(width >= 90 ? [{ id: "kind" as const, label: "Kind", width: 13, align: "left" as const }] : []),
  ];
}

export const letterKindLabel = (letter: Letter): string => LETTER_KIND_LABELS[letter.kind];
