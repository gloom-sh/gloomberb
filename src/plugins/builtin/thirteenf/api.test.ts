import { afterEach, describe, expect, test } from "bun:test";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import { setHttpFetchTransport } from "../../../utils/http-transport";
import {
  attachThirteenFApiPersistence,
  lookupThirteenFTickers,
  resetThirteenFApiPersistence,
  searchThirteenFFunds,
} from "./api";

afterEach(() => {
  setHttpFetchTransport(null);
  resetThirteenFApiPersistence();
});

describe("13F API", () => {
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
