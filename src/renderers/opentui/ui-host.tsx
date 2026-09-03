import { RGBA, StyledText as OpenTuiStyledText, SyntaxStyle, TextAttributes as OpenTuiTextAttributes } from "@opentui/core";
import { createElement, forwardRef, useEffect, useState, type ReactNode } from "react";
import { TextAttributes, type UiHost, type TextProps } from "../../ui/host";
import { renderAsciiText } from "../../ui/ascii-font";
import { OpenTuiImageSurface } from "./image/surface";
import { OpenTuiChartSurface } from "./chart-surface";

interface OpenTuiPrimitiveProps {
  children?: ReactNode;
  [key: string]: unknown;
}

function createOpenTuiPrimitive(tagName: string) {
  return forwardRef<unknown, OpenTuiPrimitiveProps>(function OpenTuiPrimitive(
    { children, ...props },
    ref,
  ) {
    return createElement(tagName as any, { ...props, ref }, children as ReactNode);
  });
}

function mapTextAttributes(appAttributes: number | undefined, props?: TextProps): number | undefined {
  const flags = typeof appAttributes === "number" ? appAttributes : 0;
  let attributes = 0;
  if (flags & TextAttributes.BOLD || props?.bold) attributes |= OpenTuiTextAttributes.BOLD;
  if (flags & TextAttributes.UNDERLINE || props?.underline) attributes |= OpenTuiTextAttributes.UNDERLINE;
  if (flags & TextAttributes.INVERSE || props?.inverse) attributes |= OpenTuiTextAttributes.INVERSE;
  if (flags & TextAttributes.DIM || props?.dim) attributes |= OpenTuiTextAttributes.DIM;
  if (flags & TextAttributes.ITALIC || props?.italic) attributes |= OpenTuiTextAttributes.ITALIC;
  if (flags & TextAttributes.STRIKETHROUGH || props?.strikethrough) attributes |= OpenTuiTextAttributes.STRIKETHROUGH;
  return attributes || undefined;
}

function stripTextProps({ bold, underline, inverse, dim, italic, strikethrough, ...props }: TextProps) {
  return props;
}

function mapColor(color: unknown): unknown {
  return typeof color === "string" ? RGBA.fromHex(color) : color;
}

function mapTextContent(content: unknown): unknown {
  if (!content || typeof content === "string") return content;
  if (
    typeof content === "object"
    && Array.isArray((content as { chunks?: unknown }).chunks)
  ) {
    return new OpenTuiStyledText((content as { chunks: Array<Record<string, unknown>> }).chunks.map((chunk) => ({
      ...chunk,
      fg: mapColor(chunk.fg),
      bg: mapColor(chunk.bg),
      attributes: mapTextAttributes(chunk.attributes as number | undefined),
    })) as any);
  }
  return content;
}

const OpenTuiBox = createOpenTuiPrimitive("box");
const OpenTuiScrollBox = createOpenTuiPrimitive("scrollbox");
const OpenTuiInput = createOpenTuiPrimitive("input");
const OpenTuiTextarea = createOpenTuiPrimitive("textarea");
const OpenTuiMediaSurface = createOpenTuiPrimitive("box");

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const OpenTuiSpinnerMark = forwardRef<unknown, OpenTuiPrimitiveProps & { name?: string; color?: string }>(
  function OpenTuiSpinnerMark({ name: _name, color, ...props }, ref) {
    const [frame, setFrame] = useState(0);
    useEffect(() => {
      const timer = setInterval(() => setFrame((current) => (current + 1) % SPINNER_FRAMES.length), 80);
      return () => clearInterval(timer);
    }, []);
    return createElement("text" as any, {
      ...props,
      ref,
      fg: color,
      content: SPINNER_FRAMES[frame],
    });
  },
);

const OpenTuiText = forwardRef<unknown, TextProps>(function OpenTuiText({ children, ...props }, ref) {
  const textProps = stripTextProps(props);
  return createElement("text" as any, {
    ...textProps,
    ref,
    content: mapTextContent(textProps.content),
    attributes: mapTextAttributes(props.attributes as number | undefined, props),
  }, children as ReactNode);
});

const OpenTuiSpan = forwardRef<unknown, TextProps>(function OpenTuiSpan({ children, ...props }, ref) {
  return createElement("span" as any, {
    ...stripTextProps(props),
    ref,
    attributes: mapTextAttributes(props.attributes as number | undefined, props),
  }, children as ReactNode);
});

const OpenTuiStrong = forwardRef<unknown, TextProps>(function OpenTuiStrong({ children, ...props }, ref) {
  return createElement("strong" as any, { ...stripTextProps(props), ref }, children as ReactNode);
});

const OpenTuiUnderline = forwardRef<unknown, TextProps>(function OpenTuiUnderline({ children, ...props }, ref) {
  return createElement("u" as any, { ...stripTextProps(props), ref }, children as ReactNode);
});

export const openTuiUiHost: UiHost = {
  kind: "opentui",
  capabilities: {
    nativeCharts: true,
    publicSharing: true,
  },
  Box: OpenTuiBox as UiHost["Box"],
  Text: OpenTuiText as UiHost["Text"],
  Span: OpenTuiSpan as UiHost["Span"],
  Strong: OpenTuiStrong as UiHost["Strong"],
  Underline: OpenTuiUnderline as UiHost["Underline"],
  ScrollBox: OpenTuiScrollBox as UiHost["ScrollBox"],
  Input: OpenTuiInput as UiHost["Input"],
  Textarea: OpenTuiTextarea as UiHost["Textarea"],
  ChartSurface: OpenTuiChartSurface,
  ImageSurface: OpenTuiImageSurface,
  MediaSurface: OpenTuiMediaSurface as UiHost["MediaSurface"],
  SpinnerMark: OpenTuiSpinnerMark as UiHost["SpinnerMark"],
  AsciiText: ({ text, font = "tiny", color, fg, bg, backgroundColor, selectable = false, ...props }) => {
    const resolvedColor = color ?? fg;
    const resolvedBackground = backgroundColor ?? bg;
    if (font === "wordmark") {
      return createElement(
        "box" as any,
        { ...props, flexDirection: props.flexDirection ?? "column" },
        renderAsciiText(text, font).map((line, index) => createElement("text" as any, {
          key: index,
          fg: resolvedColor,
          bg: resolvedBackground,
          selectable,
        }, line)),
      );
    }
    return createElement("ascii-font" as any, {
      ...props,
      text,
      font,
      color: resolvedColor,
      backgroundColor: resolvedBackground,
      selectable,
    });
  },
  createSyntaxStyle: () => SyntaxStyle.create(),
  colorFromHex: (hex) => RGBA.fromHex(hex),
};
