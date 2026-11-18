import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import type { FuturesContractTermsPayload } from "../api-client/futures-curve";
import { apiClient } from "../api-client";
import { ApiRequestError } from "../api-client/errors";
import { forgetDataServiceReach, noteDataServiceReach, SHOT_SERVICE_UNREACHABLE_HEADER } from "../api-client/request";
import { collectSavedCopies, savedCopyAt } from "../data/saved-copies";
import { attachFuturesTermsPersistence, loadFuturesContractTerms } from "../market-data/futures-contract";
import { MemoryPluginPersistence } from "../test-support/plugin-persistence";
import { DataServiceUnreachableError } from "../utils/network-failure";
import { answerShotApiCall } from "./desktop-pane-shot";
import { progressNotice } from "./pane-functions";
import { withUnreachedSavedCopyWarning } from "./result";

/**
 * Offline, `fn DES GC=F` took 23 s, kept the saved quote but dated it as
 * "15 min delayed", dropped the settle and the Contract block, never said the
 * data service went unanswered, and opened with "Still loading the data for
 * T GC=F."; `quote GC=F` lost the contract terms and the settle label.
 */

const GOLD: FuturesContractTermsPayload = {
  symbol: "GC=F", root: "GC", name: "Gold", contract: "GCZ26", contractSymbol: "GCZ26.CMX", deliveryMonth: "2026-12",
  spec: { unit: "USD / troy oz", size: "100 troy oz", pointValue: 100, tick: 0.1, tickValue: 10, settlement: "physical" },
  lastTrade: "2026-12-29", firstNotice: "2026-11-30", inDelivery: false, settlement: { price: 3864.2, date: "2026-11-17" },
};

// The data service: it answers the terms, and anything else with a quote.
const service = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  fetch: (request) => new URL(request.url).pathname === "/v1/cloud/futures/contract/GC=F" || new URL(request.url).pathname === "/v1/cloud/futures/contract/GC%3DF"
    ? Response.json(GOLD) : Response.json({ symbol: "GC=F", price: 3767.2 }),
});
// A connection that is accepted and never answered: a hung proxy.
const held: unknown[] = [];
const hung = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { open: (socket) => { held.push(socket); }, data: () => {} } });
afterAll(() => { service.stop(true); hung.stop(true); });

beforeEach(() => {
  forgetDataServiceReach();
  attachFuturesTermsPersistence(new MemoryPluginPersistence());
});
afterEach(() => forgetDataServiceReach());

const read = (path: string, apiProxy: Parameters<typeof answerShotApiCall>[1]) =>
  answerShotApiCall(JSON.stringify({ id: 1, path, headers: [] }), apiProxy).then((reply) => JSON.parse(reply));
const body = (reply: { body: string }) => JSON.parse(Buffer.from(reply.body, "base64").toString("utf8"));

test("a capture's page gets a futures symbol's terms from their saved copy once the service goes unanswered, and every read is bounded", async () => {
  const online = { baseUrl: `http://127.0.0.1:${service.port}/v1`, sessionToken: null };
  expect(body(await read("/cloud/futures/contract/GC%3DF", online))).toMatchObject({ contract: "GCZ26", settlement: { price: 3864.2 } });

  // The command's own read just went unanswered.
  noteDataServiceReach(false);
  const saved: number[] = [];
  const offline = { baseUrl: `http://127.0.0.1:${hung.port}/v1`, sessionToken: null, onSavedCopy: (at: number) => { saved.push(at); } };
  const started = Date.now();
  const terms = await read("/cloud/futures/contract/GC%3DF", offline);
  expect(Date.now() - started).toBeLessThan(1_000);
  expect(terms.status).toBe(200);
  expect(body(terms)).toMatchObject({ contract: "GCZ26", spec: { size: "100 troy oz" }, settlement: { price: 3864.2, date: "2026-11-17" } });
  expect(saved).toHaveLength(1);

  // Any other read waits three seconds, as the client's own would once the service is unreachable, not until the page gives up.
  const cutStarted = Date.now();
  const quote = await read("/market/quote?symbol=GC%3DF", offline);
  const waited = Date.now() - cutStarted;
  expect(waited).toBeGreaterThanOrEqual(2_500);
  expect(waited).toBeLessThan(6_000);
  expect(quote.status).toBe(502);
  expect(new Map(quote.headers).get(SHOT_SERVICE_UNREACHABLE_HEADER.toLowerCase())).toBe("1");
}, 15_000);

test("a command's futures terms answer from their saved copy, dated as saved, when the service is not reached; a refusal stays an error", async () => {
  let answer: () => Promise<FuturesContractTermsPayload> = async () => GOLD;
  const original = apiClient.getCloudFuturesContract;
  apiClient.getCloudFuturesContract = (() => answer()) as typeof original;
  try {
    await collectSavedCopies(async () => {
      const fresh = await loadFuturesContractTerms("GC=F");
      expect(savedCopyAt(fresh)).toBeNull();
      answer = async () => { throw new DataServiceUnreachableError(new Error("offline")); };
      const offline = await loadFuturesContractTerms("GC=F");
      expect(offline).toMatchObject({ contract: "GCZ26", settlement: { price: 3864.2 } });
      expect(savedCopyAt(offline)).not.toBeNull();
      answer = async () => { throw new ApiRequestError("Not a futures symbol with known contract terms", 404); };
      await expect(loadFuturesContractTerms("GC=F")).rejects.toThrow("Not a futures symbol");
    });
  } finally {
    apiClient.getCloudFuturesContract = original;
  }
});

test("output shown from saved copies while the service went unanswered says so, in the unreachable words", () => {
  const freshness = { source: "Gloom Cloud", status: "delayed", retrievedAt: "2026-11-18T11:30:00.000Z", savedAt: "2026-11-18T09:10:00.000Z" } as const;
  const result = { data: [], freshness } as never;
  expect(withUnreachedSavedCopyWarning(result)).toBe(result);
  noteDataServiceReach(false);
  expect((withUnreachedSavedCopyWarning(result) as { warnings?: string[] }).warnings?.[0])
    .toStartWith("Gloom couldn't reach its data service, so this is the copy saved earlier. Check the internet connection");
  // Current data, however the service fared, says nothing.
  const current = { data: [], freshness: { ...freshness, savedAt: undefined } } as never;
  expect(withUnreachedSavedCopyWarning(current)).toBe(current);
});

test("a slow report's progress line is a terminal's alone, and is cleared once the report is in", async () => {
  const written: string[] = [];
  const terminal = { isTTY: true, write: (text: string) => { written.push(text); return true; } };
  const progress = progressNotice({ cliOptions: { quiet: false } } as never, "T GC=F", 5, terminal as never);
  await Bun.sleep(20);
  progress.stop();
  expect(written[0]).toContain("Still loading the data for T GC=F.");
  expect(written.at(-1)).toBe("\r\x1b[2K");
  const piped: string[] = [];
  const quiet = progressNotice({ cliOptions: { quiet: false } } as never, "T GC=F", 5, { isTTY: false, write: (text: string) => { piped.push(text); return true; } } as never);
  await Bun.sleep(20);
  quiet.stop();
  expect(piped).toEqual([]);
});
