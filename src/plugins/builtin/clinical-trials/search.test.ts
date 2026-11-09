import { describe, expect, test } from "bun:test";
import { buildStudiesUrl } from "./client";
import { leadSponsorName, leadSponsorNames, registryTerm, trialSearch, trialSearchFallback, trialSearchScope } from "./search";

const company = (name: string, legalName = name, healthcare = true) => ({ name, legalName, healthcare });

describe("trialSearch", () => {
  test("a healthcare company's ticker waits for its company, then searches it as lead sponsor", () => {
    // `TRIAL CRMD` searched as text matched Abbott's "Cardiac Rhythm Management" devices.
    expect(trialSearch("CRMD", undefined, 0)).toEqual({ kind: "pending", ticker: "CRMD" });
    const search = trialSearch("CRMD", company("CorMedix", "CorMedix Inc."), 0);
    expect(search).toEqual({ kind: "company", ticker: "CRMD", company: "CorMedix", sponsor: "CorMedix" });
    expect(trialSearchScope(search)).toBe("CorMedix (CRMD) · lead sponsor");
    expect(trialSearchFallback(search)).toBeNull();
    // Pharming Group files its studies as Pharming Technologies.
    expect(trialSearch("PHAR", company("Pharming Group"), 0)).toMatchObject({ kind: "company", sponsor: "Pharming" });
  });

  // AMD, MS, HD, CF and PD are diseases first; their companies sponsor no trials.
  test("any other company's ticker searches as text", () => {
    for (const [ticker, name] of [["AMD", "Advanced Micro Devices"], ["MS", "Morgan Stanley"], ["HD", "Home Depot"], ["CF", "CF Industries"], ["PD", "PagerDuty"]])
      expect(trialSearch(ticker, company(name, name, false), 0)).toEqual({ kind: "text", term: ticker });
  });

  test("a company that leads no study under any of its names is searched as text, and the footer warns", () => {
    // Its name, then the name without "Pharmaceuticals", then text.
    const regeneron = company("Regeneron Pharmaceuticals", "Regeneron Pharmaceuticals, Inc.");
    expect(trialSearch("REGN", regeneron, 0)).toMatchObject({ kind: "company", sponsor: "Regeneron Pharmaceuticals" });
    expect(trialSearch("REGN", regeneron, 1)).toMatchObject({ kind: "company", sponsor: "Regeneron" });
    const search = trialSearch("FLNA", company("Filana Therapeutics"), 1);
    expect(search).toEqual({ kind: "mentions", ticker: "FLNA", company: "Filana Therapeutics", sponsor: "Filana Therapeutics", term: "FLNA" });
    expect(trialSearchScope(search)).toBeNull();
    expect(trialSearchFallback(search)).toBe("No trials under lead sponsor Filana Therapeutics; text matches for FLNA");
  });

  test("no company, a word or a name searches text, a company's name of several words as one phrase", () => {
    expect(trialSearch("ZZQX", null, 0)).toEqual({ kind: "text", term: "ZZQX" });
    // Lower case is a word until the word finds nothing.
    expect(trialSearch("pain", undefined, 0)).toEqual({ kind: "text", term: "pain" });
    expect(trialSearch("vktx", company("Viking Therapeutics"), 0)).toMatchObject({ kind: "company", ticker: "VKTX" });
    expect(trialSearch("Viking Therapeutics", undefined, 0)).toEqual({ kind: "text", term: "\"Viking Therapeutics\"" });
    expect(trialSearch("", undefined, 0)).toEqual({ kind: "latest" });
  });
});

// `TRIAL MRNA` found nothing (ModernaTX), and both Mercks read as "Merck".
test("large sponsors are searched under the registry's name for them, each Merck under its own", () => {
  expect(leadSponsorNames(company("Moderna", "Moderna, Inc."))).toEqual(["ModernaTX"]);
  expect(leadSponsorNames(company("GSK", "GSK plc"))).toEqual(["GlaxoSmithKline"]);
  expect(leadSponsorNames(company("Takeda Pharmaceutical", "Takeda Pharmaceutical Company Limited"))).toEqual(["Takeda"]);
  expect(leadSponsorNames(company("Merck", "Merck & Co., Inc."))).toEqual(["Merck Sharp & Dohme"]);
  expect(leadSponsorNames(company("Merck", "Merck KGaA"))).toEqual(["Merck KGaA"]);
  expect(leadSponsorNames(company("Jazz Pharmaceuticals"))).toEqual(["Jazz Pharmaceuticals", "Jazz"]);
  expect(leadSponsorNames(company("CorMedix"))).toEqual(["CorMedix"]);
});

test("registryTerm quotes only a company's name of several words", () => {
  expect(registryTerm("Summit  Therapeutics Inc.")).toBe("\"Summit Therapeutics Inc.\"");
  expect(registryTerm("obesity semaglutide")).toBe("obesity semaglutide");
  expect(registryTerm("\"breast cancer\"")).toBe("\"breast cancer\"");
  expect(registryTerm("Lilly OR Novo Holdings")).toBe("Lilly OR Novo Holdings");
  expect(leadSponsorName("Roche Holding")).toBe("Roche");
});

test("a lead sponsor search asks the registry for the name as one phrase beside the filters", () => {
  const url = new URL(buildStudiesUrl({ leadSponsor: "Viking \"Therapeutics\"", phases: ["PHASE3"] }));
  expect(url.searchParams.get("filter.advanced")).toBe("AREA[LeadSponsorName]\"Viking Therapeutics\" AND AREA[Phase]PHASE3");
  expect(url.searchParams.get("query.term")).toBeNull();
});
