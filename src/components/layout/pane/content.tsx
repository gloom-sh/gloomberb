import { memo, useCallback } from "react";
import { useAppLanguage } from "../../../i18n/react";
import { PaneInstanceProvider } from "../../../state/app/context";
import { useThemeColors } from "../../../theme/theme-context";
import { PaneKeyboardScrollController } from "../../../state/pane-scroll-registry";
import type { PaneDef } from "../../../types/plugin";
import { Box } from "../../../ui";

interface PaneContentProps {
  component: PaneDef["component"];
  paneId: string;
  paneType: string;
  focused: boolean;
  width: number;
  height: number;
  onClose?: (paneId: string) => void;
}

export const PaneContent = memo(function PaneContent({
  component: Component,
  paneId,
  paneType,
  focused,
  width,
  height,
  onClose,
}: PaneContentProps) {
  useAppLanguage();
  useThemeColors();
  const close = useCallback(() => {
    onClose?.(paneId);
  }, [onClose, paneId]);

  return (
    <PaneInstanceProvider paneId={paneId}>
      <PaneKeyboardScrollController paneId={paneId} focused={focused} />
      <Box
        flexDirection="column"
        flexGrow={1}
        flexShrink={1}
        flexBasis={0}
        minWidth={0}
        minHeight={0}
        overflow="hidden"
        data-gloom-role="pane-content"
      >
        <Component
          paneId={paneId}
          paneType={paneType}
          focused={focused}
          width={width}
          height={height}
          close={onClose ? close : undefined}
        />
      </Box>
    </PaneInstanceProvider>
  );
});
