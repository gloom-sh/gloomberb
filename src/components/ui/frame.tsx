import { Box, Text, useUiHost } from "../../ui";
import { TextAttributes } from "../../ui";
import { type ComponentType, type ReactNode } from "react";
import { t } from "../../i18n";
import { useThemeColors } from "../../theme/theme-context";

export interface DialogFrameProps {
  title: string;
  children: ReactNode;
  footer?: string;
  showTitleDivider?: boolean;
}

export function DialogFrame({ title: rawTitle, children, footer: rawFooter, showTitleDivider = false }: DialogFrameProps) {
  const title = t(rawTitle);
  const footer = rawFooter === undefined ? undefined : t(rawFooter);
  const colors = useThemeColors();
  const HostDialogFrame = useUiHost().DialogFrame as ComponentType<DialogFrameProps> | undefined;
  if (HostDialogFrame) {
    return (
      <HostDialogFrame title={title} footer={footer} showTitleDivider={showTitleDivider}>
        {children}
      </HostDialogFrame>
    );
  }

  return (
    <Box flexDirection="column">
      <Box height={1}>
        <Text fg={colors.text} attributes={TextAttributes.BOLD}>{title}</Text>
      </Box>
      <Box height={1} />
      {children}
      {footer && (
        <>
          <Box height={1} />
          <Box height={1}>
            <Text fg={colors.textMuted}>{footer}</Text>
          </Box>
        </>
      )}
    </Box>
  );
}
