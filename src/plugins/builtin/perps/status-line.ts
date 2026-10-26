import { useMemo } from "react";
import { deriveHeadlessFreshness, paneStatusLineVariants } from "../../../cli/pane-functions/freshness";
import type { PaneFooterSegment } from "../../../components";
import { useAgeClock } from "../../../react/auto-refresh";
import { useRemoteUiNode } from "../../../remote/semantic-tree";
import type { HeadlessPaneFreshness } from "../../../types/headless";

/**
 * The footer line a tab ends with, from the same freshness its text report declares (`declare`, null while there is
 * nothing to date): the source, its time and how old it is, the line `fn PERP` and `shot PERP` end with. It keeps ageing
 * while the pane is seen (`since` is when the data loaded), and is published for a capture to date itself the same way.
 */
export function useFreshnessStatusLine(declare: ((now: number) => HeadlessPaneFreshness | null) | null, since: number | null): PaneFooterSegment[] {
  const now = useAgeClock(since);
  const declared = useMemo(() => declare?.(now) ?? null, [declare, now]);
  useRemoteUiNode(declared ? { role: "report-freshness", label: "Venue freshness", getMetadata: () => ({ ...declared }) } : null);
  return useMemo(() => {
    if (!declared) return [];
    const freshness = deriveHeadlessFreshness({ shape: "rows" }, { rows: [], freshness: declared }, now);
    const tone = freshness.status === "stale" ? "warning" as const : "muted" as const;
    // A footer too narrow beside its keys gives up the note before any venue's time.
    const [line, ...shorter] = paneStatusLineVariants(freshness).map((text) => [{ text, tone }]);
    return [{ id: "perp-freshness", asOf: true, parts: line!, variants: shorter }];
  }, [declared, now]);
}
