import type { CloudSearchDocument, CloudSearchHit } from "../../../api-client";
import {
  articleGist,
  listedTickers,
  parseArticle,
  type ArticleBlock,
} from "../../../components/reader/article-text";
import { formatDetailDate } from "../../../utils/datetime-format";
import { chunkAttribution, hitTypeLabel } from "./model";

export interface SearchArticle {
  meta: string[];
  tickers: string[];
  lead: string | null;
  facts: string[];
  body: ArticleBlock[];
  rawText: string;
  /** The chunk the hit came from, as a section of the article; -1 when the document no longer has it. */
  matchSection: number;
  /** Where the reader opens: the match in a call or a filing, the top of a story. */
  revealSection: number | null;
}

function kindLabel(document: CloudSearchDocument, hit: CloudSearchHit): string | null {
  if (document.docType === "transcript") return "Earnings call";
  if (document.docType === "filing") return hitTypeLabel(hit);
  return null;
}

/**
 * A search document as the reader lays it out. A news story is cleaned of
 * page chrome and opens on its gist; a call keeps each speaker's turn under
 * their name and a filing each part under its section, both as written, and
 * both open where the search matched, as they always have.
 */
export function searchArticle(document: CloudSearchDocument, hit: CloudSearchHit): SearchArticle {
  const news = document.docType === "news";
  const source = news ? document.chunks.find((chunk) => chunk.metadata?.source?.trim())?.metadata.source?.trim() ?? "" : "";
  const blocks = parseArticle(
    document.chunks.map((chunk) => ({
      text: chunk.body ?? "",
      heading: news ? undefined : chunkAttribution(document.docType, chunk.metadata) || undefined,
    })),
    { title: document.title, source, clean: news },
  );
  const rawText = document.chunks.map((chunk) => chunk.body ?? "").join("\n\n");
  const gist = news
    ? articleGist(blocks, { summary: document.chunks[0]?.metadata?.summary })
    : { lead: null, facts: [], body: blocks };
  const matchSection = document.chunks.findIndex((chunk) => chunk.chunkIndex === hit.chunkIndex);
  const tickers = [
    document.ticker,
    ...(news ? listedTickers(rawText) : []),
  ].filter((symbol): symbol is string => !!symbol?.trim());
  return {
    meta: [source, formatDetailDate(document.publishedAt || hit.publishedAt, ""), kindLabel(document, hit) ?? ""],
    tickers: [...new Set(tickers)],
    lead: gist.lead,
    facts: gist.facts,
    body: gist.body,
    rawText,
    matchSection,
    revealSection: !news && matchSection > 0 ? matchSection : null,
  };
}
