import { type ComponentType } from "react";
import { t } from "../../i18n";
import { useThemeColors } from "../../theme/theme-context";
import { Text, useShortcutLabel, useUiHost } from "../../ui";
import type { DialogKeyHint } from "./frame";

export interface KeyHintsProps {
  keys: DialogKeyHint[];
  /** The keys' and words' colour, for hints on a surface of their own; a dialog's hint colours otherwise. */
  color?: string;
}

/**
 * The terminal's form of `keys`, as a dialog's footer line says them:
 * "Enter here · Shift+Enter new pane". `formatKey` writes each key in the
 * host's notation (useShortcutLabel).
 */
export function keyHintsText(keys: readonly DialogKeyHint[], formatKey: (key: string) => string = (key) => key): string {
  return keys.map((hint) => `${formatKey(hint.key)} ${t(hint.label)}`).join(" · ");
}

/**
 * Keys and what they do, as one quiet line that is not a button: on the
 * desktop and the web a keycap and a word each, as a dialog's hints beside its
 * buttons; in the terminal the words of a dialog's footer line. Nothing here
 * takes the pointer; whatever the keys run has its own control.
 */
export function KeyHints({ keys, color }: KeyHintsProps) {
  const HostKeyHints = useUiHost().KeyHints as ComponentType<KeyHintsProps> | undefined;
  const colors = useThemeColors();
  const formatKey = useShortcutLabel();
  if (HostKeyHints) return <HostKeyHints keys={keys} color={color} />;
  return <Text fg={color ?? colors.textMuted}>{keyHintsText(keys, formatKey)}</Text>;
}
