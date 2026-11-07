import { commandBarResultsFromNodes } from "../../../../remote/command-bar";
import { findCommandBarResult, findMatchingUiNode } from "../../../../remote/matching";
import type { RemoteSideEffectLevel, RemoteUiNodeSnapshot } from "../../../../remote/types";
import { shortValue, type CallSummary } from "./summary";

/**
 * What a remote assistant connected through Gloom Cloud may do in this app.
 * Ask Gloom applies the same table to its own calls (askg/executor.ts), with
 * no approval step: it is the person's own assistant, but it reads the same
 * untrusted text.
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
  "pane.screenshot": { policy: "allow", reason: "Reads only: a picture of what is already on the person's own screen." },
  "pane.createFromTemplate": { policy: "allow", reason: OPEN },
  "view.create": { policy: "allow", reason: "Creates a custom view pane from data the app already reads." },
  "view.update": { policy: "allow", reason: "Replaces a custom view's spec; layout.undo reverts it." },
  "pane.setState": { policy: "allow", reason: "Patches a pane's runtime state." },
  "pane.setSetting": { policy: "allow", reason: "Changes one pane setting." },
  "ticker.navigate": { policy: "allow", reason: OPEN },
  "ticker.pin": { policy: "allow", reason: OPEN },
  "ticker.select": { policy: "allow", reason: OPEN },
  "ticker.switchTab": { policy: "allow", reason: OPEN },
  "watchlist.add": {
    policy: "confirm",
    reason: "Changes the person's own watchlist, which syncs to their other devices; asks each time, naming the list, ticker and exchange.",
  },
  "watchlist.remove": {
    policy: "confirm",
    reason: "Takes a ticker off the person's own watchlist; asks each time, naming the list, ticker and exchange.",
  },
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
  "desktop.dockPane": { policy: "allow", reason: "Returns a popped-out desktop pane to the main window." },
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
const TERMINAL_RELAY_READ_POLICY: TerminalRelayPolicyEntry = {
  policy: "allow",
  reason: "Reads what the app shows; credentials are removed from configuration.",
};

/** JSON Patch on a mutable resource. Configuration holds broker connections. */
export function patchPolicy(resource: string): TerminalRelayPolicyEntry {
  return resource === "app://config"
    ? { policy: "confirm", reason: "Configuration holds broker connections and plugin settings." }
    : { policy: "allow", reason: "Patches layout, pane state or pane settings; layout.undo reverts layout changes." };
}

/** Every read: snapshots, pane content, resources, market data. */
export function readPolicy(): TerminalRelayPolicyEntry {
  return TERMINAL_RELAY_READ_POLICY;
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
const LOCAL_UI_ACTIONS: ReadonlySet<string> = new Set([
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
const NAVIGATION_RESULT_KINDS: ReadonlySet<string> = new Set([
  "ticker",
  "ticker-search",
  "pane",
  "pane-template",
  "route",
  "search",
  "mode",
]);

/** `metadata.scope` of the relay's own prompts (prompts.tsx). */
export const RELAY_PROMPT_SCOPE = "terminal-relay-prompt";
/** `metadata.scope` of Ask Gloom's approval row, its keys and the pane-consent prompt. */
export const ASKG_PROMPT_SCOPE = "askg-prompt";
/**
 * The prompts that ask the person about an assistant's calls. No UI call acts
 * on one, whichever assistant sent it: it could otherwise approve itself.
 */
const PROMPT_SCOPES: ReadonlySet<string> = new Set([RELAY_PROMPT_SCOPE, ASKG_PROMPT_SCOPE]);

function isPromptNode(node: RemoteUiNodeSnapshot | undefined): boolean {
  const scope = node?.metadata?.scope;
  return typeof scope === "string" && PROMPT_SCOPES.has(scope);
}

const PROMPT_OPEN = "A Gloom confirmation is open; the assistant cannot act on it.";
const TARGET_CHANGED = "What the call pointed at changed while the person decided, so it did not run. Read the state again and retry.";

/** A UI call the policy refuses outright, before anything is asked. */
export class UiCallRefusal extends Error {
  constructor(readonly code: "not_allowed" | "invalid_input", message: string) {
    super(message);
  }
}

/** What the policy says about one call that acts on what is on screen. */
export interface UiCallPlan {
  /** What the person is asked before it runs; null runs it without asking. */
  confirm: CallSummary | null;
  /**
   * Right before the call runs, after any answer: why it may no longer run (a
   * confirmation is open, the call now aims at a prompt, or the control the
   * person allowed is not the one there now), or null.
   */
  recheck(promptOpen: boolean): Promise<string | null>;
}

export interface UiCallContext {
  /** The live semantic UI tree (`ui://tree`). */
  uiNodes(): Promise<RemoteUiNodeSnapshot[]>;
  /** One of the caller's own confirmations waits for the person. */
  promptOpen: boolean;
}

/** A control by what the person sees: `"Place order" (button)`. */
function controlName(node: RemoteUiNodeSnapshot): string {
  return node.label ? `"${shortValue(node.label)}" (${node.role})` : `an unlabelled ${node.role}`;
}

function nodeFingerprint(node: RemoteUiNodeSnapshot | undefined): string {
  return node ? `${node.id}|${node.role}|${node.label ?? ""}` : "";
}

/**
 * The per-call policy of an operation that acts on what is on screen
 * (`local-ui`, `navigation`), for every assistant that drives the app: the
 * terminal relay and Ask Gloom. Null for any other policy, which the caller
 * applies as the table says. Throws UiCallRefusal for a call that may not run
 * at all: one aimed at a confirmation prompt, or any while one is open.
 */
export async function planUiCall(
  operation: string,
  input: Record<string, unknown>,
  context: UiCallContext,
): Promise<UiCallPlan | null> {
  const { policy } = operationPolicy(operation);
  if (policy === "local-ui") return planLocalUiCall(operation, input, context);
  if (policy === "navigation") return planCommandBarCall(input, context);
  return null;
}

async function planLocalUiCall(
  operation: string,
  input: Record<string, unknown>,
  { uiNodes, promptOpen }: UiCallContext,
): Promise<UiCallPlan> {
  const action = typeof input.action === "string" && input.action ? input.action : "press";
  const find = async () => {
    const nodes = await uiNodes();
    return operation === "ui.invoke"
      ? nodes.find((node) => node.id === input.nodeId)
      : findMatchingUiNode(nodes, input);
  };
  const target = await find();
  if (promptOpen || isPromptNode(target)) throw new UiCallRefusal("not_allowed", PROMPT_OPEN);
  const local = LOCAL_UI_ACTIONS.has(action);
  const fingerprint = nodeFingerprint(target);
  const control = target ? controlName(target) : "a control";
  return {
    confirm: local ? null : {
      title: action === "press" ? `Press ${control}` : `Run "${shortValue(action)}" on ${control}`,
      lines: [
        ...(target ? [] : [{ label: "Control", value: "none visible yet" }]),
        ...(input.input !== undefined ? [{ label: "Input", value: shortValue(input.input) }] : []),
      ],
    },
    recheck: async (open) => {
      const now = await find();
      if (open || isPromptNode(now)) return PROMPT_OPEN;
      return !local && nodeFingerprint(now) !== fingerprint ? TARGET_CHANGED : null;
    },
  };
}

async function planCommandBarCall(
  input: Record<string, unknown>,
  { uiNodes, promptOpen }: UiCallContext,
): Promise<UiCallPlan> {
  if (promptOpen) throw new UiCallRefusal("not_allowed", PROMPT_OPEN);
  const find = async () => findCommandBarResult(commandBarResultsFromNodes(await uiNodes()), input);
  const result = await find();
  if (!result) throw new UiCallRefusal("invalid_input", "No matching command-bar result is visible.");
  const kindOf = (row: typeof result) => (typeof row.kind === "string" ? row.kind : "");
  const fingerprintOf = (row: typeof result) => `${shortValue(row.label)}|${kindOf(row)}|${shortValue(row.itemId)}`;
  if (NAVIGATION_RESULT_KINDS.has(kindOf(result))) {
    return { confirm: null, recheck: async (open) => (open ? PROMPT_OPEN : null) };
  }
  const fingerprint = fingerprintOf(result);
  return {
    confirm: {
      title: `Run "${shortValue(result.label)}" from the command bar`,
      lines: [
        { label: "Command", value: shortValue(result.label) },
        ...(result.detail ? [{ label: "Detail", value: shortValue(result.detail) }] : []),
      ],
    },
    recheck: async (open) => {
      if (open) return PROMPT_OPEN;
      const now = await find();
      return now && fingerprintOf(now) === fingerprint ? null : TARGET_CHANGED;
    },
  };
}

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
