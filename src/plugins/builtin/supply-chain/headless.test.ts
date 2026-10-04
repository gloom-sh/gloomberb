import { expect, test } from "bun:test";
import { createTestHeadlessArgs, createTestHeadlessContext } from "../../../test-support/headless";
import { supplyChainHeadless } from "./headless";
import { supplyPayload, supplyRow } from "./test-fixture";

test("headless reports keep original evidence and unconverted native units with translation provenance", async () => {
  const row = supplyRow("japan", { nativeAmount: 228_273, nativeCurrency: "JPY", nativeScale: 1_000_000,
    quote: "金額 (百万円) 割合 (%) NVIDIA INTERNATIONAL, INC. - - 228,273 20.2", quoteLanguage: "ja",
    quoteGloss: "NVIDIA INTERNATIONAL: JPY 228,273 million, 20.2% of revenue.", jurisdiction: "JP", entityScope: "entity", sectionRef: "販売実績" });
  const context = createTestHeadlessContext();
  context.apiClient = { ...context.apiClient, getCloudSupplyChain: async () => supplyPayload({ says: [row] }) };
  const result = await supplyChainHeadless.load(createTestHeadlessArgs({ symbols: ["6857.T"] }), context);
  expect(result.sections[0]?.rows?.[0]).toMatchObject({ nativeAmount: 228_273, nativeCurrency: "JPY", nativeScale: 1_000_000, usd: null,
    quote: row.quote, quoteLanguage: "ja", quoteGloss: row.quoteGloss, quoteGlossKind: "machine_translation", jurisdiction: "JP", entityScope: "entity", sectionRef: "販売実績", filingUrl: row.filingUrl });
});
