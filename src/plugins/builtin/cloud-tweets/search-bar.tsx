import { useCallback, type RefObject } from "react";
import type { InputRenderable } from "../../../ui";
import { QueryBar } from "../../../components";
import {
  TWEET_SEARCH_DEBOUNCE_MS,
  type TwitterFeed,
} from "./model";

export function TwitterFeedSearchBar({
  feed,
  focused,
  active,
  width,
  focusToken,
  inputRef,
  onFocus,
  onBlur,
  onNavigateDown,
  onQueryChange,
}: {
  feed: TwitterFeed;
  focused: boolean;
  active: boolean;
  width: number;
  focusToken: number;
  inputRef: RefObject<InputRenderable | null>;
  onFocus: () => void;
  onBlur: () => void;
  onNavigateDown?: () => void;
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
        active,
        onActiveChange: (next) => (next ? onFocus() : onBlur()),
        focusToken,
        inputRef,
        debounceMs: TWEET_SEARCH_DEBOUNCE_MS,
        onNavigateDown,
      }}
    />
  );
}
