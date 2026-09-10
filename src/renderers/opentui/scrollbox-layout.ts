import type { ScrollBoxRenderable as NativeScrollBoxRenderable } from "@opentui/core";
import type { ScrollBoxRenderable } from "../../ui/host";

/** Observe computed native content layout after ScrollBox updates its range. */
export function observeScrollBoxContentSize(
  scrollBox: ScrollBoxRenderable | null,
  onSizeChange: () => void,
): (() => void) | undefined {
  const content = (scrollBox as NativeScrollBoxRenderable | null)?.content;
  if (!content) return;
  // Computed layout invokes onSizeChange, not the explicit resize event.
  // Preserve the internal handler that recalculates the scrollbars.
  const previousSizeChange = content.onSizeChange;
  const handleContentSizeChange = () => {
    previousSizeChange?.call(content);
    onSizeChange();
  };
  content.onSizeChange = handleContentSizeChange;
  return () => {
    if (content.onSizeChange === handleContentSizeChange) {
      content.onSizeChange = previousSizeChange;
    }
  };
}
