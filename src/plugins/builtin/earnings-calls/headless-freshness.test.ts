import { afterEach, expect, test } from "bun:test";
import { apiClient, setCloudApiFetchTransport } from "../../../api-client";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import { attachEarningsCallsPersistence, resetEarningsCallsPersistence } from "./data";
import { earningsCallsHeadless } from "./headless";
import { buildHeadlessFunctionReport } from "../../../cli/pane-functions/headless";
import { createDefaultConfig } from "../../../types/config";
const call = {id:"FIRST-q1",ticker:"FIRST",companyName:"First Corp",fiscalYear:2026,fiscalQuarter:1,callAt:"2026-05-01T20:00:00Z",status:"published",durationSeconds:3600,wordCount:50,hasTranscript:true,sentiment:null};
const transcript = {...call,timing:null,webcastUrl:null,fullText:"Management expects 20% growth.",turns:[],participants:[],summary:null,guidance:"Management expects 20% growth.",riskFactors:null,analystFocus:null,notable:null,sentimentRationale:null,qaStartTurn:null,asrModel:null,updatedAt:"2026-05-02T00:00:00Z"};

afterEach(() => { resetEarningsCallsPersistence(); setCloudApiFetchTransport(null); apiClient.setSessionToken(null); });
for (const stale of [false, true]) {
  for (const quarter of ["latest", "FQ1-2026"]) {
    test(`${quarter} guidance preserves usable rows and ${stale ? "failed" : "fresh"} discovery provenance`, async () => {
      const store = new MemoryPluginPersistence();
      attachEarningsCallsPersistence(store);
      if (stale) store.seedResource("calls", JSON.stringify(["FIRST", 200]), { calls: [call] },
        { sourceKey: "earnings-calls", schemaVersion: 3, stale: true, expired: true });
      store.seedResource("transcript", call.id, transcript, { sourceKey: "earnings-calls", schemaVersion: 1 });
      apiClient.setSessionToken("controlled-test-session");
      setCloudApiFetchTransport(async () => stale
        ? Response.json({ error: "Controlled call discovery outage" }, { status: 503 })
        : Response.json({ calls: [call] }));
      const report = await buildHeadlessFunctionReport({
        headless: earningsCallsHeadless, token: "CALLS", label: "Earnings Calls",
        options: { quarter, section: "guidance", limit: 20, offset: 0 }, instance: { settings: {} }, capability: { id: "transcript" },
      } as never, { config: createDefaultConfig("/tmp/unused-offline-transcript-report"), store: { loadTicker: async () => null } } as never, "FIRST");
      expect(report.data).toMatchObject({ complete: !stale, rowCount: 1, unavailableSymbols: [],
        metadata: { stale, callListFetchedAt: expect.any(Number), callListPending: false, fiscalQuarter: 1, callAt: call.callAt },
      });
      expect(report.text).toContain("20% growth");
      if (stale) {
        expect(report.data.errors).toEqual(["Controlled call discovery outage"]);
        expect(report.text).toContain("Controlled call discovery outage");
      } else {
        expect(report.data.errors).toBeUndefined();
        expect(report.text).not.toContain("Controlled call discovery outage");
      }
    });
  }
}
