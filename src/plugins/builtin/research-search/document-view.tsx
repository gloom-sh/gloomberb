import { useEffect, useMemo, useRef } from "react";
import { EmptyState, Spinner } from "../../../components";
import { colors } from "../../../theme/colors";
import { Box, ScrollBox, Text, TextAttributes, type ScrollBoxRenderable } from "../../../ui";
import { wrapTextLines } from "../../../utils/text-wrap";
import type { CloudSearchDocument, CloudSearchHit } from "../../../api-client";
import { chunkAttribution, docTypeLabel, formatHitDate } from "./model";
import { highlightTerms, snippetMatchTerms, type SnippetSegment } from "./snippet";
import { SnippetText } from "./snippet-text";

interface DocumentLine {
  key: string;
  kind: "attribution" | "body";
  text: string;
  segments?: SnippetSegment[];
  /** Part of the chunk the hit came from. */
  active: boolean;
}

interface DocumentLayout {
  lines: DocumentLine[];
  matchLine: number | null;
}

function buildLayout(
  document: CloudSearchDocument,
  hit: CloudSearchHit,
  width: number,
): DocumentLayout {
  const terms = snippetMatchTerms(hit.snippet);
  const lines: DocumentLine[] = [];
  let matchLine: number | null = null;

  for (const chunk of document.chunks) {
    const active = chunk.chunkIndex === hit.chunkIndex;
    if (active && matchLine === null) matchLine = lines.length;

    const attribution = chunkAttribution(document.docType, chunk.metadata);
    if (attribution) {
      lines.push({
        key: `${chunk.id}:attribution`,
        kind: "attribution",
        text: attribution,
        active,
      });
    }
    const bodyLines = wrapTextLines(chunk.body ?? "", width);
    for (const [index, line] of bodyLines.entries()) {
      lines.push({
        key: `${chunk.id}:${index}`,
        kind: "body",
        text: line,
        // Only the chunk that matched carries term highlights; marking every
        // occurrence in a long filing would leave nothing standing out.
        segments: active && terms.length > 0 ? highlightTerms(line, terms) : undefined,
        active,
      });
    }
    lines.push({ key: `${chunk.id}:gap`, kind: "body", text: "", active: false });
  }

  return { lines, matchLine };
}

export function SearchDocumentView({
  hit,
  document,
  loading,
  error,
  width,
}: {
  hit: CloudSearchHit;
  document: CloudSearchDocument | null;
  loading: boolean;
  error: string | null;
  width: number;
}) {
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const bodyWidth = Math.max(20, width - 2);
  const layout = useMemo(
    () => (document ? buildLayout(document, hit, bodyWidth) : null),
    [bodyWidth, document, hit],
  );

  // Land the reader on the chunk that matched, with a little context above it.
  useEffect(() => {
    if (layout?.matchLine == null) return;
    scrollRef.current?.scrollTo(Math.max(0, layout.matchLine - 2));
  }, [layout]);

  if (loading && !document) {
    return (
      <Box flexGrow={1} alignItems="center" justifyContent="center">
        <Spinner label="Loading document..." />
      </Box>
    );
  }
  if (error && !document) {
    return <EmptyState title="Could not load this document." message={error} />;
  }
  if (!document || !layout) return null;

  // The stack title already names the document, so the body opens on metadata.
  const meta = [
    document.ticker,
    formatHitDate(document.publishedAt),
    hit.docType === "filing" ? hit.metadata?.form?.trim() || docTypeLabel(document.docType) : docTypeLabel(document.docType),
    hit.metadata?.accession,
    `${document.chunks.length} sections`,
  ]
    .filter((part): part is string => !!part && part.length > 0)
    .join("  \u00b7  ");

  return (
    <ScrollBox ref={scrollRef} scrollY flexGrow={1} paddingX={1}>
      <Box flexDirection="column" width={bodyWidth}>
        <Box height={1}>
          <Text fg={colors.textMuted}>{meta}</Text>
        </Box>
        <Box height={1} />
        {layout.lines.map((line) => {
          const background = line.active ? colors.panel : undefined;
          if (line.kind === "attribution") {
            return (
              <Box key={line.key} height={1} backgroundColor={background}>
                <Text
                  fg={line.active ? colors.textBright : colors.textDim}
                  attributes={TextAttributes.BOLD}
                >
                  {line.text}
                </Text>
              </Box>
            );
          }
          if (line.segments) {
            return (
              <SnippetText
                key={line.key}
                segments={line.segments}
                color={colors.textBright}
                backgroundColor={background}
              />
            );
          }
          return (
            <Box key={line.key} height={1} backgroundColor={background}>
              <Text fg={line.active ? colors.textBright : colors.text}>{line.text}</Text>
            </Box>
          );
        })}
      </Box>
    </ScrollBox>
  );
}
