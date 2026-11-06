import { StyledText, Text, useShortcutLabel, useUiHost } from "../../ui";
import { colors } from "../../theme/colors";
import { useRef } from "react";
import { KeyHint } from "./key-hints";
import { keyHintWords } from "./key-hint-words";

type ShortcutHintMouseEvent = {
  pixelX?: number;
  pixelY?: number;
  stopPropagation?: () => void;
  preventDefault?: () => void;
};

export interface ShortcutHintProps {
  /** The key as written (`a`, `Enter`, `Ctrl+S`); it shows in the host's notation. */
  hotkey: string;
  /** What the terminal writes after `[key]`: `eries` for `[s]eries`, ` remove` for `[x] remove`. */
  label: string;
  /**
   * The whole words the desktop and the web show after the keycap ("series").
   * Read from `hotkey` and `label` when left out (keyHintWords).
   */
  words?: string;
  prefix?: string;
  disabled?: boolean;
  dataGloomRole?: string;
  onPress?: (event?: ShortcutHintMouseEvent) => void;
}

/** Cells a hint takes in the terminal, for the key as it shows (useShortcutLabel). */
export function getShortcutHintWidth(hotkey: string, label: string, prefix = ""): number {
  return prefix.length + hotkey.length + label.length + 2;
}

function stopMouseEvent(event?: ShortcutHintMouseEvent) {
  event?.stopPropagation?.();
  event?.preventDefault?.();
}

/**
 * A key and its action: `[s]eries` in the terminal, the key brightest; on the
 * desktop and the web the KeyHint every key hint shares, the key in a keycap
 * before the whole word.
 */
export function ShortcutHint({
  hotkey,
  label,
  words,
  prefix = "",
  disabled = false,
  dataGloomRole,
  onPress,
}: ShortcutHintProps) {
  const desktop = !!useUiHost().KeyHint;
  const interactive = !!onPress && !disabled;
  const keyColor = disabled ? colors.textMuted : colors.textBright;
  const labelColor = disabled ? colors.textMuted : colors.textDim;
  const shownKey = useShortcutLabel()(hotkey);
  const keyText = `[${shownKey}]`;
  const triggerMouseDownRef = useRef(false);
  if (desktop) {
    return (
      <KeyHint
        keyName={hotkey}
        label={words ?? keyHintWords({ key: hotkey, label })}
        onPress={interactive ? onPress : undefined}
        disabled={disabled}
        dataGloomRole={dataGloomRole}
      />
    );
  }
  const startPress = (event?: ShortcutHintMouseEvent) => {
    triggerMouseDownRef.current = true;
    stopMouseEvent(event);
  };
  const finishPress = (event?: ShortcutHintMouseEvent) => {
    const startedOnTrigger = triggerMouseDownRef.current;
    triggerMouseDownRef.current = false;
    if (startedOnTrigger) onPress?.(event);
    else stopMouseEvent(event);
  };

  return (
    <Text
      width={getShortcutHintWidth(shownKey, label, prefix)}
      content={new StyledText([
        ...(prefix ? [{ text: prefix, fg: labelColor }] : []),
        { text: keyText, fg: keyColor },
        { text: label, fg: labelColor },
      ])}
      fg={disabled ? colors.textMuted : colors.textDim}
      onMouseDown={interactive ? startPress : undefined}
      onMouseUp={interactive ? finishPress : undefined}
      {...(dataGloomRole ? { "data-gloom-role": dataGloomRole } : {})}
    />
  );
}
