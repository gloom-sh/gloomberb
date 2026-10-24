import { expect, test } from "bun:test";
import { applyListingArgument, resolvePaneFunction } from "../../../cli/pane-functions/resolver";
import { parsePaneFunctionArgs } from "../../../cli/pane-functions/options";
import type { PaneFunctionCatalog } from "../../../cli/pane-functions/catalog";
import type { MarketContext } from "../../../cli/types";
import { createDefaultConfig } from "../../../types/config";
import { membersPlugin } from "./index";
import { canonicalFund } from "./model";

test("MEMB index arguments reach the fund service without requiring a stock quote", async () => {
  const registry: PaneFunctionCatalog = {
    panes: new Map(membersPlugin.panes!.map(pane => [pane.id, pane])),
    paneTemplates: new Map(membersPlugin.paneTemplates!.map(template => [template.id, template])), destroy() {},
  };
  const context = { config: createDefaultConfig(":memory:"), dataProvider: new Proxy({}, { get() { throw new Error("An index alias must not resolve as a stock"); } }) } as MarketContext;
  for (const [alias, fund] of Object.entries({ SPX: "IVV", "^SPX": "IVV", "^GSPC": "IVV", "^MID": "IJH", "^SML": "IJR", "^RUT": "IWM", "^RUI": "IWB" })) {
    const args = await applyListingArgument(registry, context, parsePaneFunctionArgs(["MEMB", alias, "--tab", "breadth"]));
    const resolved = await resolvePaneFunction(registry, context, args, { strictHeadlessOptions: true });
    expect(resolved.instance.binding).toMatchObject({ kind: "fixed", symbol: alias });
    expect(resolved.options.tab).toBe("breadth");
    expect(canonicalFund(alias)).toBe(fund);
  }
});
