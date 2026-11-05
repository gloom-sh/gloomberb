import { StyledText, Text, TextAttributes, useShortcutLabel } from "../../ui";
import { colors } from "../../theme/colors";
import { useRef } from "react";

type ShortcutHintMouseEvent = {
  pixelX?: number;
  pixelY?: number;
  stopPropagation?: () => void;
  preventDefault?: () => void;
};

export interface ShortcutHintProps {
  /** The key as written (`a`, `Enter`, `Ctrl+S`); it shows in the host's notation. */
  hotkey: string;
  label: string;
  prefix?: string;
  disabled?: boolean;
  dataGloomRole?: string;
  onPress?: (event?: ShortcutHintMouseEvent) => void;
}

/** Cells a hint takes, for the key as it shows (useShortcutLabel). */
export function getShortcutHintWidth(hotkey: string, label: string, prefix = ""): number {
  return prefix.length + hotkey.length + label.length + 2;
}

function stopMouseEvent(event?: ShortcutHintMouseEvent) {
  event?.stopPropagation?.();
  event?.preventDefault?.();
}

export function ShortcutHint({
  hotkey,
  label,
  prefix = "",
  disabled = false,
  dataGloomRole,
  onPress,
}: ShortcutHintProps) {
  const interactive = !!onPress && !disabled;
  const keyColor = disabled ? colors.textMuted : colors.textBright;
  const labelColor = disabled ? colors.textMuted : colors.textDim;
  const shownKey = useShortcutLabel()(hotkey);
  const keyText = `[${shownKey}]`;
  const triggerMouseDownRef = useRef(false);
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
      attributes={interactive ? TextAttributes.BOLD : 0}
      onMouseDown={interactive ? startPress : undefined}
      onMouseUp={interactive ? finishPress : undefined}
      {...(dataGloomRole ? { "data-gloom-role": dataGloomRole } : {})}
    />
  );
}
