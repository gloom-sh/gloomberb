import { useCallback } from "react";
import { QueryBar, type QueryBarSearchFocus } from "../../../components";
import {
  TWEET_SEARCH_DEBOUNCE_MS,
  type TwitterFeed,
} from "./model";

export function TwitterFeedSearchBar({
  feed,
  focused,
  width,
  searchProps,
  onQueryChange,
}: {
  feed: TwitterFeed;
  focused: boolean;
  width: number;
  searchProps: QueryBarSearchFocus["searchProps"];
  onQueryChange: (feedId: string, query: string) => void;
}) {
  const updateQuery = useCallback((value: string) => {
    onQueryChange(feed.id, value);
  }, [feed.id, onQueryChange]);

  return (
    <QueryBar
      width={width}
      search={{
        value: feed.query,
        onChange: updateQuery,
        placeholder: "$AAPL -filter:replies",
        focused,
        ...searchProps,
        debounceMs: TWEET_SEARCH_DEBOUNCE_MS,
      }}
    />
  );
}
