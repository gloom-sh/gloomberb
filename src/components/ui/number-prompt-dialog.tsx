import { useEffect, useRef, useState } from "react";
import { Box, Text, type InputRenderable } from "../../ui";
import type { PromptContext } from "../../ui/dialog";
import { useThemeColors } from "../../theme/theme-context";
import { DialogFrame } from "./frame";
import { TextField } from "./fields";

/** A whole number within [min, max], or null for anything else. */
export function parseWholeNumber(text: string, min: number, max: number): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value >= min && value <= max ? value : null;
}

export interface NumberPromptDialogProps extends PromptContext<number> {
  title: string;
  initialValue: number;
  min: number;
  max: number;
  /** Shown under the field when Enter is pressed on something out of range. */
  invalidMessage: string;
}

/**
 * One prefilled number field. Enter keeps a valid value, Esc closes without
 * one (the dialog host resolves the prompt with undefined).
 */
export function NumberPromptDialog({
  resolve,
  title,
  initialValue,
  min,
  max,
  invalidMessage,
}: NumberPromptDialogProps) {
  const colors = useThemeColors();
  const inputRef = useRef<InputRenderable>(null);
  const [value, setValue] = useState(String(initialValue));
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    inputRef.current?.focus?.();
  }, []);

  return (
    <DialogFrame title={title}>
      <Box flexDirection="column" width={32}>
        <TextField
          inputRef={inputRef}
          value={value}
          focused
          onChange={(next) => {
            setValue(next);
            setInvalid(false);
          }}
          onSubmit={(submitted) => {
            const parsed = parseWholeNumber(submitted, min, max);
            if (parsed === null) setInvalid(true);
            else resolve(parsed);
          }}
        />
        {invalid && (
          <Box height={1}>
            <Text fg={colors.negative}>{invalidMessage}</Text>
          </Box>
        )}
      </Box>
    </DialogFrame>
  );
}
