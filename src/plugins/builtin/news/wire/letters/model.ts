import type { DataTableColumn, SelectButtonOption } from "../../../../../components";
import type { Letter, LetterDateBasis, LetterKind } from "../../../../../api-client/letters";

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

/** What each date is. A file's last change is not when the letter came out. */
export const DATE_BASIS_LABELS: Record<LetterDateBasis, string> = {
  published: "Published",
  filed: "Filed",
  file_modified: "File updated",
};

/** Own keys only: `constructor` or `__proto__` name nothing here. */
export const isOwnKey = <T extends object>(record: T, key: unknown): key is keyof T =>
  typeof key === "string" && Object.prototype.hasOwnProperty.call(record, key);

/** The kind a saved filter names, or null for all of them (also for a value an older build saved). */
export function letterKindFilter(value: string): LetterKind | null {
  return isOwnKey(LETTER_KIND_LABELS, value) ? value : null;
}

/** Below this width the table has no Date basis column and the footer names the selected row's. */
export const BASIS_COLUMN_MIN_WIDTH = 48;

type LetterColumnId = "date" | "basis" | "entity" | "title" | "kind";
export type LetterColumn = DataTableColumn & { id: LetterColumnId };

/** Narrow panes drop the kind first, then the entity, then the date basis (the footer then names it). */
export function letterColumns(width: number): LetterColumn[] {
  return [
    { id: "date", label: "Date", width: 10, align: "left" },
    ...(BASIS_COLUMN_MIN_WIDTH <= width ? [{ id: "basis" as const, label: "Date basis", width: 12, align: "left" as const }] : []),
    ...(width >= 66 ? [{ id: "entity" as const, label: "From", width: 26, align: "left" as const }] : []),
    { id: "title", label: "Title", width: 20, align: "left", flexGrow: 1 },
    ...(width >= 104 ? [{ id: "kind" as const, label: "Kind", width: 13, align: "left" as const }] : []),
  ];
}

export const letterKindLabel = (letter: Letter): string => LETTER_KIND_LABELS[letter.kind];
export const letterDateBasisLabel = (letter: Letter): string => DATE_BASIS_LABELS[letter.date_basis];
