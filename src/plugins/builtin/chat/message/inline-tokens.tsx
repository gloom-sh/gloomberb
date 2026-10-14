import { useMemo, useRef, useState } from "react";
import { Box, Span, Text, useUiCapabilities, type BoxRenderable } from "../../../../ui";
import { TextAttributes } from "../../../../ui";
import { Divider, ExternalLinkText } from "../../../../components/ui";
import { InlineTickerBadge } from "../../../../components/ticker/badge";
import type { InlineTickerCatalogEntry } from "../../../../state/hooks/inline-tickers";
import { blendHex, colors } from "../../../../theme/colors";
import type { ChatUserSummary } from "../../../../api-client";
import { parseMarkdownLines, type MarkdownLine } from "../../../../utils/markdown";
import { chatBadgeTextWidth, type ChatBodyLine } from "../layout";
import { chatInlineTokens, type ChatInlineToken, type ChatTextStyle } from "../markdown";
import type { ChatUserAnchor, ChatUserContextMenuEvent } from "./types";

interface ChatUserHandlers {
  userByUsername?: Map<string, ChatUserSummary>;
  onUserHover?: (user: ChatUserSummary, anchor?: ChatUserAnchor) => void;
  onUserHoverEnd?: () => void;
  onUserActivate?: (user: ChatUserSummary, anchor?: ChatUserAnchor) => void;
  onUserContextMenu?: (user: ChatUserSummary, event: ChatUserContextMenuEvent, anchor?: ChatUserAnchor) => void;
}

interface ChatTextProps extends ChatUserHandlers {
  catalog: Record<string, InlineTickerCatalogEntry>;
  textColor: string;
  /** Code, list markers, a quote's bar and a link's host. */
  mutedColor: string;
  openTicker: (symbol: string) => void;
}

/** Desktop and web: a run of text inside a line, which wraps with the line. */
const INLINE_TEXT_STYLE = { display: "inline", whiteSpace: "pre-wrap", overflowWrap: "anywhere", minWidth: 0 } as const;
/** Desktop and web: a chip that sits in a line of text, on the line's own row. */
const INLINE_CHIP_STYLE = { display: "inline-flex", verticalAlign: "top", height: "var(--cell-h)" } as const;

function styleAttributes(style: ChatTextStyle | undefined): number {
  if (!style) return 0;
  return (style.bold ? TextAttributes.BOLD : 0)
    | (style.italic ? TextAttributes.ITALIC : 0)
    | (style.strike ? TextAttributes.STRIKETHROUGH : 0);
}

function styleColor(style: ChatTextStyle | undefined, textColor: string, mutedColor: string): string {
  return style?.code || style?.muted ? mutedColor : textColor;
}

/** An @mention: a name that opens its user's card, when the chat knows the user. */
function UserMentionToken({
  value,
  user,
  inline,
  nativeContextMenu,
  onUserHover,
  onUserHoverEnd,
  onUserActivate,
  onUserContextMenu,
}: Omit<ChatUserHandlers, "userByUsername"> & {
  value: string;
  user: ChatUserSummary | null;
  inline: boolean;
  nativeContextMenu: boolean;
}) {
  // The card opens beside the mention the pointer is on.
  const tokenRef = useRef<BoxRenderable | null>(null);
  const pointer = user && onUserActivate ? { cursor: "pointer" } : undefined;
  return (
    <Box
      ref={tokenRef}
      height={1}
      flexDirection="row"
      backgroundColor={blendHex(colors.panel, colors.positive, 0.24)}
      onMouseOver={() => {
        if (user) onUserHover?.(user, tokenRef.current);
      }}
      onMouseOut={() => {
        if (user) onUserHoverEnd?.();
      }}
      // Only a mention of someone the chat has a summary for has a card or a menu to open.
      onMouseDown={user && onUserActivate ? (event: { button?: number; preventDefault?: () => void; stopPropagation?: () => void }) => {
        event.preventDefault?.();
        event.stopPropagation?.();
        if (event.button === 2 && nativeContextMenu) return;
        onUserActivate(user, tokenRef.current);
      } : undefined}
      {...(user && onUserContextMenu ? {
        "data-gloom-context-menu-surface": "true",
        onContextMenu: (event: ChatUserContextMenuEvent) => onUserContextMenu(user, event, tokenRef.current),
      } : {})}
      style={inline ? { ...INLINE_CHIP_STYLE, ...pointer } : pointer}
    >
      <Text fg={colors.positive} attributes={TextAttributes.BOLD}>
        {value}
      </Text>
    </Box>
  );
}

/**
 * The tokens of a message line: styled text, links, @mentions and $TICKER
 * chips. `inline` draws them for a line of text on the desktop and the web;
 * otherwise each is a cell of a terminal row.
 */
function ChatTokens({
  tokens,
  keyPrefix,
  inline,
  prewrapped,
  catalog,
  textColor,
  mutedColor,
  openTicker,
  hoveredSymbol,
  setHoveredSymbol,
  userByUsername,
  ...userHandlers
}: ChatTextProps & {
  tokens: readonly ChatInlineToken[];
  keyPrefix: string;
  inline: boolean;
  /** Terminal rows wrapped ahead of time, whose chips keep the width reserved for them. */
  prewrapped: boolean;
  hoveredSymbol: string | null;
  setHoveredSymbol: (update: (current: string | null) => string | null) => void;
}) {
  const { nativeContextMenu } = useUiCapabilities();
  return (
    <>
      {tokens.map((token, index) => {
        const key = `${keyPrefix}:${index}`;
        if (token.kind === "text") {
          if (!token.value) return null;
          const fg = styleColor(token.style, textColor, mutedColor);
          const attributes = styleAttributes(token.style) || undefined;
          return inline
            ? <Span key={key} fg={fg} attributes={attributes} style={INLINE_TEXT_STYLE}>{token.value}</Span>
            : <Text key={key} fg={fg} attributes={attributes}>{token.value}</Text>;
        }

        if (token.kind === "link") {
          return (
            <ExternalLinkText
              key={key}
              url={token.url}
              label={token.value}
              color={textColor}
              attributes={styleAttributes(token.style)}
              inline={inline}
            />
          );
        }

        if (token.kind === "username") {
          return (
            <UserMentionToken
              key={key}
              value={token.value}
              user={userByUsername?.get(token.username.toLowerCase()) ?? null}
              inline={inline}
              nativeContextMenu={nativeContextMenu === true}
              {...userHandlers}
            />
          );
        }

        const entry = catalog[token.symbol];
        if (!entry || entry.status === "missing") {
          const fg = styleColor(token.style, textColor, mutedColor);
          const attributes = styleAttributes(token.style) || undefined;
          return inline
            ? <Span key={key} fg={fg} attributes={attributes} style={INLINE_TEXT_STYLE}>{token.value}</Span>
            : <Text key={key} fg={fg} attributes={attributes}>{token.value}</Text>;
        }
        const badge = (
          <InlineTickerBadge
            key={key}
            symbol={token.symbol}
            entry={entry}
            // Pre-wrapped lines reserved this width for the chip; it never outgrows it.
            maxTextWidth={prewrapped ? chatBadgeTextWidth(token.symbol, entry) : undefined}
            hovered={hoveredSymbol === token.symbol}
            onHoverStart={() => setHoveredSymbol(() => token.symbol)}
            onHoverEnd={() => {
              setHoveredSymbol((current) => (current === token.symbol ? null : current));
            }}
            onOpen={openTicker}
          />
        );
        return inline ? <Box key={key} style={INLINE_CHIP_STYLE}>{badge}</Box> : badge;
      })}
    </>
  );
}

/** One row of a message in the terminal, wrapped ahead of time (getMessageBodyTokenLines). */
export function TerminalChatMessageRow({ line, ...props }: ChatTextProps & { line: ChatBodyLine }) {
  const [hoveredSymbol, setHoveredSymbol] = useState<string | null>(null);
  return (
    <Box flexDirection="row" flexWrap="wrap" flexGrow={1} style={{ minWidth: 0, width: "100%" }}>
      <ChatTokens
        {...props}
        tokens={line}
        keyPrefix="row"
        inline={false}
        prewrapped
        hoveredSymbol={hoveredSymbol}
        setHoveredSymbol={setHoveredSymbol}
      />
    </Box>
  );
}

/** A line of text that wraps at the width of its box, a list item's later lines hung under its text. */
function lineStyle(hang = 0) {
  return {
    display: "block",
    minWidth: 0,
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
    ...(hang > 0 ? { paddingLeft: `${hang}ch`, textIndent: `-${hang}ch` } : {}),
  } as const;
}

type DesktopBlock = MarkdownLine | { kind: "code-block"; lines: string[] };

/** A code block's lines as one block, so it selects and copies as one. */
function desktopBlocks(text: string): DesktopBlock[] {
  const blocks: DesktopBlock[] = [];
  for (const line of parseMarkdownLines(text)) {
    const previous = blocks[blocks.length - 1];
    if (line.kind === "code" && previous?.kind === "code-block") previous.lines.push(line.text);
    else blocks.push(line.kind === "code" ? { kind: "code-block", lines: [line.text] } : line);
  }
  return blocks;
}

/**
 * A message's text on the desktop and the web: its markdown drawn as lines of
 * running text that the browser wraps at the width of the row, so a resize
 * reflows it smoothly instead of a cell at a time.
 */
export function DesktopChatMessageText({ text, ...props }: ChatTextProps & { text: string }) {
  const [hoveredSymbol, setHoveredSymbol] = useState<string | null>(null);
  const blocks = useMemo(() => desktopBlocks(text), [text]);
  const { textColor, mutedColor } = props;
  const tokens = (lineText: string, keyPrefix: string, mark?: ChatTextStyle) => (
    <ChatTokens
      {...props}
      tokens={mark ? chatInlineTokens(lineText).map((token) => ({ ...token, style: { ...token.style, ...mark } })) : chatInlineTokens(lineText)}
      keyPrefix={keyPrefix}
      inline
      prewrapped={false}
      hoveredSymbol={hoveredSymbol}
      setHoveredSymbol={setHoveredSymbol}
    />
  );

  return (
    <Box flexDirection="column" style={{ minWidth: 0, width: "100%" }}>
      {blocks.map((block, index) => {
        const key = `${block.kind}:${index}`;
        switch (block.kind) {
          case "blank":
            return <Text key={key} fg={textColor}>{" "}</Text>;
          case "code-block":
            return <Text key={key} fg={mutedColor} style={lineStyle()}>{block.lines.join("\n")}</Text>;
          case "heading":
            return <Text key={key} fg={textColor} style={lineStyle()}>{tokens(block.text, key, { bold: true })}</Text>;
          case "quote":
            // The bar is the kit's rule, a cell wide as the terminal's.
            return (
              <Box key={key} flexDirection="row" style={{ minWidth: 0 }}>
                <Divider orientation="vertical" />
                <Box paddingLeft={1} flexGrow={1} style={{ minWidth: 0 }}>
                  <Text fg={textColor} style={lineStyle()}>{tokens(block.text, key)}</Text>
                </Box>
              </Box>
            );
          case "list": {
            const marker = `${" ".repeat(block.indent)}${/^\d/.test(block.marker) ? block.marker : "\u2022"} `;
            return (
              <Text key={key} fg={textColor} style={lineStyle(marker.length)}>
                <Span fg={mutedColor} style={INLINE_TEXT_STYLE}>{marker}</Span>
                {tokens(block.text, key)}
              </Text>
            );
          }
          case "text":
            return <Text key={key} fg={textColor} style={lineStyle()}>{tokens(block.text, key)}</Text>;
        }
      })}
    </Box>
  );
}
