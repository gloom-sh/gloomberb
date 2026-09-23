import { useMemo } from "react";
import type { PaneFooterSegment, PaneHint } from "../../../components";
import { formatTimeAgo } from "../../../utils/format";
import {
  TWITTER_FEED_PANE_ID,
  type TwitterFeed,
} from "./model";
import { usePaneStatusFooter } from "../shared/pane-footer";

export function useTwitterFeedFooter({
  activeFeed,
  addFeed,
  focusSearch,
  removeFeed,
}: {
  activeFeed: TwitterFeed | null;
  addFeed: () => void;
  focusSearch: () => void;
  removeFeed: (feedId: string) => void;
}) {
  const info = useMemo<PaneFooterSegment[]>(() => (
    activeFeed?.lastSuccessAt
      ? [{ id: "last", parts: [{ text: `ran ${formatTimeAgo(new Date(activeFeed.lastSuccessAt))}`, tone: "muted" }] }]
      : []
  ), [activeFeed?.lastSuccessAt]);
  // The same keys the pane handles; [ and ] stay implicit because the feed
  // tabs already switch feeds.
  const activeFeedId = activeFeed?.id ?? null;
  const hints = useMemo<PaneHint[]>(() => [
    { id: "search", key: "/", label: "search", onPress: focusSearch },
    { id: "new-feed", key: "n", label: "ew feed", onPress: addFeed },
    ...(activeFeedId ? [{ id: "remove-feed", key: "d", label: " remove feed", onPress: () => removeFeed(activeFeedId) }] : []),
  ], [activeFeedId, addFeed, focusSearch, removeFeed]);
  usePaneStatusFooter({ registrationId: TWITTER_FEED_PANE_ID, info, hints });
}
