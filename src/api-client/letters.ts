/**
 * Public fund and investor letters: a link-only list of each letter's title,
 * who wrote it, when, what kind it is and where its publisher keeps it. The
 * route is anonymous; the Letters code of Topic News parses the answer before
 * drawing anything.
 */
export type LetterKind = "shareholder_letter" | "memo" | "commentary" | "annual_report";

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
  /** The publication day, `YYYY-MM-DD`. */
  date: string;
  /** The publisher's own page or file. */
  url: string;
}

export interface LettersPayload {
  items: Letter[];
  hasMore: boolean;
  limit: number;
  offset: number;
}
