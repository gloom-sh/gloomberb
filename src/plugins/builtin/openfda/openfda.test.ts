import { afterEach, describe, expect, test } from "bun:test";
import { setHttpFetchTransport } from "../../../utils/http-transport";
import {
  OpenFdaClient,
  buildOpenFdaUrl,
  parseDeviceReport,
  parseDrugRecall,
  parseDrugReport,
  parseOpenFdaPage,
} from "./client";

const savedKey = process.env.OPENFDA_API_KEY;
afterEach(() => {
  setHttpFetchTransport(null);
  if (savedKey === undefined) delete process.env.OPENFDA_API_KEY;
  else process.env.OPENFDA_API_KEY = savedKey;
});

// Trimmed from a live FAERS answer to "metformin": the patient took twenty
// drugs, Dupixent was the suspect one and metformin was only concomitant.
const DRUG_REPORT = {
  safetyreportid: "26940238",
  receivedate: "20260630",
  serious: "1",
  seriousnesshospitalization: "1",
  occurcountry: "US",
  primarysource: { qualification: "5" },
  patient: {
    reaction: [{ reactionmeddrapt: "Upper-airway cough syndrome" }, { reactionmeddrapt: "Nasal congestion" }],
    drug: [
      { medicinalproduct: "DUPIXENT", drugcharacterization: "1", openfda: { generic_name: ["DUPILUMAB"], manufacturer_name: ["Sanofi-Aventis U.S. LLC"] } },
      { medicinalproduct: "AMLODIPINE BESYLATE", drugcharacterization: "2", openfda: { manufacturer_name: ["Zydus Pharmaceuticals USA Inc.", "Viatris Specialty LLC"] } },
      {
        medicinalproduct: "METFORMIN",
        drugcharacterization: "2",
        openfda: { generic_name: ["METFORMIN"], manufacturer_name: ["Mylan Pharmaceuticals Inc.", "Granules Pharmaceuticals Inc."] },
      },
    ],
  },
};

describe("openFDA requests", () => {
  test("join the search clauses with spaces, page by skip and keep each dataset's newest-first order", () => {
    const url = buildOpenFdaUrl("drug", "metformin", 100);
    // A literal "+OR+" is sent as "%2BOR%2B", which openFDA answers with no matches.
    expect(url).not.toContain("%2BOR%2B");
    const params = new URL(url).searchParams;
    // By drug name only: a generic's manufacturer list names every labeler.
    expect(params.get("search")).toBe(
      '(patient.drug.medicinalproduct:"metformin" OR patient.drug.openfda.brand_name:"metformin" OR '
      + 'patient.drug.openfda.generic_name:"metformin")',
    );
    expect(params.get("skip")).toBe("100");
    expect(params.get("sort")).toBe("receivedate:desc");
    expect(new URL(buildOpenFdaUrl("recall", "")).searchParams.has("search")).toBe(false);
    expect(new URL(buildOpenFdaUrl("device", 'insulin "pump"')).searchParams.get("search")).toContain('device.brand_name:"insulin pump"');
  });

  test("send the optional key in a header, never in the URL, treat no match as empty and fail loudly otherwise", async () => {
    process.env.OPENFDA_API_KEY = "test-key-123";
    const seen: Array<{ url: string; authorization: string | null }> = [];
    const answers = [
      new Response(JSON.stringify({ error: { code: "NOT_FOUND" } }), { status: 404 }),
      new Response("bad request", { status: 400 }),
    ];
    setHttpFetchTransport(async (url, init) => {
      seen.push({ url, authorization: new Headers(init?.headers).get("authorization") });
      return answers.shift() ?? new Response("bad request", { status: 400 });
    });
    const client = new OpenFdaClient();
    expect(await client.listPage("device", "no such device", 0)).toMatchObject({ rows: [], matched: 0, hasMore: false });
    await expect(client.listPage("drug", "x", 0)).rejects.toThrow("FDA data request failed (400)");
    expect(seen[0]!.url).not.toContain("test-key-123");
    expect(seen[0]!.authorization).toBe(`Basic ${btoa("test-key-123:")}`);
  });
});

describe("openFDA records", () => {
  test("a drug report names the drug the search matched, with its role, not the report's first drug", () => {
    const report = parseDrugReport(DRUG_REPORT, "metformin");
    expect(report).toMatchObject({
      id: "drug:26940238",
      product: "METFORMIN",
      role: "concomitant",
      outcome: "Serious",
      outcomes: ["Hospitalization"],
      reporter: "Consumer",
      reactions: ["Upper-airway cough syndrome", "Nasal congestion"],
    });
    // A generic lists every labeler, so none is named as the product's maker.
    expect(report?.manufacturer).toBeNull();
    expect(parseDrugReport(DRUG_REPORT, "dupilumab")).toMatchObject({ product: "DUPIXENT", role: "suspect", manufacturer: "Sanofi-Aventis U.S. LLC" });
    expect(parseDrugReport(DRUG_REPORT, "")?.product).toBe("DUPIXENT");
    expect(parseDrugReport({ ...DRUG_REPORT, seriousnessdeath: "1" }, "metformin")?.outcome).toBe("Death");
  });

  test("a device report names the matched device, and recalls without a number stay apart", () => {
    const device = parseDeviceReport({
      mdr_report_key: "50515356",
      date_received: "20260831",
      event_type: "Malfunction",
      product_problems: ["Failure to Charge"],
      device: [
        { brand_name: "N/A", generic_name: "Infusion set", manufacturer_d_name: "Acme" },
        { brand_name: "t:slim X2 Insulin Pump", generic_name: "Insulin Infusion Pump", manufacturer_d_name: "Tandem Diabetes Care" },
      ],
    }, "insulin pump");
    expect(device).toMatchObject({ product: "t:slim X2 Insulin Pump", manufacturer: "Tandem Diabetes Care", eventType: "Malfunction" });

    const first = parseDrugRecall({ recall_number: "N/A", event_id: "96082", product_description: "Tablets 500 mg, lot A" });
    const second = parseDrugRecall({ recall_number: "N/A", event_id: "96082", product_description: "Tablets 1000 mg, lot B" });
    expect(first?.id).not.toBe(second?.id);
    expect(first?.recallNumber).toBeNull();
    expect(parseDrugRecall({ recall_number: "D-0192-2025", recalling_firm: "Granules", classification: "Class II" }))
      .toMatchObject({ id: "recall:D-0192-2025", firm: "Granules", classification: "Class II" });
  });

  test("a page keeps what matched, its data date, and stops where skipping can no longer reach", () => {
    const results = Array.from({ length: 50 }, (_, index) => ({ ...DRUG_REPORT, safetyreportid: String(index) }));
    const meta = (total: number) => ({ last_updated: "2026-07-30", results: { skip: 0, limit: 50, total } });
    expect(parseOpenFdaPage("drug", { meta: meta(461_396), results }, "metformin", 0))
      .toMatchObject({ matched: 461_396, lastUpdated: "2026-07-30", hasMore: true, nextOffset: 50, windowLimited: false });
    expect(parseOpenFdaPage("drug", { meta: meta(461_396), results }, "metformin", 25_000))
      .toMatchObject({ hasMore: false, nextOffset: null, windowLimited: true });
    expect(parseOpenFdaPage("drug", { meta: meta(60), results: results.slice(0, 10) }, "metformin", 50))
      .toMatchObject({ hasMore: false, windowLimited: false });
  });
});
