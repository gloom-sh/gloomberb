import type { RemoteSideEffectLevel } from "../../../../remote/types";

/**
 * What a remote assistant connected through Gloom Cloud may do in this app.
 *
 * - `allow`: runs once the person approved the assistant for this terminal
 *   (one prompt per assistant, see grants.ts).
 * - `confirm`: the person confirms every single call in the app, after
 *   reading what it will do. A remote assistant reads untrusted text and can
 *   be steered by it, so anything that reaches an outside service (a broker
 *   order, a transfer, a message, a plugin capability) asks each time.
 * - `local-ui`: `allow` for semantic UI actions that only move, select or
 *   type inside the app; `confirm` for every other action (press, submit,
 *   activate), since a button can send an order or a message.
 * - `navigation`: `allow` when the command-bar row opens a ticker or a pane;
 *   `confirm` for rows that run a command.
 *
 * Every operation of the local remote API has a row, so the policy can be
 * read in one place. An operation added to the schema without a row is
 * still relayed, under `confirm`, never `allow`.
 */
export type TerminalRelayPolicy = "allow" | "confirm" | "local-ui" | "navigation";

export interface TerminalRelayPolicyEntry {
  policy: TerminalRelayPolicy;
  /** Why, in one line, for reviewers. */
  reason: string;
}

const ARRANGE = "Rearranges the person's own layout; layout.undo reverts it.";
const OPEN = "Opens, focuses or navigates panes in this app only.";

export const TERMINAL_RELAY_OPERATION_POLICY: Readonly<Record<string, TerminalRelayPolicyEntry>> = {
  "app.openCommandBar": { policy: "allow", reason: "Opens the command bar; running a row is commandBar.activateResult." },
  "app.closeCommandBar": { policy: "allow", reason: "Closes the command bar." },
  "app.closeDialog": { policy: "allow", reason: "Closes the dialog on top as Esc would; a relay prompt answers Deny when closed." },
  "app.setCommandBarQuery": { policy: "allow", reason: "Types into the command bar." },
  "app.search": { policy: "allow", reason: "Opens command-bar search." },
  "app.switchPanel": { policy: "allow", reason: OPEN },
  "app.notify": { policy: "allow", reason: "Shows a local notification." },
  "commandBar.activateResult": { policy: "navigation", reason: "A row can open a ticker or a pane, or run any command." },
  "pane.show": { policy: "allow", reason: OPEN },
  "pane.focus": { policy: "allow", reason: OPEN },
  "pane.close": { policy: "allow", reason: "Closes a pane; layout.undo brings it back." },
  "pane.createFromTemplate": { policy: "allow", reason: OPEN },
  "view.create": { policy: "allow", reason: "Creates a custom view pane from data the app already reads." },
  "view.update": { policy: "allow", reason: "Replaces a custom view's spec; layout.undo reverts it." },
  "pane.setState": { policy: "allow", reason: "Patches a pane's runtime state." },
  "pane.setSetting": { policy: "allow", reason: "Changes one pane setting." },
  "ticker.navigate": { policy: "allow", reason: OPEN },
  "ticker.pin": { policy: "allow", reason: OPEN },
  "ticker.select": { policy: "allow", reason: OPEN },
  "ticker.switchTab": { policy: "allow", reason: OPEN },
  "layout.switch": { policy: "allow", reason: ARRANGE },
  "layout.new": { policy: "allow", reason: "Adds a blank layout." },
  "layout.rename": { policy: "allow", reason: "Renames a layout; renaming back restores it." },
  "layout.duplicate": { policy: "allow", reason: "Copies a layout." },
  "layout.delete": {
    policy: "confirm",
    reason: "Deleting a layout drops its undo history with it, so it cannot be reverted; asks each time.",
  },
  "layout.undo": { policy: "allow", reason: ARRANGE },
  "layout.redo": { policy: "allow", reason: ARRANGE },
  "layout.gridlock": { policy: "allow", reason: ARRANGE },
  "layout.closeFloating": { policy: "allow", reason: ARRANGE },
  "layout.placePane": { policy: "allow", reason: ARRANGE },
  "layout.focusRegion": { policy: "allow", reason: OPEN },
  "layout.setGrid": { policy: "allow", reason: ARRANGE },
  "desktop.popOutPane": { policy: "allow", reason: "Moves a pane into its own desktop window." },
  "desktop.dockPane": { policy: "allow", reason: "Docks a detached desktop pane back." },
  "desktop.closeDetachedPane": { policy: "allow", reason: "Closes a detached desktop window." },
  "desktop.focusDetachedPane": { policy: "allow", reason: "Focuses a detached desktop window." },
  "capability.invoke": {
    policy: "confirm",
    reason: "Plugin capabilities reach outside services: broker orders, transfers, paid data, messages.",
  },
  "ui.invoke": { policy: "local-ui", reason: "A semantic action can scroll a list or press a Send or Submit button." },
  "ui.invokeMatching": { policy: "local-ui", reason: "Same as ui.invoke, with the node picked by role and label." },
};

/** Reads never change anything; app://config arrives with credentials removed (redact.ts). */
export const TERMINAL_RELAY_READ_POLICY: TerminalRelayPolicyEntry = {
  policy: "allow",
  reason: "Reads what the app shows; credentials are removed from configuration.",
};

/** JSON Patch on a mutable resource. Configuration holds broker connections. */
export function patchPolicy(resource: string): TerminalRelayPolicyEntry {
  return resource === "app://config"
    ? { policy: "confirm", reason: "Configuration holds broker connections and plugin settings." }
    : { policy: "allow", reason: "Patches layout, pane state or pane settings; layout.undo reverts layout changes." };
}

export function operationPolicy(operation: string): TerminalRelayPolicyEntry {
  return TERMINAL_RELAY_OPERATION_POLICY[operation]
    ?? { policy: "confirm", reason: "Not reviewed for remote control yet." };
}

/**
 * UI actions that only scroll, move a cursor, select or type inside the app.
 * Everything else a node exposes (press, submit, activate, toggle, release)
 * may act outside it and asks each time.
 */
export const LOCAL_UI_ACTIONS: ReadonlySet<string> = new Set([
  "scroll",
  "scrollBy",
  "scrollTo",
  "moveCursor",
  "drag",
  "selectRow",
  "sort",
  "select",
  "setValue",
  "focus",
  "blur",
  "hover",
  "open",
  "close",
]);

/** Command-bar rows that only open a ticker or a pane. */
export const NAVIGATION_RESULT_KINDS: ReadonlySet<string> = new Set([
  "ticker",
  "ticker-search",
  "pane",
  "pane-template",
  "route",
  "search",
  "mode",
]);

/** What the policy carries into a tool's description. */
export function policySentence(policy: TerminalRelayPolicy): string {
  switch (policy) {
    case "allow":
      return "Runs once the person approved this assistant in Gloom.";
    case "confirm":
      return "The person confirms each call in Gloom; unanswered after 60 s it is denied.";
    case "local-ui":
      return "Scroll, select, setValue and focus run once the assistant is approved; press, submit and other actions are confirmed by the person on each call.";
    case "navigation":
      return "Rows that open a ticker or a pane run once the assistant is approved; rows that run a command are confirmed by the person on each call.";
  }
}

export function tierLabel(level: RemoteSideEffectLevel): string {
  return level === "none" ? "read" : level;
}
