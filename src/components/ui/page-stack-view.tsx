import { Box, Text, TextAttributes, useUiHost } from "../../ui";
import type { BoxRenderable } from "../../ui/host";
import { useShortcut } from "../../react/input";
import { useCallback, useLayoutEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import { colors } from "../../theme/colors";
import { usePaneShareItem } from "../../shares/pane-item";
import { observeBoxWidth } from "../../renderers/opentui/box-width";
import { clipToDisplayWidth } from "../../utils/format";
import {
  isDetailBackNavigationKey,
  isMouseBackNavigationEvent,
} from "../../utils/back-navigation";

export interface PageStackViewProps {
  focused: boolean;
  detailOpen: boolean;
  onBack: () => void;
  rootContent: ReactNode;
  detailContent: ReactNode;
  detailTitle?: string;
  /** @deprecated Omit it; the back control will always read "Back". */
  backLabel?: string;
  /** @deprecated Omit it; stack headers will not draw a trailing hint. */
  backHint?: string;
}

export function PageStackView({
  focused,
  detailOpen,
  onBack,
  rootContent,
  detailContent,
  detailTitle,
  backLabel = "Back",
  backHint,
}: PageStackViewProps) {
  const HostPageStackView = useUiHost().PageStackView as ComponentType<PageStackViewProps> | undefined;
  // The open detail's title names what the pane is on, for a link to it.
  usePaneShareItem(detailOpen && detailTitle ? { title: detailTitle } : null, { kit: true });
  const props = {
    focused,
    detailOpen,
    onBack,
    rootContent,
    detailContent,
    detailTitle,
    backLabel,
    backHint,
  };
  if (HostPageStackView) {
    return <HostPageStackView {...props} />;
  }

  return <OpenTuiPageStackView {...props} />;
}

/**
 * The item's title on the one row Back sits in: a title longer than the room
 * the row leaves ends in an ellipsis, it never wraps. The room is only known
 * once the row is laid out, so until then the whole title is drawn, clipped
 * by its box.
 */
function StackTitle({ title }: { title: string }) {
  const boxRef = useRef<BoxRenderable>(null);
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => observeBoxWidth(boxRef.current, setWidth), []);
  return (
    <Box ref={boxRef} flexGrow={1} flexShrink={1} flexBasis={0} minWidth={0} overflow="hidden">
      <Text fg={colors.textBright} attributes={TextAttributes.BOLD} wrapMode="none">
        {width === null ? title : clipToDisplayWidth(title, width)}
      </Text>
    </Box>
  );
}

function OpenTuiPageStackView({
  focused,
  detailOpen,
  onBack,
  rootContent,
  detailContent,
  detailTitle,
  backLabel,
  backHint,
}: PageStackViewProps) {
  const goBack = useCallback((event?: {
    preventDefault?: () => void;
    stopPropagation?: () => void;
  }) => {
    event?.stopPropagation?.();
    event?.preventDefault?.();
    onBack();
  }, [onBack]);

  useShortcut((event) => {
    if (!focused || !detailOpen || !isDetailBackNavigationKey(event)) return;
    goBack(event);
  });

  const handleMouseDown = useCallback((event: {
    button?: unknown;
    preventDefault?: () => void;
    stopPropagation?: () => void;
  }) => {
    if (!focused || !detailOpen || !isMouseBackNavigationEvent(event)) return;
    goBack(event);
  }, [detailOpen, focused, goBack]);

  if (!detailOpen) {
    return (
      <Box flexDirection="column" flexGrow={1} flexShrink={1} flexBasis={0} minWidth={0} minHeight={0} overflow="hidden">
        {rootContent}
      </Box>
    );
  }

  return (
    <Box
      flexDirection="column"
      flexGrow={1}
      flexShrink={1}
      flexBasis={0}
      minWidth={0}
      minHeight={0}
      overflow="hidden"
      onMouseDown={handleMouseDown}
    >
      <Box height={1} flexDirection="row">
        <Box
          onMouseDown={(event: { preventDefault?: () => void; stopPropagation?: () => void }) => {
            goBack(event);
          }}
          backgroundColor={colors.selected}
        >
          <Text
            fg={colors.selectedText}
            bg={colors.selected}
            attributes={TextAttributes.BOLD}
          >
            {`← ${backLabel}`}
          </Text>
        </Box>
        {detailTitle ? (
          <>
            <Box width={1} flexShrink={0} />
            <StackTitle title={detailTitle} />
          </>
        ) : (
          <Box flexGrow={1} />
        )}
        {backHint ? <Text fg={colors.textMuted}>{backHint}</Text> : null}
      </Box>
      <Box flexDirection="column" flexGrow={1} flexShrink={1} flexBasis={0} minWidth={0} minHeight={0} overflow="hidden">
        {detailContent}
      </Box>
    </Box>
  );
}
