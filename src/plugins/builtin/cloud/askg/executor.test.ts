import { describe, expect, test } from "bun:test";
import type { MarketContext } from "../../../../cli/types";
import type { PaneFunctionCatalog } from "../../../../cli/pane-functions/catalog";
import type { RemoteCallContext, RemoteControlResponse } from "../../../../remote/types";
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

const watchlistAddManifest: ClientToolManifest = {
  name: "watchlist.add",
  source: "remote-op",
  title: "Watchlist: Add",
  description: "Add a ticker to a watchlist.",
  writeTier: "user-data",
  inputSchema: { type: "object" },
  confirm: "always",
  timeoutMs: 10_000,
};

function executor(options: {
  manifests?: ClientToolManifest[];
  remoteHandler?: (request: unknown, context?: RemoteCallContext) => Promise<RemoteControlResponse>;
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
  test("previews a confirmed write from its dry run, and hands the approved key to the app", async () => {
    const requests: Array<{ request: unknown; confirmed?: string }> = [];
    const tools = executor({
      manifests: [watchlistAddManifest],
      remoteHandler: async (request, context) => {
        requests.push({ request, ...(context?.confirmed ? { confirmed: context.confirmed } : {}) });
        return (request as { dryRun?: boolean }).dryRun
          ? { ok: true, data: { changes: true, summary: "Add MSFT (NASDAQ) to Tech", confirmKey: "add|tech|MSFT" } }
          : { ok: true, data: { changed: true, outcome: "added" } };
      },
    });
    const watchlistCall = call(watchlistAddManifest, { args: { symbol: "MSFT", watchlist: "tech" }, requiresConfirmation: true });

    expect(await tools.preview!(watchlistCall)).toEqual({ kind: "change", summary: "Add MSFT (NASDAQ) to Tech", confirmKey: "add|tech|MSFT" });
    expect(await tools.execute(watchlistCall, { confirmed: true, confirmedChange: "add|tech|MSFT" })).toMatchObject({ status: "ok" });
    // Unapproved, the key never reaches the app.
    expect(await tools.execute(watchlistCall, { confirmedChange: "add|tech|MSFT" })).toMatchObject({ status: "denied" });

    expect(requests).toEqual([
      { request: { type: "call", operation: "watchlist.add", input: { symbol: "MSFT", watchlist: "tech" }, dryRun: true, include: [] } },
      { request: { type: "call", operation: "watchlist.add", input: { symbol: "MSFT", watchlist: "tech" } }, confirmed: "add|tech|MSFT" },
    ]);
  });

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

  test("a long warning list becomes one short note grouped by message", async () => {
    // Per-holding warnings of a large synthetic broker portfolio.
    const foreign = Array.from({ length: 8 }, (_, index) => `FX${index + 1}`);
    const history = Array.from({ length: 13 }, (_, index) => `HS${String(index + 1).padStart(2, "0")}`);
    const errors = [
      ...foreign.map((symbol) => `${symbol}: Current USD listing identity unavailable`),
      "Treasury yield: Internal server error",
      "2 holdings had no current quote; weighted at the latest completed close.",
      ...foreign.map((symbol) => `${symbol}: Foreign holdings: historical FX returns required`),
      ...history.map((symbol) => `${symbol}: Daily history unavailable`),
      "Basket covers 78% of market value \u00b7 21 holdings left out; metadata.coverage lists each with its reason.",
      `Volatility: Request failed {"type":"validation","found":{"note":"${"x".repeat(300)}"}}`,
    ];
    const tools = executor({
      headlessExecutor: async () => ({ result: { rows: [{ value: 1 }] }, rowCount: 1, errors }),
    });

    const result = await tools.execute(call(headlessManifest));

    expect(result.status).toBe("partial");
    expect(result.note!.length).toBeLessThanOrEqual(400);
    expect(result.note).toContain("Current USD listing identity unavailable (FX1, FX2, FX3, FX4 and 4 more)");
    expect(result.note).toMatch(/and \d+ more$/);
    expect(result.note).not.toContain("{");
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
