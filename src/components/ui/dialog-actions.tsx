import { type ComponentType, type ReactNode } from "react";
import { Box, Text, useUiHost } from "../../ui";
import { t } from "../../i18n";
import { useThemeColors } from "../../theme/theme-context";
import type { DialogDesktopFooter, DialogKeyHint } from "./frame";

export interface DialogActionsProps {
  /** The dialog's buttons. */
  children: ReactNode;
  /** The buttons sit at the right, as a form's Cancel and Submit do. */
  alignEnd?: boolean;
  /** Buttons that do not fit wrap to another row. */
  wrap?: boolean;
  /**
   * Desktop and web: keys no button carries and a quiet note, across from
   * the buttons. The terminal says these in the dialog's footer line.
   */
  hints?: DialogDesktopFooter;
}

/**
 * The row of buttons that answers a dialog. On the desktop and the web the
 * buttons show their keys and `hints` sit on the same row, so the dialog
 * needs no key line under it.
 */
export function DialogActions({ children, alignEnd = false, wrap = false, hints }: DialogActionsProps) {
  const HostDialogActions = useUiHost().DialogActions as ComponentType<DialogActionsProps> | undefined;
  if (HostDialogActions) {
    return <HostDialogActions alignEnd={alignEnd} wrap={wrap} hints={hints}>{children}</HostDialogActions>;
  }
  return (
    <Box
      flexDirection="row"
      gap={1}
      {...(alignEnd ? { justifyContent: "flex-end" as const } : {})}
      {...(wrap ? { flexWrap: "wrap" as const } : {})}
    >
      {children}
    </Box>
  );
}

export interface DialogHintsProps {
  keys?: DialogKeyHint[];
  note?: string;
}

/**
 * Keys and a note for a dialog that has no button to put them on, such as a
 * sign-in code waiting for a phone: keycaps on the desktop and the web, one
 * muted line in the terminal.
 */
export function DialogHints({ keys = [], note }: DialogHintsProps) {
  const colors = useThemeColors();
  const HostDialogHints = useUiHost().DialogHints as ComponentType<DialogHintsProps> | undefined;
  if (HostDialogHints) return <HostDialogHints keys={keys} note={note} />;
  const parts = [...keys.map((hint) => `${hint.key} ${t(hint.label)}`), ...(note ? [t(note)] : [])];
  if (parts.length === 0) return null;
  return (
    <Box height={1}>
      <Text fg={colors.textMuted}>{parts.join(" · ")}</Text>
    </Box>
  );
}
