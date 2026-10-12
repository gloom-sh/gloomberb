import { describe, expect, test } from "bun:test";
import { CURRENT_CONFIG_VERSION, DEFAULT_PORTFOLIO_COLUMN_IDS, type LayoutConfig, type PaneInstanceConfig } from "../../../types/config";
import { materializeMarketplaceLayout } from "../../../shares/portable-layout";
import { migrateSavedConfig } from "./migrations";
import { swapDefaultPortfolioAgeColumn } from "./portfolio-as-of-column";

const OLD_DEFAULT = [
  "ticker", "price", "change_pct", "market_cap", "pe", "forward_pe", "latency",
  "sparkline", "shares", "avg_cost", "cost_basis", "mkt_value", "day_pnl", "pnl", "pnl_pct",
];

function portfolioPane(instanceId: string, columnIds: string[]): PaneInstanceConfig {
  return { instanceId, paneId: "portfolio-list", binding: { kind: "none" }, settings: { columnIds, viewMode: "table" } };
}

function layout(...instances: PaneInstanceConfig[]): LayoutConfig {
  return { dockRoot: { kind: "pane", instanceId: instances[0]!.instanceId }, instances, floating: [], detached: [] };
}

const columnsOf = (value: unknown, instanceId: string) =>
  (value as LayoutConfig).instances.find((instance) => instance.instanceId === instanceId)?.settings?.columnIds;

describe("portfolio panes on the old default columns get AS OF UTC where AGE was", () => {
  const customised = [...OLD_DEFAULT.slice(0, -1)];
  const reordered = ["latency", ...OLD_DEFAULT.filter((id) => id !== "latency")];
  const migratedAlready = [...DEFAULT_PORTFOLIO_COLUMN_IDS];

  test("only an untouched default list changes, at AGE's position, and a second pass changes nothing", () => {
    const before = layout(
      portfolioPane("portfolio-list:main", [...OLD_DEFAULT]),
      portfolioPane("portfolio-list:trimmed", customised),
      portfolioPane("portfolio-list:moved", reordered),
      portfolioPane("portfolio-list:new", migratedAlready),
      // Another pane that happens to save the same list is not a portfolio pane.
      { instanceId: "other", paneId: "equity-screener", binding: { kind: "none" }, settings: { columnIds: [...OLD_DEFAULT] } },
    );
    const after = swapDefaultPortfolioAgeColumn(before);

    const main = columnsOf(after, "portfolio-list:main") as string[];
    expect(main).toEqual(DEFAULT_PORTFOLIO_COLUMN_IDS);
    expect(main.indexOf("as_of")).toBe(OLD_DEFAULT.indexOf("latency"));
    expect(columnsOf(after, "portfolio-list:trimmed")).toEqual(customised);
    expect(columnsOf(after, "portfolio-list:moved")).toEqual(reordered);
    expect(columnsOf(after, "portfolio-list:new")).toEqual(migratedAlready);
    expect(columnsOf(after, "other")).toEqual(OLD_DEFAULT);
    // The pane's other settings stay.
    expect(after.instances[0]!.settings).toMatchObject({ viewMode: "table" });

    expect(swapDefaultPortfolioAgeColumn(after)).toBe(after);
    const untouched = layout(portfolioPane("portfolio-list:trimmed", customised), portfolioPane("portfolio-list:new", migratedAlready));
    expect(swapDefaultPortfolioAgeColumn(untouched)).toBe(untouched);
  });

  test("a saved config moves the open layout and every saved tab", () => {
    const saved = {
      configVersion: 25,
      layout: layout(portfolioPane("portfolio-list:main", [...OLD_DEFAULT])),
      layouts: [
        { name: "Home", layout: layout(portfolioPane("portfolio-list:main", [...OLD_DEFAULT])) },
        { name: "Mine", layout: layout(portfolioPane("portfolio-list:mine", customised)) },
      ],
    };
    const result = migrateSavedConfig(saved, "/unused-portfolio-as-of");
    expect(result.applied).toEqual(["portfolio-as-of-column"]);
    expect(result.config.configVersion).toBe(CURRENT_CONFIG_VERSION);
    const layouts = result.config.layouts as Array<{ layout: LayoutConfig }>;
    expect(columnsOf(result.config.layout, "portfolio-list:main")).toEqual(DEFAULT_PORTFOLIO_COLUMN_IDS);
    expect(columnsOf(layouts[0]!.layout, "portfolio-list:main")).toEqual(DEFAULT_PORTFOLIO_COLUMN_IDS);
    expect(columnsOf(layouts[1]!.layout, "portfolio-list:mine")).toEqual(customised);
  });

  test("a layout shared before the change opens with AS OF UTC too", () => {
    const shared = materializeMarketplaceLayout({ layout: layout(portfolioPane("portfolio-list:main", [...OLD_DEFAULT])), paneState: {} });
    expect(shared.layout.instances[0]!.settings?.columnIds).toEqual(DEFAULT_PORTFOLIO_COLUMN_IDS);
  });
});
