import { useEffect, useRef, useState } from "react";
import { Button, ChoiceDialog, ConfirmDialog, DialogFrame, TextField, type ChoiceDialogChoice } from "../../../../components";
import { t } from "../../../../i18n";
import { colors } from "../../../../theme/colors";
import { Box, Text, Textarea, type InputRenderable, type TextareaRenderable } from "../../../../ui";
import { type DialogApi, type PromptContext, useDialogKeyboard } from "../../../../ui/dialog";

/**
 * The questions a thesis flow asks, on the same dialog pattern as the rest
 * of the app: a DialogFrame, kit buttons, and an `Enter save · Esc cancel`
 * footer. Every prompt resolves `undefined` when the person backs out.
 */

interface TextDialogProps extends PromptContext<string> {
  title: string;
  body?: string[];
  defaultValue?: string;
  placeholder?: string;
  /** Sentences rather than a name: a taller field where Shift+Enter breaks a line. */
  multiline?: boolean;
  /** Empty is a valid answer (clearing a field) rather than a cancel. */
  allowEmpty?: boolean;
  width?: number;
}

const CANCEL = "\u0000cancel";

function TextDialog({ resolve, dialogId, title, body, defaultValue = "", placeholder, multiline = false, allowEmpty = false, width = 72 }: TextDialogProps) {
  const inputRef = useRef<InputRenderable | null>(null);
  const textareaRef = useRef<TextareaRenderable | null>(null);
  const [value, setValue] = useState(defaultValue);

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
  const save = () => {
    const text = current().trim();
    if (text || allowEmpty) resolve(text);
  };
  const cancel = () => resolve(CANCEL);

  useDialogKeyboard((event) => {
    if (event.name === "escape") {
      event.stopPropagation();
      cancel();
    }
  }, { scope: dialogId, allowEditable: true });

  return (
    <DialogFrame
      title={title}
      footer={multiline ? "Enter save · Shift+Enter newline · Esc cancel" : "Enter save · Esc cancel"}
    >
      <Box flexDirection="column" width={width}>
        {body?.map((line, index) => (
          <Text key={index} fg={colors.textDim} wrapText width={width}>{line ? t(line) : " "}</Text>
        ))}
        {body && body.length > 0 && <Box height={1} />}
        {multiline ? (
          <Box height={5} border borderColor={colors.border} backgroundColor={colors.panel}>
            <Textarea
              ref={textareaRef}
              initialValue={defaultValue}
              placeholder={placeholder ? t(placeholder) : ""}
              focused
              textColor={colors.text}
              placeholderColor={colors.textDim}
              backgroundColor={colors.panel}
              flexGrow={1}
              wrapText
              keyBindings={[
                { name: "return", action: "submit" },
                { name: "linefeed", action: "submit" },
                { name: "return", shift: true, action: "newline" },
                { name: "linefeed", shift: true, action: "newline" },
              ]}
              onSubmit={save}
              onInput={setValue}
            />
          </Box>
        ) : (
          <TextField
            inputRef={inputRef}
            value={value}
            placeholder={placeholder ? t(placeholder) : ""}
            focused
            onChange={setValue}
            onSubmit={save}
          />
        )}
        <Box height={1} />
        <Box flexDirection="row" gap={1}>
          <Button label="Save" variant="primary" onPress={save} />
          <Button label="Cancel" variant="secondary" onPress={cancel} />
        </Box>
      </Box>
    </DialogFrame>
  );
}

async function ask(dialog: DialogApi, props: Omit<TextDialogProps, keyof PromptContext<string>>): Promise<string | undefined> {
  const value = await dialog.prompt<string>({
    content: (context: PromptContext<string>) => <TextDialog {...context} {...props} />,
  }).catch(() => undefined);
  return value === undefined || value === CANCEL ? undefined : value;
}

export function promptText(
  dialog: DialogApi,
  step: { label: string; defaultValue?: string; placeholder?: string; body?: string[]; required?: boolean },
): Promise<string | undefined> {
  return ask(dialog, {
    title: step.label,
    body: step.body,
    defaultValue: step.defaultValue,
    placeholder: step.placeholder,
    allowEmpty: step.required === false,
  });
}

export function promptTextarea(
  dialog: DialogApi,
  step: { label: string; defaultValue?: string; placeholder?: string; body?: string[] },
): Promise<string | undefined> {
  return ask(dialog, {
    title: step.label,
    body: step.body,
    defaultValue: step.defaultValue,
    placeholder: step.placeholder,
    multiline: true,
  });
}

export async function promptChoice(
  dialog: DialogApi,
  title: string,
  choices: ChoiceDialogChoice[],
  selectedChoiceId?: string,
): Promise<string | undefined> {
  const value = await dialog.prompt<string>({
    closeOnClickOutside: true,
    content: (context: PromptContext<string>) => (
      <ChoiceDialog {...context} title={title} choices={choices} selectedChoiceId={selectedChoiceId} />
    ),
  }).catch(() => undefined);
  return value || undefined;
}

/** A pick from labelled options; the same choice dialog as everywhere else. */
export function promptSelect(
  dialog: DialogApi,
  step: { label: string; options: Array<{ label: string; value: string; description?: string }>; defaultValue?: string; body?: string[] },
): Promise<string | undefined> {
  // ChoiceDialog ids must be non-empty; an empty "none" value gets a stand-in.
  const NONE = "\u0000none";
  return promptChoice(
    dialog,
    step.label,
    step.options.map((option) => ({
      id: option.value || NONE,
      label: option.label,
      ...(option.description ? { description: option.description } : {}),
    })),
    step.defaultValue || (step.options.some((option) => option.value === "") ? NONE : undefined),
  ).then((value) => (value === NONE ? "" : value));
}

export async function promptNumber(
  dialog: DialogApi,
  step: { label: string; defaultValue?: number; placeholder?: string; body?: string[]; min?: number; max?: number; integer?: boolean },
): Promise<number | undefined> {
  for (;;) {
    const raw = await promptText(dialog, {
      label: step.label,
      placeholder: step.placeholder,
      body: step.body,
      defaultValue: step.defaultValue === undefined ? undefined : String(step.defaultValue),
    });
    if (raw === undefined) return undefined;
    const value = Number(raw.replace(/[,%x\s]/g, ""));
    const valid = Number.isFinite(value)
      && (!step.integer || Number.isInteger(value))
      && (step.min === undefined || value >= step.min)
      && (step.max === undefined || value <= step.max);
    if (valid) return value;
  }
}

export async function confirm(
  dialog: DialogApi,
  options: { title: string; body: string | string[]; confirmLabel: string; danger?: boolean },
): Promise<boolean> {
  const value = await dialog.prompt<boolean>({
    content: (context: PromptContext<boolean>) => (
      <ConfirmDialog
        {...context}
        title={options.title}
        body={options.body}
        confirmLabel={options.confirmLabel}
        confirmVariant={options.danger ? "danger" : "primary"}
      />
    ),
  }).catch(() => undefined);
  return value === true;
}
