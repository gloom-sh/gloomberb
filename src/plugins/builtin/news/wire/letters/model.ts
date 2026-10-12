import type { DataTableColumn, SelectButtonOption } from "../../../../../components";
import type { Letter, LetterDateBasis, LetterKind } from "../../../../../api-client/letters";

export const LETTER_KIND_LABELS: Record<LetterKind, string> = {
  shareholder_letter: "Letter",
  memo: "Memo",
  commentary: "Commentary",
  annual_report: "Annual report",
};

/**
 * What the Kind filter can show. The default leaves out the annual reports,
 * which EDGAR sends by the dozen in proxy season and would bury the letters;
 * they are one choice away, as is each kind on its own and everything.
 * `kinds: null` asks for every kind.
 */
export const LETTER_KIND_VIEWS = {
  no_annual_reports: { label: "All but annual reports", kinds: ["shareholder_letter", "memo", "commentary"] },
  shareholder_letter: { label: "Shareholder letters", kinds: ["shareholder_letter"] },
  memo: { label: "Memos", kinds: ["memo"] },
  commentary: { label: "Commentary", kinds: ["commentary"] },
  annual_report: { label: "Annual reports", kinds: ["annual_report"] },
  everything: { label: "Everything", kinds: null },
} as const satisfies Record<string, { label: string; kinds: readonly LetterKind[] | null }>;
export type LetterKindView = keyof typeof LETTER_KIND_VIEWS;
export const DEFAULT_KIND_VIEW: LetterKindView = "no_annual_reports";

export const LETTER_KIND_OPTIONS: SelectButtonOption[] = (
  Object.entries(LETTER_KIND_VIEWS) as [LetterKindView, { label: string }][]
).map(([value, view]) => ({ value, label: view.label }));

/** What each date is. A file's last change is not when the letter came out. */
export const DATE_BASIS_LABELS: Record<LetterDateBasis, string> = {
  published: "Published",
  filed: "Filed",
  file_modified: "File updated",
};

/** Own keys only: `constructor` or `__proto__` name nothing here. */
export const isOwnKey = <T extends object>(record: T, key: unknown): key is keyof T =>
  typeof key === "string" && Object.prototype.hasOwnProperty.call(record, key);

/**
 * The view a saved filter names. Anything else, including an older build's
 * "all" or an inherited name such as `constructor`, is the default view.
 */
export function letterKindView(value: unknown): LetterKindView {
  return isOwnKey(LETTER_KIND_VIEWS, value) ? value : DEFAULT_KIND_VIEW;
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
