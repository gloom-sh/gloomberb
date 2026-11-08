import { expect, test } from "bun:test";
import { normalizeCapabilityOptions, type PaneFunctionCapability } from "../../../cli/pane-functions/capabilities";
import { createTestHeadlessContext } from "../../../test-support/headless";
import type { HeadlessPaneContext } from "../../../types/plugin";
import { creditConditionsHeadless } from "./headless";

test("--region takes regions as typed, one or a comma list, and reads only their series", async () => {
  const capability = { id: "credit-conditions", botSafe: true, options: creditConditionsHeadless.options } as unknown as PaneFunctionCapability;
  const normalize = (region?: string) => normalizeCapabilityOptions(capability, region === undefined ? {} : { region }, { strict: true, code: "CRD" }).region;
  expect(normalize()).toBe("all");
  expect(normalize("Asia")).toBe("asia");
  expect(normalize("Asia, emerging markets")).toBe("asia,em");
  expect(normalize("USA,eurozone")).toBe("us,euro");
  expect(() => normalize("asia,mars")).toThrow('Invalid --region value "mars". Use one or more of: all, us, euro, em, asia.');

  // The normalized list reads Asia and the other emerging markets series, nothing of the US or the euro area.
  const requested: string[] = [];
  const apiClient = {
    getCloudFredSeries: async (seriesId: string) => {
      requested.push(seriesId);
      throw new Error("offline");
    },
  } as unknown as HeadlessPaneContext["apiClient"];
  const options = { region: normalize("asia, EM") };
  await expect(creditConditionsHeadless.load({ symbols: [], options } as never, createTestHeadlessContext({ apiClient }))).rejects.toThrow("offline");
  expect(requested.sort()).toEqual([
    "BAMLEMCBPIOAS", "BAMLEMHBHYCRPIOAS", "BAMLEMIBHGCRPIOAS", "BAMLEMRACRPIASIAOAS", "BAMLEMRECRPIEMEAOAS", "BAMLEMRLCRPILAOAS",
  ]);
});
