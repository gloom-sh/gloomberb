import { ChoiceDialog, TextPromptDialog, type ChoiceDialogChoice, type TextPromptDialogProps } from "../../../../components";
import type { DialogApi, PromptContext } from "../../../../ui/dialog";

/**
 * The questions a thesis flow asks, on the same dialog pattern as the rest
 * of the app: a DialogFrame, kit buttons, and an `Enter save · Esc cancel`
 * footer. Every prompt resolves `undefined` when the person backs out.
 */

async function ask(dialog: DialogApi, props: Omit<TextPromptDialogProps, keyof PromptContext<string>>): Promise<string | undefined> {
  return dialog.prompt<string>({
    content: (context) => (
      <TextPromptDialog
        {...context}
        {...props}
        footer={props.multiline ? "Enter save · Shift+Enter newline · Esc cancel" : "Enter save · Esc cancel"}
      />
    ),
  }).catch(() => undefined);
}

export function promptText(
  dialog: DialogApi,
  step: { label: string; defaultValue?: string; placeholder?: string; body?: string[]; required?: boolean },
): Promise<string | undefined> {
  return ask(dialog, {
    title: step.label,
    body: step.body,
    initialValue: step.defaultValue,
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
    initialValue: step.defaultValue,
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

