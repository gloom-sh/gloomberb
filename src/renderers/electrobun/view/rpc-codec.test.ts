import { expect, test } from "bun:test";
import { ApiRequestError } from "../../../api-client/errors";
import { HistoryRetentionError, type HistoryRecoveryCandidate, type HistoryRetention } from "../../../sources/history-retention";
import { decodeRpcResponse, decodeRpcValue, encodeRpcResponse, encodeRpcValue } from "./rpc-codec";

// Load Electrobun's actual transport core without starting its window/socket entrypoint.
const { createRPC } = await import(new URL("../shared/rpc.ts", import.meta.resolve("electrobun/view")).href);

function requestThroughRpc(load: () => unknown | Promise<unknown>, encode = encodeRpcResponse) {
  let receiveClient: (packet: unknown) => void;
  let receiveServer: (packet: unknown) => void;
  const client = createRPC({ maxRequestTime: 1000 });
  const server = createRPC({ requestHandler: { "backend.request": () => encode(load) } });
  client.setTransport({
    registerHandler: (handler: typeof receiveClient) => { receiveClient = handler; },
    send: (packet: unknown) => { queueMicrotask(() => receiveServer(JSON.parse(JSON.stringify(packet)))); },
  });
  server.setTransport({
    registerHandler: (handler: typeof receiveServer) => { receiveServer = handler; },
    send: (packet: unknown) => { queueMicrotask(() => receiveClient(JSON.parse(JSON.stringify(packet)))); },
  });
  return client.request["backend.request"]({ method: "capability.invoke", payload: null }).then(decodeRpcResponse);
}

test.each([401, 402, 403, 429, 503, undefined])("API error %s survives Electrobun's JSON transport", async (status) => {
  const failure = await requestThroughRpc(() => { throw new ApiRequestError("Controlled provider failure", status, 2000); }).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(ApiRequestError);
  expect(failure.message).toBe("Controlled provider failure");
  expect(failure.status).toBe(status);
  expect(failure.retryAfterMs).toBe(2000);
});

test("successful research preserves dates, maps, nulls and response-shaped payloads", async () => {
  const value = {
    dated: new Date("2026-09-12T00:00:00Z"),
    nested: new Map([["symbol", { observations: [null, 0, 12.34] }]]),
    __gloomRpcResponse: 1, ok: false, error: { message: "This is legitimate data", status: 403 },
  };
  expect(await requestThroughRpc(() => value)).toEqual(value);
  expect(await requestThroughRpc(() => null)).toBeNull();
  expect(await requestThroughRpc(() => undefined)).toBeUndefined();
  expect(decodeRpcValue(encodeRpcValue(value.dated))).toEqual(value.dated);
});

test("generic failures retain their message without inventing API status", async () => {
  const failure = await requestThroughRpc(() => { throw new Error("Research source timed out"); }).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect(failure).not.toBeInstanceOf(ApiRequestError);
  expect(failure.message).toBe("Research source timed out");
  expect(failure.status).toBeUndefined();
});

test("malformed response metadata cannot become a trusted API rejection", () => {
  for (const error of [null, {}, { message: 42 }, { message: "x", status: "403" }, { message: "x", status: 0 }, { message: "x", retryAfterMs: -1 }]) {
    try {
      decodeRpcResponse({ __gloomRpcResponse: 1, ok: false, error });
      throw new Error("Expected a malformed-response rejection");
    } catch (failure) {
      expect(failure).not.toBeInstanceOf(ApiRequestError);
      expect((failure as Error).message).toBe("Invalid desktop response");
    }
  }
  expect(() => decodeRpcResponse({ __gloomRpcResponse: 2, ok: true, value: 42 })).toThrow("Unsupported desktop response");
  expect(() => decodeRpcResponse(encodeRpcValue(new Map([["symbol", 1]])))).toThrow("Invalid desktop response");
});

function retentionFixture(): { retention: HistoryRetention; candidate: HistoryRecoveryCandidate } {
  const now = Math.floor(Date.now() / 1000) * 1000;
  const retention: HistoryRetention = { version: 1, source: "yahoo", symbol: "BTC-USD", exchange: "CCC", interval: "15min",
    requestedStart: now - 90 * 86_400_000, requestedEnd: now, observedAt: now, availableStart: now - 60 * 86_400_000 };
  return { retention, candidate: { sourceKey: "provider:cloud-test", retention, request: {
    symbol: "BTC-USD", exchange: "CCC", entityKey: "contract:11", brokerId: "ibkr", brokerInstanceId: "work",
    interval: "15min", requestedStart: retention.requestedStart, requestedEnd: retention.requestedEnd,
  } } };
}

test("scoped history failure survives the actual desktop JSON transport with frozen outcomes", async () => {
  const { retention, candidate } = retentionFixture();
  const source = new HistoryRetentionError(retention, { candidates: [candidate], outcomes: [
    { sourceKey: "provider:cloud-test", outcome: "retention" }, { sourceKey: "broker:ibkr:work", outcome: "timeout" },
    { sourceKey: "provider:limited", outcome: "rate-limit", status: 429 },
  ] });
  const failure = await requestThroughRpc(() => { throw source; }).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(HistoryRetentionError);
  expect(failure.candidates).toEqual(source.candidates);
  expect(failure.outcomes).toEqual(source.outcomes);
  expect(Object.isFrozen(failure.candidates[0].retention)).toBe(true);
  expect(Object.isFrozen(failure.outcomes)).toBe(true);
  // A raw Cloud failure can also cross a bridge before outer routing binds it.
  expect(await requestThroughRpc(() => { throw new HistoryRetentionError(retention); }).catch((error: unknown) => error)).toBeInstanceOf(HistoryRetentionError);
});

test("malformed desktop retention source, bounds, interval or candidate scope is rejected", () => {
  const { retention, candidate } = retentionFixture();
  const base = { kind: "history-retention", retention, candidates: [candidate], outcomes: [{ sourceKey: candidate.sourceKey, outcome: "retention" }] };
  for (const mutate of [
    (value: any) => { value.retention.source = "arbitrary-url"; },
    (value: any) => { value.retention.interval = "unknown"; },
    (value: any) => { value.retention.interval = "2min"; },
    (value: any) => { value.retention.availableStart += 1000; },
    (value: any) => { value.retention.requestedStart = value.retention.availableStart; },
    (value: any) => { value.retention.observedAt += 60_000; },
    (value: any) => { value.retention.observedAt -= 300_001; },
    (value: any) => { value.candidates[0].request.symbol = "OTHER"; },
    (value: any) => { value.candidates[0].request.symbol = "OTHER"; value.candidates[0].retention.symbol = "OTHER"; },
    (value: any) => { value.candidates[0].sourceKey = "broker:ibkr:work"; },
    (value: any) => { value.outcomes[0].outcome = "rate-limit"; },
  ]) {
    const value = JSON.parse(JSON.stringify(base)); mutate(value);
    expect(() => decodeRpcResponse({ __gloomRpcResponse: 1, ok: false, error: value })).toThrow("Invalid desktop response");
  }
});
