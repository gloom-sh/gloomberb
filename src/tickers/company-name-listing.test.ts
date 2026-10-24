import { expect, test } from "bun:test";
import type { InstrumentSearchResult } from "../types/instrument";
import { findListingOfCompanyName } from "./company-name-listing";

const listing = (symbol: string, name: string, exchange: string, type = "Common Stock"): InstrumentSearchResult =>
  ({ providerId: "test", symbol, name, exchange, type, currency: "USD" });

test("a company's name is its own common stock on its US line, never a subsidiary sharing the word, a line abroad, or a preferred or note", async () => {
  // Search order puts the subsidiary and the line abroad first.
  const whirlpool = [
    listing("WHIRLPOOL", "Whirlpool of India Limited", "NSE"),
    listing("WHR", "Whirlpool Corp", "XETRA"),
    listing("WHR", "Whirlpool Corp", "NYSE"),
  ];
  expect(await findListingOfCompanyName({ search: async () => whirlpool }, "Whirlpool Corporation"))
    .toEqual({ symbol: "WHR", exchange: "NYSE", name: "Whirlpool Corp" });
  // The preferred and the note have the shorter symbols, which would otherwise go first.
  const acme = [
    listing("AC", "Acme Corp", "NYSE", "Preferred Stock"),
    listing("AN", "Acme Corp", "NYSE", "Notes"),
    listing("ACME", "Acme Corp", "NYSE"),
  ];
  expect(await findListingOfCompanyName({ search: async () => acme }, "Acme Corporation"))
    .toEqual({ symbol: "ACME", exchange: "NYSE", name: "Acme Corp" });
});

test("a word of the name may be its short form, and the listing whose name says no more than the one typed still wins", async () => {
  // "philip morris intl" is Philip Morris International, never INTL or a longer name.
  const philip = [
    listing("INTL", "Main International ETF", "BATS", "ETF"),
    listing("PMI", "Philip Morris International Holdings Ltd", "LSE"),
    listing("PM", "Philip Morris International Inc.", "NYSE"),
  ];
  expect(await findListingOfCompanyName({ search: async () => philip }, "philip morris intl"))
    .toEqual({ symbol: "PM", exchange: "NYSE", name: "Philip Morris International Inc." });
  expect(await findListingOfCompanyName({ search: async () => philip }, "phillip morris intl")).toBeNull();
});
