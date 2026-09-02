import { useEffect, useMemo, useRef } from "react";
import { Button, EmptyState, Spinner } from "../../../components";
import { openUrl } from "../../../components/ui/external-link";
import { colors } from "../../../theme/colors";
import {
  Box,
  ScrollBox,
  StyledText,
  Text,
  TextAttributes,
  useUiCapabilities,
  type ScrollBoxRenderable,
} from "../../../ui";
import { wrapTextLines } from "../../../utils/text-wrap";
import type {
  CloudSearchDocType,
  CloudSearchDocument,
  CloudSearchDocumentChunk,
  CloudSearchHit,
} from "../../../api-client";
import { chunkAttribution, documentBodyWidth } from "./model";
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

const WRAPPED_BODY_STYLE = { display: "block" };

function segmentsToStyledText(segments: readonly SnippetSegment[], color: string): StyledText {
  return new StyledText(segments.map((segment) => ({
    text: segment.text,
    fg: segment.marked ? colors.warning : color,
    attributes: segment.marked ? TextAttributes.BOLD : TextAttributes.NONE,
  })));
}

function AttributionText({ text, active }: { text: string; active: boolean }) {
  return (
    <Text
      fg={active ? colors.textBright : colors.textDim}
      attributes={TextAttributes.BOLD}
    >
      {text}
    </Text>
  );
}

/**
 * One chunk as a single paragraph the host wraps for itself. The desktop lays
 * boxes out on the cell grid but draws glyphs on a narrower advance, so a line
 * pre-wrapped to a cell count stops roughly a tenth of the pane short of the
 * right edge there. Only the terminal, whose cell is the glyph, can pre-wrap.
 */
function DocumentChunkView({
  chunk,
  docType,
  terms,
  active,
}: {
  chunk: CloudSearchDocumentChunk;
  docType: CloudSearchDocType;
  terms: readonly string[];
  active: boolean;
}) {
  const attribution = chunkAttribution(docType, chunk.metadata);
  const body = chunk.body ?? "";
  const color = active ? colors.textBright : colors.text;
  const highlighted = active && terms.length > 0;

  return (
    <Box
      flexDirection="column"
      width="100%"
      paddingBottom={1}
      backgroundColor={active ? colors.panel : undefined}
    >
      {attribution ? <AttributionText text={attribution} active={active} /> : null}
      {highlighted ? (
        <Text
          wrapText
          width="100%"
          style={WRAPPED_BODY_STYLE}
          content={segmentsToStyledText(highlightTerms(body, terms), color)}
        />
      ) : (
        <Text fg={color} wrapText width="100%" style={WRAPPED_BODY_STYLE}>{body}</Text>
      )}
    </Box>
  );
}

function DocumentLineView({ line }: { line: DocumentLine }) {
  const background = line.active ? colors.panel : undefined;
  if (line.kind === "attribution") {
    return (
      <Box height={1} backgroundColor={background}>
        <AttributionText text={line.text} active={line.active} />
      </Box>
    );
  }
  if (line.segments) {
    return (
      <SnippetText
        segments={line.segments}
        color={colors.textBright}
        backgroundColor={background}
      />
    );
  }
  return (
    <Box height={1} backgroundColor={background}>
      <Text fg={line.active ? colors.textBright : colors.text}>{line.text}</Text>
    </Box>
  );
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
  const { nativePaneChrome } = useUiCapabilities();
  const bodyWidth = documentBodyWidth(width);
  const terms = useMemo(() => snippetMatchTerms(hit.snippet), [hit.snippet]);
  const layout = useMemo(
    () => (document ? buildLayout(document, hit, bodyWidth) : null),
    [bodyWidth, document, hit],
  );

  // Land the reader on the chunk that matched, with a little context above it.
  // The host wraps the same text into its own number of lines, so aim by the
  // share of the document above the match rather than by the counted line.
  useEffect(() => {
    const scrollBox = scrollRef.current;
    if (!scrollBox || layout?.matchLine == null) return;
    const target = nativePaneChrome && layout.lines.length > 0
      ? Math.round((layout.matchLine / layout.lines.length) * scrollBox.scrollHeight)
      : layout.matchLine;
    scrollBox.scrollTo(Math.max(0, target - 2));
  }, [layout, nativePaneChrome]);

  if (loading && !document) {
    return (
      <Box flexGrow={1} alignItems="center" justifyContent="center">
        <Spinner label="Loading document..." />
      </Box>
    );
  }
  if (error && !document) {
    // A news hit names a story that is public at its source, so a server that
    // will not hand over the indexed copy is not a dead end: the whole point of
    // opening one is to read it, and the original always can be.
    if (hit.url) {
      return (
        <Box flexDirection="column" paddingX={1}>
          <EmptyState
            title="Could not load the indexed copy."
            message={error}
          />
          <Box flexDirection="row" marginTop={1}>
            <Button
              label="Open original"
              variant="secondary"
              onPress={() => openUrl(hit.url)}
            />
          </Box>
        </Box>
      );
    }
    return <EmptyState title="Could not load this document." message={error} />;
  }
  if (!document || !layout) return null;

  return (
    // Only the left inset lives here: the scrollbar already holds the column on
    // the right, and padding on both sides would push the text under it.
    <ScrollBox ref={scrollRef} scrollY flexGrow={1} paddingLeft={1}>
      <Box flexDirection="column" width={nativePaneChrome ? "100%" : bodyWidth}>
        {nativePaneChrome
          ? document.chunks.map((chunk) => (
            <DocumentChunkView
              key={chunk.id}
              chunk={chunk}
              docType={document.docType}
              terms={terms}
              active={chunk.chunkIndex === hit.chunkIndex}
            />
          ))
          : layout.lines.map((line) => <DocumentLineView key={line.key} line={line} />)}
      </Box>
    </ScrollBox>
  );
}
