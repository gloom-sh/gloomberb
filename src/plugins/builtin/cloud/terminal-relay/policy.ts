import { commandBarResultsFromNodes } from "../../../../remote/command-bar";
import { findCommandBarResult, findMatchingUiNode } from "../../../../remote/matching";
import type { RemoteSideEffectLevel, RemoteUiNodeSnapshot } from "../../../../remote/types";
import { logFailure } from "../../../../utils/log-failure";
import { keyArgumentLines, shortValue, type CallSummary } from "./summary";

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
 *   activate, an item of a plain menu), since a button can send an order or a
 *   message.
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
 * may act outside it and asks each time, and so does `select` on a plain
 * menu, which runs the item (actionRunsSomething).
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
 * Every control drawn inside one carries its scope (RemoteUiScope), labelled
 * or not.
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
   * confirmation is open, the call now aims at a prompt, or what the person
   * allowed is not what is there now), or null.
   */
  recheck(promptOpen: boolean): Promise<string | null>;
}

export interface UiCallContext {
  /** Reads one app resource (`ui://tree`, `ui://node/{id}`, `app://layouts`). */
  read(resource: string): Promise<unknown>;
  /** One of the caller's own confirmations waits for the person. */
  promptOpen: boolean;
}

type ReadResource = UiCallContext["read"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

async function readUiTree(read: ReadResource): Promise<RemoteUiNodeSnapshot[]> {
  const nodes = await read("ui://tree");
  return Array.isArray(nodes) ? nodes as RemoteUiNodeSnapshot[] : [];
}

/**
 * Whether a UI action runs something rather than only moving, selecting or
 * typing. A plain menu's `select` runs the item it picks (a pane's action
 * menu); a select field's menu only picks a value.
 */
function actionRunsSomething(node: RemoteUiNodeSnapshot | undefined, action: string): boolean {
  if (!LOCAL_UI_ACTIONS.has(action)) return true;
  return action === "select" && node?.role === "menu" && (node.metadata?.selection ?? "none") === "none";
}

/** A control by what the person sees: `"Place order" (button)`. */
function controlName(node: RemoteUiNodeSnapshot): string {
  return node.label ? `"${shortValue(node.label)}" (${node.role})` : `an unlabelled ${node.role}`;
}

/** Actions that pick one row or item of the control, by index, id, key or label. */
const ITEM_ACTIONS: ReadonlySet<string> = new Set(["activate", "activateRow", "select"]);

interface ItemEntry {
  index: number;
  keys: string[];
  label: string;
}

/** A list's or menu's items (`metadata.items`), or a table's rows from its detail. */
function itemEntries(metadata: Record<string, unknown> | undefined): ItemEntry[] {
  const items = Array.isArray(metadata?.items) ? metadata.items : [];
  if (items.length > 0) {
    return items.flatMap((entry, position) => {
      if (!isRecord(entry) || typeof entry.label !== "string") return [];
      return [{
        index: typeof entry.index === "number" ? entry.index : position,
        keys: [entry.id, entry.label, entry.value].filter((key): key is string => typeof key === "string"),
        label: entry.label,
      }];
    });
  }
  const rows = Array.isArray(metadata?.rows) ? metadata.rows : [];
  return rows.flatMap((row, position) => {
    if (!isRecord(row) || row.section === true) return [];
    const cells = Array.isArray(row.cells) ? row.cells.filter(isRecord) : [];
    const label = cells.map((cell) => (typeof cell.text === "string" ? cell.text : "")).find(Boolean);
    if (!label) return [];
    return [{ index: position, keys: typeof row.key === "string" ? [row.key] : [], label }];
  });
}

/** The row or item an action's input picks, as the control resolves it (resolveRemoteItemIndex). */
function pickedItem(entries: ItemEntry[], input: unknown): ItemEntry | undefined {
  if (typeof input === "number") return entries.find((entry) => entry.index === input);
  if (typeof input === "string") return entries.find((entry) => entry.keys.includes(input));
  if (!isRecord(input)) return undefined;
  if (typeof input.index === "number") return entries.find((entry) => entry.index === input.index);
  for (const key of ["id", "key", "label", "value"]) {
    const value = input[key];
    if (typeof value === "string") return entries.find((entry) => entry.keys.includes(value));
  }
  return undefined;
}

/** One node with its pane's title and its detail (a table's rows); null when unreadable. */
async function readNodeDetail(nodeId: string, read: ReadResource): Promise<Record<string, unknown> | null> {
  try {
    const detail = await read(`ui://node/${encodeURIComponent(nodeId)}`);
    return isRecord(detail) ? detail : null;
  } catch {
    // Intentional ignore: the tree already named the control, and the pane and the row only add to it.
    return null;
  }
}

interface TargetDescription {
  title: string;
  lines: CallSummary["lines"];
  /** The same while the call would act on the same control, pane and row. */
  fingerprint: string;
}

/**
 * What a UI action that runs something is asked as: the control by label and
 * role, the pane it is in, and for a row or item the label it shows.
 */
async function describeTarget(
  node: RemoteUiNodeSnapshot | undefined,
  action: string,
  input: unknown,
  read: ReadResource,
): Promise<TargetDescription> {
  const inputLine = input !== undefined ? [{ label: "Input", value: shortValue(input) }] : [];
  if (!node) {
    return {
      title: action === "press" ? "Press a control" : `Run "${shortValue(action)}" on a control`,
      lines: [{ label: "Control", value: "none visible yet" }, ...inputLine],
      fingerprint: "",
    };
  }
  const detail = await readNodeDetail(node.id, read);
  const paneTitle = typeof detail?.paneTitle === "string" && detail.paneTitle.trim() ? shortValue(detail.paneTitle) : null;
  const metadata = isRecord(detail?.metadata) ? detail.metadata : node.metadata;
  const item = ITEM_ACTIONS.has(action) ? pickedItem(itemEntries(metadata), input)?.label : undefined;
  const control = controlName(node);
  const title = item
    ? `Choose "${shortValue(item)}" ${node.role === "menu" ? "from" : "in"} ${control}`
    : action === "press" ? `Press ${control}` : `Run "${shortValue(action)}" on ${control}`;
  return {
    title,
    lines: [
      ...(paneTitle ? [{ label: "Pane", value: paneTitle }] : []),
      ...(item ? [] : inputLine),
    ],
    fingerprint: [node.id, node.role, node.label ?? "", paneTitle ?? "", item ?? ""].join("|"),
  };
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
  { read, promptOpen }: UiCallContext,
): Promise<UiCallPlan> {
  const action = typeof input.action === "string" && input.action ? input.action : "press";
  const find = async () => {
    const nodes = await readUiTree(read);
    return operation === "ui.invoke"
      ? nodes.find((node) => node.id === input.nodeId)
      : findMatchingUiNode(nodes, input);
  };
  const target = await find();
  if (promptOpen || isPromptNode(target)) throw new UiCallRefusal("not_allowed", PROMPT_OPEN);
  if (!actionRunsSomething(target, action)) {
    return {
      confirm: null,
      recheck: async (open) => (open || isPromptNode(await find()) ? PROMPT_OPEN : null),
    };
  }
  const asked = await describeTarget(target, action, input.input, read);
  return {
    confirm: { title: asked.title, lines: asked.lines },
    recheck: async (open) => {
      const now = await find();
      if (open || isPromptNode(now)) return PROMPT_OPEN;
      const current = await describeTarget(now, action, input.input, read);
      return current.fingerprint === asked.fingerprint ? null : TARGET_CHANGED;
    },
  };
}

async function planCommandBarCall(
  input: Record<string, unknown>,
  { read, promptOpen }: UiCallContext,
): Promise<UiCallPlan> {
  if (promptOpen) throw new UiCallRefusal("not_allowed", PROMPT_OPEN);
  const find = async () => findCommandBarResult(commandBarResultsFromNodes(await readUiTree(read)), input);
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

/** A `confirm` operation as the person is asked about it, and what is checked again before it runs. */
export interface ConfirmedOperationPlan {
  confirm: CallSummary;
  /** Why the call may no longer run (what it named is gone or changed), or null. */
  recheck?: () => Promise<string | null>;
}

/**
 * How the relay and Ask Gloom ask about a `confirm` operation that has no dry
 * run of its own: the layout a delete removes, by name, and the plugin and
 * operation a capability call runs. Null leaves the caller's own wording.
 */
export async function describeConfirmedOperation(
  operation: string,
  input: Record<string, unknown>,
  read: ReadResource,
): Promise<ConfirmedOperationPlan | null> {
  if (operation === "layout.delete") {
    const layoutName = async (): Promise<string | null> => {
      const layouts = await read("app://layouts");
      const layout = Array.isArray(layouts) && typeof input.index === "number" ? layouts[input.index] : undefined;
      return isRecord(layout) && typeof layout.name === "string" ? layout.name : null;
    };
    let name: string | null = null;
    try {
      name = await layoutName();
    } catch (error) {
      // The index still identifies it.
      logFailure("cloud.terminal-relay", "Read layout names for a confirmation failed")(error);
    }
    return {
      confirm: {
        title: `Delete the layout ${name ? `"${shortValue(name)}"` : `#${String(input.index)}`}`,
        lines: [{ label: "Undo", value: "Not available for a deleted layout" }],
      },
      // The layout at that place now is not the one the person agreed to lose.
      recheck: name === null ? undefined : async () => ((await layoutName()) === name ? null : TARGET_CHANGED),
    };
  }
  if (operation === "capability.invoke") {
    const capabilityId = typeof input.capabilityId === "string" ? input.capabilityId : "";
    const operationId = typeof input.operationId === "string" ? input.operationId : "";
    let plugin = capabilityId;
    let operationTitle = operationId;
    try {
      const manifests = await read("app://capabilities");
      const manifest = Array.isArray(manifests)
        ? manifests.find((entry) => isRecord(entry) && entry.id === capabilityId) as Record<string, unknown> | undefined
        : undefined;
      if (manifest && typeof manifest.name === "string") plugin = manifest.name;
      const operations = manifest && Array.isArray(manifest.operations) ? manifest.operations : [];
      const described = operations.find((entry) => isRecord(entry) && entry.id === operationId) as Record<string, unknown> | undefined;
      if (described && typeof described.title === "string") operationTitle = described.title;
    } catch (error) {
      // The ids alone still say what runs.
      logFailure("cloud.terminal-relay", "Read plugin names for a confirmation failed")(error);
    }
    return {
      confirm: {
        title: `${shortValue(operationTitle)} with ${shortValue(plugin)}`,
        lines: [
          { label: "Plugin", value: `${shortValue(plugin)}${plugin !== capabilityId ? ` (${shortValue(capabilityId)})` : ""}` },
          { label: "Operation", value: shortValue(operationId) },
          ...keyArgumentLines(input.payload),
        ],
      },
    };
  }
  return null;
}

/** What the policy carries into a tool's description. */
export function policySentence(policy: TerminalRelayPolicy): string {
  switch (policy) {
    case "allow":
      return "Runs once the person approved this assistant in Gloom.";
    case "confirm":
      return "The person confirms each call in Gloom; unanswered after 60 s it is denied.";
    case "local-ui":
      return "Scroll, select, setValue and focus run once the assistant is approved; press, submit, choosing a menu item and other actions are confirmed by the person on each call.";
    case "navigation":
      return "Rows that open a ticker or a pane run once the assistant is approved; rows that run a command are confirmed by the person on each call.";
  }
}

export function tierLabel(level: RemoteSideEffectLevel): string {
  return level === "none" ? "read" : level;
}
