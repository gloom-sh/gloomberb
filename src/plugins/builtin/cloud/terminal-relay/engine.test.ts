import { describe, expect, test } from "bun:test";
import type { RemoteControlRequest, RemoteControlResponse } from "../../../../remote/types";
import type { PluginPersistence } from "../../../../types/plugin";
import { TerminalRelayEngine, type ConfirmationAnswer, type ApprovalAnswer } from "./engine";
import { TerminalRelayGrants } from "./grants";
import { TERMINAL_RELAY_OPERATION_POLICY, type TerminalRelayPolicyEntry } from "./policy";
import { REDACTED } from "./redact";

function memoryPersistence(): PluginPersistence {
  const state = new Map<string, unknown>();
  return {
    getState: <T,>(key: string) => (state.has(key) ? state.get(key) as T : null),
    setState: (key, value) => { state.set(key, value); },
    deleteState: (key) => { state.delete(key); },
    getResource: () => null,
    setResource: () => { throw new Error("unused"); },
    deleteResource: () => {},
  };
}

interface Harness {
  engine: TerminalRelayEngine;
  grants: TerminalRelayGrants;
  sent: Array<Record<string, unknown>>;
  handled: RemoteControlRequest[];
  approvals: Array<(answer: ApprovalAnswer) => void>;
  confirmations: Array<{ title: string; lines: Array<{ label: string; value: string }>; answer: (answer: ConfirmationAnswer) => void }>;
  call(id: string, tool: string, input?: Record<string, unknown>, extra?: Record<string, unknown>): void;
  results(): Array<Record<string, unknown>>;
}

const CLAUDE = { id: "oauth:client-1", name: "Claude Code" };

function harness(options: {
  handle?: (request: RemoteControlRequest) => Promise<RemoteControlResponse>;
  confirmWindowMs?: number;
  executionBudgetMs?: number;
} = {}): Harness {
  const sent: Array<Record<string, unknown>> = [];
  const handled: RemoteControlRequest[] = [];
  const approvals: Harness["approvals"] = [];
  const confirmations: Harness["confirmations"] = [];
  const grants = new TerminalRelayGrants();
  grants.attach(memoryPersistence());
  const engine = new TerminalRelayEngine({
    handle: async (request) => {
      handled.push(request);
      if (options.handle) return options.handle(request);
      if (request.type === "get" && request.resource === "ui://tree") {
        return { ok: true, data: [
          { id: "ui:1", role: "button", label: "Submit order", actions: ["press"] },
          { id: "ui:2", role: "table", label: "Data table", actions: ["scrollBy", "selectRow"] },
          { id: "ui:3", role: "button", label: "Always allow", actions: ["press"], metadata: { scope: "terminal-relay-prompt" } },
        ] };
      }
      if (request.type === "get" && request.resource === "app://config") {
        return { ok: true, data: { theme: "amber", brokerInstances: [{ id: "b1", label: "Main", config: { host: "x", apiSecret: "s3cret" } }], plugin: { token: "t0ken" } } };
      }
      return { ok: true, data: { done: true } };
    },
    send: (frame) => {
      sent.push(frame);
      return true;
    },
    grants,
    prompts: {
      askApproval: (_caller, signal) => new Promise((resolve) => {
        approvals.push(resolve);
        signal.addEventListener("abort", () => resolve("deny"));
      }),
      askConfirmation: (_caller, summary, signal) => new Promise((resolve) => {
        confirmations.push({ ...summary, answer: resolve });
        signal.addEventListener("abort", () => resolve("deny"));
      }),
    },
    confirmWindowMs: options.confirmWindowMs ?? 1_000,
    executionBudgetMs: options.executionBudgetMs ?? 1_000,
  });
  engine.connected();
  return {
    engine,
    grants,
    sent,
    handled,
    approvals,
    confirmations,
    call(id, tool, input = {}, extra = {}) {
      engine.receive("terminal.call", { id, tool, input, client: CLAUDE, ...extra });
    },
    results: () => sent.filter((frame) => frame.type === "terminal.result"),
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
const ran = (h: Harness, operation: string) => h.handled.filter((request) => request.type === "call" && request.operation === operation).length;

describe("terminal relay engine", () => {
  test("asks once per assistant, then runs local operations without asking", async () => {
    const h = harness();
    h.call("c1", "pane.show", { paneId: "quote" });
    await settle();
    expect(h.approvals).toHaveLength(1);
    expect(h.sent.some((frame) => frame.type === "terminal.waiting" && frame.prompt === "approval")).toBe(true);
    expect(ran(h, "pane.show")).toBe(0);

    h.approvals[0]!("session");
    await settle();
    expect(ran(h, "pane.show")).toBe(1);
    expect(h.results()[0]).toMatchObject({ id: "c1", ok: true });

    h.call("c2", "layout.switch", { index: 1 });
    await settle();
    expect(h.approvals).toHaveLength(1);
    expect(ran(h, "layout.switch")).toBe(1);
  });

  test("a denied assistant is refused without another prompt", async () => {
    const h = harness();
    h.call("c1", "pane.show", { paneId: "quote" });
    await settle();
    h.approvals[0]!("deny");
    await settle();
    h.call("c2", "pane.show", { paneId: "quote" });
    await settle();
    expect(h.approvals).toHaveLength(1);
    expect(ran(h, "pane.show")).toBe(0);
    expect(h.results().map((frame) => (frame.error as { code: string }).code)).toEqual(["denied", "denied"]);
  });

  test("an external-side-effect call needs a fresh in-app Allow, whatever the server claims", async () => {
    const h = harness();
    h.grants.decide(CLAUDE.id, CLAUDE.name, "always");
    const order = { capabilityId: "broker.ibkr", operationId: "placeOrder", payload: { symbol: "NVDA", side: "buy", quantity: 10 } };
    h.call("c1", "capability.invoke", order, { confirmed: true, approved: true, policy: "allow" });
    await settle();
    expect(ran(h, "capability.invoke")).toBe(0);
    expect(h.confirmations).toHaveLength(1);
    expect(h.confirmations[0]!.lines).toEqual(expect.arrayContaining([
      { label: "Symbol", value: "NVDA" },
      { label: "Side", value: "buy" },
      { label: "Size", value: "10" },
    ]));
    h.confirmations[0]!.answer("deny");
    await settle();
    expect(ran(h, "capability.invoke")).toBe(0);
    expect(h.results()[0]).toMatchObject({ ok: false, error: { code: "denied" } });

    // No standing approval: the next identical call asks again.
    h.call("c2", "capability.invoke", order);
    await settle();
    expect(h.confirmations).toHaveLength(2);
    h.confirmations[1]!.answer("allow");
    await settle();
    expect(ran(h, "capability.invoke")).toBe(1);
  });

  test("an unanswered confirmation is denied after its window and never runs", async () => {
    const h = harness({ confirmWindowMs: 30 });
    h.grants.decide(CLAUDE.id, CLAUDE.name, "always");
    h.call("c1", "capability.invoke", { capabilityId: "x", operationId: "send" });
    await new Promise((resolve) => setTimeout(resolve, 60));
    h.confirmations[0]?.answer("allow");
    await settle();
    expect(ran(h, "capability.invoke")).toBe(0);
    expect(h.results()[0]).toMatchObject({ ok: false, error: { code: "confirmation_timeout" } });
  });

  test("nothing runs after the server cancels, a revoke, or a lost connection", async () => {
    const h = harness();
    h.grants.decide(CLAUDE.id, CLAUDE.name, "always");
    const action = { capabilityId: "x", operationId: "transfer" };

    h.call("c1", "capability.invoke", action);
    await settle();
    h.engine.receive("terminal.cancel", { id: "c1" });
    h.confirmations[0]!.answer("allow");
    await settle();

    h.call("c2", "capability.invoke", action);
    await settle();
    h.engine.receive("terminal.revoke", { clientId: CLAUDE.id });
    h.confirmations[1]!.answer("allow");
    await settle();
    expect(h.results().find((frame) => frame.id === "c2")).toMatchObject({ ok: false, error: { code: "revoked" } });

    h.grants.decide(CLAUDE.id, CLAUDE.name, "always");
    h.call("c3", "capability.invoke", action);
    await settle();
    h.engine.disconnected();
    h.confirmations[2]!.answer("allow");
    await settle();

    expect(ran(h, "capability.invoke")).toBe(0);
    expect(h.results().find((frame) => frame.id === "c1")).toBeUndefined();
    expect(h.results().find((frame) => frame.id === "c3")).toBeUndefined();
  });

  test("a replayed call id runs once", async () => {
    const h = harness();
    h.grants.decide(CLAUDE.id, CLAUDE.name, "always");
    h.call("c1", "layout.new", { name: "Semis" });
    h.call("c1", "layout.new", { name: "Semis" });
    await settle();
    expect(ran(h, "layout.new")).toBe(1);
    expect(h.results()).toHaveLength(1);
  });

  test("the execution budget starts after the answer and ends a hung operation", async () => {
    const h = harness({
      confirmWindowMs: 1_000,
      executionBudgetMs: 30,
      handle: async (request) => (request.type === "call" ? new Promise(() => {}) : { ok: true, data: [] }),
    });
    h.grants.decide(CLAUDE.id, CLAUDE.name, "always");
    h.call("c1", "capability.invoke", { capabilityId: "x", operationId: "y" });
    await new Promise((resolve) => setTimeout(resolve, 60));
    // Still waiting on the person: the operation budget has not started.
    expect(h.results()).toHaveLength(0);
    h.confirmations[0]!.answer("allow");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(h.results()[0]).toMatchObject({ ok: false, error: { code: "timeout" } });
  });

  test("an operation missing from the policy table is confirmed, never allowed", async () => {
    const table = TERMINAL_RELAY_OPERATION_POLICY as Record<string, TerminalRelayPolicyEntry>;
    const saved = table["pane.show"]!;
    delete table["pane.show"];
    try {
      const h = harness();
      h.grants.decide(CLAUDE.id, CLAUDE.name, "always");
      h.call("c1", "pane.show", { paneId: "quote" });
      await settle();
      expect(h.confirmations).toHaveLength(1);
      expect(ran(h, "pane.show")).toBe(0);
    } finally {
      table["pane.show"] = saved;
    }
  });

  test("semantic UI: scrolling runs, pressing asks, and the relay's own prompt is out of reach", async () => {
    const h = harness();
    h.grants.decide(CLAUDE.id, CLAUDE.name, "always");
    h.call("c1", "ui.invoke", { nodeId: "ui:2", action: "scrollBy", input: { delta: 3 } });
    await settle();
    expect(ran(h, "ui.invoke")).toBe(1);

    h.call("c2", "ui.invoke_matching", { role: "button", label: "Submit order" });
    await settle();
    expect(h.confirmations[0]!.title).toBe("Press \"Submit order\"");
    h.confirmations[0]!.answer("allow");
    await settle();
    expect(ran(h, "ui.invokeMatching")).toBe(1);

    h.call("c3", "ui.invoke", { nodeId: "ui:3", action: "press" });
    await settle();
    expect(h.results().find((frame) => frame.id === "c3")).toMatchObject({ ok: false, error: { code: "not_allowed" } });
    expect(h.confirmations).toHaveLength(1);
  });

  test("configuration leaves the app without credentials, and they cannot be written back", async () => {
    const h = harness();
    h.grants.decide(CLAUDE.id, CLAUDE.name, "always");
    h.call("c1", "get_resource", { resource: "app://config" });
    await settle();
    const config = (h.results()[0]!.data as { items: Array<Record<string, any>> }).items[0]!;
    expect(config.theme).toBe("amber");
    expect(config.plugin.token).toBe(REDACTED);
    expect(config.brokerInstances[0].config).toEqual({ host: REDACTED, apiSecret: REDACTED });

    h.call("c2", "patch_resource", { resource: "app://config", patch: [{ op: "replace", path: "/plugin/token", value: REDACTED }] });
    await settle();
    expect(h.results()[1]).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(h.confirmations).toHaveLength(0);
  });

  test("a tool this app did not generate is refused", async () => {
    const h = harness();
    h.grants.decide(CLAUDE.id, CLAUDE.name, "always");
    h.call("c1", "shell.exec", { command: "rm -rf ~" });
    await settle();
    expect(h.results()[0]).toMatchObject({ ok: false, error: { code: "not_allowed" } });
    expect(h.handled).toHaveLength(0);
  });
});

