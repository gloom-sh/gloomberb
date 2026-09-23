import { Box, Text, TextAttributes } from "../../../ui";
import { useState } from "react";
import { InlineTickerBadge } from "./index";
import { ExternalLinkText, openUrl } from "../../ui";
import { usePaneLinkMenuEntry } from "../../ui/external-link";
import { tf } from "../../../i18n";
import { tokenizeInlineContent } from "../../../utils/inline-content-tokenizer";
import type { InlineTickerCatalogEntry } from "../../../state/hooks/inline-tickers";
import { splitLongTextSegmentByDisplayWidth } from "../../../utils/text-wrap";
import { blendHex, colors } from "../../../theme/colors";

export interface TickerBadgeTextProps {
  text: string;
  lineWidth: number;
  catalog: Record<string, InlineTickerCatalogEntry>;
  textColor: string;
  openTicker: (symbol: string) => void;
  openLink?: (url: string) => void;
  openUsername?: (username: string) => void;
}

function UsernameBadge({
  username,
  hovered,
  onHoverStart,
  onHoverEnd,
  onOpen,
}: {
  username: string;
  hovered: boolean;
  onHoverStart: () => void;
  onHoverEnd: () => void;
  onOpen: (username: string) => void;
}) {
  const backgroundColor = hovered
    ? blendHex(colors.bg, colors.borderFocused, 0.34)
    : blendHex(colors.bg, colors.borderFocused, 0.16);
  const color = hovered ? colors.textBright : colors.borderFocused;
  usePaneLinkMenuEntry(`user:${username}`, tf("Open {label}", { label: `@${username}` }), () => onOpen(username));

  return (
    <Box paddingRight={1} flexShrink={0}>
      <Box
        paddingX={1}
        backgroundColor={backgroundColor}
        onMouseOver={onHoverStart}
        onMouseOut={onHoverEnd}
        onMouseDown={(event: any) => {
          event.stopPropagation?.();
          event.preventDefault?.();
          onOpen(username);
        }}
      >
        <Text fg={color} attributes={TextAttributes.BOLD}>{`@${username}`}</Text>
      </Box>
    </Box>
  );
}

function splitTextForWrap(value: string, lineWidth: number): string[] {
  const width = Math.max(1, lineWidth);
  const segments = value.match(/\S+\s*|\s+/g) ?? [value];
  return segments.flatMap((segment) => splitLongTextSegmentByDisplayWidth(segment, width));
}

export function TickerBadgeText({
  text,
  lineWidth,
  catalog,
  textColor,
  openTicker,
  openLink = openUrl,
  openUsername,
}: TickerBadgeTextProps) {
  const [hoveredSymbol, setHoveredSymbol] = useState<string | null>(null);
  const [hoveredUsername, setHoveredUsername] = useState<string | null>(null);
  const lines = text.split("\n");

  return (
    <Box
      flexDirection="column"
      width={lineWidth}
    >
      {lines.map((line, lineIndex) => {
        if (!line) return <Box key={`line:${lineIndex}`} height={1} />;

        return (
          <Box
            key={`line:${lineIndex}`}
            flexDirection="row"
            flexWrap="wrap"
            width={lineWidth}
          >
            {tokenizeInlineContent(line).map((token, index) => {
              if (token.kind === "text") {
                if (!token.value) return null;
                return splitTextForWrap(token.value, lineWidth).map((part, partIndex) => (
                  <Text key={`text:${lineIndex}:${index}:${partIndex}`} fg={textColor}>{part}</Text>
                ));
              }

              if (token.kind === "link") {
                return (
                  <ExternalLinkText
                    key={`link:${lineIndex}:${index}`}
                    url={token.url}
                    label={token.value}
                    color={textColor}
                    onOpen={openLink}
                  />
                );
              }

              if (token.kind === "username") {
                if (!openUsername) {
                  return <Text key={`raw-username:${lineIndex}:${index}`} fg={textColor}>{token.value}</Text>;
                }

                return (
                  <UsernameBadge
                    key={`username:${lineIndex}:${index}:${token.username}`}
                    username={token.username}
                    hovered={hoveredUsername === token.username}
                    onHoverStart={() => setHoveredUsername(token.username)}
                    onHoverEnd={() => {
                      setHoveredUsername((current) => (current === token.username ? null : current));
                    }}
                    onOpen={openUsername}
                  />
                );
              }

              const entry = catalog[token.symbol];
              if (!entry || entry.status === "missing") {
                return <Text key={`raw:${lineIndex}:${index}`} fg={textColor}>{token.value}</Text>;
              }

              return (
                <InlineTickerBadge
                  key={`badge:${lineIndex}:${index}:${token.symbol}`}
                  symbol={token.symbol}
                  entry={entry}
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
      })}
    </Box>
  );
}
