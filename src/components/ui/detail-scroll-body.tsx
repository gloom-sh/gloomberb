import { forwardRef, useEffect, type ReactNode } from "react";
import { useForwardedScrollBoxRef } from "../../state/pane-scroll-registry";
import { Box, ScrollBox, useUiCapabilities, type ScrollBoxRenderable } from "../../ui";

export interface DetailScrollBodyProps {
  /** Brings the body back to the top when it changes; pass the open item's id. */
  resetScrollKey?: unknown;
  children?: ReactNode;
}

/**
 * On the desktop and the web the scroller itself runs from the stack header
 * to the pane footer, and its inset is padding inside what scrolls: text goes
 * under the footer edge rather than stopping a blank band above it.
 */
const NATIVE_DETAIL_INSET = { padding: "var(--gloom-space-md) var(--gloom-inset) var(--gloom-space-lg)" } as const;

/**
 * The scrolling body of a stack detail, filling the space under the stack
 * header, with its content inset from the pane edges. Give
 * `DataTableStackView` the same ref as `detailScrollRef` so j/k and the
 * arrows read it a line at a time.
 */
export const DetailScrollBody = forwardRef<ScrollBoxRenderable, DetailScrollBodyProps>(
  function DetailScrollBody({ resetScrollKey, children }, ref) {
    const scrollRef = useForwardedScrollBoxRef<ScrollBoxRenderable>(ref);
    const { nativePaneChrome } = useUiCapabilities();

    useEffect(() => {
      const scrollBox = scrollRef.current;
      if (scrollBox) scrollBox.scrollTop = 0;
    }, [resetScrollKey, scrollRef]);

    if (nativePaneChrome) {
      return (
        <ScrollBox
          ref={scrollRef}
          flexGrow={1}
          flexBasis={0}
          minHeight={0}
          scrollY
          focusable={false}
          style={NATIVE_DETAIL_INSET}
          data-gloom-role="detail-scroll-body"
        >
          {children}
        </ScrollBox>
      );
    }

    // The terminal pads a cell on each side, outside the scrolled rows.
    return (
      <Box
        flexDirection="column"
        flexGrow={1}
        flexBasis={0}
        minHeight={0}
        overflow="hidden"
        paddingX={1}
        paddingY={1}
      >
        <ScrollBox
          ref={scrollRef}
          flexGrow={1}
          flexBasis={0}
          minHeight={0}
          scrollY
          focusable={false}
        >
          {children}
        </ScrollBox>
      </Box>
    );
  },
);
