import type { ReactNode, RefObject } from "react";
import { ScrollBox, useUiHost, type ScrollBoxRenderable } from "../../ui";

/** A variable-height list. The terminal keeps its ordinary, unwindowed rows. */
export interface WindowedListProps {
  itemKeys: readonly string[];
  renderItem: (index: number) => ReactNode;
  scrollRef: RefObject<ScrollBoxRenderable | null>;
  /** Pixel estimate only; mounted rows are measured at their actual CSS width. */
  estimateSize?: number;
  overscan?: number;
  onScrollActivity?: (event?: { scroll?: { direction?: "up" | "down" | "left" | "right" } }) => void;
  onPinChange?: (pinned: boolean) => void;
  onPointerMove?: (event: { target?: unknown; pixelX?: number; pixelY?: number }) => void;
  role?: string;
}

export function WindowedList(props: WindowedListProps) {
  const HostList = useUiHost().WindowedList;
  if (HostList) return <HostList {...props} />;
  return <ScrollBox ref={props.scrollRef} flexGrow={1} scrollY stickyScroll stickyStart="bottom"
    data-gloom-role={props.role} onMouseScroll={props.onScrollActivity}
    onMouseMove={props.onPointerMove} onStickyPinChange={props.onPinChange}
    style={{ minHeight: 0, display: "block" }}>
    {props.itemKeys.map((_, index) => props.renderItem(index))}
  </ScrollBox>;
}
