import { Box, Text, useUiHost } from "../../ui";
import { TextAttributes } from "../../ui";
import { type ComponentType, type ReactNode } from "react";
import { t } from "../../i18n";
import type { ThemeColors } from "../../theme/colors";
import { RADIUS, SPACE, controlBorderColour, surfaceRaisedColour } from "../../theme/ui-tokens";
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
    padding: options.padding ?? SPACE.lg,
    // The floating surface (docs/pane-conventions.md, "Dialogs, menus and surfaces").
    backgroundColor: surfaceRaisedColour(colors),
    border: `1px solid ${controlBorderColour(colors)}`,
    borderRadius: RADIUS.lg,
    boxShadow: "var(--gloom-elevation)",
    boxSizing: "border-box" as const,
    overflowY: "auto" as const,
  };
}

/**
 * Desktop and web: what the pointer is over, explained (a heat map tile, a
 * map feature, a flow's relationship): the floating surface at its smallest,
 * the raised fill, the control border, the surface radius and the one
 * elevation, the app's type, 4px by 8px inside. A tooltip never takes the
 * pointer.
 */
export const TOOLTIP_SURFACE_STYLE = {
  background: "var(--gloom-surface-raised)",
  border: "1px solid var(--gloom-control-border)",
  borderRadius: "var(--gloom-radius-lg)",
  boxShadow: "var(--gloom-elevation)",
  padding: "var(--gloom-space-xs) var(--gloom-space-sm)",
  fontSize: "var(--gloom-type-ui)",
  boxSizing: "border-box",
  pointerEvents: "none",
} as const;

/** A key and what it does, drawn on the desktop and the web as a keycap and a word. */
export interface DialogKeyHint {
  /** As the terminal names it: "Enter", "Esc", "Shift+Enter", "Tab", "↑↓", "y". */
  key: string;
  /** What it does, short and lowercase; translated where it is drawn. */
  label: string;
}

/**
 * What a dialog's footer says on the desktop and the web. The buttons there
 * carry their own keys, so this keeps only keys no button has and a quiet
 * note, such as a deadline.
 */
export interface DialogDesktopFooter {
  keys?: DialogKeyHint[];
  /** After the keys; translated where it is drawn. */
  note?: string;
}

/**
 * A form dialog's width, in cells: pane settings and New Portfolio, whose
 * broker connect step fits in it (its QR code, the link, the note wrapped),
 * and the browser sign-in dialogs, which match that step.
 */
export const FORM_DIALOG_WIDTH = 68;

/**
 * Desktop and web: the width of a dialog body laid out `columns` cells wide,
 * narrowed to fit a phone, where the fixed width would run past the edge.
 */
export function fitDialogWidth(columns: number): string {
  return `min(calc(var(--cell-w) * ${columns}), calc(100vw - 80px))`;
}

export interface DialogFrameProps {
  title: string;
  /** Muted line under the title. */
  subtitle?: string;
  children: ReactNode;
  /** The terminal's key line under the dialog. */
  footer?: string;
  /**
   * Desktop and web: what shows instead of `footer`; `null` shows nothing.
   * Left out, `footer` shows there as one quiet line.
   */
  desktopFooter?: DialogDesktopFooter | null;
  showTitleDivider?: boolean;
  /** Adds a close button at the right of the title (desktop). Esc still closes every dialog. */
  onClose?: () => void;
  /**
   * Desktop: lets the frame shrink inside a dialog that caps its height, so a
   * scrolling body in it gives up the height and the rows after it stay in view.
   */
  shrinkable?: boolean;
}

export function DialogFrame({ title: rawTitle, subtitle, children, footer: rawFooter, desktopFooter, showTitleDivider = false, onClose, shrinkable }: DialogFrameProps) {
  const title = t(rawTitle);
  const footer = rawFooter === undefined ? undefined : t(rawFooter);
  const colors = useThemeColors();
  const HostDialogFrame = useUiHost().DialogFrame as ComponentType<DialogFrameProps> | undefined;
  if (HostDialogFrame) {
    return (
      <HostDialogFrame title={title} subtitle={subtitle} footer={footer} desktopFooter={desktopFooter} showTitleDivider={showTitleDivider} onClose={onClose} shrinkable={shrinkable}>
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
