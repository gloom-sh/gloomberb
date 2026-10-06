import { describe, expect, test } from "bun:test";
import type { MarketContext } from "../../../../cli/types";
import type { PaneFunctionCatalog } from "../../../../cli/pane-functions/catalog";
import type { RemoteControlResponse } from "../../../../remote/types";
import { createDefaultConfig } from "../../../../types/config";
import type { HeadlessPaneDefinition, PaneDef, PaneTemplateDef } from "../../../../types/plugin";
import {
  MAX_TOOL_RESULT_BYTES,
  type ASKGToolCallEvent,
  type ClientToolManifest,
} from "./protocol";
import { createASKGToolExecutor } from "./executor";

const emptyRegistry: PaneFunctionCatalog = {
  panes: new Map(),
  paneTemplates: new Map(),
  destroy() {},
};
const emptyContext = {} as MarketContext;

const headlessManifest: ClientToolManifest = {
  name: "val",
  source: "headless",
  title: "Valuation",
  description: "Read valuation data.",
  writeTier: "read",
  shape: "rows",
  argument: { kind: "none" },
  options: [],
  confirm: "never",
  timeoutMs: 30_000,
};

const resourceManifest: ClientToolManifest = {
  name: "app.get_resource",
  source: "remote-op",
  title: "App: Get resource",
  description: "Read an app resource.",
  writeTier: "read",
  inputSchema: { type: "object" },
  confirm: "never",
  timeoutMs: 10_000,
};

function call(
  manifest: ClientToolManifest,
  overrides: Partial<ASKGToolCallEvent> = {},
): ASKGToolCallEvent {
  return {
    seq: 1,
    type: "tool-call",
    turnId: "turn-1",
    toolCallId: "tool-1",
    name: manifest.name,
    args: {},
    writeTier: manifest.writeTier,
    requiresConfirmation: false,
    preview: null,
    timeoutMs: 1_000,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

function executor(options: {
  manifests?: ClientToolManifest[];
  remoteHandler?: (request: unknown) => Promise<RemoteControlResponse>;
  headlessExecutor?: Parameters<typeof createASKGToolExecutor>[0]["headlessExecutor"];
}) {
  return createASKGToolExecutor({
    manifests: options.manifests ?? [headlessManifest],
    registry: emptyRegistry,
    context: emptyContext,
    remoteHandler: options.remoteHandler ?? (async () => ({ ok: true, data: {} })),
    ...(options.headlessExecutor ? { headlessExecutor: options.headlessExecutor } : {}),
  });
}

describe("ASKG delegated tool executor", () => {
  test("denies a server tier that does not match the advertised tier", async () => {
    let executions = 0;
    const tools = executor({
      headlessExecutor: async () => {
        executions += 1;
        return { result: { rows: [] }, rowCount: 0 };
      },
    });

    const result = await tools.execute(call(headlessManifest, { writeTier: "ui-write" }));

    expect(result.status).toBe("denied");
    expect(result.note).toContain("tier mismatch");
    expect(executions).toBe(0);
  });

  test("returns timeout without waiting for a stalled loader", async () => {
    const tools = executor({
      headlessExecutor: async () => new Promise(() => {}),
    });

    const result = await tools.execute(call(headlessManifest, { timeoutMs: 5 }));

    expect(result.status).toBe("timeout");
    expect(result.elapsedMs).toBeLessThan(500);
  });

  test("cancels an in-flight delegated load", async () => {
    const started = Promise.withResolvers<void>();
    const tools = executor({
      headlessExecutor: async () => {
        started.resolve();
        return new Promise(() => {});
      },
    });
    const controller = new AbortController();
    const pending = tools.execute(call(headlessManifest), { signal: controller.signal });
    await started.promise;
    controller.abort();

    const result = await pending;

    expect(result.status).toBe("cancelled");
  });

  test("cuts one oversized text value under the byte cap and marks it", async () => {
    const tools = executor({
      manifests: [resourceManifest],
      remoteHandler: async () => ({ ok: true, data: { rows: [{ text: "x".repeat(MAX_TOOL_RESULT_BYTES * 2) }] } }),
    });

    const result = await tools.execute(call(resourceManifest, {
      args: { resource: "app://snapshot" },
    }));

    expect(result.status).toBe("partial");
    expect(result.truncated).toBe(true);
    expect(result.rowCount).toBe(1);
    expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThanOrEqual(MAX_TOOL_RESULT_BYTES);
    const text = (result.result as { rows: Array<{ text: string }> }).rows[0]!.text;
    expect(text.endsWith(" [cut]")).toBe(true);
    expect(result.note).toContain("characters");
  });

  test("an oversized bundle loses rows from its biggest section, never its sections", async () => {
    const holdings = Array.from({ length: 90 }, (_, index) => ({ label: `H${index}`, value: `${index}.00 % gross` }));
    const pairs = Array.from({ length: 4_000 }, (_, index) => ({
      label: `H${index % 90} / H${(index + 1) % 90}`,
      value: "0.42 correlation",
      detail: "60 matched daily returns",
    }));
    const tools = executor({
      headlessExecutor: async () => ({
        result: {
          errors: ["ASML: Current USD listing identity unavailable"],
          metadata: { model: { padding: "m".repeat(40_000) } },
          sections: [
            { title: "holdings", columns: [], rows: holdings },
            { title: "correlation", columns: [], rows: pairs },
          ],
        },
        rowCount: holdings.length + pairs.length,
        errors: ["ASML: Current USD listing identity unavailable"],
      }),
    });

    const result = await tools.execute(call(headlessManifest));
    const bundle = result.result as { sections: Array<{ title: string; rows: unknown[] }>; jsonPreview?: string };

    expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThanOrEqual(MAX_TOOL_RESULT_BYTES);
    expect(bundle.jsonPreview).toBeUndefined();
    expect(bundle.sections.map((section) => section.title)).toEqual(["holdings", "correlation"]);
    expect(bundle.sections[0]!.rows).toHaveLength(90);
    expect(bundle.sections[1]!.rows.length).toBeGreaterThan(100);
    expect(bundle.sections[1]!.rows.length).toBeLessThan(4_000);
    expect(result.status).toBe("partial");
    expect(result.note).toContain("of 4000 rows");
  });

  test("sends Gloom the function's compact result", async () => {
    const definition: HeadlessPaneDefinition<"rows"> = {
      shape: "rows",
      argument: { kind: "none" },
      options: [],
      load: () => ({
        rows: Array.from({ length: 500 }, (_, index) => ({ value: index })),
        metadata: { model: { precise: 0.123456789 } },
      }),
      compact: (result) => ({ rows: result.rows.slice(0, 3) }),
    };
    const pane: PaneDef = { id: "values", name: "Values", component: () => null, defaultPosition: "left" };
    const template: PaneTemplateDef = {
      id: "values-pane",
      paneId: pane.id,
      label: "Values",
      description: "Read values.",
      shortcut: { prefix: "VAL" },
      headless: definition,
    };
    const registry: PaneFunctionCatalog = {
      panes: new Map([[pane.id, pane]]),
      paneTemplates: new Map([[template.id, template]]),
      destroy() {},
    };
    const context = {
      config: createDefaultConfig("/unused/askg-executor"),
      store: { loadAllTickers: async () => [] },
      dataProvider: {},
    } as unknown as MarketContext;
    const tools = createASKGToolExecutor({
      manifests: [headlessManifest],
      registry,
      context,
      remoteHandler: async () => ({ ok: true, data: {} }),
    });

    const result = await tools.execute(call(headlessManifest));

    expect(result.status).toBe("ok");
    expect(result.rowCount).toBe(3);
    expect(result.result).toEqual({ columns: [{ key: "value", header: "value" }], rows: [{ value: 0 }, { value: 1 }, { value: 2 }] });
  });

  test("returns remote failures as error values", async () => {
    const tools = executor({
      manifests: [resourceManifest],
      remoteHandler: async () => ({
        ok: false,
        error: { code: "upstream_unavailable", message: "Upstream source is unavailable." },
      }),
    });

    const result = await tools.execute(call(resourceManifest, {
      args: { resource: "app://snapshot" },
    }));

    expect(result).toMatchObject({
      status: "error",
      result: { code: "upstream_unavailable" },
      note: "Upstream source is unavailable.",
      truncated: false,
    });
  });
});
