import { expect, test } from "bun:test";
import type { CloudFilingEventPayload } from "../../../../api-client";
import type { DistressDesignation, InsolvencyNotice } from "../../../../api-client/distress";
import {
  designationRemarks,
  designationTicker,
  filingEventLabel,
  goingConcernColumns,
  insolvencyNoticeLabel,
  plainText,
  venueTicker,
} from "./model";
import { delistedRow, designationRow, filingEvent, insolvencyRow } from "./test-fixture";

test("a venue-qualified symbol opens its listing; OTC opens by symbol; a CIK placeholder opens nothing", () => {
  expect(venueTicker("BMRA:NASDAQ")).toEqual({ key: "BMRA:XNAS", label: "BMRA" });
  expect(venueTicker("ELVX:OTC")).toEqual({ key: "ELVX", label: "ELVX:OTC" });
  expect(venueTicker("CIK2123169")).toBeNull();
  expect(venueTicker(null)).toBeNull();
  expect(designationTicker(designationRow() as DistressDesignation)?.key).toBe("4943:TWSE");
  // A delisted security no longer trades.
  expect(designationTicker(delistedRow() as DistressDesignation)).toBeNull();
});

test("an 8-K names its first watched item and counts the rest", () => {
  expect(filingEventLabel(filingEvent() as CloudFilingEventPayload)).toBe("Bankruptcy/receivership +1");
  expect(filingEventLabel(filingEvent({ items: ["2.04", "9.01"], form: "8-K/A" }) as CloudFilingEventPayload)).toBe("Obligation trigger (8-K/A)");
});

test("a Gazette notice keeps its section: a members' voluntary winding up is not a creditors' one", () => {
  expect(insolvencyNoticeLabel(insolvencyRow({ raw_code: "2431" }) as InsolvencyNotice, "short")).toBe("Resolution for winding up (MVL)");
  expect(insolvencyNoticeLabel(insolvencyRow({ raw_code: "2441" }) as InsolvencyNotice)).toBe("Resolution for winding up, creditors' voluntary winding up");
  expect(insolvencyNoticeLabel(insolvencyRow({ raw_code: "2499" }) as InsolvencyNotice)).toBe("Notice code 2499");
  // France sends the official judgment label itself.
  expect(insolvencyNoticeLabel(insolvencyRow({ country: "FR", raw_code: "Jugement d'ouverture de liquidation judiciaire" }) as InsolvencyNotice))
    .toBe("Jugement d'ouverture de liquidation judiciaire");
});

test("source text loses terminal escapes and controls but keeps its line breaks", () => {
  expect(plainText("Note 2\u001b[31m GOING\r\nCONCERN\u0007")).toBe("Note 2 [31m GOING\nCONCERN ");
});

test("listing remarks read as words, without empty flags or the missing-date note", () => {
  expect(designationRemarks("PeriodicCallAuctionTrading=**; official designation date not supplied")).toEqual(["Periodic call auction trading: **"]);
  expect(designationRemarks("PeriodicTrading=none; ManagedStock=none; MatchingFrequency=; official designation date not supplied")).toEqual([]);
});

test("columns fill the width, and the disclosure column appears only when every verdict is listed", () => {
  const filtered = goingConcernColumns(120, "doubt_raised");
  expect(filtered.map((column) => column.id)).toEqual(["filed", "company", "ticker", "form", "period"]);
  expect(filtered.reduce((sum, column) => sum + column.width + 2, 3)).toBe(120);
  expect(goingConcernColumns(120, "all").map((column) => column.id)).toContain("verdict");
  // Narrow, the period, form and ticker give way before the disclosure.
  expect(goingConcernColumns(80, "all").map((column) => column.id)).toEqual(["filed", "company", "verdict"]);
});
