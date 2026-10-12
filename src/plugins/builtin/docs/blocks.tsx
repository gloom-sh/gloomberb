/**
 * Docs and lesson blocks drawn with the app's own components: markdown text
 * through `MarkdownText`, pictures through `RemoteImage` on the desktop and
 * the web, and nothing from the page run as code or HTML. The terminal shows
 * a picture's caption and a diagram's steps instead of the picture.
 */
import { useState } from "react";
import { ActionRow, MarkdownText, RemoteImage, usePaneLinkMenuEntry } from "../../../components";
import type { DocsBlock } from "../../../docs/content";
import { tf } from "../../../i18n";
import { isDarkTheme } from "../../../theme/themes";
import { useThemeColors, useThemeId } from "../../../theme/theme-context";
import { Box, Text, TextAttributes, useUiCapabilities } from "../../../ui";

/** A screenshot's height in cells for a given width: about 16:10 in 8 by 18 pixel cells. */
function pictureRows(width: number): number {
  return Math.max(6, Math.round(width * 0.28));
}

const CALLOUT_LABELS: Record<string, string> = {
  key: "Key idea",
  tip: "Tip",
  note: "Note",
  warning: "Watch out",
  example: "Example",
};

const LINK_PATTERN = /\[([^\]]+)\]\(([^)\s]+)\)/g;

/** Inline links of a block, for the pane menu: the terminal cannot press a word. */
function blockLinks(block: DocsBlock): Array<{ label: string; href: string }> {
  const texts = block.type === "paragraph" || block.type === "heading" ? [block.text]
    : block.type === "list" ? block.items
      : block.type === "table" ? block.rows.flat()
        : [];
  return texts.flatMap((text) => [...text.matchAll(LINK_PATTERN)].map((match) => ({ label: match[1] ?? "", href: match[2] ?? "" })));
}

function LinkMenuEntry({ label, href, onOpen }: { label: string; href: string; onOpen: (href: string) => void }) {
  usePaneLinkMenuEntry(`docs-link:${href}`, tf("Open {label}", { label: label.replace(/[*`]/g, "") }), () => onOpen(href));
  return null;
}

function escapeCell(cell: string): string {
  return cell.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/** A table as GFM, for `MarkdownText`, which lays it out or stacks it when narrow. */
function tableMarkdown(headers: string[], rows: string[][]): string {
  return [
    `| ${headers.map(escapeCell).join(" | ")} |`,
    `|${headers.map(() => "---").join("|")}|`,
    ...rows.map((row) => `| ${headers.map((_, index) => escapeCell(row[index] ?? "")).join(" | ")} |`),
  ].join("\n");
}

/** One item per row, wrapped lines hung under the text rather than the marker. */
function ListBlock({ items, ordered, start, width, onOpenLink }: {
  items: string[];
  ordered: boolean;
  start: number;
  width: number;
  onOpenLink?: (href: string) => void;
}) {
  const colors = useThemeColors();
  const markers = items.map((_, index) => (ordered ? `${start + index}.` : "•"));
  const markerWidth = Math.max(...markers.map((marker) => marker.length)) + 1;
  return (
    <Box flexDirection="column">
      {items.map((item, index) => (
        <Box key={index} flexDirection="row">
          <Box width={markerWidth} flexShrink={0}>
            <Text fg={colors.textDim}>{markers[index]}</Text>
          </Box>
          <MarkdownText text={item.replace(/\n/g, " ")} lineWidth={Math.max(8, width - markerWidth)} onOpenLink={onOpenLink} />
        </Box>
      ))}
    </Box>
  );
}

function DetailsBlock({ summary, blocks, width, onOpenLink }: {
  summary: string;
  blocks: DocsBlock[];
  width: number;
  onOpenLink: (href: string) => void;
}) {
  const [open, setOpen] = useState(false);
  usePaneLinkMenuEntry(`docs-details:${summary}`, open ? tf("Hide {label}", { label: summary }) : tf("Show {label}", { label: summary }), () => setOpen((value) => !value));
  return (
    <Box flexDirection="column">
      <ActionRow label={summary} expanded={open} onPress={() => setOpen((value) => !value)} width={width} />
      {open && (
        <Box flexDirection="column" paddingLeft={2} paddingTop={1}>
          <DocsBlocks blocks={blocks} width={Math.max(12, width - 2)} onOpenLink={onOpenLink} />
        </Box>
      )}
    </Box>
  );
}

function Picture({ src, alt, caption, width }: { src: string; alt: string; caption?: string; width: number }) {
  const colors = useThemeColors();
  const { nativePaneChrome } = useUiCapabilities();
  if (!nativePaneChrome) {
    return caption ? <Text fg={colors.textMuted} attributes={TextAttributes.ITALIC} wrapText width={width}>{caption}</Text> : null;
  }
  return (
    <Box flexDirection="column" gap={0}>
      <RemoteImage src={src} alt={alt || caption || "Screenshot"} width={width} height={pictureRows(width)} label={alt || "image"} />
      {caption ? <Text fg={colors.textMuted} wrapText width={width}>{caption}</Text> : null}
    </Box>
  );
}

function Block({ block, width, onOpenLink }: { block: DocsBlock; width: number; onOpenLink: (href: string) => void }) {
  const colors = useThemeColors();
  const themeId = useThemeId();
  const { nativePaneChrome } = useUiCapabilities();
  switch (block.type) {
    case "paragraph":
      return <MarkdownText text={block.text.replace(/\n/g, " ")} lineWidth={width} onOpenLink={onOpenLink} />;
    case "heading":
      // A section reads bright; a step inside it, in the text colour.
      return (
        <Text fg={block.level === 2 ? colors.textBright : colors.text} attributes={TextAttributes.BOLD} wrapText width={width}>
          {block.text.replace(/[*`]/g, "")}
        </Text>
      );
    case "list":
      return <ListBlock items={block.items} ordered={block.ordered === true} start={block.start ?? 1} width={width} onOpenLink={onOpenLink} />;
    case "table":
      return <MarkdownText text={tableMarkdown(block.headers, block.rows)} lineWidth={width} onOpenLink={onOpenLink} />;
    case "code":
      return (
        <Box flexDirection="column" paddingLeft={2}>
          {block.code.split("\n").map((line, index) => (
            <Text key={index} fg={colors.textBright} selectable>{line || " "}</Text>
          ))}
        </Box>
      );
    case "image":
      return <Picture src={block.src} alt={block.alt} caption={block.caption} width={width} />;
    case "diagram":
      if (nativePaneChrome) {
        return <Picture src={isDarkTheme(themeId) ? block.dark : block.light} alt={block.alt} width={width} />;
      }
      return block.steps && block.steps.length > 0
        ? <ListBlock items={block.steps} ordered start={1} width={width} />
        : <Text fg={colors.textMuted} attributes={TextAttributes.ITALIC} wrapText width={width}>{block.alt}</Text>;
    case "callout":
      return (
        <Box flexDirection="column" paddingLeft={2}>
          {block.kind && CALLOUT_LABELS[block.kind] ? (
            <Text fg={colors.borderFocused} attributes={TextAttributes.BOLD}>{CALLOUT_LABELS[block.kind]}</Text>
          ) : null}
          <DocsBlocks blocks={block.blocks} width={Math.max(12, width - 2)} onOpenLink={onOpenLink} />
        </Box>
      );
    case "details":
      return <DetailsBlock summary={block.summary} blocks={block.blocks} width={width} onOpenLink={onOpenLink} />;
  }
}

/** Blocks one under the other with a line of air between them. */
export function DocsBlocks({ blocks, width, onOpenLink }: {
  blocks: DocsBlock[];
  width: number;
  onOpenLink: (href: string) => void;
}) {
  return (
    <Box flexDirection="column" gap={1}>
      {blocks.map((block, index) => (
        <Box key={index} flexDirection="column" marginTop={block.type === "heading" && block.level === 2 && index > 0 ? 1 : 0}>
          <Block block={block} width={width} onOpenLink={onOpenLink} />
          {blockLinks(block).map((link) => <LinkMenuEntry key={link.href} label={link.label} href={link.href} onOpen={onOpenLink} />)}
        </Box>
      ))}
    </Box>
  );
}
