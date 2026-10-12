import { afterEach, expect, test } from "bun:test";
import type { CloudEarningsCallListPayload, CloudEarningsCallPayload, CloudEarningsTranscriptPayload } from "../../../api-client";
import { ApiRequestError } from "../../../api-client/errors";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import type { HeadlessPaneContext } from "../../../types/plugin";
import {
  attachEarningsCallsPersistence,
  loadEarningsCallsWithClient,
  loadTranscriptWithClient,
  resetEarningsCallsPersistence,
} from "./data";
import { createEarningsCallsHeadless } from "./headless";

type Client = Parameters<typeof loadEarningsCallsWithClient>[0];
const calls: CloudEarningsCallPayload[] = Array.from({ length: 200 }, (_, i) => ({
  id: `controlled-${i}`,
  ticker: "SYN",
  companyName: "Synthetic Research Fixture",
  fiscalYear: 2026 - Math.floor(i / 4),
  fiscalQuarter: 4 - i % 4,
  callAt: new Date(Date.UTC(2026 - Math.floor(i / 4), 11 - (i % 4) * 3, 1)).toISOString(),
  status: "published",
  durationSeconds: null,
  wordCount: null,
  hasTranscript: true,
  sentiment: null,
}));
const requestArgs = { argument: "SYN", rawArgument: "SYN", symbols: ["SYN"], options: {} };
function clientWith(load: Client["getCloudEarningsCalls"]): Client {
  return {
    getCloudEarningsCalls: load,
    getCloudEarningsTranscript: async () => { throw new Error("No transcript expected"); },
  };
}
afterEach(resetEarningsCallsPersistence);

test("a cached 50-call pane request cannot satisfy a 200-call research export", async () => {
  attachEarningsCallsPersistence(new MemoryPluginPersistence());
  const limits: number[] = [];
  const client = clientWith(async ({ limit = 50 } = {}) => {
    limits.push(limit);
    return { calls: calls.slice(0, limit) };
  });
  await loadEarningsCallsWithClient(client, "SYN", { limit: 50 });
  const report = await createEarningsCallsHeadless().load(
    { ...requestArgs, options: { limit: 200 } }, { apiClient: client } as HeadlessPaneContext,
  );
  expect(report.rows).toHaveLength(200);
  expect(limits).toEqual([50, 200]);
  expect(report.complete).toBe(false);
  expect(report.metadata).toMatchObject({ sourceLimit: 200, sourceLimitReached: true, totalIsExact: false, truncated: true });
  const cached = await loadEarningsCallsWithClient(client, "SYN", { limit: 200 });
  expect(cached).toMatchObject({ sourceLimit: 200, sourceLimitReached: true });
  expect(limits).toEqual([50, 200]);
});

test("a later page is requested from the server and never answers the cached first page", async () => {
  attachEarningsCallsPersistence(new MemoryPluginPersistence());
  const requested: Array<{ limit?: number; offset?: number }> = [];
  const client = clientWith(async ({ limit = 50, offset = 0 } = {}) => {
    requested.push({ limit, offset });
    return { calls: calls.slice(offset, offset + limit) };
  });
  const first = await loadEarningsCallsWithClient(client, "SYN", { limit: 50 });
  expect(first.calls[0]!.id).toBe("controlled-0");
  expect(first.sourceLimitReached).toBe(true);

  const second = await loadEarningsCallsWithClient(client, "SYN", { limit: 50, offset: 50 });
  expect(second.calls[0]!.id).toBe("controlled-50");
  // A page is live data: asking again reaches the server rather than a cache
  // entry that would also shadow the first page.
  const secondAgain = await loadEarningsCallsWithClient(client, "SYN", { limit: 50, offset: 50 });
  expect(secondAgain.calls[0]!.id).toBe("controlled-50");
  const cachedFirst = await loadEarningsCallsWithClient(client, "SYN", { limit: 50 });
  expect(cachedFirst.calls[0]!.id).toBe("controlled-0");
  expect(requested).toEqual([
    { limit: 50, offset: 0 },
    { limit: 50, offset: 50 },
    { limit: 50, offset: 50 },
  ]);
});

test("a failing later page surfaces its error instead of an expired first page", async () => {
  const store = new MemoryPluginPersistence();
  attachEarningsCallsPersistence(store);
  const client = clientWith(async ({ offset = 0 } = {}) => {
    if (offset > 0) throw new ApiRequestError("Controlled page outage", 503);
    return { calls: calls.slice(0, 50) };
  });
  await loadEarningsCallsWithClient(client, "SYN", { limit: 50 });
  await expect(loadEarningsCallsWithClient(client, "SYN", { limit: 50, offset: 50 }))
    .rejects.toThrow("Controlled page outage");
});

for (const marker of ["pending", "unknownTicker"] as const) {
  test(`empty results retain ${marker} semantics for the pane and transcript export`, async () => {
    attachEarningsCallsPersistence(new MemoryPluginPersistence());
    let requests = 0;
    const client = clientWith(async () => { requests++; return { calls: [], [marker]: true }; });
    const first = await loadEarningsCallsWithClient(client, "SYN");
    const second = await loadEarningsCallsWithClient(client, "SYN");
    expect(first[marker]).toBe(true);
    expect(second[marker]).toBe(true);
    expect(requests).toBe(marker === "pending" ? 2 : 1);
    await expect(createEarningsCallsHeadless().load(
      { ...requestArgs, options: { quarter: "latest" } }, { apiClient: client } as HeadlessPaneContext,
    )).rejects.toThrow(marker === "pending" ? "still pending" : "not a known listed company");
  });
}

test("different depths do not share an in-flight result, equivalent normalized requests do", async () => {
  let finish!: (value: CloudEarningsCallListPayload) => void;
  const requested: Array<{ ticker?: string; limit?: number }> = [];
  const client = clientWith((options = {}) => {
    requested.push(options);
    return options.limit === 50 ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ calls });
  });
  const shallow = loadEarningsCallsWithClient(client, " syn ", { limit: 50.9 });
  const equivalent = loadEarningsCallsWithClient(client, "SYN");
  const deep = loadEarningsCallsWithClient(client, "SYN", { limit: 500 });
  finish({ calls: calls.slice(0, 50) });
  expect((await shallow).calls).toHaveLength(50);
  expect((await equivalent).calls).toHaveLength(50);
  expect((await deep).calls).toHaveLength(200);
  expect(requested).toEqual([{ ticker: "SYN", limit: 50 }, { ticker: "SYN", limit: 200 }]);
});

test("a listing abroad never shares calls with its US namesake, and refuses the namesake's calls", async () => {
  attachEarningsCallsPersistence(new MemoryPluginPersistence());
  const call = (id: string, companyName: string) => ({ ...calls[0]!, id, ticker: "AI", companyName });
  const requested: Array<Parameters<Client["getCloudEarningsCalls"]>[0]> = [];
  let venueAware = false;
  // A server that predates venue-aware lookups ignores the venue and lists C3.ai's calls.
  const client = clientWith(async (params = {}) => {
    requested.push(params);
    return { calls: [venueAware && params.exchange ? call("paris", "Air Liquide S.A.") : call("us", "C3.ai, Inc.")] };
  });
  const ids = (result: { calls: CloudEarningsCallPayload[] }) => result.calls.map((row) => row.id);
  const [us, abroad] = await Promise.all([
    loadEarningsCallsWithClient(client, "AI"),
    loadEarningsCallsWithClient(client, "AI", { exchange: "XPAR", name: "Air Liquide S.A." }),
  ]);
  expect([ids(us), ids(abroad)]).toEqual([["us"], []]);
  venueAware = true;
  expect(ids(await loadEarningsCallsWithClient(client, "AI:EPA", { name: "Air Liquide S.A.", force: true }))).toEqual(["paris"]);
  expect(ids(await loadEarningsCallsWithClient(client, "AI"))).toEqual(["us"]);
  expect(ids(await loadEarningsCallsWithClient(client, "AI", { exchange: "EPA", name: "Air Liquide S.A." }))).toEqual(["paris"]);
  expect(requested).toEqual([
    { ticker: "AI", limit: 50 },
    { ticker: "AI", exchange: "EPA", name: "Air Liquide S.A.", limit: 50 },
    { ticker: "AI:EPA", exchange: "EPA", name: "Air Liquide S.A.", limit: 50 },
  ]);
});

test("an older response cannot overwrite a force-refreshed list in persistence", async () => {
  attachEarningsCallsPersistence(new MemoryPluginPersistence());
  let finishOld!: (value: CloudEarningsCallListPayload) => void;
  let count = 0;
  const client = clientWith(() => ++count === 1
    ? new Promise(resolve => { finishOld = resolve; }) : Promise.resolve({ calls: [calls[0]!] }));
  const old = loadEarningsCallsWithClient(client, "SYN");
  await loadEarningsCallsWithClient(client, "SYN", { force: true });
  finishOld({ calls: [calls[1]!] });
  expect((await old).calls[0]?.id).toBe(calls[1]!.id);
  expect((await loadEarningsCallsWithClient(client, "SYN")).calls[0]?.id).toBe(calls[0]!.id);
  expect(count).toBe(2);
});

test("an unsettled refresh invalidates an earlier settled empty result", async () => {
  attachEarningsCallsPersistence(new MemoryPluginPersistence());
  let count = 0;
  const client = clientWith(async () => ++count === 1 ? { calls: [] } : { calls: [], pending: true });
  await loadEarningsCallsWithClient(client, "SYN");
  expect((await loadEarningsCallsWithClient(client, "SYN", { force: true })).pending).toBe(true);
  expect((await loadEarningsCallsWithClient(client, "SYN")).pending).toBe(true);
  expect(count).toBe(3);
});

test("a reset prevents an old session from filling the next persistence store", async () => {
  attachEarningsCallsPersistence(new MemoryPluginPersistence());
  let finish!: (value: CloudEarningsCallListPayload) => void;
  const client = clientWith(() => new Promise(resolve => { finish = resolve; }));
  const old = loadEarningsCallsWithClient(client, "SYN");
  resetEarningsCallsPersistence();
  attachEarningsCallsPersistence(new MemoryPluginPersistence());
  finish({ calls: [calls[0]!] });
  await old;
  let requests = 0;
  const current = clientWith(async () => { requests++; return { calls: [calls[1]!] }; });
  expect((await loadEarningsCallsWithClient(current, "SYN")).calls[0]?.id).toBe(calls[1]!.id);
  expect(requests).toBe(1);
});

test("a transient refresh failure retains metadata, observations and their original retrieval time", async () => {
  attachEarningsCallsPersistence(new MemoryPluginPersistence());
  const client = clientWith(async () => ({ calls: [], unknownTicker: true }));
  await loadEarningsCallsWithClient(client, "SYN");
  const cached = await loadEarningsCallsWithClient(client, "SYN");
  client.getCloudEarningsCalls = async () => { throw new ApiRequestError("Controlled unavailable", 503); };
  expect(await loadEarningsCallsWithClient(client, "SYN", { force: true })).toMatchObject({
    calls: [], unknownTicker: true, stale: true, fetchedAt: cached.fetchedAt,
    refreshError: "Controlled unavailable", errorStatus: 503,
  });
});

for (const status of [401, 402, 403]) {
  test(`explicit ${status} remains an error instead of returning stale data`, async () => {
    attachEarningsCallsPersistence(new MemoryPluginPersistence());
    const client = clientWith(async () => ({ calls: [calls[0]!] }));
    await loadEarningsCallsWithClient(client, "SYN");
    client.getCloudEarningsCalls = async () => { throw new ApiRequestError("Controlled auth error", status); };
    await expect(loadEarningsCallsWithClient(client, "SYN", { force: true })).rejects.toThrow("Controlled auth error");
  });
}

const transcriptValue = (text: string): CloudEarningsTranscriptPayload => ({
  ...calls[0]!, timing: null, webcastUrl: null, fullText: text, turns: [], participants: [],
  summary: null, guidance: null, riskFactors: null, notable: null, analystFocus: null,
  sentimentRationale: null, qaStartTurn: null, asrModel: null, updatedAt: null,
});

test("an older transcript response cannot rewind a completed force refresh", async () => {
  attachEarningsCallsPersistence(new MemoryPluginPersistence());
  let finish!: (value: CloudEarningsTranscriptPayload) => void;
  let requests = 0;
  const client = clientWith(async () => ({ calls: [] }));
  client.getCloudEarningsTranscript = () => ++requests === 1
    ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(transcriptValue("Current response"));
  const old = loadTranscriptWithClient(client, "controlled-0");
  await loadTranscriptWithClient(client, "controlled-0", { force: true });
  finish(transcriptValue("Earlier response"));
  expect((await old).fullText).toBe("Earlier response");
  expect((await loadTranscriptWithClient(client, "controlled-0")).fullText).toBe("Current response");
  expect(requests).toBe(2);
});

test("a transcript response from before reset cannot fill the replacement store", async () => {
  attachEarningsCallsPersistence(new MemoryPluginPersistence());
  let finish!: (value: CloudEarningsTranscriptPayload) => void;
  const client = clientWith(async () => ({ calls: [] }));
  client.getCloudEarningsTranscript = () => new Promise(resolve => { finish = resolve; });
  const old = loadTranscriptWithClient(client, "controlled-0");
  resetEarningsCallsPersistence();
  attachEarningsCallsPersistence(new MemoryPluginPersistence());
  finish(transcriptValue("Previous session"));
  await old;
  let requests = 0;
  client.getCloudEarningsTranscript = async () => { requests++; return transcriptValue("Current session"); };
  expect((await loadTranscriptWithClient(client, "controlled-0")).fullText).toBe("Current session");
  expect(requests).toBe(1);
});

test("a forced pending transcript invalidates published cache until content recovers", async () => {
  attachEarningsCallsPersistence(new MemoryPluginPersistence());
  let requests = 0;
  const client = clientWith(async () => ({ calls: [] }));
  client.getCloudEarningsTranscript = async () => {
    requests++;
    return requests === 2 ? { status: "pending" } as CloudEarningsTranscriptPayload
      : transcriptValue(requests === 1 ? "Original" : "Recovered");
  };
  await loadTranscriptWithClient(client, "controlled-0");
  expect((await loadTranscriptWithClient(client, "controlled-0", { force: true })).status).toBe("pending");
  expect((await loadTranscriptWithClient(client, "controlled-0")).fullText).toBe("Recovered");
  expect(requests).toBe(3);
});

for (const status of [401, 402, 403, 503]) {
  test(`transcript refresh status ${status} preserves the existing entitlement/fallback boundary`, async () => {
    attachEarningsCallsPersistence(new MemoryPluginPersistence());
    const client = clientWith(async () => ({ calls: [] }));
    client.getCloudEarningsTranscript = async () => transcriptValue("Available text");
    await loadTranscriptWithClient(client, "controlled-0");
    client.getCloudEarningsTranscript = async () => { throw new ApiRequestError("Controlled failure", status); };
    const refresh = loadTranscriptWithClient(client, "controlled-0", { force: true });
    if (status === 503) expect((await refresh).fullText).toBe("Available text");
    else await expect(refresh).rejects.toThrow("Controlled failure");
  });
}
