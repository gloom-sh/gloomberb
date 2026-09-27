import { useShortcut } from "../../../react/input";
import { isPlainKey } from "../../../utils/keyboard";

/** `/`, `n` and `d` are footer hints (see footer.ts), which bind their own keys. */
export function useTwitterFeedKeyboard({
  blurSearch,
  cycleFeeds,
  focused,
  searchFocused,
}: {
  blurSearch: () => void;
  cycleFeeds: (direction: -1 | 1) => void;
  focused: boolean;
  searchFocused: boolean;
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

    if (isPlainKey(event, "[", "]")) {
      event.preventDefault?.();
      event.stopPropagation?.();
      cycleFeeds(event.name === "[" ? -1 : 1);
    }
  }, { allowEditable: true });
}
