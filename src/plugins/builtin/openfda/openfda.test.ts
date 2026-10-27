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
import { activeFilters, termsCellText } from "./model";

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

  test("filters join the search with AND, and each dataset sends only the filters it offers", () => {
    const now = new Date("2026-10-13T00:00:00Z");
    const state = { outcome: "death", role: "suspect", event: "injury", recallClass: "1", status: "ongoing", range: "365" };
    const search = (dataset: "drug" | "device" | "recall", query: string) =>
      new URL(buildOpenFdaUrl(dataset, query, 0, activeFilters(dataset, state, now))).searchParams.get("search");
    expect(search("drug", "keytruda")).toBe(
      '(patient.drug.medicinalproduct:"keytruda" OR patient.drug.openfda.brand_name:"keytruda" OR '
      + 'patient.drug.openfda.generic_name:"keytruda") AND seriousnessdeath:"1" AND '
      + 'patient.drug.drugcharacterization:"1" AND receivedate:[20251013 TO 99991231]',
    );
    expect(search("device", "")).toBe('event_type:"Injury" AND date_received:[20251013 TO 99991231]');
    expect(search("recall", "")).toBe('classification:"Class I" AND status:"Ongoing" AND recall_initiation_date:[20251013 TO 99991231]');
    // Nothing chosen sends no search at all, and an unknown stored value is no filter.
    expect(new URL(buildOpenFdaUrl("drug", "", 0, activeFilters("drug", { outcome: "bogus" }, now))).searchParams.has("search")).toBe(false);
  });

  test("a role filtered row by row reads on until the list fills, and says its count is not exact", async () => {
    const concomitant = { ...DRUG_REPORT, patient: { ...DRUG_REPORT.patient, drug: [DRUG_REPORT.patient.drug[2]!] } };
    const page = (offset: number) => ({
      meta: { last_updated: "2026-07-30", results: { skip: offset, limit: 50, total: 500 } },
      results: Array.from({ length: 50 }, (_, index) => ({
        ...(index % 10 === 0 ? DRUG_REPORT : concomitant),
        safetyreportid: String(offset + index),
      })),
    });
    const skips: number[] = [];
    setHttpFetchTransport(async (url) => {
      const skip = Number(new URL(url).searchParams.get("skip") ?? 0);
      skips.push(skip);
      return new Response(JSON.stringify(page(skip)), { status: 200 });
    });
    const result = await new OpenFdaClient().listPage("drug", "dupilumab", 0, undefined, { role: "suspect" });
    // Five suspect rows a page: three pages read, every row the matched drug as suspect.
    expect(skips).toEqual([0, 50, 100]);
    expect(result.rows).toHaveLength(15);
    expect(result.rows.every((row) => row.dataset === "drug" && row.role === "suspect" && row.product === "DUPIXENT")).toBe(true);
    expect(result).toMatchObject({ nextOffset: 150, hasMore: true, matched: 500, matchedExact: false });
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
    // A role asked for names a drug in that role, and drops a report whose matched drug plays another part.
    expect(parseDrugReport(DRUG_REPORT, "metformin", "suspect")).toBeNull();
    expect(parseDrugReport(DRUG_REPORT, "", "concomitant")).toMatchObject({ product: "AMLODIPINE BESYLATE", labelers: 2 });
  });

  test("a report codes each reaction once, and a row names the first three and counts the rest", () => {
    // A vaccine report codes the same reaction once per dose, in either case.
    const reaction = (names: string[]) => names.map((reactionmeddrapt) => ({ reactionmeddrapt }));
    const report = parseDrugReport({ ...DRUG_REPORT, patient: { ...DRUG_REPORT.patient, reaction: reaction([
      "Headache", "Pyrexia", "HEADACHE", "Thrombosis", "Pyrexia", "Fatigue", "Nausea",
    ]) } }, "metformin");
    expect(report?.reactions).toEqual(["Headache", "Pyrexia", "Thrombosis", "Fatigue", "Nausea"]);
    expect(termsCellText(report!.reactions)).toBe("Headache, Pyrexia, Thrombosis +2 more");
    expect(termsCellText(["Headache", "Pyrexia"])).toBe("Headache, Pyrexia");
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
