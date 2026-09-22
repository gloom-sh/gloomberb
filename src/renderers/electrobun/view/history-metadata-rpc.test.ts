import { expect, test } from "bun:test";
import { assetDataProvider } from "../../../capabilities/factories";
import { CapabilityRegistry } from "../../../capabilities/registry";
import type { DataProvider } from "../../../types/data-provider";
import type { PriceHistoryResult } from "../../../types/price-history";
import { HistoryRetentionError, type HistoryRetention } from "../../../sources/history-retention";
import { DesktopCapabilityBridge } from "../bun/desktop/capability-bridge";
import { decodeRpcResponse, decodeRpcValue, encodeRpcResponse, encodeRpcValue } from "./rpc-codec";

const { createRPC } = await import(new URL("../shared/rpc.ts", import.meta.resolve("electrobun/view")).href);

function transport(provider: DataProvider) {
  const registry = new CapabilityRegistry();
  registry.register("test", assetDataProvider(provider));
  const bridge = new DesktopCapabilityBridge({ getRegistry: () => registry, getWindowKey: () => "research" });
  let receiveClient: (value: unknown) => void, receiveServer: (value: unknown) => void;
  const client = createRPC({ maxRequestTime: 1000 });
  const server = createRPC({ requestHandler: { "backend.request": (request: unknown) =>
    encodeRpcResponse(() => bridge.handle({ send: { "capability.event": () => {} } }, decodeRpcValue(request))) } });
  client.setTransport({ registerHandler: (handler: typeof receiveClient) => { receiveClient = handler; },
    send: (value: unknown) => { queueMicrotask(() => receiveServer(JSON.parse(JSON.stringify(value)))); } });
  server.setTransport({ registerHandler: (handler: typeof receiveServer) => { receiveServer = handler; },
    send: (value: unknown) => { queueMicrotask(() => receiveClient(JSON.parse(JSON.stringify(value)))); } });
  return { registry, request: (operationId: string, payload: unknown) => client.request["backend.request"](encodeRpcValue({
    method: "capability.invoke", payload: { capabilityId: `asset-data.${provider.id}`, operationId, payload },
  })).then(decodeRpcResponse) };
}

test("history metadata methods cross desktop capabilities and JSON with Dates, acquisition time and context intact", async () => {
  const calls: unknown[][] = [];
  const result: PriceHistoryResult = { points: [{ date: new Date("2026-09-21T19:45:00Z"), close: 338.89, volume: 2218511 }],
    resolution: "15m", sourceKey: "provider:gloomberb-cloud", session: { version: 1, kind: "regular", calendar: "us-equity",
      timeZone: "America/New_York", symbol: "AAPL", exchange: "NASDAQ", interval: "15min", source: "yahoo",
      timestampConvention: "bar-open", barAlignment: "session-open", observedAt: Date.parse("2026-09-22T12:42:12Z") } };
  const load = async (...args: unknown[]) => { calls.push(args); return result; };
  const { request } = transport({ id: "test", name: "History", getPriceHistoryWithMetadata: load,
    getPriceHistoryForResolutionWithMetadata: load, getDetailedPriceHistoryWithMetadata: load } as unknown as DataProvider);
  const startDate = new Date("2026-09-14T00:00:00Z"), endDate = new Date("2026-09-22T12:42:12Z");
  const context = { brokerId: "ibkr", brokerInstanceId: "work", instrument: { brokerId: "ibkr", conId: 11, symbol: "AAPL" },
    historyRequestKey: "stable-acquisition", cacheMode: "refresh" };
  expect(await request("getDetailedPriceHistoryWithMetadata", { ticker: "AAPL", exchange: "NASDAQ", startDate, endDate, barSize: "15m", context })).toEqual(result);
  expect(calls[0]).toEqual(["AAPL", "NASDAQ", startDate, endDate, "15m", context]);
  expect(await request("getPriceHistoryForResolutionWithMetadata", { ticker: "AAPL", exchange: "NASDAQ", bufferRange: "1M", resolution: "15m", context })).toEqual(result);
  expect(calls[1]).toEqual(["AAPL", "NASDAQ", "1M", "15m", context]);
  expect(await request("getPriceHistoryWithMetadata", { ticker: "AAPL", exchange: "NASDAQ", range: "1M", context })).toEqual(result);
  expect(calls).toHaveLength(3);
});

test("metadata-aware desktop history preserves typed retention errors and does not advertise unsupported methods", async () => {
  const now = Math.floor(Date.now() / 1000) * 1000;
  const retention: HistoryRetention = { version: 1, source: "yahoo", symbol: "BTC-USD", exchange: "CCC", interval: "15min",
    requestedStart: now - 90 * 86_400_000, requestedEnd: now, observedAt: now, availableStart: now - 60 * 86_400_000 };
  const { request } = transport({ id: "test", name: "History", getDetailedPriceHistoryWithMetadata: async () => {
    throw new HistoryRetentionError(retention);
  } } as unknown as DataProvider);
  const error = await request("getDetailedPriceHistoryWithMetadata", { ticker: "BTC-USD", exchange: "CCC",
    startDate: new Date(retention.requestedStart), endDate: new Date(retention.requestedEnd), barSize: "15m" }).catch((failure: unknown) => failure);
  expect(error).toBeInstanceOf(HistoryRetentionError);
  expect((error as HistoryRetentionError).retention).toEqual(retention);
  const legacy = transport({ id: "legacy", name: "Legacy", getPriceHistory: async () => [] } as unknown as DataProvider);
  expect(legacy.registry.manifests()[0]!.operations.some(op => op.id.endsWith("WithMetadata"))).toBe(false);
});
