import { Box, Text, useUiHost } from "../../ui";
import { TextAttributes } from "../../ui";
import { type ComponentType, type ReactNode } from "react";
import { t } from "../../i18n";
import { blendHex, type ThemeColors } from "../../theme/colors";
import { useThemeColors } from "../../theme/theme-context";

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
  return {
    width: options.width ?? "min(540px, 100%)",
    height: "auto",
    maxHeight: options.maxHeight ?? "calc(100vh - 88px)",
    padding: options.padding ?? 14,
    backgroundColor: blendHex(colors.panel, colors.bg, 0.12),
    border: `1px solid ${blendHex(colors.border, colors.borderFocused, 0.18)}`,
    borderRadius: 6,
    boxShadow: `0 18px 48px color-mix(in srgb, ${colors.bg} 46%, transparent), inset 0 1px 0 color-mix(in srgb, ${colors.textBright} 5%, transparent)`,
    boxSizing: "border-box" as const,
    overflowY: "auto" as const,
  };
}

export interface DialogFrameProps {
  title: string;
  /** Muted line under the title. */
  subtitle?: string;
  children: ReactNode;
  footer?: string;
  showTitleDivider?: boolean;
  /** Adds a close button at the right of the title (desktop). Esc still closes every dialog. */
  onClose?: () => void;
}

export function DialogFrame({ title: rawTitle, subtitle, children, footer: rawFooter, showTitleDivider = false, onClose }: DialogFrameProps) {
  const title = t(rawTitle);
  const footer = rawFooter === undefined ? undefined : t(rawFooter);
  const colors = useThemeColors();
  const HostDialogFrame = useUiHost().DialogFrame as ComponentType<DialogFrameProps> | undefined;
  if (HostDialogFrame) {
    return (
      <HostDialogFrame title={title} subtitle={subtitle} footer={footer} showTitleDivider={showTitleDivider} onClose={onClose}>
        {children}
      </HostDialogFrame>
    );
  }

  return (
    <Box flexDirection="column">
      <Box height={1}>
        <Text fg={colors.text} attributes={TextAttributes.BOLD}>{title}</Text>
      </Box>
      {subtitle && <Text fg={colors.textMuted} wrapText>{subtitle}</Text>}
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
