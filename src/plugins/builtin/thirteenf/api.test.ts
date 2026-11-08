import { afterEach, describe, expect, test } from "bun:test";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import { setHttpFetchTransport } from "../../../utils/http-transport";
import { isNetworkFailure } from "../../../utils/network-failure";
import {
  attachThirteenFApiPersistence,
  listThirteenFForms,
  lookupThirteenFTickers,
  mapForm,
  resetThirteenFApiPersistence,
  searchThirteenFFunds,
  THIRTEENF_SOURCE_UNAVAILABLE,
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

test("a failed forced refresh retains the saved copy only for consumers that say when it was saved, and reopening retries", async () => {
  const store = new MemoryPluginPersistence();
  attachThirteenFApiPersistence(store);
  let unavailable = false;
  let calls = 0;
  setHttpFetchTransport(async () => {
    calls++;
    return unavailable ? new Response("Unavailable", { status: 503 })
      : Response.json([{ cik: "1067983", name: "Berkshire Hathaway" }]);
  });
  const expected = await searchThirteenFFunds("Berkshire", 1);
  const key = "/funds?name=Berkshire&offset=0&limit=1";
  const original = store.getResource("forms13f-api", key, { sourceKey: "forms13f" })!;
  expect(original).not.toBeNull();
  unavailable = true;
  await expect(searchThirteenFFunds("Berkshire", 1, undefined, { forceRefresh: true })).rejects.toThrow(THIRTEENF_SOURCE_UNAVAILABLE);
  const saved: number[] = [];
  expect(await searchThirteenFFunds("Berkshire", 1, undefined, {
    forceRefresh: true, onSavedCopy: savedAt => saved.push(savedAt),
  })).toEqual(expected);
  expect(saved).toEqual([original.fetchedAt]);
  expect(store.getResource("forms13f-api", key, { sourceKey: "forms13f" })).toEqual(original);
  const callsAtReopen = calls;
  expect(await searchThirteenFFunds("Berkshire", 1)).toEqual(expected);
  for (let i = 0; i < 40 && calls === callsAtReopen; i++) await Promise.resolve();
  expect(calls).toBe(callsAtReopen + 1);
  for (let i = 0; i < 40; i++) await Promise.resolve();
  unavailable = false;
  const callsBeforeRecovery = calls;
  expect(await searchThirteenFFunds("Berkshire", 1)).toEqual(expected);
  for (let i = 0; i < 40 && calls === callsBeforeRecovery; i++) await Promise.resolve();
  expect(calls).toBe(callsBeforeRecovery + 1);
  for (let i = 0; i < 40; i++) await Promise.resolve();
  await searchThirteenFFunds("Berkshire", 1);
  expect(calls).toBe(callsBeforeRecovery + 1);
});

test("a source outage is said as one when Gloom Cloud answered, and its stored copy as a saved copy, not kept as fresh", async () => {
  const store = new MemoryPluginPersistence();
  attachThirteenFApiPersistence(store);
  const form = { cik: "0001067983", accession_number: "0001193125-26-352200", period_of_report: "2026-06-30" };
  let cloud: () => Response = () => Response.json({ message: "Internal server error" }, { status: 500 });
  setHttpFetchTransport(async (url) => {
    // The public source refuses every connection, as it did for hours on end.
    if (String(url).includes("forms13f.com")) throw Object.assign(new Error("Unable to connect"), { code: "ECONNREFUSED" });
    return cloud();
  });
  const read = (onSavedCopy?: (savedAt: number) => void) =>
    listThirteenFForms("1067983", "2022-11-08", "2026-11-08", 100, undefined, { onSavedCopy });
  const failure = await read().catch((error: unknown) => error);
  expect(failure).toMatchObject({ message: THIRTEENF_SOURCE_UNAVAILABLE, code: "source_unavailable" });
  expect(isNetworkFailure(failure)).toBe(false);
  const storedAsOf = "2026-11-07T08:39:40.935Z";
  cloud = () => Response.json([{ ...form, stored_as_of: storedAsOf }]);
  const saved: number[] = [];
  expect((await read(savedAt => saved.push(savedAt))).map(row => row.accessionNumber)).toEqual([form.accession_number]);
  expect(saved).toEqual([Date.parse(storedAsOf)]);
  // Only a fresh answer is kept: the next read asks again.
  expect(store.getResource("forms13f-api", "/forms?cik=0001067983&from=2022-11-08&to=2026-11-08&limit=100&offset=0", {
    sourceKey: "forms13f", allowExpired: true,
  })).toBeNull();
});

test("a second caller for a missing response awaits the download already in flight", async () => {
  let calls = 0;
  let release: ((response: Response) => void) | undefined;
  setHttpFetchTransport(async () => {
    calls += 1;
    return new Promise<Response>((resolve) => { release = resolve; });
  });
  const first = searchThirteenFFunds("Berkshire", 1);
  for (let i = 0; i < 30 && calls === 0; i++) await Promise.resolve();
  expect(calls).toBe(1);
  const second = searchThirteenFFunds("Berkshire", 1);
  expect(calls).toBe(1);
  release!(Response.json([{ cik: "1067983", name: "Berkshire Hathaway" }]));
  const expected = [{ cik: "0001067983", name: "Berkshire Hathaway" }];
  expect(await first).toEqual(expected);
  expect(await second).toEqual(expected);
  expect(calls).toBe(1);
});

test("returns a stale cached response before its refresh, and a second caller shares that refresh", async () => {
  const store = new MemoryPluginPersistence();
  attachThirteenFApiPersistence(store);
  const key = "/funds?name=Berkshire&offset=0&limit=1";
  store.seedResource("forms13f-api", key, [{ cik: "1067983", name: "Old name" }], {
    sourceKey: "forms13f", schemaVersion: 1, stale: true,
  });
  let release: ((response: Response) => void) | undefined;
  let calls = 0;
  setHttpFetchTransport(async () => {
    calls += 1;
    return new Promise<Response>((resolve) => { release = resolve; });
  });
  const first = searchThirteenFFunds("Berkshire", 1);
  const stale = await Promise.race([
    first,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("stale cache waited for refresh")), 500)),
  ]);
  expect(stale).toEqual([{ cik: "0001067983", name: "Old name" }]);
  for (let i = 0; i < 30 && calls === 0; i++) await Promise.resolve();
  expect(calls).toBe(1);
  expect(await searchThirteenFFunds("Berkshire", 1)).toEqual([{ cik: "0001067983", name: "Old name" }]);
  expect(calls).toBe(1);
  release!(Response.json([{ cik: "1067983", name: "Current name" }]));
  for (let i = 0; i < 40; i++) {
    const stored = store.getResource<Array<{ name: string }>>("forms13f-api", key, { sourceKey: "forms13f" });
    if (stored && !stored.stale && stored.value[0]?.name === "Current name") break;
    await Promise.resolve();
  }
  expect(await searchThirteenFFunds("Berkshire", 1)).toEqual([{ cik: "0001067983", name: "Current name" }]);
  expect(calls).toBe(1);
});

test("stale but unexpired research refreshes, and a late request cannot overwrite newer cache", async () => {
  const store = new MemoryPluginPersistence();
  attachThirteenFApiPersistence(store);
  const key = "/funds?name=Berkshire&offset=0&limit=1";
  store.seedResource("forms13f-api", key, [{ cik: "1067983", name: "Old name" }], {
    sourceKey: "forms13f", schemaVersion: 1, stale: true,
  });
  let release!: (response: Response) => void;
  let calls = 0;
  setHttpFetchTransport(async () => {
    if (++calls === 1) return new Promise<Response>(resolve => { release = resolve; });
    return Response.json([{ cik: "1067983", name: "Current name" }]);
  });
  const older = searchThirteenFFunds("Berkshire", 1);
  for (let i = 0; i < 5 && !release; i++) await Promise.resolve();
  await searchThirteenFFunds("Berkshire", 1, undefined, { forceRefresh: true });
  release(Response.json([{ cik: "1067983", name: "Superseded name" }]));
  await older;
  expect(await searchThirteenFFunds("Berkshire", 1)).toEqual([{ cik: "0001067983", name: "Current name" }]);
  expect(calls).toBe(2);
});

for (const status of [403, 404]) test(`authoritative public ${status} cannot retain a removed 13F response`, async () => {
  const store = new MemoryPluginPersistence();
  attachThirteenFApiPersistence(store);
  let denied = false;
  setHttpFetchTransport(async () => denied ? new Response("Removed", { status })
    : Response.json([{ cik: "1067983", name: "Berkshire Hathaway" }]));
  await searchThirteenFFunds("Berkshire", 1);
  denied = true;
  const saved: number[] = [];
  await expect(searchThirteenFFunds("Berkshire", 1, undefined, {
    forceRefresh: true, onSavedCopy: savedAt => saved.push(savedAt),
  })).rejects.toThrow(String(status));
  expect(saved).toEqual([]);
  expect(store.getResource("forms13f-api", "/funds?name=Berkshire&offset=0&limit=1", {
    sourceKey: "forms13f", allowExpired: true,
  })).toBeNull();
});
