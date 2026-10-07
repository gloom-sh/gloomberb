export const COMMENT_LETTERS_PLUGIN_ID = "comment-letters";
export const COMMENT_LETTERS_PANE_ID = "comment-letters";

/** UPLOAD is a letter SEC staff wrote; CORRESP is one the company sent. */
type CommentLetterAuthor = "staff" | "company";

/** One SEC comment-letter filing: a staff letter or a company's correspondence. */
export interface CommentLetter {
  /** The accession number: one filing, however many documents it holds. */
  id: string;
  accessionNumber: string;
  form: string;
  author: CommentLetterAuthor;
  companyName?: string;
  /** Every ticker EDGAR lists for the filer, first one first. */
  tickers: string[];
  /** Ten-digit, zero-padded. */
  cik: string;
  filingDate: Date;
  filingUrl: string;
  primaryDocument?: string;
  primaryDocumentUrl?: string;
}

/** A company a ticker names, as EDGAR resolves it. */
export interface CommentLetterIssuer {
  cik: string;
  ticker: string;
  name: string;
}

/**
 * One page of letters. `issuer` is set when the search was a ticker and the
 * page lists that company's letters. `windowLimited` says the search matched
 * more letters than the full-text search lets anyone page through.
 */
export interface CommentLetterPage {
  rows: CommentLetter[];
  hasMore: boolean;
  nextOffset: number | null;
  issuer: CommentLetterIssuer | null;
  windowLimited: boolean;
}
