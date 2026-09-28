import { describe, expect, test } from "bun:test";
import type { PaneTemplateContext } from "../../../types/plugin";
import { earningsModule } from "./index";
import { scopedSymbolsFromSettings } from "./model";

describe("ERN pane scope", () => {
  /**
   * The shortcut takes tickers, but the template used to drop them and follow
   * the active collection instead, so `ERN NKE` opened a pane that reported no
   * tickers in scope while the same argument produced a report.
   */
  test("scopes the pane to the tickers the shortcut was given", async () => {
    const template = earningsModule.paneTemplates?.find(
      (candidate) => candidate.id === "earnings-calendar-pane",
    );
    const context = { activeCollectionId: "main" } as unknown as PaneTemplateContext;

    const scoped = await template?.createInstance?.(context, { arg: "nke, msft" });
    expect(scopedSymbolsFromSettings(scoped?.settings)).toEqual(["NKE", "MSFT"]);

    const unscoped = await template?.createInstance?.(context, undefined);
    expect(scopedSymbolsFromSettings(unscoped?.settings)).toEqual([]);
  });
});
