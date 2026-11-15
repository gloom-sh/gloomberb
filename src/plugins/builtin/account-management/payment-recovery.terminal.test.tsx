import { expect, test } from "bun:test";
import { PaymentRecoveryRow } from "./payment-recovery-row";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";

const terminal = createOpenTuiTestHarness({ width: 72, height: 12 });

test("the terminal keeps payment status and errors on the same actionable row", async () => {
  let pressed = 0;
  await terminal.render(<PaymentRecoveryRow active busy={false} message="Could not open invoice payment. Try again." labelWidth={16} onPay={() => { pressed++; }} onFocus={() => {}} />);
  await terminal.waitForFrameToContain("Pay invoice");
  expect(terminal.frame()).toContain("Your Pro payment did not go through.");
  expect(terminal.frame()).toContain("Could not open invoice payment. Try again.");
  await terminal.clickFrameText("Pay invoice");
  expect(pressed).toBe(1);
});
