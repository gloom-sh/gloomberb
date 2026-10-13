import { forwardRef, useMemo } from "react";
import { t } from "../../i18n";
import { hoverBg } from "../../theme/colors";
import { useThemeColors } from "../../theme/theme-context";
import { Box, Text, useUiCapabilities, type ScrollBoxRenderable } from "../../ui";
import { wrapTextLines } from "../../utils/text-wrap";
import { MarkdownText } from "../markdown-text";
import { DetailScrollBody } from "../ui/detail-scroll-body";
import { KeyValueRow } from "../ui/display";
import { ExternalLink, usePaneLinkMenuEntry } from "../ui/external-link";
import { parseArticle } from "./article-text";
import { DESKTOP_LINE_HEIGHT, READER_APP_FONT, READER_COLUMN_FONT, READER_HEADING_STYLE, ReaderBlock, ReaderText, type ReaderGeometry } from "./reader-text";

export interface DetailFact {
  label: string;
  value: string;
  /** A domain colour for the value, such as a status in its tone; the words carry the meaning. */
  color?: string;
  /**
   * Opens what the value names (a security's DES): a click on it, and inside a
   * `PaneLinkMenu` an entry in the pane menu, so the keyboard reaches it too.
   */
  link?: { label: string; onOpen: () => void };
}

export interface DetailReaderProps {
  /** Brings the body back to the top when it changes; pass the open item's id. */
  resetScrollKey?: unknown;
  /** The pane's width in cells: where the terminal wraps. The desktop and the web wrap at the pane's own width. */
  width: number;
  /** Short lines above the text, such as a date or an id and a status. */
  meta?: readonly string[];
  /**
   * The item's facts as label and value pairs, laid out as a block on the
   * desktop and the web. The terminal keeps its compact `meta` lines; with no
   * `meta`, it lists the facts one to a line, labels aligned.
   */
  facts?: readonly DetailFact[];
  body?: string | null;
  /** `markdown` reads headings, lists and inline styles; `text` is the words as written, in paragraphs. */
  bodyFormat?: "text" | "markdown";
  /** After the text, dimmer; a line that is a URL becomes a link. */
  note?: string | null;
}

const DESKTOP_GEOMETRY: ReaderGeometry = { desktop: true, measure: 0, margin: 0 };
/** A paragraph's air on the desktop, the same after a text paragraph and a markdown one. */
const PARAGRAPH_GAP = "0.9em";
const URL_LINE = /^https?:\/\/\S+$/;

const COLUMN_STYLE = { fontSize: READER_COLUMN_FONT, lineHeight: DESKTOP_LINE_HEIGHT } as const;
const META_STYLE = { marginBottom: "0.8em" } as const;
/**
 * At the app's own size, as metadata is in every reader. Its columns come from
 * styles.css: one pair to a row, or two in a wide reader.
 */
const FACTS_STYLE = {
  display: "grid",
  columnGap: "2em",
  rowGap: "0.3em",
  fontSize: READER_APP_FONT,
  lineHeight: 1.5,
  marginBottom: "1.6em",
} as const;
const FACT_TEXT_STYLE = { display: "block", lineHeight: "inherit", minWidth: 0 } as const;
/** Markdown lines take the reader's line height (the host sets Text line height from --cell-h). */
const MARKDOWN_STYLE = { "--cell-h": `${DESKTOP_LINE_HEIGHT}em` } as const;
const NOTE_STYLE = { marginTop: "0.4em", fontSize: READER_APP_FONT, lineHeight: "normal" } as const;

/**
 * The open item of a list pane: a few lines of metadata, its facts, then its
 * text, scrolling between the stack header and the pane footer. The desktop
 * and the web set it in the reader's type across the pane's whole width,
 * wrapped by the browser; the terminal draws it pre-wrapped at `width`.
 */
export const DetailReader = forwardRef<ScrollBoxRenderable, DetailReaderProps>(function DetailReader(
  { resetScrollKey, width, meta = [], facts = [], body, bodyFormat = "text", note },
  ref,
) {
  const { nativePaneChrome } = useUiCapabilities();
  return (
    <DetailScrollBody ref={ref} resetScrollKey={resetScrollKey}>
      {nativePaneChrome
        ? <NativeDetail meta={meta} facts={facts} body={body} bodyFormat={bodyFormat} note={note} />
        : <TerminalDetail width={width} meta={meta} facts={facts} body={body} bodyFormat={bodyFormat} note={note} />}
    </DetailScrollBody>
  );
});

interface DetailContentProps {
  meta: readonly string[];
  facts: readonly DetailFact[];
  body?: string | null;
  bodyFormat: "text" | "markdown";
  note?: string | null;
}

function NativeDetail({ meta, facts, body, bodyFormat, note }: DetailContentProps) {
  const colors = useThemeColors();
  const blocks = useMemo(
    () => (bodyFormat === "text" && body?.trim() ? parseArticle([{ text: body }]) : []),
    [body, bodyFormat],
  );
  const noteLines = note?.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) ?? [];
  return (
    <Box flexDirection="column" width="100%" data-gloom-ui="detail-reader">
      <Box flexDirection="column" width="100%" data-gloom-ui="reader-column" style={COLUMN_STYLE}>
        {facts.length > 0 ? (
          <Box data-gloom-ui="detail-facts" style={FACTS_STYLE}>
            {facts.flatMap((fact, index) => [
              <Text key={`label-${index}`} fg={colors.textDim} style={FACT_TEXT_STYLE}>{t(fact.label)}</Text>,
              <FactValue key={`value-${index}`} fact={fact} />,
            ])}
          </Box>
        ) : meta.length > 0 ? (
          <Box flexDirection="column" style={META_STYLE}>
            {meta.map((line, index) => (
              <ReaderText key={index} text={line} geometry={DESKTOP_GEOMETRY} color={colors.textDim} variant="meta" />
            ))}
          </Box>
        ) : null}
        {bodyFormat === "markdown" && body ? (
          <Box flexDirection="column" width="100%" style={MARKDOWN_STYLE}>
            <MarkdownText text={body} paragraphGap={PARAGRAPH_GAP} headingStyle={READER_HEADING_STYLE} />
          </Box>
        ) : blocks.map((block, index) => (
          <Box key={index} flexDirection="column">
            <ReaderBlock block={block} geometry={DESKTOP_GEOMETRY} />
          </Box>
        ))}
        {noteLines.length > 0 ? (
          <Box flexDirection="column" style={NOTE_STYLE}>
            {noteLines.map((line, index) => (URL_LINE.test(line)
              ? <ExternalLink key={index} url={line} />
              : <Text key={index} fg={colors.textDim} wrapText width="100%" style={FACT_TEXT_STYLE}>{line}</Text>))}
          </Box>
        ) : null}
      </Box>
    </Box>
  );
}

function FactValue({ fact }: { fact: DetailFact }) {
  const colors = useThemeColors();
  const { link } = fact;
  usePaneLinkMenuEntry(link ? `detail-fact:${fact.label}:${fact.value}` : null, link?.label ?? "", () => link?.onOpen());
  const target = link ? {
    cursor: "pointer" as const,
    hoverBackgroundColor: hoverBg(colors),
    onMouseDown: (event?: { button?: number }) => { if ((event?.button ?? 0) === 0) link.onOpen(); },
    "data-gloom-interactive": "true",
    "data-gloom-label": link.label,
  } : {};
  return (
    <Box minWidth={0} {...target}>
      <Text fg={fact.color ?? colors.text} wrapText style={FACT_TEXT_STYLE}>{fact.value}</Text>
    </Box>
  );
}

function TerminalDetail({ width, meta, facts, body, bodyFormat, note }: DetailContentProps & { width: number }) {
  const colors = useThemeColors();
  const lineWidth = Math.max(width - 2, 12);
  const metaLines = meta.length > 0 ? meta : facts.map((fact) => `${t(fact.label)}: ${fact.value}`);
  if (bodyFormat === "markdown") {
    // Markdown carries its own blank lines.
    return (
      <Box flexDirection="column" width={lineWidth}>
        {metaLines.map((line, index) => <Text key={index} fg={colors.textMuted}>{line}</Text>)}
        <MarkdownText text={body ?? ""} lineWidth={lineWidth} />
      </Box>
    );
  }
  // Facts without meta lines read as aligned label and value rows, keeping their colour and link.
  const labelWidth = Math.max(0, ...facts.map((fact) => t(fact.label).length)) + 1;
  return (
    <Box flexDirection="column">
      {meta.length === 0 && facts.length > 0
        ? facts.map((fact, index) => (
          <KeyValueRow key={`fact-${index}`} label={fact.label} value={fact.value} color={fact.color} link={fact.link} width={lineWidth} labelWidth={labelWidth} />
        ))
        : metaLines
          .flatMap((entry) => wrapTextLines(entry, lineWidth, 2))
          .map((line, index) => (
            <Box key={`meta-${index}`} height={1}>
              <Text fg={colors.textMuted}>{line}</Text>
            </Box>
          ))}

      <Box height={1} />

      {wrapTextLines(body ?? "", lineWidth).map((line, index) => (
        <Box key={`body-${index}`} height={1}>
          <Text fg={colors.text}>{line}</Text>
        </Box>
      ))}

      {note ? (
        <>
          <Box height={1} />
          {wrapTextLines(note, lineWidth).map((line, index) =>
            URL_LINE.test(line.trim()) ? (
              <ExternalLink key={`note-${index}`} url={line.trim()} />
            ) : (
              <Box key={`note-${index}`} height={1}>
                <Text fg={colors.textDim}>{line}</Text>
              </Box>
            ))}
        </>
      ) : null}
    </Box>
  );
}
