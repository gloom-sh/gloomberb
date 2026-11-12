import { RGBA, StyledText as OpenTuiStyledText, SyntaxStyle, TextAttributes as OpenTuiTextAttributes } from "@opentui/core";
import { createElement, forwardRef, useEffect, useRef, useState, type ReactNode } from "react";
import { TextAttributes, type UiHost, type TextProps } from "../../ui/host";
import { renderAsciiText } from "../../ui/ascii-font";
import { scrollBoxScrollsVertically } from "../../ui/scroll-box-axis";
import { OpenTuiImageSurface } from "./image/surface";
import { OpenTuiChartSurface } from "./chart-surface";
import { joinPastedLines } from "../../utils/pasted-lines";
import { withoutControlCharacters } from "../../utils/untrusted-text";

interface OpenTuiPrimitiveProps {
  children?: ReactNode;
  [key: string]: unknown;
}

// A padding or margin edge falls back to the broader prop still passed, so
// dropping paddingLeft under paddingX keeps paddingX on that edge.
const EDGE_FALLBACKS: Record<string, readonly string[]> = {
  padding: [],
  paddingX: ["padding"],
  paddingY: ["padding"],
  paddingTop: ["paddingY", "padding"],
  paddingBottom: ["paddingY", "padding"],
  paddingLeft: ["paddingX", "padding"],
  paddingRight: ["paddingX", "padding"],
  margin: [],
  marginX: ["margin"],
  marginY: ["margin"],
  marginTop: ["marginY", "margin"],
  marginBottom: ["marginY", "margin"],
  marginLeft: ["marginX", "margin"],
  marginRight: ["marginX", "margin"],
};

const LAYOUT_DEFAULTS: Record<string, unknown> = {
  width: "auto",
  height: "auto",
  top: "auto",
  right: "auto",
  bottom: "auto",
  left: "auto",
  minWidth: undefined,
  minHeight: undefined,
  maxWidth: undefined,
  maxHeight: undefined,
  flexBasis: undefined,
  position: "relative",
  overflow: "visible",
};

function isLayoutProp(key: string): boolean {
  return key in EDGE_FALLBACKS || key in LAYOUT_DEFAULTS;
}

function hasNumericSize(props: OpenTuiPrimitiveProps): boolean {
  return typeof props.width === "number" || typeof props.height === "number";
}

interface AppliedLayout {
  keys: Set<string>;
  forcedFlexShrink: boolean;
}

/**
 * @opentui/react sends null for a prop that is no longer passed, and the core
 * layout setters ignore null. A reused host node (a status box turning into
 * the content box) would keep its padding, margins and size, so layout props
 * applied on an earlier render get an explicit reset once they go away.
 */
function withLayoutResets(props: OpenTuiPrimitiveProps, applied: AppliedLayout): OpenTuiPrimitiveProps {
  let next: OpenTuiPrimitiveProps | null = null;
  for (const key of applied.keys) {
    if (props[key] != null) continue;
    next ??= { ...props };
    const fallbacks = EDGE_FALLBACKS[key];
    next[key] = fallbacks
      ? fallbacks.map((fallback) => props[fallback]).find((value) => value != null) ?? 0
      : LAYOUT_DEFAULTS[key];
  }
  // A numeric width or height forces flexShrink to 0 in the core; restore the
  // default once no numeric size is left, unless the caller set flexShrink.
  if (props.flexShrink == null) {
    if (hasNumericSize(props)) {
      applied.forcedFlexShrink = true;
    } else if (applied.forcedFlexShrink) {
      next ??= { ...props };
      next.flexShrink = 1;
    }
  }
  for (const key in props) {
    if (props[key] != null && isLayoutProp(key)) applied.keys.add(key);
  }
  return next ?? props;
}

function createOpenTuiPrimitive(tagName: string) {
  return forwardRef<unknown, OpenTuiPrimitiveProps>(function OpenTuiPrimitive(
    { children, ...props },
    ref,
  ) {
    const appliedLayout = useRef<AppliedLayout>({ keys: new Set(), forcedFlexShrink: false });
    return createElement(
      tagName as any,
      { ...withLayoutResets(props, appliedLayout.current), ref },
      children as ReactNode,
    );
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

/**
 * Every string drawn in the terminal goes through here: a chat message, a
 * name, a headline or a share reaches the screen as the text it is, without
 * control characters (withoutControlCharacters). Colour and weight come from
 * styled chunks, so no text needs an escape sequence of its own.
 */
function mapTextContent(content: unknown): unknown {
  if (!content) return content;
  if (typeof content === "string") return withoutControlCharacters(content);
  if (
    typeof content === "object"
    && Array.isArray((content as { chunks?: unknown }).chunks)
  ) {
    return new OpenTuiStyledText((content as { chunks: Array<Record<string, unknown>> }).chunks.map((chunk) => ({
      ...chunk,
      text: typeof chunk.text === "string" ? withoutControlCharacters(chunk.text) : chunk.text,
      fg: mapColor(chunk.fg),
      bg: mapColor(chunk.bg),
      attributes: mapTextAttributes(chunk.attributes as number | undefined),
    })) as any);
  }
  return content;
}

/** The text children of a text element, as mapTextContent draws a string. Elements in them map their own. */
function plainTextChildren(children: ReactNode): ReactNode {
  if (typeof children === "string") return withoutControlCharacters(children);
  if (!Array.isArray(children)) return children;
  let plain: ReactNode[] | null = null;
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index] as ReactNode;
    const mapped = plainTextChildren(child);
    if (mapped === child) continue;
    plain ??= [...children];
    plain[index] = mapped;
  }
  return plain ?? children;
}

const OpenTuiBox = createOpenTuiPrimitive("box");
const OpenTuiScrollBoxPrimitive = createOpenTuiPrimitive("scrollbox");
// The native box scrolls vertically unless scrollY is false; the shared rule
// also keeps the one-row horizontal strips from scrolling on that axis.
const OpenTuiScrollBox = forwardRef<unknown, OpenTuiPrimitiveProps>(function OpenTuiScrollBox(props, ref) {
  return createElement(OpenTuiScrollBoxPrimitive, { ...props, scrollY: scrollBoxScrollsVertically(props), ref });
});
const OpenTuiInputPrimitive = createOpenTuiPrimitive("input");

/**
 * A field's placeholder in the terminal's dim role: faint as well as in the
 * placeholder colour, so an example value (`10`, `USD`) does not read as one
 * typed, nor as the hint under the field in the same muted colour (review,
 * 12 Nov 2026: AP's placeholders and hints were one grey). The desktop draws
 * its placeholder inside a sunken field and keeps the colour alone.
 */
function dimPlaceholder(props: OpenTuiPrimitiveProps): OpenTuiPrimitiveProps {
  const { placeholder, placeholderColor } = props as { placeholder?: unknown; placeholderColor?: unknown };
  if (typeof placeholder !== "string" || placeholder.length === 0) return props;
  // One styled text per placeholder and colour, so a re-render does not hand the field a new one to apply.
  const key = `${typeof placeholderColor === "string" ? placeholderColor : ""}\u0000${placeholder}`;
  let styled = dimPlaceholders.get(key);
  if (!styled) {
    if (dimPlaceholders.size >= 256) dimPlaceholders.clear();
    styled = new OpenTuiStyledText([{
      __isChunk: true,
      text: withoutControlCharacters(placeholder),
      fg: typeof placeholderColor === "string" ? RGBA.fromHex(placeholderColor) : undefined,
      attributes: OpenTuiTextAttributes.DIM,
    }] as any);
    dimPlaceholders.set(key, styled);
  }
  return { ...props, placeholder: styled };
}
const dimPlaceholders = new Map<string, OpenTuiStyledText>();

interface PasteEventLike {
  bytes: Uint8Array;
}

/**
 * A one-line field drops the line breaks of a paste, which fuses a pasted
 * column of symbols into one word; a browser's field turns each break into a
 * space. `joinPastedLines` does the same here, for the fields that read a
 * list, or with `"list"` keeps each line an entry (`PastedLines`).
 */
const OpenTuiInput = forwardRef<unknown, OpenTuiPrimitiveProps>(function OpenTuiInput({ joinPastedLines: join, onPaste, ...props }, ref) {
  const handlePaste = typeof onPaste === "function" ? onPaste as (event: PasteEventLike) => void : null;
  return createElement(OpenTuiInputPrimitive, {
    ...dimPlaceholder(props),
    ref,
    onPaste: join === true || join === "list" || handlePaste
      ? (event: PasteEventLike) => {
        if (join === true || join === "list") event.bytes = new TextEncoder().encode(joinPastedLines(new TextDecoder().decode(event.bytes), join));
        handlePaste?.(event);
      }
      : undefined,
  });
});
const OpenTuiTextareaPrimitive = createOpenTuiPrimitive("textarea");
const OpenTuiTextarea = forwardRef<unknown, OpenTuiPrimitiveProps>(function OpenTuiTextarea(props, ref) {
  return createElement(OpenTuiTextareaPrimitive, { ...dimPlaceholder(props), ref });
});
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
  }, plainTextChildren(children as ReactNode));
});

const OpenTuiSpan = forwardRef<unknown, TextProps>(function OpenTuiSpan({ children, ...props }, ref) {
  return createElement("span" as any, {
    ...stripTextProps(props),
    ref,
    attributes: mapTextAttributes(props.attributes as number | undefined, props),
  }, plainTextChildren(children as ReactNode));
});

const OpenTuiStrong = forwardRef<unknown, TextProps>(function OpenTuiStrong({ children, ...props }, ref) {
  return createElement("strong" as any, { ...stripTextProps(props), ref }, plainTextChildren(children as ReactNode));
});

const OpenTuiUnderline = forwardRef<unknown, TextProps>(function OpenTuiUnderline({ children, ...props }, ref) {
  return createElement("u" as any, { ...stripTextProps(props), ref }, plainTextChildren(children as ReactNode));
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
  AsciiText: ({ text, font = "tiny", color, fg, bg, backgroundColor, selectable = false, scale: _scale, ...props }) => {
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
