/**
 * How a one-line field takes a paste of several lines: `true` joins them as
 * words, each line break or tab a space (`AAPL MSFT`); `"list"` keeps each
 * line and each tab-separated cell an entry, joined with ", " (`Apple Inc,
 * Meta Platforms`), so a pasted column or sheet row of names or terminal codes
 * (`VOD LN`, `BARC LN`) stays one entry a line.
 */
export type PastedLines = boolean | "list";

/** A paste as the one line a field that reads a list takes (`PastedLines`). */
export function joinPastedLines(text: string, mode: Exclude<PastedLines, false>): string {
  if (mode === "list") return text.replace(/^[\s,]+|[\s,]+$/g, "").replace(/[ \t]*[\t\r\n][\s]*/g, ", ");
  return text.replace(/^[\r\n]+|[\r\n]+$/g, "").replace(/[ \t]*[\r\n]+[ \t]*/g, " ").replace(/\t+/g, " ");
}
