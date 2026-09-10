import { afterEach, expect, test } from "bun:test";
import { act, useState } from "react";
import { testRender } from "../../../../renderers/opentui/test-utils";
import { JsonTickerRepository } from "../../../../data/json-ticker-repository";
import { createTestDataProvider } from "../../../../test-support/data-provider";
import { Box } from "../../../../ui";
import { setSharedRegistryForTests, type PluginRegistry } from "../../../registry";
import { setAiRunHost } from "../runner";
import { createScreenerTab, type AiScreenerTab } from "./model";
import { getScreenerPromptSignature } from "./contract";
import { useAiScreenerRunner } from "./runner";

let renderer: Awaited<ReturnType<typeof testRender>> | undefined;
afterEach(() => { renderer?.renderer.destroy(); renderer = undefined; setAiRunHost(null); setSharedRegistryForTests(undefined); });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
const response = (symbol: string) => JSON.stringify({ tickers: [{ symbol, exchange: "NASDAQ", reason: "Controlled response" }] });

async function harness(search = async (symbol: string) => [{ providerId: "test", symbol, exchange: "NASDAQ", name: symbol, currency: "USD", type: "EQUITY" }]) {
  const values = new Map<string, string>();
  setSharedRegistryForTests({ tickerRepository: new JsonTickerRepository({ getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); }, removeItem: (key) => { values.delete(key); } }), events: { emit() {} } } as unknown as PluginRegistry);
  const provider = createTestDataProvider({ search });
  let current!: { tab: AiScreenerTab; edit: (prompt: string) => void; run: () => Promise<void> };
  function Harness() {
    const [tab, setTab] = useState(() => createScreenerTab("Original criteria", "anthropic"));
    const runner = useAiScreenerRunner({ dataProvider: provider, dispatch() {}, providers: [{ id: "anthropic", name: "Claude", available: true, status: "ready", outputModes: ["screener"] }],
      tabs: [tab], tickers: new Map(), upsertTab: (_id, updater) => setTab(updater) });
    current = { tab, edit: (prompt) => setTab((old) => ({ ...old, prompt })), run: () => runner.runTab(tab.id) };
    return <Box />;
  }
  renderer = await testRender(<Harness />, { width: 80, height: 12 });
  await act(async () => { await renderer!.renderOnce(); });
  return () => current;
}
async function flush() { await act(async () => { await Bun.sleep(5); await renderer!.renderOnce(); }); }

test("editing the prompt during a run preserves the identity of the submitted criteria", async () => {
  const output = deferred<string>();
  setAiRunHost({ checkStatus: async () => ({ available: true, authenticated: true, message: null }), run: () => ({ done: output.promise, cancel() {} }) });
  const state = await harness();
  let run!: Promise<void>;
  await act(async () => { run = state().run(); await Bun.sleep(0); });
  await act(async () => { state().edit("Different criteria"); });
  output.resolve(response("AAPL"));
  await act(async () => { await run; });
  expect(state().tab.prompt).toBe("Different criteria");
  expect(state().tab.lastRunPromptSignature).toBe(getScreenerPromptSignature("Original criteria", "anthropic"));
});

test("a superseded run cannot overwrite newer results after its ticker lookup completes", async () => {
  const delayed = deferred<Array<{ providerId: string; symbol: string; exchange: string; name: string; currency: string; type: string }>>();
  let lookupStarted = false;
  let runs = 0;
  setAiRunHost({ checkStatus: async () => ({ available: true, authenticated: true, message: null }), run: () => ({ done: Promise.resolve(response(++runs === 1 ? "OLD" : "NEW")), cancel() {} }) });
  const state = await harness(async (symbol) => {
    if (symbol === "OLD") { lookupStarted = true; return delayed.promise; }
    return [{ providerId: "test", symbol, exchange: "NASDAQ", name: symbol, currency: "USD", type: "EQUITY" }];
  });
  let oldRun!: Promise<void>;
  await act(async () => { oldRun = state().run(); await Bun.sleep(0); });
  await flush();
  expect(lookupStarted).toBe(true);
  await act(async () => { await state().run(); });
  expect(state().tab.results[0]?.symbol).toBe("NEW");
  delayed.resolve([{ providerId: "test", symbol: "OLD", exchange: "NASDAQ", name: "OLD", currency: "USD", type: "EQUITY" }]);
  await act(async () => { await oldRun; });
  expect(state().tab.results[0]?.symbol).toBe("NEW");
});
