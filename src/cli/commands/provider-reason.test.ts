import { expect, test } from "bun:test";
import { createDefaultConfig } from "../../types/config";
import type { TickerFinancials } from "../../types/financials";
import type { CliCommandContext } from "../../types/plugin";
import type { MarketContext } from "../types";
import { AssetDataRouter } from "../../sources/provider-router";
import { createEmptyAnswerProvider, createTestFinancials } from "../../test-support/data-provider";
import { createTestCliContext } from "../../test-support/cli-context";
import { marketDataCliCommands } from "./market";
import { ticker } from "./ticker";

const REASON = "Spot gold is not quoted; GC=F is the front-month future.";
const config = createDefaultConfig("/tmp/gloom-provider-reason-test");
const command = (name: string) => marketDataCliCommands.find((entry) => entry.name === name)!;

function context(dataProvider: AssetDataRouter, format: "text" | "json" = "text") {
  const cli = createTestCliContext({ config, dataProvider }, { format });
  const failures: Array<{ message: string; details?: string }> = [];
  const fail = (message: string, details?: string): never => {
    failures.push({ message, details });
    throw new Error(message);
  };
  return { cli, failures, context: { ...cli.context, fail } as unknown as CliCommandContext };
}

test("quote and fx show the sentence the service gave for an empty answer, and keep today's wording without one", async () => {
  for (const [reason, quoteWarning, fxFailure] of [
    [REASON, `XAU/USD: ${REASON}`, REASON],
    [undefined, "XAU/USD: No quote provider available", "Exchange rate unavailable for XAU."],
  ] as const) {
    const router = new AssetDataRouter(null, [createEmptyAnswerProvider(reason)]);

    const text = context(router);
    await command("quote").execute(["XAU/USD"], text.context);
    expect(text.cli.printed[0]!.result.warnings).toEqual([quoteWarning]);

    const json = context(router, "json");
    await command("quote").execute(["XAU/USD"], json.context);
    expect((json.cli.printed[0]!.result.data as Array<{ error: string }>)[0]!.error)
      .toBe(reason ?? "No quote provider available for XAU/USD");

    const fx = context(router);
    await expect(command("fx").execute(["XAU"], fx.context)).rejects.toThrow(fxFailure);
    expect(fx.cli.printed).toEqual([]);
  }
});

test("ticker puts the reason where it used to say the data failed, or that the quote is unavailable", async () => {
  const run = async (provider: ReturnType<typeof createEmptyAnswerProvider>, format: "text" | "json") => {
    const failures: Array<[string, string | undefined]> = [];
    const warnings: string[][] = [];
    await ticker("XAU/USD", {
      initMarketData: async () => ({
        config, dataDir: "/tmp/gloom-provider-reason-test", persistence: { close: () => {} },
        store: { loadTicker: async () => null, loadAllTickers: async () => [] },
        dataProvider: new AssetDataRouter(null, [provider]),
      }) as unknown as MarketContext,
      fail: (message, details) => { failures.push([message, details]); throw new Error(message); },
      ...(format === "json" ? { printResult: (result) => { warnings.push(result.warnings ?? []); } } : {}),
    }).catch(() => {});
    return { failures, warnings };
  };

  expect((await run(createEmptyAnswerProvider(REASON), "text")).failures)
    .toEqual([["Failed to fetch data for XAU/USD.", REASON]]);
  expect((await run(createEmptyAnswerProvider(), "text")).failures)
    .toEqual([["Failed to fetch data for XAU/USD.", "No provider available for XAU/USD"]]);

  // Research that loads without a quote says why the quote is missing.
  const financials: TickerFinancials = createTestFinancials({ profile: { description: "Known issuer without a quote." } });
  expect((await run(createEmptyAnswerProvider(REASON, { getTickerFinancials: async () => financials }), "json")).warnings)
    .toEqual([[REASON]]);
  expect((await run(createEmptyAnswerProvider(undefined, { getTickerFinancials: async () => financials }), "json")).warnings)
    .toEqual([["Quote unavailable."]]);
});
