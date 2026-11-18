// The words every surface uses for the options features that need Pro
// (options flow, an IV spike alert) and what a free account has instead:
// the FLOW walls, Add Event Alert, ALRT's Events tab, `fn ALRT`, and
// `alerts add` and `alerts list`. Short on purpose, and kept here so they
// read the same everywhere.

/** What a free account has instead of options flow. */
export const FLOW_FREE = "Free: OMON chain, price and move alerts.";

/** What a free account has instead of an IV spike alert: the IV level alert the app checks comes first. */
const IV_SPIKE_FREE = "Free: IV level alerts, OMON chain, price and move alerts.";

/** The FLOW wall's line for a signed-out reader: options flow is Pro, and what is free. */
export const FLOW_PRO_NOTE = `Options flow is Pro. ${FLOW_FREE}`;

/** What is free instead of a Pro alert of `kind`; an IV spike's list leads with IV level alerts. */
export function proAlertFree(kind: string): string {
  return kind === "iv_spike" ? IV_SPIKE_FREE : FLOW_FREE;
}

/** What is free instead of any of `kinds`: the IV spike list when one of them is an IV spike, which covers flow's too. */
export function proAlertsFree(kinds: readonly string[]): string {
  return kinds.includes("iv_spike") ? IV_SPIKE_FREE : FLOW_FREE;
}

/** Add Event Alert's line under a Pro kind's first field. */
export function proAlertFormNote(kind: string): string {
  return `Pro: saved now, checked only with Pro. ${proAlertFree(kind)}`;
}

/** What `alerts add` and the saved toast say after a Pro alert saved without Pro. */
export function proAlertSavedNote(kind: string): string {
  return `Checked only with Pro. ${proAlertFree(kind)}`;
}
