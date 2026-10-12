import { useMemo } from "react";
import type { CloudSearchDocument, CloudSearchHit } from "../../../api-client";
import { Button, PaneStatusBody } from "../../../components";
import { ArticleReader } from "../../../components/reader/article-reader";
import { openUrl } from "../../../components/ui/external-link";
import { searchArticle } from "./article";
import { snippetMatchTerms } from "./snippet";

export function SearchDocumentView({
  hit,
  document,
  loading,
  error,
  width,
  height,
  focused = false,
  onNext,
  onPrevious,
}: {
  hit: CloudSearchHit;
  document: CloudSearchDocument | null;
  loading: boolean;
  error: string | null;
  width: number;
  height: number;
  focused?: boolean;
  /** The next or previous hit in the results, or null at either end. */
  onNext?: (() => void) | null;
  onPrevious?: (() => void) | null;
}) {
  const article = useMemo(() => (document ? searchArticle(document, hit) : null), [document, hit]);
  const terms = useMemo(() => snippetMatchTerms(hit.snippet), [hit.snippet]);

  if (loading && !document) {
    return (
      <PaneStatusBody loading align="center" loadingLabel="Loading document..." />
    );
  }
  if (error && !document) {
    // A news hit names a story that is public at its source, so a server that
    // will not hand over the indexed copy is not a dead end: the whole point of
    // opening one is to read it, and the original always can be.
    return (
      <PaneStatusBody
        error={error}
        errorTitle={hit.url ? "Could not load the indexed copy." : "Could not load this document."}
        actions={hit.url ? <Button label="Open original" variant="secondary" onPress={() => openUrl(hit.url)} /> : undefined}
      />
    );
  }
  if (!document || !article) return null;

  return (
    <ArticleReader
      articleKey={`${document.docType}:${document.sourceId}`}
      title={document.title || hit.title}
      meta={article.meta}
      tickers={article.tickers}
      lead={article.lead}
      facts={article.facts}
      body={article.body}
      rawText={article.rawText}
      // Only the section that matched carries the terms; marking every
      // occurrence in a long filing would leave nothing standing out.
      highlight={article.matchSection >= 0 && terms.length > 0 ? { section: article.matchSection, terms } : null}
      revealSection={article.revealSection}
      focused={focused}
      width={width}
      height={height}
      onNext={onNext}
      onPrevious={onPrevious}
    />
  );
}
