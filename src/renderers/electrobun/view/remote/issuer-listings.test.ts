import { expect, mock, test } from "bun:test";
import { assetDataProvider } from "../../../../capabilities/factories";
import { CapabilityRegistry } from "../../../../capabilities/registry";
import { ahPairOf, ahPairSide, listingBoardLot } from "../../../../market-data/ah-pair";
import { createRpcLoopback } from "../../../../test-support/rpc-loopback";
import type { DataProvider } from "../../../../types/data-provider";
import type { IssuerListings } from "../../../../types/issuer-listings";
import { DesktopCapabilityBridge } from "../../bun/desktop/capability-bridge";
import { decodeRpcResponse, decodeRpcValue, encodeRpcResponse, encodeRpcValue } from "../../shared/rpc-codec";

// BYD's lines as the company universe holds them, and HSBC's, a company with no A shares.
const BYD: IssuerListings = { issuer: "byd", name: "BYD", country: "CN", listings: [
  { symbol: "002594:SZSE", exchange: "SZSE", name: "BYD", primary: true },
  { symbol: "1211:HKEX", exchange: "HKEX", name: "BYD", primary: false, boardLot: 500 },
] };
const HSBC: IssuerListings = { issuer: "hsbc", name: "HSBC", country: "GB", listings: [
  { symbol: "HSBA:LSE", exchange: "LSE", name: "HSBC", primary: true },
  { symbol: "0005:HKEX", exchange: "HKEX", name: "HSBC", primary: false, boardLot: 400 },
  { symbol: "HSBC", exchange: "NYSE", name: "HSBC", primary: false },
] };

// The view's client reads the backend's manifest and sends each call through the real bridge and RPC codec.
let registry = new CapabilityRegistry();
const bridge = new DesktopCapabilityBridge({ getRegistry: () => registry, getWindowKey: () => "research" });
const send = createRpcLoopback((request) =>
  encodeRpcResponse(() => bridge.handle({ send: { "capability.event": () => {} } }, decodeRpcValue(request))));
mock.module("../backend-rpc", () => ({
  getElectrobunBackendInitSnapshot: () => ({ capabilityManifests: registry.manifests() }),
  // A run keeps the names the first mock of this module exports, so each mock of it here exports all three.
  subscribeBackendCapability: () => () => {},
  backendRequest: (method: string, payload: unknown) => send(encodeRpcValue({ method, payload })).then(decodeRpcResponse),
}));

function backend(provider: Partial<DataProvider>) {
  registry = new CapabilityRegistry();
  registry.register("test", assetDataProvider({ id: "asset-data-router", name: "Router", ...provider } as DataProvider));
}

test("the desktop view reads a company's lines from the backend, from either A+H line however it is written", async () => {
  const asked: unknown[] = [];
  backend({ getIssuerListings: async (symbol, exchange) => {
    asked.push([symbol, exchange]);
    return symbol.startsWith("0005") ? HSBC : BYD;
  } });
  const manifest = registry.manifests()[0]!.operations.find((operation) => operation.id === "getIssuerListings");
  expect(manifest).toMatchObject({ rendererSafe: true, inputShape: "{ symbol: string, exchange?: string }" });
  const { createRemoteAssetDataClient } = await import("./asset-data-client");
  const client = createRemoteAssetDataClient();
  // Saved tickers (002594 on its MIC, 01211 in HKEX's five digits) and keys with the venue in them.
  for (const [symbol, exchange, other] of [["002594", "XSHE", "1211:HKEX"], ["002594:SZSE", undefined, "1211:HKEX"],
    ["01211", "HKEX", "002594:SZSE"], ["1211:HKEX", undefined, "002594:SZSE"]] as const) {
    const issuer = await client.getIssuerListings!(symbol, exchange);
    expect(issuer).toEqual(BYD);
    const pair = ahPairOf(issuer)!;
    expect(ahPairSide(pair, symbol, exchange) === "h" ? pair.a : pair.h).toBe(other);
  }
  expect(listingBoardLot(await client.getIssuerListings!("01211", "HKEX"), "01211", "HKEX")).toBe(500);
  // A Hong Kong line of a company without A shares keeps its board lot and has no pair.
  const hsbc = await client.getIssuerListings!("0005", "HKEX");
  expect([ahPairOf(hsbc), listingBoardLot(hsbc, "0005", "HKEX")]).toEqual([null, 400]);
  expect(asked).toEqual([["002594", "XSHE"], ["002594:SZSE", undefined], ["01211", "HKEX"], ["1211:HKEX", undefined], ["01211", "HKEX"], ["0005", "HKEX"]]);
});

test("a backend whose sources hold no company listings leaves the read off the view's client", async () => {
  backend({});
  const { createRemoteAssetDataClient } = await import("./asset-data-client");
  expect(createRemoteAssetDataClient().getIssuerListings).toBeUndefined();
});
