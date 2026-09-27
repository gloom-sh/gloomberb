import { forwardRef, useEffect, type ReactNode } from "react";
import { useForwardedScrollBoxRef } from "../../state/pane-scroll-registry";
import { Box, ScrollBox, type ScrollBoxRenderable } from "../../ui";

export interface DetailScrollBodyProps {
  /** Brings the body back to the top when it changes; pass the open item's id. */
  resetScrollKey?: unknown;
  children?: ReactNode;
}

/**
 * The scrolling body of a stack detail, padded a cell on each side and filling
 * the space under the stack header. Give `DataTableStackView` the same ref as
 * `detailScrollRef` so j/k and the arrows read it a line at a time.
 */
export const DetailScrollBody = forwardRef<ScrollBoxRenderable, DetailScrollBodyProps>(
  function DetailScrollBody({ resetScrollKey, children }, ref) {
    const scrollRef = useForwardedScrollBoxRef<ScrollBoxRenderable>(ref);

    useEffect(() => {
      const scrollBox = scrollRef.current;
      if (scrollBox) scrollBox.scrollTop = 0;
    }, [resetScrollKey, scrollRef]);

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
