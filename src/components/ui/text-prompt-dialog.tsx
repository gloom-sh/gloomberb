import { useEffect, useRef, useState } from "react";
import { Box, Text, Textarea, useUiCapabilities, type InputRenderable, type TextareaRenderable } from "../../ui";
import { t } from "../../i18n";
import { useDialogKeyboard, type PromptContext } from "../../ui/dialog";
import { useThemeColors } from "../../theme/theme-context";
import { Button } from "./button";
import { FRAMED_TEXTAREA_DESKTOP_STYLE, TextField } from "./fields";
import { DialogFrame } from "./frame";

export interface TextPromptDialogProps extends PromptContext<string> {
  title: string;
  /** Lines above the field; an empty string is a blank line. */
  body?: string[];
  /** Label above the field. */
  label?: string;
  initialValue?: string;
  placeholder?: string;
  /** The primary button. */
  confirmLabel?: string;
  /** Sentences rather than a name: a taller field where Shift+Enter breaks a line. */
  multiline?: boolean;
  /** Lines the multiline field shows. */
  rows?: number;
  /** Empty is an answer (clearing a value) rather than nothing to save. */
  allowEmpty?: boolean;
  width?: number;
  footer?: string;
}

/**
 * Asks for one line of text, or a few with `multiline`. Enter or the primary
 * button resolves the trimmed value; Esc and Cancel close without one (the
 * prompt resolves undefined).
 */
export function TextPromptDialog({
  resolve,
  dismiss,
  title,
  body,
  label,
  initialValue = "",
  placeholder,
  confirmLabel = "Save",
  multiline = false,
  rows = 3,
  allowEmpty = false,
  width = 72,
  footer,
}: TextPromptDialogProps) {
  const colors = useThemeColors();
  const { nativePaneChrome } = useUiCapabilities();
  const inputRef = useRef<InputRenderable | null>(null);
  const textareaRef = useRef<TextareaRenderable | null>(null);
  const [value, setValue] = useState(initialValue);

  useEffect(() => {
    (multiline ? textareaRef.current : inputRef.current)?.focus?.();
  }, [multiline]);

  const current = () => {
    if (!multiline) return value;
    try {
      return textareaRef.current?.editBuffer.getText() ?? value;
    } catch {
      return value;
    }
  };
  // The one-line field submits the text it holds, which can be ahead of the
  // last render when Enter arrives with the typing (a paste, a fast typist).
  const submit = (text: string) => {
    const trimmed = text.trim();
    if (trimmed || allowEmpty) resolve(trimmed);
  };

  useDialogKeyboard((event) => {
    if (event.name !== "escape") return;
    event.stopPropagation();
    dismiss();
  }, { allowEditable: true });

  const shownPlaceholder = placeholder ? t(placeholder) : "";
  return (
    <DialogFrame title={title} footer={footer}>
      <Box flexDirection="column" width={width}>
        {body?.map((line, index) => (
          <Text key={index} fg={colors.textDim} wrapText width={width}>{line ? t(line) : " "}</Text>
        ))}
        {body && body.length > 0 && <Box height={1} />}
        {multiline ? (
          <Box height={rows + 2} border borderColor={colors.border} backgroundColor={colors.panel}>
            <Textarea
              ref={textareaRef}
              initialValue={initialValue}
              placeholder={shownPlaceholder}
              focused
              textColor={colors.text}
              placeholderColor={colors.textDim}
              backgroundColor={colors.panel}
              flexGrow={1}
              wrapText
              {...(nativePaneChrome ? { style: FRAMED_TEXTAREA_DESKTOP_STYLE } : {})}
              keyBindings={[
                { name: "return", action: "submit" },
                { name: "linefeed", action: "submit" },
                { name: "return", shift: true, action: "newline" },
                { name: "linefeed", shift: true, action: "newline" },
              ]}
              onSubmit={() => submit(current())}
              onInput={setValue}
            />
          </Box>
        ) : (
          <TextField
            inputRef={inputRef}
            label={label ? t(label) : undefined}
            value={value}
            placeholder={shownPlaceholder}
            focused
            width={width}
            onChange={setValue}
            onSubmit={submit}
          />
        )}
        <Box height={1} />
        <Box flexDirection="row" gap={1}>
          {/* A textarea is read when it submits, so its button stays live. */}
          <Button label={confirmLabel} variant="primary" disabled={!multiline && !allowEmpty && !value.trim()} onPress={() => submit(current())} />
          <Button label="Cancel" variant="secondary" onPress={dismiss} />
        </Box>
      </Box>
    </DialogFrame>
  );
}
