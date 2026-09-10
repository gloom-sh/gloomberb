import { Box, Text, useUiHost } from "../../ui";
import { TextAttributes } from "../../ui";
import { type ComponentType, type ReactNode } from "react";
import { t } from "../../i18n";
import { type ThemeColors } from "../../theme/colors";
import { resolveTokensForPalette } from "../../theme/tokens";
import { getCurrentStyleId } from "../../theme/colors";
import { useThemeColors, useThemeTokens } from "../../theme/theme-context";

export interface ModalSurfaceOptions {
  width?: string;
  maxHeight?: string;
  /** Set to 0 when the content brings its own padding, e.g. `DialogFrame`. */
  padding?: number;
}

/**
 * Border, background and shadow for a floating panel on the DOM renderer,
 * matching the `.gloom-dialog` surface so the onboarding modal and the hosted
 * terminal's sign-in gate sit at the same elevation as a real dialog.
 */
export function modalSurfaceStyle(colors: ThemeColors, options: ModalSurfaceOptions = {}) {
  const { dialog } = resolveTokensForPalette(colors, getCurrentStyleId());
  return {
    width: options.width ?? "min(540px, 100%)",
    height: "auto",
    maxHeight: options.maxHeight ?? "calc(100vh - 88px)",
    padding: options.padding ?? 14,
    backgroundColor: dialog.surfaceBg,
    border: `1px solid ${dialog.surfaceBorder}`,
    borderRadius: "var(--gloom-radius-pane, 6px)",
    boxShadow: "var(--gloom-shadow-floating, none)",
    boxSizing: "border-box" as const,
    overflowY: "auto" as const,
  };
}

export interface DialogFrameProps {
  title: string;
  children: ReactNode;
  footer?: string;
  showTitleDivider?: boolean;
}

export function DialogFrame({ title: rawTitle, children, footer: rawFooter, showTitleDivider = false }: DialogFrameProps) {
  const title = t(rawTitle);
  const footer = rawFooter === undefined ? undefined : t(rawFooter);
  const tokens = useThemeTokens();
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
        <Text fg={tokens.dialog.titleText} attributes={TextAttributes.BOLD}>{title}</Text>
      </Box>
      <Box height={1} />
      {children}
      {footer && (
        <>
          <Box height={1} />
          <Box height={1}>
            <Text fg={tokens.dialog.subtleText}>{footer}</Text>
          </Box>
        </>
      )}
    </Box>
  );
}
