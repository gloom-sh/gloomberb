export type CloudSearchDocType = "transcript" | "news" | "filing";

export type CloudSearchSort = "relevance" | "newest" | "oldest";

/**
 * Per-chunk provenance. Which keys are present depends on `docType`: transcripts
 * carry speaker attribution, news carries the wire source, filings carry the
 * form and section. Kept as one optional-key record so an unknown docType from a
 * newer server still renders instead of failing to parse.
 */
export interface CloudSearchChunkMetadata {
  speaker?: string;
  role?: string;
  /** A call speaker's company; on a filing hit, the filer as EDGAR names it. */
  company?: string;
  isQa?: boolean;
  startSeconds?: number;
  turnIndex?: number;
  source?: string;
  summary?: string;
  form?: string;
  accession?: string;
  section?: string;
  /** On a filing hit, the day EDGAR dated it (YYYY-MM-DD); `publishedAt` is the acceptance instant. */
  filingDate?: string;
}

export interface CloudSearchHit {
  id: string;
  docType: CloudSearchDocType;
  sourceId: string;
  chunkIndex: number;
  ticker: string;
  publishedAt: string;
  title: string;
  url: string;
  /** Matched terms wrapped in `<mark>`, fragments joined by an ellipsis. */
  snippet: string;
  score: number;
  metadata: CloudSearchChunkMetadata;
  /**
   * Chunks of this document that matched. Only sent for a distinct search,
   * where the row stands for the document rather than for one chunk.
   */
  matchCount?: number;
}

export interface CloudSearchResponse {
  hits: CloudSearchHit[];
  total: number;
  /** The server stopped counting past its cap, so `total` is a lower bound. */
  countCapped: boolean;
  hasMore: boolean;
  nextOffset: number;
  tookMs: number;
}

interface CloudSearchDocumentChunk {
  id: string;
  chunkIndex: number;
  body: string;
  metadata: CloudSearchChunkMetadata;
}

export interface CloudSearchDocument {
  docType: CloudSearchDocType;
  sourceId: string;
  ticker: string;
  title: string;
  url: string;
  publishedAt: string;
  chunks: CloudSearchDocumentChunk[];
}

export interface CloudSearchDocumentResponse {
  document: CloudSearchDocument;
}

export interface CloudSavedSearchFilters {
  tickers?: string[];
  docTypes?: CloudSearchDocType[];
  sources?: string[];
  from?: string;
  to?: string;
}

export interface CloudSavedSearch {
  id: string;
  name: string;
  query: string;
  filters: CloudSavedSearchFilters;
  alertEnabled: boolean;
  alertChannels: string[];
  lastRunAt: string | null;
  lastMatchAt: string | null;
  matchCount: number;
  createdAt: string;
}

export interface CloudSavedSearchListResponse {
  searches: CloudSavedSearch[];
}

export interface CloudSavedSearchInput {
  name: string;
  query: string;
  filters?: CloudSavedSearchFilters;
  alertEnabled?: boolean;
  alertChannels?: string[];
}
