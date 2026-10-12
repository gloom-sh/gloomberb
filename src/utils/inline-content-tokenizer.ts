import { tokenizeInlineLinks } from "./link-tokenizer";
import { isKnownExchangeCode } from "./exchanges";

interface InlineContentTextToken {
  kind: "text";
  value: string;
}

interface InlineContentLinkToken {
  kind: "link";
  value: string;
  url: string;
}

interface InlineContentTickerToken {
  kind: "ticker";
  value: string;
  symbol: string;
}

interface InlineContentUsernameToken {
  kind: "username";
  value: string;
  username: string;
}

export type InlineContentToken =
  | InlineContentTextToken
  | InlineContentLinkToken
  | InlineContentTickerToken
  | InlineContentUsernameToken;

// A cashtag is $SYMBOL, or $SYMBOL:VENUE for a listing ($SAN:EPA, $7203:TSE).
const INLINE_SYMBOL_TOKEN_RE = /\$[A-Z0-9][A-Z0-9.:-]{0,24}|@[A-Za-z][A-Za-z0-9_]{2,29}/g;
const SYMBOL_CHAR_RE = /[A-Za-z0-9.-]/;
const USERNAME_CHAR_RE = /[A-Za-z0-9_]/;
const TICKER_SYMBOL_RE = /^[A-Z0-9][A-Z0-9.-]{0,9}$/;

function trimTrailingTickerPunctuation(value: string): string {
  let trimmed = value;
  while (trimmed.length > 2 && /[.:-]$/.test(trimmed)) {
    trimmed = trimmed.slice(0, -1);
  }
  return trimmed;
}

/**
 * The cashtag at the start of `value` ($NVDA, $SAN:EPA), or null. A venue
 * after the colon counts only when it is one the app knows ($NVDA:AMD is
 * $NVDA), and a symbol starting with a digit only with one ($7203:TSE; $100
 * is money).
 */
function cashtag(value: string): string | null {
  const colon = value.indexOf(":");
  const symbol = colon > 0 ? value.slice(1, colon) : value.slice(1);
  const venue = colon > 0 ? value.slice(colon + 1) : "";
  if (!TICKER_SYMBOL_RE.test(symbol)) return null;
  if (venue && /^[A-Z][A-Z0-9]{1,9}$/.test(venue) && isKnownExchangeCode(venue)) return `$${symbol}:${venue}`;
  return /^[A-Z]/.test(symbol) ? `$${symbol}` : null;
}

function isValidTickerBoundary(text: string, start: number, end: number): boolean {
  const prev = start > 0 ? text[start - 1] ?? "" : "";
  const next = end < text.length ? text[end] ?? "" : "";
  return !SYMBOL_CHAR_RE.test(prev) && !SYMBOL_CHAR_RE.test(next);
}

function isValidUsernameBoundary(text: string, start: number, end: number): boolean {
  const prev = start > 0 ? text[start - 1] ?? "" : "";
  const next = end < text.length ? text[end] ?? "" : "";
  return !USERNAME_CHAR_RE.test(prev) && !USERNAME_CHAR_RE.test(next);
}

export function tokenizeInlineContent(text: string): InlineContentToken[] {
  const tokens: InlineContentToken[] = [];

  for (const segment of tokenizeInlineLinks(text)) {
    if (segment.kind === "link") {
      tokens.push(segment);
      continue;
    }

    let cursor = 0;
    let match: RegExpExecArray | null;

    INLINE_SYMBOL_TOKEN_RE.lastIndex = 0;
    while ((match = INLINE_SYMBOL_TOKEN_RE.exec(segment.value)) !== null) {
      const rawValue = match[0];
      const start = match.index;
      const rawEnd = start + rawValue.length;
      const isTicker = rawValue.startsWith("$");
      const value = isTicker ? cashtag(trimTrailingTickerPunctuation(rawValue)) : rawValue;
      if (!value) continue;
      const end = start + value.length;
      if (
        isTicker
          ? !isValidTickerBoundary(segment.value, start, rawEnd)
          : !isValidUsernameBoundary(segment.value, start, rawEnd)
      ) continue;

      if (start > cursor) {
        tokens.push({ kind: "text", value: segment.value.slice(cursor, start) });
      }
      tokens.push(isTicker
        ? { kind: "ticker", value, symbol: value.slice(1) }
        : { kind: "username", value, username: value.slice(1) });
      cursor = end;
    }

    if (cursor < segment.value.length) {
      tokens.push({ kind: "text", value: segment.value.slice(cursor) });
    }
  }

  return tokens;
}
