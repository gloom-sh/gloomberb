import { expect, test } from "bun:test";
import { sameCompany, shortCompanyName } from "./company-name";

// "ao" and "tas" were dropped anywhere in a name, so AO World read as World Acceptance's and AO Smith as Smith & Wesson's.
test("a Turkish legal form short enough to open a name is one only as its last word", () => {
  expect(sameCompany("Türk Hava Yolları A.O.", "Turk Hava Yollari Anonim Ortakligi")).toBe(true);
  expect(sameCompany("Turk Hava Yollari A.O. Unsponsored ADR", "Türk Hava Yolları")).toBe(true);
  expect(sameCompany("Türkiye Garanti Bankası T.A.Ş.", "Turkiye Garanti Bankasi")).toBe(true);
  expect(sameCompany("AO World plc", "World Acceptance Corporation")).toBe(false);
  expect(sameCompany("AO Smith Corp", "Smith & Wesson Brands, Inc.")).toBe(false);
  expect(shortCompanyName("Türk Hava Yolları A.O.")).toBe("Türk Hava Yolları");
  expect(shortCompanyName("AO World plc")).toBe("AO World");
});
