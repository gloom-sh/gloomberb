import { describe, expect, test } from "bun:test";
import { buildStudiesUrl } from "./client";
import { leadSponsorName, registryTerm, trialSearch, trialSearchScope } from "./search";

describe("trialSearch", () => {
  test("a term written as a ticker waits for its company, then searches it as lead sponsor", () => {
    // `TRIAL CRMD` searched as text matched Abbott's "Cardiac Rhythm Management" devices.
    expect(trialSearch("CRMD", undefined, false)).toEqual({ kind: "pending", ticker: "CRMD" });
    const search = trialSearch("CRMD", "CorMedix", false);
    expect(search).toEqual({ kind: "company", ticker: "CRMD", company: "CorMedix", sponsor: "CorMedix" });
    expect(trialSearchScope(search)).toBe("Lead sponsor: CorMedix (CRMD)");
    // Pharming Group files its studies as Pharming Technologies.
    expect(trialSearch("PHAR", "Pharming Group", false)).toMatchObject({ kind: "company", sponsor: "Pharming" });
  });

  test("a company that leads no study is searched as text, and the header says so", () => {
    const search = trialSearch("FLNA", "Filana Therapeutics", true);
    expect(search).toEqual({ kind: "mentions", ticker: "FLNA", company: "Filana Therapeutics", term: "FLNA" });
    expect(trialSearchScope(search)).toBe("Filana Therapeutics (FLNA) leads no trials; studies that mention FLNA");
  });

  test("no company, a word or a name searches text, a company's name of several words as one phrase", () => {
    expect(trialSearch("ZZQX", null, false)).toEqual({ kind: "text", term: "ZZQX" });
    // Lower case is a word until the word finds nothing.
    expect(trialSearch("pain", undefined, false)).toEqual({ kind: "text", term: "pain" });
    expect(trialSearch("vktx", "Viking Therapeutics", false)).toMatchObject({ kind: "company", ticker: "VKTX" });
    expect(trialSearch("Viking Therapeutics", undefined, false)).toEqual({ kind: "text", term: "\"Viking Therapeutics\"" });
    expect(trialSearch("", undefined, false)).toEqual({ kind: "latest" });
  });
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
