import { expect, test } from "bun:test";
import type { PaneTemplateContext } from "../../../types/plugin";
import { portfolioListModule } from "./index";

const pf = portfolioListModule.paneTemplates!.find((template) => template.shortcut?.prefix === "PF")!;

function openedBy(activeCollectionId: string | null, portfolios = [{ id: "main", name: "Main Portfolio" }, { id: "ira", name: "IRA" }], arg?: string) {
  const context = {
    activeCollectionId,
    config: { portfolios, watchlists: [{ id: "watchlist", name: "Watchlist" }] },
  } as unknown as PaneTemplateContext;
  return pf.createInstance!(context, arg ? { arg } : undefined)?.params?.collectionId;
}

/** Review, 12 Nov 2026: PF opened the Watchlist, the collection last in view, under the name "Collection". */
test("PF opens the portfolio in view or the first one, a watchlist only when named or when there is no portfolio", () => {
  expect(pf.label).toBe("Portfolio");
  expect(openedBy("watchlist")).toBe("main");
  expect(openedBy(null)).toBe("main");
  expect(openedBy("ira")).toBe("ira");
  expect(openedBy("watchlist", [], undefined)).toBe("watchlist");
  expect(openedBy("main", undefined, "watch")).toBe("watchlist");
});
