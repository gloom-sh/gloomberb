import type { ChoiceDialogChoice, TextPromptDialogProps } from "../../../../components";
import { choiceDialog, textPromptDialog } from "../../../../components/ui";
import { teamStore } from "../../../../team/store";
import type { DialogApi, PromptContext } from "../../../../ui/dialog";

/**
 * The questions a thesis flow asks, on the same dialog pattern as the rest
 * of the app: a DialogFrame, kit buttons, and an `Enter save · Esc cancel`
 * footer in the terminal (the desktop shows the keys on the buttons). Every
 * prompt resolves `undefined` when the person backs out.
 */

function ask(dialog: DialogApi, props: Omit<TextPromptDialogProps, keyof PromptContext<string>>): Promise<string | undefined> {
  return textPromptDialog(dialog, {
    ...props,
    footer: props.multiline ? "Enter save · Shift+Enter newline · Esc cancel" : "Enter save · Esc cancel",
    logSource: "cloud.thesis.prompts",
    logMessage: "A thesis text prompt failed",
  });
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

export function promptChoice(
  dialog: DialogApi,
  title: string,
  choices: ChoiceDialogChoice[],
  selectedChoiceId?: string,
): Promise<string | undefined> {
  return choiceDialog(dialog, {
    title,
    choices,
    selectedChoiceId,
    logSource: "cloud.thesis.prompts",
    logMessage: "A thesis choice prompt failed",
  });
}

/** Asks whether a new thesis is personal or shared with a team; returns undefined if cancelled. */
export async function promptThesisScope(
  dialog: DialogApi,
  teams: ReadonlyArray<{ id: string; name: string }>,
): Promise<{ scope: "user" } | { scope: "team"; teamId: string } | undefined> {
  if (teams.length === 0) return { scope: "user" };
  const owner = await promptChoice(dialog, "Whose thesis?", [
    { id: "user", label: "Mine" },
    ...teams.map((team) => ({ id: team.id, label: team.name, description: "Shared with the team; teammates can challenge it." })),
  ], teamStore.getDefaultTeamId() ?? "user");
  if (!owner) return undefined;
  return owner === "user" ? { scope: "user" } : { scope: "team", teamId: owner };
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

