/**
 * Public fund and investor letters: a link-only list of each letter's title,
 * who wrote it, when, what kind it is and where its publisher keeps it. The
 * route is anonymous; the Letters code of Topic News parses the answer before
 * drawing anything.
 */
export type LetterKind = "shareholder_letter" | "memo" | "commentary" | "annual_report";

/**
 * What a letter's date is: the date its publisher states, its EDGAR filing
 * date, or the last change of its document file (for publishers whose pages
 * give no date), which is not a publication date.
 */
export type LetterDateBasis = "published" | "filed" | "file_modified";

export interface LettersParams {
  kind?: LetterKind;
  /** 1 to 200. */
  limit?: number;
  offset?: number;
}

export interface Letter {
  id: string;
  title: string;
  entity: string;
  kind: LetterKind;
  /** `YYYY-MM-DD`; `date_basis` says what it is. */
  date: string;
  date_basis: LetterDateBasis;
  /** The publisher's own page or file. */
  url: string;
}

export interface LettersPayload {
  items: Letter[];
  hasMore: boolean;
  limit: number;
  offset: number;
}
