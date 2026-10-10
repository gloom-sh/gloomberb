import { commandBarResultsFromNodes } from "../../../../remote/command-bar";
import { findCommandBarResult, findMatchingUiNode } from "../../../../remote/matching";
import type {
  RemoteControlRequest,
  RemoteControlResponse,
  RemoteJsonPatchOperation,
  RemoteUiNodeSnapshot,
} from "../../../../remote/types";
import type { AssistantDecision, TerminalRelayGrants } from "./grants";
import {
  isKnownRemoteResource,
  resolveTerminalRelayTool,
  terminalRelayToolTitle,
  type TerminalRelayToolKind,
} from "./manifest";
import {
  LOCAL_UI_ACTIONS,
  NAVIGATION_RESULT_KINDS,
  operationPolicy,
  patchPolicy,
} from "./policy";
import { REDACTED, redactConfig, redactResource } from "./redact";
import { keyArgumentLines, shortValue, type CallSummary } from "./summary";

/**
 * Runs the tool calls Gloom Cloud relays from a remote assistant, in this
 * app, and decides on its own whether each may run: the server's word is
 * never enough.
 *
 * 1. The tool must be one this app generated (manifest.ts).
 * 2. The assistant must be approved for this terminal (one prompt each).
 * 3. A call under the `confirm` policy needs the person's Allow for that
 *    call, given in this app within 60 s. Nothing the server sends counts.
 * 4. Right before running, the call must still be live: not cancelled by the
 *    server, not revoked, not from a closed connection, not answered.
 *
 * Waiting for the person and running the call are separate budgets: up to
 * 60 s for an answer, then up to 15 s for the operation.
 */

export const RELAY_PROMPT_SCOPE = "terminal-relay-prompt";
export const CONFIRM_WINDOW_MS = 60_000;
const EXECUTION_BUDGET_MS = 15_000;
/** Answers the server cannot take (a call frame tens of megabytes long) are cut to fit. */
const MAX_RESULT_CHARS = 900_000;
const SEEN_CALL_TTL_MS = 10 * 60_000;
const MAX_SEEN_CALLS = 2_000;
const MAX_CALL_ID_LENGTH = 64;

export interface RelayCaller {
  id: string;
  name: string;
}

export type ApprovalAnswer = Exclude<AssistantDecision, never> | "timeout";
export type ConfirmationAnswer = "allow" | "deny" | "timeout";

/** The prompts, drawn by the host (prompts.tsx). Each closes when `signal` aborts. */
export interface RelayPrompts {
  askApproval(caller: RelayCaller, signal: AbortSignal): Promise<ApprovalAnswer>;
  askConfirmation(caller: RelayCaller, summary: CallSummary, signal: AbortSignal): Promise<ConfirmationAnswer>;
}

export type RelayActivity =
  | { type: "acted"; caller: RelayCaller; tool: string; at: number }
  | { type: "revoked"; clientId: string };

export interface TerminalRelayEngineOptions {
  handle: (request: RemoteControlRequest) => Promise<RemoteControlResponse>;
  /** Sends one frame on the socket the engine was last connected to. */
  send: (frame: Record<string, unknown>) => boolean;
  grants: Pick<TerminalRelayGrants, "decision" | "decide" | "forget" | "markUsed">;
  prompts: RelayPrompts;
  onActivity?: (activity: RelayActivity) => void;
  now?: () => number;
  confirmWindowMs?: number;
  executionBudgetMs?: number;
}

type ErrorCode =
  | "not_allowed"
  | "denied"
  | "confirmation_timeout"
  | "invalid_input"
  | "app_error"
  | "timeout"
  | "revoked";

class RelayRefusal extends Error {
  constructor(readonly code: ErrorCode, message: string) {
    super(message);
  }
}

interface LiveCall {
  id: string;
  caller: RelayCaller;
  generation: number;
  controller: AbortController;
}

interface PlannedCall {
  request: RemoteControlRequest | null;
  binding: TerminalRelayToolKind;
  confirm: CallSummary | null;
  /** Re-reads the target right before running; false when it changed while the person decided. */
  stillSame?: () => Promise<boolean>;
  /** Refuses a semantic action aimed at the relay's own prompt. */
  targetsPrompt?: () => Promise<boolean>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asItems(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}

function containsRedacted(value: unknown): boolean {
  if (value === REDACTED) return true;
  if (Array.isArray(value)) return value.some(containsRedacted);
  if (isRecord(value)) return Object.values(value).some(containsRedacted);
  return false;
}

/** Cuts the item list until the answer fits what one socket frame should carry. */
function fitResult(result: Record<string, unknown>): Record<string, unknown> {
  let text = JSON.stringify(result);
  if (text.length <= MAX_RESULT_CHARS || !Array.isArray(result.items)) return result;
  const items = [...result.items];
  while (items.length > 0 && text.length > MAX_RESULT_CHARS) {
    items.splice(Math.max(0, Math.floor(items.length * 0.75)));
    text = JSON.stringify({ ...result, items });
  }
  return { ...result, items, truncated: true };
}

export class TerminalRelayEngine {
  private generation = 0;
  private readonly live = new Map<string, LiveCall>();
  private readonly seen = new Map<string, number>();
  private promptChain: Promise<unknown> = Promise.resolve();
  private openPrompts = 0;
  private readonly now: () => number;
  private readonly confirmWindowMs: number;
  private readonly executionBudgetMs: number;

  constructor(private readonly options: TerminalRelayEngineOptions) {
    this.now = options.now ?? Date.now;
    this.confirmWindowMs = options.confirmWindowMs ?? CONFIRM_WINDOW_MS;
    this.executionBudgetMs = options.executionBudgetMs ?? EXECUTION_BUDGET_MS;
  }

  /** A new socket: calls from the previous one can no longer be answered, so none of them runs. */
  connected(): void {
    this.abortAll();
    this.generation += 1;
  }

  disconnected(): void {
    this.abortAll();
    this.generation += 1;
  }

  dispose(): void {
    this.disconnected();
  }

  get promptOpen(): boolean {
    return this.openPrompts > 0;
  }

  /** One frame of the relay from Gloom Cloud. */
  receive(type: string, data: unknown): void {
    if (type === "terminal.call") {
      void this.handleCall(data);
    } else if (type === "terminal.cancel" && isRecord(data) && typeof data.id === "string") {
      this.live.get(data.id)?.controller.abort();
      this.live.delete(data.id);
    } else if (type === "terminal.revoke" && isRecord(data) && typeof data.clientId === "string") {
      this.revoke(data.clientId);
    }
  }

  /** The person or Gloom Cloud revoked an assistant: its decision is forgotten and its calls end. */
  revoke(clientId: string): void {
    this.options.grants.forget(clientId);
    for (const call of [...this.live.values()]) {
      if (call.caller.id !== clientId) continue;
      call.controller.abort();
      this.live.delete(call.id);
      this.reply(call, { ok: false, error: { code: "revoked", message: "This assistant's access to the terminal was revoked." } });
    }
    this.options.onActivity?.({ type: "revoked", clientId });
  }

  private abortAll(): void {
    for (const call of this.live.values()) call.controller.abort();
    this.live.clear();
  }

  private rememberCall(id: string): boolean {
    const now = this.now();
    for (const [seenId, at] of this.seen) {
      if (now - at < SEEN_CALL_TTL_MS && this.seen.size <= MAX_SEEN_CALLS) break;
      this.seen.delete(seenId);
    }
    if (this.seen.has(id)) return false;
    this.seen.set(id, now);
    return true;
  }

  private isLive(call: LiveCall): boolean {
    return !call.controller.signal.aborted
      && call.generation === this.generation
      && this.live.get(call.id) === call;
  }

  private reply(call: LiveCall, body: Record<string, unknown>): void {
    // A call from a closed connection has nobody to answer to.
    if (call.generation !== this.generation) return;
    this.options.send({ type: "terminal.result", id: call.id, ...body });
  }

  private async handleCall(data: unknown): Promise<void> {
    if (!isRecord(data) || typeof data.id !== "string" || !data.id || data.id.length > MAX_CALL_ID_LENGTH) return;
    // A repeated id is a replay: the first copy is the only one that runs.
    if (!this.rememberCall(data.id)) return;
    const client = isRecord(data.client) ? data.client : null;
    const caller: RelayCaller | null = client && typeof client.id === "string" && typeof client.name === "string"
      ? { id: client.id.slice(0, 120), name: client.name.trim().slice(0, 60) || "An assistant" }
      : null;
    const call: LiveCall = {
      id: data.id,
      caller: caller ?? { id: "", name: "" },
      generation: this.generation,
      controller: new AbortController(),
    };
    this.live.set(call.id, call);
    try {
      if (!caller || !caller.id) throw new RelayRefusal("not_allowed", "The call does not say which assistant sent it.");
      if (typeof data.tool !== "string") throw new RelayRefusal("not_allowed", "The call names no tool.");
      const binding = resolveTerminalRelayTool(data.tool);
      if (!binding) throw new RelayRefusal("not_allowed", `This Gloom version has no tool "${data.tool}".`);
      const input = isRecord(data.input) ? data.input : {};

      await this.ensureApproved(call);
      const plan = await this.plan(binding, input);
      if (plan.confirm) await this.confirm(call, plan.confirm);

      // Last check before anything runs.
      if (!this.isLive(call)) return;
      if (this.options.grants.decision(caller.id) === "deny" || this.options.grants.decision(caller.id) === null) {
        throw new RelayRefusal("revoked", "This assistant's access to the terminal was revoked.");
      }
      if (plan.targetsPrompt && (this.promptOpen || await plan.targetsPrompt())) {
        throw new RelayRefusal("not_allowed", "A Gloom confirmation is open; the assistant cannot act on it.");
      }
      if (plan.stillSame && !(await plan.stillSame())) {
        throw new RelayRefusal("not_allowed", "What the call pointed at changed while the person decided, so it did not run. Read the state again and retry.");
      }
      if (!this.isLive(call)) return;

      const result = await this.execute(binding, plan, input);
      if (!this.isLive(call)) return;
      this.options.grants.markUsed(caller.id, this.now());
      this.options.onActivity?.({ type: "acted", caller, tool: data.tool, at: this.now() });
      this.reply(call, { ok: true, data: fitResult({ asOf: new Date(this.now()).toISOString(), ...result }) });
    } catch (error) {
      if (!this.isLive(call)) return;
      const refusal = error instanceof RelayRefusal
        ? error
        : new RelayRefusal("app_error", error instanceof Error ? error.message : String(error));
      this.reply(call, { ok: false, error: { code: refusal.code, message: refusal.message } });
    } finally {
      if (this.live.get(call.id) === call) this.live.delete(call.id);
    }
  }

  /** Tells Gloom Cloud the call waits for the person, so it holds the call instead of timing out. */
  private announceWaiting(call: LiveCall, kind: "approval" | "confirmation", expiresAt: number): void {
    if (call.generation !== this.generation) return;
    this.options.send({ type: "terminal.waiting", id: call.id, prompt: kind, expiresAt: new Date(expiresAt).toISOString() });
  }

  /**
   * One prompt at a time; each keeps its own 60 s window from when it opens.
   * Aborting the call (a cancel, a revoke, a lost connection) closes it at once.
   */
  private prompt<T>(call: LiveCall, kind: "approval" | "confirmation", ask: (signal: AbortSignal) => Promise<T>): Promise<T | "timeout"> {
    this.announceWaiting(call, kind, this.now() + this.confirmWindowMs);
    const run = async (): Promise<T | "timeout"> => {
      if (!this.isLive(call)) throw new RelayRefusal("app_error", "cancelled");
      this.announceWaiting(call, kind, this.now() + this.confirmWindowMs);
      const window = new AbortController();
      const onAbort = () => window.abort();
      call.controller.signal.addEventListener("abort", onAbort, { once: true });
      let timer: ReturnType<typeof setTimeout> | null = null;
      this.openPrompts += 1;
      try {
        return await Promise.race([
          ask(window.signal),
          new Promise<"timeout">((resolve) => {
            timer = setTimeout(() => resolve("timeout"), this.confirmWindowMs);
            window.signal.addEventListener("abort", () => resolve("timeout"), { once: true });
          }),
        ]);
      } finally {
        this.openPrompts -= 1;
        if (timer) clearTimeout(timer);
        window.abort();
        call.controller.signal.removeEventListener("abort", onAbort);
      }
    };
    const result = this.promptChain.then(run, run);
    this.promptChain = result.catch(() => {});
    return result;
  }

  private async ensureApproved(call: LiveCall): Promise<void> {
    const decision = this.options.grants.decision(call.caller.id);
    if (decision === "always" || decision === "session") return;
    if (decision === "deny") {
      throw new RelayRefusal("denied", `The person declined to let ${call.caller.name} control this terminal. They can change that in Account Management, Agents.`);
    }
    const answer = await this.prompt(call, "approval", (signal) => this.options.prompts.askApproval(call.caller, signal));
    if (!this.isLive(call)) throw new RelayRefusal("app_error", "cancelled");
    if (answer === "timeout") {
      throw new RelayRefusal("confirmation_timeout", `Nobody answered the request to let ${call.caller.name} control this terminal within ${Math.round(this.confirmWindowMs / 1_000)} s, so nothing ran.`);
    }
    // A decision made while this prompt waited (a revoke) does not get overwritten.
    this.options.grants.decide(call.caller.id, call.caller.name, answer, this.now());
    if (answer === "deny") {
      throw new RelayRefusal("denied", `The person declined to let ${call.caller.name} control this terminal.`);
    }
  }

  private async confirm(call: LiveCall, summary: CallSummary): Promise<void> {
    const answer = await this.prompt(call, "confirmation", (signal) => this.options.prompts.askConfirmation(call.caller, summary, signal));
    if (!this.isLive(call)) throw new RelayRefusal("app_error", "cancelled");
    if (answer === "timeout") {
      throw new RelayRefusal("confirmation_timeout", `The person did not confirm "${summary.title}" within ${Math.round(this.confirmWindowMs / 1_000)} s, so it did not run.`);
    }
    if (answer !== "allow") throw new RelayRefusal("denied", `The person denied "${summary.title}". It did not run.`);
  }

  private async read(resource: string): Promise<unknown> {
    const response = await this.withBudget(this.options.handle({ type: "get", resource }));
    if (!response.ok) throw new Error(response.error.message);
    return response.data;
  }

  private async uiNodes(): Promise<RemoteUiNodeSnapshot[]> {
    const nodes = await this.read("ui://tree");
    return Array.isArray(nodes) ? nodes as RemoteUiNodeSnapshot[] : [];
  }

  /** The request to run and, for the `confirm` cases, what the person is asked. */
  private async plan(binding: TerminalRelayToolKind, input: Record<string, unknown>): Promise<PlannedCall> {
    switch (binding.kind) {
      case "snapshot":
      case "pane-content":
        return { request: null, binding, confirm: null };
      case "resource": {
        const resource = typeof input.resource === "string" ? input.resource : "";
        if (!isKnownRemoteResource(resource)) throw new RelayRefusal("invalid_input", `Unknown resource "${resource}".`);
        return { request: { type: "get", resource }, binding, confirm: null };
      }
      case "data":
        return { request: { type: "data", ...input } as RemoteControlRequest, binding, confirm: null };
      case "patch": {
        const resource = typeof input.resource === "string" ? input.resource : "";
        if (!Array.isArray(input.patch)) throw new RelayRefusal("invalid_input", "patch must be a JSON Patch array.");
        if (containsRedacted(input.patch)) {
          throw new RelayRefusal("invalid_input", "The patch writes a redacted placeholder back; credentials cannot be changed remotely.");
        }
        const request: RemoteControlRequest = {
          type: "patch",
          resource,
          patch: input.patch as RemoteJsonPatchOperation[],
          ...(typeof input.expectRev === "string" ? { expectRev: input.expectRev } : {}),
          include: [],
        };
        const policy = patchPolicy(resource).policy;
        return {
          request,
          binding,
          confirm: policy === "allow" ? null : {
            title: "Change the app configuration",
            lines: (input.patch as unknown[]).slice(0, 8).map((entry) => {
              const operation = isRecord(entry) ? entry : {};
              return { label: shortValue(operation.op), value: `${shortValue(operation.path)}${"value" in operation ? ` = ${shortValue(operation.value)}` : ""}` };
            }),
          },
        };
      }
      case "operation":
        return this.planOperation(binding, input);
    }
  }

  private async planOperation(
    binding: Extract<TerminalRelayToolKind, { kind: "operation" }>,
    input: Record<string, unknown>,
  ): Promise<PlannedCall> {
    const { operation } = binding;
    const request: RemoteControlRequest = { type: "call", operation, input, include: [] };
    const { policy } = operationPolicy(operation);
    if (policy === "allow") return { request, binding, confirm: null };

    if (policy === "local-ui") {
      const action = typeof input.action === "string" && input.action ? input.action : "press";
      const find = async () => {
        const nodes = await this.uiNodes();
        return operation === "ui.invoke"
          ? nodes.find((node) => node.id === input.nodeId)
          : findMatchingUiNode(nodes, input);
      };
      const target = await find();
      const targetsPrompt = async () => (await find())?.metadata?.scope === RELAY_PROMPT_SCOPE;
      if (target?.metadata?.scope === RELAY_PROMPT_SCOPE || this.promptOpen) {
        throw new RelayRefusal("not_allowed", "A Gloom confirmation is open; the assistant cannot act on it.");
      }
      if (LOCAL_UI_ACTIONS.has(action)) return { request, binding, confirm: null, targetsPrompt };
      const fingerprint = target ? `${target.id}|${target.role}|${target.label ?? ""}` : "";
      return {
        request,
        binding,
        targetsPrompt,
        stillSame: async () => {
          const now = await find();
          return (now ? `${now.id}|${now.role}|${now.label ?? ""}` : "") === fingerprint;
        },
        confirm: {
          title: `${action === "press" ? "Press" : `Run "${action}" on`} ${target?.label ? `"${shortValue(target.label)}"` : "a control"}`,
          lines: [
            { label: "Control", value: target ? `${target.label ? shortValue(target.label) : "unlabelled"} (${target.role})` : "none visible yet" },
            { label: "Action", value: action },
            ...(input.input !== undefined ? [{ label: "Input", value: shortValue(input.input) }] : []),
          ],
        },
      };
    }

    if (policy === "navigation") {
      const find = async () => findCommandBarResult(commandBarResultsFromNodes(await this.uiNodes()), input);
      const result = await find();
      if (!result) throw new RelayRefusal("invalid_input", "No matching command-bar result is visible.");
      const kind = typeof result.kind === "string" ? result.kind : "";
      if (NAVIGATION_RESULT_KINDS.has(kind)) return { request, binding, confirm: null };
      const fingerprint = `${shortValue(result.label)}|${kind}|${shortValue(result.itemId)}`;
      return {
        request,
        binding,
        stillSame: async () => {
          const now = await find();
          return !!now && `${shortValue(now.label)}|${typeof now.kind === "string" ? now.kind : ""}|${shortValue(now.itemId)}` === fingerprint;
        },
        confirm: {
          title: `Run "${shortValue(result.label)}" from the command bar`,
          lines: [
            { label: "Command", value: shortValue(result.label) },
            ...(result.detail ? [{ label: "Detail", value: shortValue(result.detail) }] : []),
          ],
        },
      };
    }

    return { request, binding, confirm: await this.operationSummary(operation, input) };
  }

  private async operationSummary(operation: string, input: Record<string, unknown>): Promise<CallSummary> {
    if (operation === "capability.invoke") {
      const capabilityId = typeof input.capabilityId === "string" ? input.capabilityId : "";
      const operationId = typeof input.operationId === "string" ? input.operationId : "";
      let plugin = capabilityId;
      let operationTitle = operationId;
      try {
        const manifests = await this.read("app://capabilities");
        const manifest = Array.isArray(manifests)
          ? manifests.find((entry) => isRecord(entry) && entry.id === capabilityId) as Record<string, unknown> | undefined
          : undefined;
        if (manifest && typeof manifest.name === "string") plugin = manifest.name;
        const operations = manifest && Array.isArray(manifest.operations) ? manifest.operations : [];
        const described = operations.find((entry) => isRecord(entry) && entry.id === operationId) as Record<string, unknown> | undefined;
        if (described && typeof described.title === "string") operationTitle = described.title;
      } catch {
        // The ids alone still say what runs.
      }
      return {
        title: `${shortValue(operationTitle)} with ${shortValue(plugin)}`,
        lines: [
          { label: "Plugin", value: `${shortValue(plugin)}${plugin !== capabilityId ? ` (${shortValue(capabilityId)})` : ""}` },
          { label: "Operation", value: shortValue(operationId) },
          ...keyArgumentLines(input.payload),
        ],
      };
    }
    if (operation === "layout.delete") {
      let name = `#${String(input.index)}`;
      try {
        const layouts = await this.read("app://layouts");
        const layout = Array.isArray(layouts) && typeof input.index === "number" ? layouts[input.index] : undefined;
        if (isRecord(layout) && typeof layout.name === "string") name = `"${shortValue(layout.name)}"`;
      } catch {
        // The index still identifies it.
      }
      return { title: `Delete the layout ${name}`, lines: [{ label: "Undo", value: "Not available for a deleted layout" }] };
    }
    return {
      title: terminalRelayToolTitle(operation),
      lines: [{ label: "Operation", value: operation }, ...keyArgumentLines(input)],
    };
  }

  private async withBudget<T>(work: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new RelayRefusal("timeout", `The operation did not finish within ${Math.round(this.executionBudgetMs / 1_000)} s.`)),
            this.executionBudgetMs,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async run(request: RemoteControlRequest): Promise<RemoteControlResponse & { ok: true }> {
    const response = await this.withBudget(this.options.handle(request));
    if (!response.ok) throw new RelayRefusal("app_error", response.error.message);
    return response;
  }

  private async execute(
    binding: TerminalRelayToolKind,
    plan: PlannedCall,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (binding.kind === "snapshot") return this.withBudget(this.snapshot());
    if (binding.kind === "pane-content") {
      const paneId = typeof input.paneId === "string" ? input.paneId : "";
      if (!paneId) throw new RelayRefusal("invalid_input", "paneId is required.");
      return this.withBudget(this.paneContent(paneId));
    }
    const response = await this.run(plan.request!);
    if (binding.kind === "resource") {
      const resource = (plan.request as { resource: string }).resource;
      return { resource, rev: response.rev ?? null, items: asItems(redactResource(resource, response.data)) };
    }
    if (binding.kind === "patch") {
      const resource = (plan.request as { resource: string }).resource;
      return { resource, rev: response.rev ?? null, items: [resource === "app://config" ? redactConfig(response.data) : response.data] };
    }
    return { items: asItems(response.data ?? null), ...(response.rev ? { rev: response.rev } : {}) };
  }

  private async snapshot(): Promise<Record<string, unknown>> {
    const snapshot = await this.read("app://snapshot");
    const record = isRecord(snapshot) ? snapshot : {};
    const config = isRecord(record.config) ? record.config : {};
    const layouts = Array.isArray(config.layouts) ? config.layouts : [];
    const activeLayoutIndex = typeof config.activeLayoutIndex === "number" ? config.activeLayoutIndex : 0;
    const panes = Array.isArray(record.panes) ? record.panes : [];
    return {
      rev: record.rev ?? null,
      app: record.app ?? null,
      activeLayout: { index: activeLayoutIndex, name: isRecord(layouts[activeLayoutIndex]) ? layouts[activeLayoutIndex].name ?? null : null },
      layouts: layouts.map((layout, index) => ({ index, name: isRecord(layout) ? layout.name ?? null : null })),
      commandBar: isRecord(record.commandBar)
        ? { open: record.commandBar.open, query: record.commandBar.query, results: Array.isArray(record.commandBar.results) ? record.commandBar.results.length : 0 }
        : null,
      form: record.form ?? null,
      items: panes.map((pane) => {
        if (!isRecord(pane)) return pane;
        const { runtimeState: _runtime, ...rest } = pane;
        return rest;
      }),
    };
  }

  private async paneContent(paneId: string): Promise<Record<string, unknown>> {
    const panes = await this.read("app://panes");
    const pane = Array.isArray(panes)
      ? panes.find((entry) => isRecord(entry) && (entry.instanceId === paneId || entry.paneId === paneId)) as Record<string, unknown> | undefined
      : undefined;
    if (!pane) throw new RelayRefusal("invalid_input", `No pane "${paneId}" is open. Call terminal.snapshot for the open panes.`);
    const instanceId = String(pane.instanceId);
    let settings: unknown = null;
    try {
      const described = await this.read(`app://pane-settings/${encodeURIComponent(instanceId)}`);
      settings = isRecord(described) ? described.settings ?? null : null;
    } catch {
      // A pane without settings.
    }
    const nodes = (await this.uiNodes()).filter((node) => (
      (node.paneId === instanceId || node.metadata?.paneInstanceId === instanceId)
      // A bare clickable box says nothing about what the pane shows.
      && !(node.role === "box" && !node.label)
    ));
    return {
      pane,
      settings: redactConfig(settings),
      items: nodes.map(({ paneId: _paneId, ...node }) => node),
    };
  }
}
