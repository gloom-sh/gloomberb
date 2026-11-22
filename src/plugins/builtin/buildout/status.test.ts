import { expect, test } from "bun:test";
import { BUILDOUT_UNDATED_FIGURES, updateBuildoutFooterInfo } from "./pane/status";
import type { BuildoutLoadState } from "./model/types";

const page = { items: [], offset: 0, hasMore: false, loadingMore: false, error: null };
const ready = { status: "ready", access: "pro", token: "t", lists: [], companies: { ...page, blurredCompanyCount: 0, listSlug: null }, sites: page, intel: page, loadedAt: 0 } as BuildoutLoadState;
const messages = { upgradeMessage: null, partialList: false, onUpgrade: () => {} };
const undated = (tab: Parameters<typeof updateBuildoutFooterInfo>[1], state = ready) =>
  updateBuildoutFooterInfo(state, tab, null, messages).find((segment) => segment.id === "undated");

test("the tables of market cap, growth and 1Y say the dataset dates none of them, and sites and intel say nothing of it", () => {
  for (const tab of ["themes", "companies"] as const) {
    const segment = undated(tab)!;
    expect(segment.parts[0]!.text).toBe("cap, growth and 1Y undated");
    expect(segment.variants?.[0]?.[0]?.text).toBe("figures undated");
    expect(segment.title).toBe(BUILDOUT_UNDATED_FIGURES);
    // A picture of the pane keeps it: the rows alone do not say it.
    expect(segment).toMatchObject({ capture: true, holdsPlace: true });
  }
  expect(undated("sites")).toBeUndefined();
  expect(undated("intel")).toBeUndefined();
  expect(undated("themes", { status: "loading" })).toBeUndefined();
});
