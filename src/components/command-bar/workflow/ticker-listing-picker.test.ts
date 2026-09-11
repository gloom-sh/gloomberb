import { expect, test } from "bun:test";
import { AmbiguousTickerError } from "../../../tickers/search";
import { buildTickerListingPicker } from "./ticker-listing-picker";
import { updateRouteStack } from "./route-actions";
import type { CommandBarRoute, CommandBarWorkflowRoute } from "./types";

const workflow: CommandBarWorkflowRoute = {
  kind: "workflow", workflowId: "fundamental-graph-pane", title: "Fundamental Graph",
  fields: [{ id: "tickers", label: "Tickers", type: "text" }],
  values: { tickers: "MSFT, COST, AAPL", metric: "eps", range: "10Y" },
  activeFieldId: "tickers", submitLabel: "Create Pane", pending: false, error: null,
  payload: { kind: "pane-template", actionId: "fundamental-graph-pane" },
  payloadMeta: { argPlaceholder: "tickers" },
};
const ambiguity = new AmbiguousTickerError("COST", ["COST:XNAS", "COST:XLON"], {
  "COST:XNAS": "Costco Wholesale", "COST:XLON": "Costain Group",
});

test("listing choice retains the complete research form and changes only the ambiguous symbol", () => {
  const picker = buildTickerListingPicker(workflow, ambiguity, () => "msft, cost, aapl")!;
  expect(picker.options.map((option) => [option.id, option.detail])).toEqual([
    ["MSFT, COST:XNAS, AAPL", "Costco Wholesale"], ["MSFT, COST:XLON, AAPL", "Costain Group"],
  ]);
  let routes: CommandBarRoute[] = [workflow, picker];
  updateRouteStack((updater) => { routes = typeof updater === "function" ? updater(routes) : updater; },
    String(picker.payload!.fieldId), picker.options[0]!.id);
  const updated = routes[0] as CommandBarWorkflowRoute;
  expect(updated.values).toEqual({ ...workflow.values, tickers: "MSFT, COST:XNAS, AAPL" });
  expect(workflow.values.tickers).toBe("MSFT, COST, AAPL");
  // The next unresolved ticker gets its own choice without undoing the first.
  const second = buildTickerListingPicker(updated, new AmbiguousTickerError("AAPL", ["AAPL:XNAS", "AAPL:XMEX"]), () => String(updated.values.tickers))!;
  expect(second.options[1]!.id).toBe("MSFT, COST:XNAS, AAPL:XMEX");
});

test("single-ticker forms can disambiguate, while missing matches and unrelated errors retain normal handling", () => {
  const single = { ...workflow, fields: [{ id: "ticker", label: "Ticker", type: "text" as const }], payloadMeta: { argPlaceholder: "ticker" } };
  expect(buildTickerListingPicker(single, ambiguity, () => "cost")?.options[0]?.id).toBe("COST:XNAS");
  expect(buildTickerListingPicker(workflow, new Error("No ticker match"), () => "COST")).toBeNull();
  expect(buildTickerListingPicker(workflow, ambiguity, () => "MSFT, AAPL")).toBeNull();
  expect(buildTickerListingPicker({ ...workflow, payload: { kind: "plugin-command", actionId: "other" } }, ambiguity, () => "COST")).toBeNull();
});
