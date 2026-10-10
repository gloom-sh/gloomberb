import { afterEach, expect, test } from "bun:test";
import { carBeneficialOwnersPayload } from "../../plugins/builtin/holders/test-fixture";
import { createTestCliContext } from "../../test-support/cli-context";
import { setHttpFetchTransport } from "../../utils/http-transport";
import type { HolderData } from "../../types/financials";
import { DEFAULT_CLI_OPTIONS } from "../options";
import { serializeCliResult } from "../result";
import { marketDataCliCommands } from "./market";

const holders = marketDataCliCommands.find((command) => command.name === "holders")!;
const HOLDER_DATA = { symbol: "CAR", holders: [{ ownerType: "institution", name: "Morgan Stanley", shares: 2_029_978, changeShares: 2_029_978 }] };

afterEach(() => setHttpFetchTransport(null));

function harness() {
  const requests: URL[] = [];
  setHttpFetchTransport(async (url) => {
    const parsed = new URL(url);
    requests.push(parsed);
    const payload = carBeneficialOwnersPayload({ history: parsed.searchParams.get("history") === "1" });
    return new Response(JSON.stringify(payload), { headers: { "Content-Type": "application/json" } });
  });
  const cli = createTestCliContext({ dataProvider: { getHolders: async () => HOLDER_DATA } });
  return { ...cli, requests };
}

test("holders --form lists the beneficial owners, --history every report, and the 13F table stays the default", async () => {
  const run = harness();
  await holders.execute(["CAR", "--form", "all", "--history"], run.context);
  expect([...run.requests[0]!.searchParams].filter(([key]) => key !== "limit" && key !== "offset"))
    .toEqual([["ticker", "CAR"], ["form", "all"], ["history", "1"]]);
  const history = run.printed[0]!.result.data as Array<Record<string, unknown>>;
  expect(history.slice(0, 2).map((row) => [row.filer, row.filingDate])).toEqual([
    ["Jane Street Group, LLC", "2026-05-11"], ["Pentwater Capital Management LP", "2026-05-07"],
  ]);
  expect(history.find((row) => row.filer === "Morgan Stanley")?.thirteenF).toBe("NEW");

  await holders.execute(["CAR"], run.context);
  expect(run.requests).toHaveLength(1);
  expect(run.printed[1]!.result.data).toBe(HOLDER_DATA);
});

test("holders refuses an unknown form, and --history without a 13D/13G form", async () => {
  const run = harness();
  await expect(holders.execute(["CAR", "--form", "13h"], run.context)).rejects.toThrow('Unknown form "13h".');
  await expect(holders.execute(["CAR", "--history"], run.context)).rejects.toThrow("--history lists 13D/13G reports.");
  expect(run.requests).toHaveLength(0);
});

test("holders on a home line label the values in their own currency and mark the rows held as receipts", async () => {
  // Gloom Cloud's BHP London list, trimmed: dollar values from the 13F filings on a pence-quoted line.
  const data: HolderData = {
    symbol: "BHP.L", name: "BHP Group Limited", currency: "GBp", exchange: "LSE", asOf: "2026-06-30",
    isDepositaryReceipt: false, adrRatio: 2, valueCurrency: "USD", valueBasis: "period_end_price",
    holders: [
      { ownerType: "institution", name: "Paradigm Asset Management Company, LLC", reportDate: "2026-06-30", shares: 66_100,
        shareBasis: "ordinary", value: 2_720_167, percentHeld: 0.000013 },
      { ownerType: "institution", name: "Horizon Financial Services, LLC", reportDate: "2026-06-30", shares: 120,
        shareBasis: "depositary_receipt", value: 9_997, percentHeld: 4.7e-8 },
    ],
  };
  const cli = createTestCliContext({ dataProvider: { getHolders: async () => data } });
  await holders.execute(["BHP:LSE"], cli.context);
  const { result, options } = cli.printed[0]!;
  const text = serializeCliResult(result, { ...DEFAULT_CLI_OPTIONS, format: "text" }, options).replace(/\u001b\[[0-9;]*m/g, "");
  expect(text).toContain("values in USD");
  expect(text).toContain("Value = shares reported at 2026-06-30 x period-end price (USD).");
  expect(text).toMatch(/Shares +Basis +Value \(USD\) +% Held/);
  expect(text).toMatch(/Paradigm Asset Management Company, LLC +2026-06-30 +66,100 +2\.72M +<0\.01%/);
  expect(text).toMatch(/Horizon Financial Services, LLC +2026-06-30 +120 +ADR +10k +<0\.01%/);
  expect(result.metadata).toMatchObject({ currency: "GBp", valueCurrency: "USD" });
});
