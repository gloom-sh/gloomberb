import { expect, test } from "bun:test";
import { YearlyPlanRow } from "./yearly-plan-row";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";

const terminal = createOpenTuiTestHarness({ width: 80, height: 18 });

const offer = { currency: "usd" as const, monthlyAmount: 7000, yearlyAmount: 63000, twelveMonthlyAmount: 84000, savingsAmount: 21000 };
const review = {
  token: "v1.review.sig",
  expiresAt: "2026-11-16T12:10:00.000Z",
  currency: "usd" as const,
  amountDue: 56729,
  yearlyAmount: 60929,
  credit: 4200,
  tax: 0,
  balanceApplied: 0,
  renewalAmount: 63000,
  renewsAt: "2027-11-04T12:00:00.000Z",
  renewalTaxed: false,
  offer,
};

test("the terminal draws the whole review inline, with the payment and Not Now as separate actions", async () => {
  let paid = 0;
  let dismissed = 0;
  await terminal.render(
    <YearlyPlanRow
      view={{ kind: "review", review }}
      busy={null}
      message={null}
      width={76}
      labelWidth={14}
      primaryActive={false}
      dismissActive
      onPrimary={() => { paid++; }}
      onDismiss={() => { dismissed++; }}
      onFocusPrimary={() => {}}
      onFocusDismiss={() => {}}
    />,
  );
  await terminal.waitForFrameToContain("Due today");
  const frame = terminal.frame();
  for (const text of ["Switch to yearly billing", "$609.29", "-$42.00", "$567.29", "Pay $567.29 and Switch", "Not Now"]) {
    expect(frame).toContain(text);
  }
  await terminal.clickFrameText("Not Now");
  expect(dismissed).toBe(1);
  expect(paid).toBe(0);
});
