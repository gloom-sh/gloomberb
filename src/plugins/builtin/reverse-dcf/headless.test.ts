import { expect, test } from "bun:test";
import { renderHeadlessPaneText } from "../../../cli/pane-functions/headless";
import { createTestDataProvider, createTestFinancials } from "../../../test-support/data-provider";
import { createTestHeadlessArgs, createTestHeadlessContext } from "../../../test-support/headless";
import type { HeadlessBundleResult } from "../../../types/headless";
import { reverseDcfHeadless } from "./headless";

async function report(trailingFcf: number) {
  const fundamentals = { enterpriseValue: 429_030_000_000, freeCashFlow: trailingFcf, financialCurrency: "USD", marketCapCurrency: "USD" };
  const annualStatements = [[2021, 11.3], [2022, 10.4], [2023, 9.7], [2024, 6.0], [2025, 5.3]]
    .map(([year, billions]) => ({ date: `${year}-12-31`, freeCashFlow: billions! * 1e9 }));
  const args = createTestHeadlessArgs({ rawArgument: "KO", argument: "KO", symbols: ["KO"] });
  const result = await reverseDcfHeadless.load(args, createTestHeadlessContext({
    marketData: createTestDataProvider({ getTickerFinancials: async () => createTestFinancials({ fundamentals, annualStatements }) }),
  })) as HeadlessBundleResult;
  return renderHeadlessPaneText(reverseDcfHeadless, result, args, "RDCF KO");
}

test("fn RDCF names the years its past growth runs between, and says when the trailing cash flow is a different base", async () => {
  const far = await report(14.3e9);
  expect(far).toMatch(/Past FCF growth +-17\.\d% a year, FY2021–FY2025/);
  expect(far).toContain("Notes: The TTM base differs from FY2025: TTM FCF is 2.7x that year's 5.3B USD.");
  const near = await report(6.1e9);
  expect(near).toMatch(/Past FCF growth +-17\.\d% a year, FY2021–FY2025/);
  expect(near).not.toContain("TTM base");
});
