import { describe, expect, test } from "bun:test";
import { ApiRequestError } from "../../../api-client/errors";
import type { OrganizationTicker } from "../../../api-client/organization-tickers";
import { SponsorTickerStore, sponsorTickerFrom } from "./sponsor-tickers";

const answer = (name: string, fields: Partial<OrganizationTicker> = {}): OrganizationTicker => ({
  name, ticker: null, exchange: null, entityName: null, resolution: "unresolved", ambiguous: false, ...fields,
});

describe("sponsor tickers", () => {
  test("show a ticker only when one listed company was found", () => {
    expect(sponsorTickerFrom(answer("Pfizer", { ticker: "PFE", exchange: "NYSE", entityName: "Pfizer Inc.", resolution: "alias" })))
      .toEqual({ kind: "listed", ticker: "PFE", exchange: "NYSE", entityName: "Pfizer Inc." });
    expect(sponsorTickerFrom(answer("University of Oxford"))).toEqual({ kind: "none", entityName: null, ambiguous: false });
    expect(sponsorTickerFrom(answer("Mayo Clinic", { entityName: "Mayo Clinic", resolution: "alias" })))
      .toEqual({ kind: "none", entityName: "Mayo Clinic", ambiguous: false });
    // Ambiguous never picks one, even if a ticker came along.
    expect(sponsorTickerFrom(answer("Merck", { ticker: "MRK", ambiguous: true }))).toEqual({ kind: "none", entityName: null, ambiguous: true });
  });

  test("a failed lookup is shown as not looked up, never kept as no ticker, and asked again", async () => {
    const asked: string[][] = [];
    let fail = true;
    const store = new SponsorTickerStore(async (names) => {
      asked.push(names);
      if (fail) throw new ApiRequestError("Too many requests", 429);
      return names.map((name) => answer(name, name === "Pfizer" ? { ticker: "PFE", exchange: "NYSE" } : {}));
    });
    expect(store.get("Pfizer")).toEqual({ kind: "pending" });
    await store.load(["Pfizer", "University of Oxford", "Pfizer"]);
    expect(store.get("Pfizer")).toEqual({ kind: "failed", reason: "too many lookups, try again shortly" });
    // Failed names wait for a retry instead of hammering the server on every render.
    await store.load(["Pfizer"]);
    expect(asked).toEqual([["Pfizer", "University of Oxford"]]);

    fail = false;
    store.retryFailed();
    await store.load(["Pfizer", "University of Oxford"]);
    expect(store.get("pfizer ")).toMatchObject({ kind: "listed", ticker: "PFE" });
    expect(store.get("University of Oxford")).toMatchObject({ kind: "none" });
    // Answers are kept: a later page with the same sponsors asks for nothing.
    await store.load(["Pfizer", "University of Oxford"]);
    expect(asked).toHaveLength(2);
  });

  test("asks a page of names at a time, and an abandoned lookup is neither answer nor failure", async () => {
    const sizes: number[] = [];
    const store = new SponsorTickerStore(async (names, signal) => {
      sizes.push(names.length);
      if (signal?.aborted) throw new Error("aborted");
      return names.map((name) => answer(name));
    });
    await store.load(Array.from({ length: 120 }, (_, index) => `Sponsor ${index}`));
    expect(sizes).toEqual([50, 50, 20]);

    const controller = new AbortController();
    controller.abort();
    await store.load(["Gilead Sciences"], controller.signal);
    expect(store.get("Gilead Sciences")).toEqual({ kind: "pending" });
  });
});
