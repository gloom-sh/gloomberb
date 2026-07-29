import { Box, Text, TextAttributes, useUiHost } from "../../ui";
import { useShortcut } from "../../react/input";
import { useCallback, type ComponentType, type ReactNode } from "react";
import { colors } from "../../theme/colors";
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
  backLabel?: string;
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
            <Box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
              <Text fg={colors.textBright} attributes={TextAttributes.BOLD}>
                {detailTitle}
              </Text>
            </Box>
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
