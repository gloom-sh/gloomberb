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
  tweetOpen,
}: {
  activeFeed: TwitterFeed | null;
  addFeed: () => void;
  focusSearch: () => void;
  removeFeed: (feedId: string) => void;
  tweetOpen: boolean;
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
    // Deleting the whole feed from inside one of its tweets is never what d meant.
    ...(activeFeedId && !tweetOpen
      ? [{ id: "remove-feed", key: "d", label: " remove feed", onPress: () => removeFeed(activeFeedId) }]
      : []),
  ], [activeFeedId, addFeed, focusSearch, removeFeed, tweetOpen]);
  usePaneStatusFooter({ registrationId: TWITTER_FEED_PANE_ID, info, hints });
}
