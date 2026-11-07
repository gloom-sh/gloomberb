import type { ScreenPayload } from "../../../api-client/equity-screener";
import type { PaneFooterSegment } from "../../../components";

/** `778 matches`, `1 match`: how many listings the screen found, whole, not the page loaded. */
function screenMatchesText(matched: number): string {
  return `${matched.toLocaleString("en-US")} ${matched === 1 ? "match" : "matches"}`;
}

/**
 * What the footer says of a screen's result: the matches, and the currency
 * that narrowed them (a screen of every currency says none). The covered
 * universe and the snapshot's time are not here: the first is the same for
 * every screen (see the screener's section of docs/usage.md), the second is
 * never more than two hours old and the rows carry live quotes over it.
 */
export function screenResultInfo(
  data: Pick<ScreenPayload, "definition" | "snapshot" | "universe"> | null,
): PaneFooterSegment[] {
  if (!data?.snapshot) return [];
  return [
    { id: "matches", parts: [{ text: screenMatchesText(data.universe.matched) }] },
    ...(data.definition.currency
      ? [{ id: "currency", parts: [{ text: data.definition.currency, tone: "muted" as const }] }]
      : []),
  ];
}

/**
 * Server warnings that describe how far the screener reaches for every screen
 * and every snapshot, not what this screen found. The server bounds the
 * universe it screens (a few thousand listings with recent financials) and
 * says so on each snapshot it assembles; the scope is in the docs and
 * `universe.covered` is its size. A ⚠ that is there on every screen reads as
 * an error and tells nothing.
 */
const STANDING_NOTICES: readonly RegExp[] = [/^Projection is bounded to /];

/**
 * The warnings a screen's ⚠ opens: the server's, less the standing ones.
 * Whatever else the server says (a name lookup that failed for this snapshot)
 * stays, as does any wording this list has not heard of.
 */
export function screenNotices(warnings: readonly string[] | undefined): string[] {
  return (warnings ?? []).filter((warning) => !STANDING_NOTICES.some((pattern) => pattern.test(warning.trim())));
}
