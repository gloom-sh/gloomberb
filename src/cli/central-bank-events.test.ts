import { expect, test } from "bun:test";
import { centralBankEventsMessage } from "./central-bank-events";

test("events answers a central bank named on its own with CBR, and leaves listings that share a name alone", () => {
  expect(centralBankEventsMessage("ECB")).toBe("ECB meetings are not listed; CBR shows the rate (gloomberb fn CBR).");
  expect(centralBankEventsMessage("Norges Bank")).toBe("Norges Bank meetings are not listed; CBR shows the rate (gloomberb fn CBR).");
  expect(centralBankEventsMessage("fomc")).toContain("next FOMC date");
  // BOE is a NYSE fund and ECB:WSE names ECB S.A. in Warsaw; neither is the bank.
  expect(["BOE", "$RBA", "ECB:WSE", "AAPL", "bank"].map(centralBankEventsMessage)).toEqual([null, null, null, null, null]);
});
