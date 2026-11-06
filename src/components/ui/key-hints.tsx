import { type ComponentType } from "react";
import { t } from "../../i18n";
import { useThemeColors } from "../../theme/theme-context";
import { Text, useShortcutLabel, useUiHost } from "../../ui";
import type { DialogKeyHint } from "./frame";

/** A press on a key hint, with where it landed, for a menu that opens at the pointer. */
interface KeyHintPressEvent {
  pixelX?: number;
  pixelY?: number;
  stopPropagation?: () => void;
  preventDefault?: () => void;
}

export interface KeyHintProps {
  /** The key as written (`s`, `Enter`, `Ctrl+S`); it shows in the host's notation. */
  keyName: string;
  /** The whole words, without the key: "series", "new pane". */
  label: string;
  /** A hint that runs its action when pressed; it brightens under the pointer. */
  onPress?: (event?: KeyHintPressEvent) => void;
  disabled?: boolean;
  /** The words' colour, for a hint on a surface of its own; the key stays a step brighter. */
  color?: string;
  dataGloomRole?: string;
}

/**
 * One key and what it does, the one look every key hint has on the desktop
 * and the web: a pane footer's hints, a dialog's and the command bar
 * prompt's. The key sits in a faint keycap before the words, the words in the
 * muted tone and the key a step brighter, none of it bold. The terminal has
 * its own forms (a footer's `[s]eries`, a dialog line's `Enter here`), so this
 * draws the key and the words there only where nothing else does.
 */
export function KeyHint({ keyName, label, onPress, disabled, color, dataGloomRole }: KeyHintProps) {
  const HostKeyHint = useUiHost().KeyHint as ComponentType<KeyHintProps> | undefined;
  const colors = useThemeColors();
  const formatKey = useShortcutLabel();
  if (HostKeyHint) {
    return <HostKeyHint keyName={keyName} label={label} onPress={onPress} disabled={disabled} color={color} dataGloomRole={dataGloomRole} />;
  }
  return <Text fg={color ?? colors.textMuted}>{label ? `${formatKey(keyName)} ${label}` : formatKey(keyName)}</Text>;
}

export interface KeyHintsProps {
  keys: DialogKeyHint[];
  /** The words' colour, for hints on a surface of their own (KeyHint's `color`). */
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
 * desktop and the web a KeyHint each, as a dialog's hints beside its buttons;
 * in the terminal the words of a dialog's footer line. Nothing here takes the
 * pointer; whatever the keys run has its own control.
 */
export function KeyHints({ keys, color }: KeyHintsProps) {
  const HostKeyHints = useUiHost().KeyHints as ComponentType<KeyHintsProps> | undefined;
  const colors = useThemeColors();
  const formatKey = useShortcutLabel();
  if (HostKeyHints) return <HostKeyHints keys={keys} color={color} />;
  return <Text fg={color ?? colors.textMuted}>{keyHintsText(keys, formatKey)}</Text>;
}
