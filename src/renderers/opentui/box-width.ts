import type { BoxRenderable as NativeBoxRenderable } from "@opentui/core";
import type { BoxRenderable } from "../../ui/host";

/**
 * Calls `listener` with a box's laid-out width in cells, now if it has one and
 * after every layout that changes it. For text that has to be cut to the room
 * a flex row gives it, which only the layout knows. Returns the unsubscribe.
 */
export function observeBoxWidth(
  box: BoxRenderable | null,
  listener: (width: number) => void,
): (() => void) | undefined {
  const native = box as NativeBoxRenderable | null;
  if (!native) return;
  const report = () => {
    const width = native.width;
    if (typeof width === "number" && width > 0) listener(width);
  };
  report();
  // Computed layout invokes onSizeChange; keep whoever else listens.
  const previous = native.onSizeChange;
  const handleSizeChange = () => {
    previous?.call(native);
    report();
  };
  native.onSizeChange = handleSizeChange;
  return () => {
    if (native.onSizeChange === handleSizeChange) native.onSizeChange = previous;
  };
}
