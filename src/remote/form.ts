import type { RemoteUiNodeSnapshot } from "./types";

/**
 * The open form or confirm, read from the node the form modal registers: its
 * kind, title, fields with their values and options, error, pending state and
 * submit label, and the node that cancels or sends it. A full-window card
 * such as the first-run setup reads the same way, as kind "setup" with its
 * step and buttons (remote/surface.tsx). `covered` when another dialog (a
 * listing picker, a sign-in) sits over it. `{ open: false }` when none is
 * open, with `otherDialogOpen` while a dialog that is not a form (pane
 * settings) is.
 */
export function formSnapshot(nodes: RemoteUiNodeSnapshot[], dialogOpen: boolean) {
  const node = findFormNode(nodes);
  if (!node) return dialogOpen ? { open: false, otherDialogOpen: true } : { open: false };
  const { scope: _scope, covered, ...form } = node.metadata ?? {};
  return { open: true, nodeId: node.id, actions: node.actions, ...form, ...(covered === true ? { covered } : {}) };
}

/** The form on top: the last one opened that nothing covers, else the last one. */
export function findFormNode(nodes: RemoteUiNodeSnapshot[]): RemoteUiNodeSnapshot | undefined {
  const forms = nodes.filter((entry) => entry.role === "form" && entry.metadata?.scope === "form");
  return forms.filter((entry) => entry.metadata?.covered !== true).at(-1) ?? forms.at(-1);
}

type FormState = Record<string, unknown>;

function isSetup(form: FormState): boolean {
  return form.open === true && form.kind === "setup";
}

/** The open form by what it is and its title: `the setup dialog "What do you hold?"`. */
function formName(form: FormState): string {
  const title = typeof form.title === "string" && form.title ? ` "${form.title}"` : "";
  return isSetup(form) ? `the setup dialog${title}` : `the form${title}`;
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** What a call made while `form` is open did not reach: the app behind it. */
export function coveredByWarning(form: FormState): string | null {
  if (form.open !== true) {
    return form.otherDialogOpen === true
      ? "A dialog is open over the app, so this change is behind it until the dialog closes (app.closeDialog)."
      : null;
  }
  return isSetup(form)
    ? `${capitalized(formName(form))} covers the app, so this change is behind it until setup is finished or skipped. app://form lists its fields and buttons.`
    : `${capitalized(formName(form))} is open over the app, so this change is behind it until the form is sent or cancelled (app://form).`;
}

/** Why the command bar does not open while `form` is open, or null when nothing is. */
export function commandBarBlockedBy(form: FormState): string | null {
  if (form.open !== true) return null;
  return `${capitalized(formName(form))} covers the app, and the command bar would open behind it. `
    + `${isSetup(form) ? "Finish or skip setup first" : "Send or cancel it first"}: app://form lists its fields and buttons.`;
}

/** Why app.closeDialog closed nothing: no dialog is open, and the setup is closed through its own buttons. */
export function noDialogToClose(form: FormState): string {
  if (!isSetup(form)) return "No dialog is open.";
  const skip = Array.isArray(form.actions) && form.actions.includes("cancel");
  return skip
    ? `No dialog is open over ${formName(form)}. Skip setup with ui.invokeMatching { role: 'form', action: 'cancel' }, or finish it with its buttons (app://form).`
    : `No dialog is open over ${formName(form)}, and this step cannot skip the whole setup. Press its buttons (app://form lists them); Skip leaves a step without filling it.`;
}
