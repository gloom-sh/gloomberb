/** @jsxImportSource react */
import type { CSSProperties, ReactNode } from "react";
import {
  StyledText,
  type AsciiTextProps,
  type StyledTextChunk,
  type TextProps,
} from "../../../../ui/host";
import { WEB_CELL_WIDTH } from "../input-host";
import { webAsciiTextLines, webAsciiTextWordmarkVariant } from "./ascii-text";
import { mouseHandlers } from "./mouse";
import { cleanDomProps, commonStyle, textStyle } from "./style";

const WEB_WORDMARK_CHAR_WIDTH_PX = Math.max(10, WEB_CELL_WIDTH);

interface WebAsciiTextProps extends AsciiTextProps {
  desktopPlatform?: string;
}

function isStyledTextContent(value: unknown): value is { chunks: StyledTextChunk[] } {
  return value instanceof StyledText
    || (!!value && typeof value === "object" && Array.isArray((value as { chunks?: unknown }).chunks));
}

function styledTextChunkStyle(baseProps: TextProps, chunk: StyledTextChunk): CSSProperties {
  const style = textStyle({
    ...baseProps,
    fg: typeof chunk.fg === "string" ? chunk.fg : baseProps.fg,
    bg: typeof chunk.bg === "string" ? chunk.bg : baseProps.bg,
    attributes: chunk.attributes,
  });
  style.display = "inline";
  style.width = undefined;
  style.maxWidth = undefined;
  style.minWidth = undefined;
  style.flexShrink = undefined;
  return style;
}

function renderTextContent(children: ReactNode, content: TextProps["content"], baseProps: TextProps): ReactNode {
  const resolved = children ?? content;
  if (!isStyledTextContent(resolved)) return resolved as ReactNode;
  return resolved.chunks.map((chunk, index) => (
    <span
      key={index}
      style={styledTextChunkStyle(baseProps, chunk)}
    >
      {chunk.text}
    </span>
  ));
}

export function WebText({ children, ...props }: TextProps) {
  return (
    <span
      {...cleanDomProps(props)}
      {...mouseHandlers(props)}
      style={{ ...textStyle(props), ...(props.style as CSSProperties | undefined) }}
    >
      {renderTextContent(children, props.content, props)}
    </span>
  );
}

export function WebSpan({ children, ...props }: TextProps) {
  return (
    <span {...cleanDomProps(props)} style={{ ...textStyle(props), ...(props.style as CSSProperties | undefined) }}>
      {children as ReactNode}
    </span>
  );
}

export function WebStrong({ children, ...props }: TextProps) {
  return (
    <strong {...cleanDomProps(props)} style={{ ...textStyle({ ...props, bold: true }), ...(props.style as CSSProperties | undefined) }}>
      {children as ReactNode}
    </strong>
  );
}

export function WebUnderline({ children, ...props }: TextProps) {
  return (
    <span {...cleanDomProps(props)} style={{ ...textStyle({ ...props, underline: true }), ...(props.style as CSSProperties | undefined) }}>
      {children as ReactNode}
    </span>
  );
}

export function WebAsciiText({
  text,
  font = "tiny",
  color,
  fg,
  bg,
  backgroundColor,
  selectable = false,
  desktopPlatform,
  ...props
}: WebAsciiTextProps) {
  const wordmarkVariant = webAsciiTextWordmarkVariant(text, font, desktopPlatform);
  const isCompatWordmark = wordmarkVariant === "compat";
  const isLegacyWordmark = wordmarkVariant === "legacy";
  const lines = webAsciiTextLines(text, font, desktopPlatform);
  const resolvedColor = color ?? fg;
  const resolvedBackground = bg ?? backgroundColor;
  const lineHeightPx = isCompatWordmark ? 16 : 12;
  const wordmarkWidthPx = isCompatWordmark
    ? Math.max(...lines.map((line) => line.length)) * WEB_WORDMARK_CHAR_WIDTH_PX
    : undefined;
  return (
    <div
      {...cleanDomProps(props)}
      data-gloom-role={(props["data-gloom-role"] as string | undefined) ?? "ascii-text"}
      style={{
        ...commonStyle({ ...props, fg: resolvedColor, bg: resolvedBackground }),
        display: isLegacyWordmark ? "flex" : "block",
        flexDirection: isLegacyWordmark ? "column" : undefined,
        flexShrink: 0,
        ...(wordmarkWidthPx != null && props.width == null
          ? { width: `${wordmarkWidthPx}px`, minWidth: `${wordmarkWidthPx}px` }
          : {}),
        color: resolvedColor,
        backgroundColor: resolvedBackground,
        fontFamily: isCompatWordmark ? "\"Cascadia Mono\", Consolas, \"Courier New\", monospace" : undefined,
        fontSize: isCompatWordmark ? "16px" : undefined,
        fontVariantLigatures: "none",
        lineHeight: `${lineHeightPx}px`,
        whiteSpace: "pre",
        letterSpacing: 0,
        userSelect: selectable ? "text" : "none",
        ...(props.style as CSSProperties | undefined),
      }}
    >
      {isLegacyWordmark
        ? lines.map((line, index) => (
          <span key={index} style={{ display: "block", height: "12px", lineHeight: "12px" }}>
            {line}
          </span>
        ))
        : lines.join("\n")}
    </div>
  );
}
