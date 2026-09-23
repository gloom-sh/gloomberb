import { useShortcut } from "../../../react/input";
import { isPlainKey } from "../../../utils/keyboard";
import type { TwitterFeed } from "./model";

export function useTwitterFeedKeyboard({
  activeFeed,
  addFeed,
  blurSearch,
  cycleFeeds,
  focusSearch,
  focused,
  removeFeed,
  searchFocused,
  tweetOpen,
}: {
  activeFeed: TwitterFeed | null;
  addFeed: () => void;
  blurSearch: () => void;
  cycleFeeds: (direction: -1 | 1) => void;
  /** Also leaves an open tweet: the search bar sits above the list. */
  focusSearch: () => void;
  focused: boolean;
  removeFeed: (feedId: string) => void;
  searchFocused: boolean;
  /** A tweet's detail is on screen instead of the list. */
  tweetOpen: boolean;
}) {
  useShortcut((event) => {
    if (!focused) return;

    if (searchFocused) {
      if (event.name === "escape") {
        event.preventDefault?.();
        event.stopPropagation?.();
        blurSearch();
      }
      return;
    }

    if (isPlainKey(event, "n")) {
      event.preventDefault?.();
      event.stopPropagation?.();
      addFeed();
      return;
    }
    if (isPlainKey(event, "/") || (event.sequence === "/" && !event.ctrl && !event.meta && !event.alt)) {
      event.preventDefault?.();
      event.stopPropagation?.();
      focusSearch();
      return;
    }
    // Deleting the whole feed from inside one of its tweets is never what d meant.
    if (isPlainKey(event, "d") && activeFeed && !tweetOpen) {
      event.preventDefault?.();
      event.stopPropagation?.();
      removeFeed(activeFeed.id);
      return;
    }
    if (isPlainKey(event, "[", "]")) {
      event.preventDefault?.();
      event.stopPropagation?.();
      cycleFeeds(event.name === "[" ? -1 : 1);
    }
  }, { allowEditable: true });
}
