import { expect, test } from "bun:test";
import { createTestHeadlessArgs, createTestHeadlessContext } from "../../../test-support/headless";
import type { ExposurePayload, ExposureRequest } from "../../../api-client/exposure";
import { createTestTicker } from "../../../test-support/ticker";
import { exposureHeadless } from "./headless";
import { DEFAULT_SCENARIO } from "./model";
import audited from "./fixtures/taiwan.fixture.json";

function context(requests: ExposureRequest[]) {
  return createTestHeadlessContext({ apiClient: {
    getCloudExposureScenarios: async () => ({ scenarios: [DEFAULT_SCENARIO] }),
    analyzeCloudExposure: async (request: ExposureRequest) => { requests.push(request); return structuredClone(audited) as ExposurePayload; },
  } as ReturnType<typeof createTestHeadlessContext>["apiClient"] });
}
test("headless sends signed weights and exports complete per-hop evidence plus source limitations", async () => {
  const requests: ExposureRequest[] = [];
  const result = await exposureHeadless.load(createTestHeadlessArgs({ rawArgument: "AAPL=1.2 NVDA=-.4", options: { depth: 3, cash: "0.2" } }), context(requests));
  expect(requests[0]).toMatchObject({ holdings: [{ symbol: "AAPL", weight: 1.2 }, { symbol: "NVDA", weight: -.4 }], depth: 3, cashWeight: .2 });
  expect(result.complete).toBe(false);
  expect(result.sections[1]!.rows!.some(r => Array.isArray(r.evidence) && r.evidence.some(e => e.quote && e.url))).toBe(true);
  expect(result.metadata?.payload).toMatchObject({ portfolio: { grossWeight: .95, cashWeight: .05 } });
});
test("headless watchlists resolve local membership before remote analysis and unknown watchlists fail closed", async () => {
  const requests: ExposureRequest[] = [], ctx = context(requests);
  const ticker = createTestTicker("2330", "TSMC", { exchange: "TWSE", watchlists: ["chips"] });
  ctx.resolveWatchlist = async id => id === "chips" ? [ticker] : null;
  await exposureHeadless.load(createTestHeadlessArgs({ rawArgument: "WATCH:chips" }), ctx);
  expect(requests[0]!.holdings[0]).toEqual({ symbol: "2330:TWSE", weight: 1 });
  await expect(exposureHeadless.load(createTestHeadlessArgs({ rawArgument: "WATCH:missing" }), ctx)).rejects.toThrow("Unknown local watchlist");
  expect(requests.length).toBe(1);
});
test("an unknown library id or invalid cash cannot produce a default scenario under a different label", async () => {
  const requests: ExposureRequest[] = [], ctx = context(requests);
  await expect(exposureHeadless.load(createTestHeadlessArgs({ rawArgument: "AAPL", options: { scenario: "not-a-scenario" } }), ctx)).rejects.toThrow("Unknown scenario");
  await expect(exposureHeadless.load(createTestHeadlessArgs({ rawArgument: "AAPL", options: { cash: "unknown" } }), ctx)).rejects.toThrow("Cash");
  expect(requests).toHaveLength(0);
});
