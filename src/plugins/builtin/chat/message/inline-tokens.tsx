import { useMemo, useState } from "react";
import { Box, Text } from "../../../../ui";
import { TextAttributes } from "../../../../ui";
import { ExternalLinkText } from "../../../../components/ui";
import { InlineTickerBadge } from "../../../../components/ticker/badge";
import type { InlineTickerCatalogEntry } from "../../../../state/hooks/inline-tickers";
import { blendHex, colors } from "../../../../theme/colors";
import type { ChatUserSummary } from "../../../../api-client";
import { tokenizeInlineContent, type InlineContentToken } from "../../../../utils/inline-content-tokenizer";
import { chatBadgeTextWidth } from "../layout";

export function ResponsiveTickerBadgeText({
  text = "",
  tokens: providedTokens,
  prewrapped = false,
  catalog,
  textColor,
  openTicker,
  userByUsername,
  onUserHover,
  onUserHoverEnd,
}: {
  text?: string;
  tokens?: readonly InlineContentToken[];
  prewrapped?: boolean;
  catalog: Record<string, InlineTickerCatalogEntry>;
  textColor: string;
  openTicker: (symbol: string) => void;
  userByUsername?: Map<string, ChatUserSummary>;
  onUserHover?: (user: ChatUserSummary) => void;
  onUserHoverEnd?: () => void;
}) {
  const [hoveredSymbol, setHoveredSymbol] = useState<string | null>(null);
  const tokens = useMemo(() => providedTokens ?? tokenizeInlineContent(text), [providedTokens, text]);
  const renderTextToken = (value: string, tokenIndex: number) => {
    if (!value) return null;
    return (
      <Text
        key={`text:${tokenIndex}`}
        fg={textColor}
        wrapText={!prewrapped}
        style={prewrapped
          ? undefined
          : {
            minWidth: 0,
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
          }}
      >
        {value}
      </Text>
    );
  };
  const renderUsernameToken = (username: string, value: string, tokenIndex: number) => {
    const user = userByUsername?.get(username.toLowerCase()) ?? null;
    return (
      <Box
        key={`mention:${tokenIndex}:${username}`}
        height={1}
        flexDirection="row"
        backgroundColor={blendHex(colors.panel, colors.positive, 0.24)}
        onMouseOver={() => {
          if (user) onUserHover?.(user);
        }}
        onMouseOut={() => {
          if (user) onUserHoverEnd?.();
        }}
      >
        <Text fg={colors.positive} attributes={TextAttributes.BOLD}>
          {value}
        </Text>
      </Box>
    );
  };

  return (
    <Box
      flexDirection="row"
      flexWrap="wrap"
      flexGrow={1}
      style={{ minWidth: 0, width: "100%" }}
    >
      {tokens.map((token, index) => {
        if (token.kind === "text") {
          return renderTextToken(token.value, index);
        }

        if (token.kind === "link") {
          return (
            <ExternalLinkText
              key={`link:${index}`}
              url={token.url}
              label={token.value}
              color={textColor}
            />
          );
        }

        if (token.kind === "username") {
          return renderUsernameToken(token.username, token.value, index);
        }

        const entry = catalog[token.symbol];
        if (!entry || entry.status === "missing") {
          return <Text key={`raw:${index}`} fg={textColor}>{token.value}</Text>;
        }
        // Pre-wrapped lines reserved this width for the chip; it never outgrows it.
        const maxTextWidth = prewrapped ? chatBadgeTextWidth(token.symbol, entry) : undefined;
        return (
          <InlineTickerBadge
            key={`badge:${index}:${token.symbol}`}
            symbol={token.symbol}
            entry={entry}
            maxTextWidth={maxTextWidth}
            hovered={hoveredSymbol === token.symbol}
            onHoverStart={() => setHoveredSymbol(token.symbol)}
            onHoverEnd={() => {
              setHoveredSymbol((current) => (current === token.symbol ? null : current));
            }}
            onOpen={openTicker}
          />
        );
      })}
    </Box>
  );
}
