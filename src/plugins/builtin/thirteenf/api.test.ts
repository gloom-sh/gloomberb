import { afterEach, describe, expect, test } from "bun:test";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import { setHttpFetchTransport } from "../../../utils/http-transport";
import {
  attachThirteenFApiPersistence,
  lookupThirteenFTickers,
  mapForm,
  resetThirteenFApiPersistence,
  searchThirteenFFunds,
} from "./api";
import { buildPeriodReports } from "./model";

afterEach(() => {
  setHttpFetchTransport(null);
  resetThirteenFApiPersistence();
});

describe("13F API", () => {
  test("preserves amendment semantics when the source provides only the supported form_type alias", () => {
    const base = {
      cik: "1067983", period_of_report: "2026-06-30", accession_number: "original",
      filed_as_of_date: "2026-08-14", form_type: "13F-HR", table_value_total: 100, table_entry_total: 1,
    };
    const original = mapForm(base)!;
    const addition = mapForm({
      ...base, accession_number: "addition", filed_as_of_date: "2026-08-20", form_type: "13F-HR/A",
      amendment_type: "NEW HOLDINGS", table_value_total: 50,
    })!;
    expect(original.isAmendment).toBe(false);
    expect(addition).toMatchObject({ submissionType: "13F-HR/A", isAmendment: true });
    expect(buildPeriodReports([original, addition])[0]).toMatchObject({ complete: true, tableValueTotal: 150, tableEntryTotal: 2 });
    const unknown = mapForm({ ...base, accession_number: "unknown", form_type: "13F-HR/A" })!;
    expect(buildPeriodReports([unknown])[0]).toMatchObject({ complete: false, tableValueTotal: null });
  });

  test("uses the shared HTTP transport", async () => {
    const urls: string[] = [];
    setHttpFetchTransport(async (url) => {
      urls.push(String(url));
      return new Response(JSON.stringify([{ cik: "1067983", name: "BERKSHIRE HATHAWAY INC" }]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const funds = await searchThirteenFFunds("transport-smoke", 1);

    expect(urls[0]).toContain("/cloud/sec/13f/funds");
    expect(funds).toEqual([{ cik: "0001067983", name: "BERKSHIRE HATHAWAY INC" }]);
  });

  test("caches successful API responses by request URL", async () => {
    attachThirteenFApiPersistence(new MemoryPluginPersistence());
    let requestCount = 0;
    setHttpFetchTransport(async () => {
      requestCount += 1;
      return new Response(JSON.stringify([{ cik: "1364742", name: "BlackRock Inc." }]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    await searchThirteenFFunds("cache-smoke", 1);
    await searchThirteenFFunds("cache-smoke", 1);

    expect(requestCount).toBe(1);
  });

  test("treats nullable ticker lookup responses as empty results", async () => {
    setHttpFetchTransport(async () => new Response("null", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    await expect(lookupThirteenFTickers(["BAKER"])).resolves.toEqual([]);
  });
});
