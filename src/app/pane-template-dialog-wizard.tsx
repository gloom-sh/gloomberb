import {
  PaneTemplateInfoStep,
  PaneTemplateInputStep,
  PaneTemplateSelectStep,
  PaneTemplateTextareaStep,
} from "../components/pane-template-wizard";
import {
  dependenciesMet,
  keysClearedByChange,
  wizardStepInitialValue,
} from "../components/command-bar/workflow/fields";
import type {
  AlertContext,
  DialogApi,
  PromptContext,
} from "../ui/dialog";
import type { WizardStep } from "../types/plugin";

/**
 * Asks a template's wizard steps one dialog at a time, on the same step rules
 * as the command-bar form. A change that clears later answers drops those
 * steps' defaults, since they have not been asked yet.
 */
export async function runPaneTemplateDialogWizard(
  dialog: DialogApi,
  steps: WizardStep[],
): Promise<Record<string, string> | null> {
  const values: Record<string, string> = {};
  const clearedKeys = new Set<string>();

  for (const step of steps) {
    if (!dependenciesMet(step.dependsOn, values)) continue;

    if (step.type === "info") {
      await dialog.alert({
        content: (ctx: AlertContext) => <PaneTemplateInfoStep {...ctx} step={step} />,
      });
      continue;
    }

    const activeStep = clearedKeys.has(step.key)
      ? { ...step, defaultValue: undefined }
      : step;
    const result = step.type === "select"
      ? await dialog.prompt<string>({
        content: (ctx: PromptContext<string>) => <PaneTemplateSelectStep {...ctx} step={activeStep} />,
      })
      : step.type === "textarea"
        ? await dialog.prompt<string>({
          content: (ctx: PromptContext<string>) => <PaneTemplateTextareaStep {...ctx} step={activeStep} />,
        })
        : await dialog.prompt<string>({
          content: (ctx: PromptContext<string>) => <PaneTemplateInputStep {...ctx} step={activeStep} />,
        });

    if (result === undefined || ((step.type === "select" || step.type === "textarea") && !result)) {
      return null;
    }

    values[step.key] = result;
    for (const key of keysClearedByChange(step.clearOnChange, wizardStepInitialValue(activeStep) ?? "", result)) {
      clearedKeys.add(key);
    }
  }

  return values;
}
