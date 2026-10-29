import { describe, expect, test } from "bun:test";
import type { InstrumentSearchResult } from "../../../types/instrument";
import { pickSponsorListing, sponsorSearchName } from "./sponsor-listing";

const row = (symbol: string, name: string, exchange: string, fields: Partial<InstrumentSearchResult> = {}): InstrumentSearchResult => ({
  providerId: "gloomberb-cloud", symbol, name, exchange, type: "Common Stock", ...fields,
});
const home = { homeListing: true };

describe("a sponsor Gloom Cloud has no name for takes the primary listing of the company its name is", () => {
  test("Bayer is Bayer AG on Xetra, not its ADR or its Indian subsidiary", () => {
    const rows = [
      row("BAYN", "Bayer AG", "XETRA", home),
      row("BAYRY", "Bayer AG Sponsored ADR", "OTC", { type: "American Depositary Receipt" }),
      row("BAYERCROP", "Bayer CropScience Ltd.", "NSE", home),
    ];
    expect(pickSponsorListing("Bayer", rows)).toEqual({ ticker: "BAYN", exchange: "XETRA", entityName: "Bayer AG" });
    expect(pickSponsorListing("Philips", [row("PHIA", "Koninklijke Philips N.V.", "AMS", home)])).toMatchObject({ ticker: "PHIA", exchange: "AMS" });
  });

  test("a name that only starts a company's, or fits two companies, has none", () => {
    expect(pickSponsorListing("Evolv", [row("EVLV", "Evolv Technologies Holdings, Inc.", "NASDAQ", home)])).toBeNull();
    expect(pickSponsorListing("Siemens", [row("SIE", "Siemens AG", "XETRA", home), row("SIEMENS", "Siemens Ltd.", "NSE", home)])).toBeNull();
    // Not the company's primary line, as search marks it.
    expect(pickSponsorListing("Bayer", [row("BAYN", "Bayer AG", "XETRA")])).toBeNull();
  });

  test("a sponsor filed under its own country's legal form never takes a listing without it", () => {
    const merckUs = row("MRK", "Merck & Company, Inc.", "NYSE", home);
    const merckDe = row("MRK", "Merck KGaA", "XETRA", home);
    expect(pickSponsorListing("Merck KGaA", [merckUs])).toBeNull();
    expect(pickSponsorListing("Merck KGaA", [merckUs, merckDe])).toMatchObject({ exchange: "XETRA" });
  });

  test("only a name of one word is searched, once its legal form is dropped", () => {
    expect(sponsorSearchName("Bayer")).toBe("Bayer");
    expect(sponsorSearchName("Eisai Inc.")).toBe("Eisai");
    expect(sponsorSearchName("Boehringer Ingelheim")).toBeNull();
    expect(sponsorSearchName("Wake Forest University Health Sciences")).toBeNull();
    expect(pickSponsorListing("Carmot Therapeutics, Inc.", [row("CARM", "Carmot Therapeutics, Inc.", "NASDAQ", home)])).toBeNull();
  });
});
