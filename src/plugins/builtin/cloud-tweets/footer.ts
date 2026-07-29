import { useMemo } from "react";
import type { PaneFooterSegment } from "../../../components";
import { formatTimeAgo } from "../../../utils/format";
import {
  TWITTER_FEED_PANE_ID,
  type TwitterFeed,
} from "./model";
import { usePaneStatusFooter } from "../shared/pane-footer";

export function useTwitterFeedFooter({
  activeFeed,
}: {
  activeFeed: TwitterFeed | null;
}) {
  const info = useMemo<PaneFooterSegment[]>(() => (
    activeFeed?.lastSuccessAt
      ? [{ id: "last", parts: [{ text: `ran ${formatTimeAgo(new Date(activeFeed.lastSuccessAt))}`, tone: "muted" }] }]
      : []
  ), [activeFeed?.lastSuccessAt]);
  usePaneStatusFooter({ registrationId: TWITTER_FEED_PANE_ID, info });
}
