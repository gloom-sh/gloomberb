import type { CompanyFrom } from "../../types/company-from";

export interface CloudEarningsCallPayload {
  id: string;
  ticker: string;
  companyName: string | null;
  fiscalYear: number | null;
  fiscalQuarter: number | null;
  callAt: string | null;
  status: string;
  durationSeconds: number | null;
  wordCount: number | null;
  hasTranscript: boolean;
  sentiment: number | null;
  /** The replay or event page the transcript came from. */
  webcastUrl?: string | null;
  /**
   * Whether `callAt` is the call's start or its day alone (00:00 UTC of that
   * New York day). Absent from a server that predates it.
   */
  callTimeKnown?: boolean;
  /**
   * "other" for an event that is not an earnings call (a deal call, a
   * conference, an investor day), named by eventLabel and with no fiscal
   * period; null when unclear. Older servers omit both.
   */
  eventKind?: "earnings" | "other" | null;
  eventLabel?: string | null;
}

export interface CloudEarningsCallListPayload {
  calls: CloudEarningsCallPayload[];
  /** Set when asking about a company started a search that is still running. */
  pending?: boolean;
  /** Set when the requested symbol is not one the SEC knows. */
  unknownTicker?: boolean;
  /** The company's home line the calls are read from, when not the listing asked (a receipt, a foreign line). */
  companyFrom?: CompanyFrom;
}

/** One row of a proxy statement's Summary Compensation Table, in dollars. */
export interface CloudExecutiveRowPayload {
  name: string;
  title: string;
  salary: number | null;
  bonus: number | null;
  stockAwards: number | null;
  optionAwards: number | null;
  nonEquityIncentive: number | null;
  pensionAndDeferred: number | null;
  allOther: number | null;
  total: number | null;
}

interface CloudProxyStatementSummaryPayload {
  id: string;
  ticker: string;
  company: {
    ticker: string;
    cik: string | null;
    name: string;
    shortName: string;
  };
  /** Year of the filing date: what people call "the 2026 proxy". */
  proxyYear: number;
  fiscalYear: number | null;
  fiscalYearLabel: string | null;
  filedAt: string;
  meetingDate: string | null;
  updatedAt: string;
  ceoName: string | null;
  ceoTitle: string | null;
  ceoTotal: number | null;
  ceoPriorYearTotal: number | null;
  payRatio: number | null;
  medianEmployeePay: number | null;
}

export interface CloudProxyStatementPayload extends CloudProxyStatementSummaryPayload {
  /**
   * `preview` for an account without Pro: each executive's total pay from
   * the latest proxy, with the breakdown, the year before, the pay ratio,
   * say-on-pay, highlights, key figures and other years null or empty.
   * Absent on Pro's full statement.
   */
  access?: "preview";
  docUrl: string;
  ceo: (CloudExecutiveRowPayload & { priorYearTotal: number | null }) | null;
  namedExecutives: CloudExecutiveRowPayload[];
  sayOnPayPriorSupport: number | null;
  highlights: string | null;
  keyFigures: CloudTranscriptKeyFigurePayload[];
  otherYears: CloudProxyStatementSummaryPayload[];
}

interface CloudRiskFactorPayload {
  heading: string;
  group: string | null;
  excerpt: string;
  words: number;
}

export interface CloudRiskNotePayload {
  /** Position of the risk in `risks` (or in the prior year's list, for removed). */
  index: number;
  text: string;
}

interface CloudRiskReportSummaryPayload {
  id: string;
  ticker: string;
  company: {
    ticker: string;
    cik: string | null;
    name: string;
    shortName: string;
  };
  /** Year of the filing date: "the 2026 10-K". */
  reportYear: number;
  /** The SEC's acceptance instant, or midnight UTC of the filing day on older reports. */
  filedAt: string;
  /** The day EDGAR dated the 10-K (YYYY-MM-DD). Older servers leave it out. */
  filingDate?: string | null;
  updatedAt: string;
  riskCount: number;
  groupCount: number;
  wordCount: number;
  addedCount: number | null;
  removedCount: number | null;
  rewordedCount: number | null;
  overview: string | null;
  /**
   * The 10-K lists no risk factors (a smaller reporting company need not):
   * no risks, and `overview` says so. Older servers leave it out and send a
   * risk count of 0.
   */
  listsNoRiskFactors?: boolean;
}

export interface CloudRiskReportPayload extends CloudRiskReportSummaryPayload {
  docUrl: string;
  groups: string[];
  risks: CloudRiskFactorPayload[];
  diff: {
    added: number[];
    removed: Array<{ heading: string; group: string | null; excerpt: string }>;
    reworded: Array<{
      index: number;
      similarity: number;
      headingChanged: boolean;
      priorHeading: string | null;
    }>;
    matched: number;
    priorRiskCount: number;
  } | null;
  notes: {
    added: CloudRiskNotePayload[];
    removed: CloudRiskNotePayload[];
    reworded: CloudRiskNotePayload[];
    top: CloudRiskNotePayload[];
  };
  otherYears: CloudRiskReportSummaryPayload[];
}

export interface CloudRiskReportListPayload {
  company: {
    ticker: string;
    cik: string | null;
    name: string;
    shortName: string;
  } | null;
  reports: CloudRiskReportSummaryPayload[];
}

interface CloudFilingPersonPayload {
  name: string;
  role: string;
  action: string;
  effective: string | null;
}

/** An 8-K, classified by its items and, when it carried news, read. */
export interface CloudFilingEventPayload {
  id: string;
  ticker: string;
  company: {
    ticker: string;
    cik: string | null;
    name: string;
    shortName: string;
  };
  filedAt: string;
  /** Verified SEC filing calendar date; filedAt may instead be an acceptance instant. */
  filingDate?: string | null;
  /** "8-K", or "8-K/A" for an amendment. Older servers omit it. */
  form?: string;
  docUrl: string;
  items: string[];
  labels: string[];
  kinds: string[];
  material: boolean;
  headline: string | null;
  summary: string | null;
  people: CloudFilingPersonPayload[];
  /** True when the headline and points are the model's reading rather than the item labels. */
  read: boolean;
}

export interface CloudProxyStatementListPayload {
  company: {
    ticker: string;
    cik: string | null;
    name: string;
    shortName: string;
  };
  proxies: CloudProxyStatementSummaryPayload[];
  /** `preview` for an account without Pro: the latest proxy alone, without the year before or the pay ratio. */
  access?: "preview";
}

export interface CloudTranscriptTurnPayload {
  speaker: string;
  role?: string;
  company?: string;
  text: string;
  /** `text` cut where the speaker paused or changed topic; absent on older transcripts. */
  paragraphs?: string[];
  isQa: boolean;
  /** Offset into the recording; null when the company published the transcript as a document. */
  startSeconds: number | null;
  /** Where each of `paragraphs` starts in the recording, in seconds; absent without timings or on older servers. */
  paragraphStarts?: number[];
}

interface CloudTranscriptKeyFigurePayload {
  /** What the number is, e.g. "Q3 revenue guidance". */
  label: string;
  /** As management said it, e.g. "$108B ± 2%". */
  value: string;
  /** Comparison or qualifier, e.g. "vs $96B in Q2". */
  note?: string;
}

interface CloudTranscriptParticipantPayload {
  name: string;
  role?: string;
  company?: string;
}

export interface CloudEarningsTranscriptPayload {
  id: string;
  ticker: string;
  companyName: string | null;
  fiscalYear: number | null;
  fiscalQuarter: number | null;
  /**
   * "other" for an event that is not an earnings call (a deal call, a
   * conference, an investor day), named by eventLabel and with no fiscal
   * period; null when unclear. Older servers omit both.
   */
  eventKind?: "earnings" | "other" | null;
  eventLabel?: string | null;
  callAt: string | null;
  timing: string | null;
  webcastUrl: string | null;
  durationSeconds: number | null;
  status: string;
  fullText: string;
  turns: CloudTranscriptTurnPayload[];
  participants: CloudTranscriptParticipantPayload[];
  /** The numbers management gave, picked for a card; empty on older transcripts. */
  keyFigures?: CloudTranscriptKeyFigurePayload[];
  summary: string | null;
  guidance: string | null;
  riskFactors: string | null;
  analystFocus: string | null;
  notable: string | null;
  sentiment: number | null;
  sentimentRationale: string | null;
  qaStartTurn: number | null;
  wordCount: number | null;
  asrModel: string | null;
  updatedAt: string | null;
}

/**
 * A call's audio to play beside its transcript. `kind` names what it is; a
 * stored recording is the only kind so far.
 */
export interface CloudEarningsCallAudioPayload {
  kind: "recording";
  /** A signed address that plays until `expiresAt`, seeking included. */
  url: string;
  expiresAt: string;
  durationSeconds: number | null;
  bytes?: number;
  contentType?: string;
}

interface CloudSecFilingPayload {
  accessionNumber: string;
  form: string;
  filingDate: string;
  acceptedAt?: string;
  /** Unmodified SEC acceptanceDateTime; a missing timezone is not inferred. */
  acceptedAtRaw?: string;
  primaryDocument?: string;
  primaryDocDescription?: string;
  items?: string;
  /** SEC's period of report, YYYY-MM-DD: a 10-Q's or 10-K's balance-sheet date. Absent from older servers. */
  reportDate?: string;
  cik: string;
  companyName?: string;
  filingUrl: string;
  primaryDocumentUrl?: string;
  /** The filing's SEC file number for this company, empty when it has none. Absent from older servers. */
  fileNumber?: string;
  /** In a fund's list from a trust that runs several funds: filed for the fund's own series. Absent from older servers. */
  fundSeries?: boolean;
}

interface CloudSecDocumentPayload {
  sequence?: string;
  type: string;
  description?: string;
  document: string;
  url: string;
  size?: string;
  isPrimary: boolean;
}

export interface CloudSecFilingsResponse {
  filings: CloudSecFilingPayload[];
  hasMore: boolean;
  nextOffset: number;
  /** The company's home line the filings are read from, when not the listing asked (a foreign line). */
  companyFrom?: CompanyFrom;
}

export interface CloudSecDocumentsResponse {
  documents: CloudSecDocumentPayload[];
}

interface CloudSecForm4Payload {
  filingDate: string;
  reportedName: string;
  title: string;
  transactionType: "P" | "S" | "A" | "D" | "";
  shares: number;
  pricePerShare: number | null;
  totalValue: number | null;
  sharesOwned: number | null;
  form: string;
}

export interface CloudSecContentResponse {
  content: string | null;
  form4: CloudSecForm4Payload | null;
}
