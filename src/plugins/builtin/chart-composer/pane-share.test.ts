import { describe, expect, test } from "bun:test";
import type { PaneTemplateContext } from "../../../types/plugin";
import { chartComposerModule } from "./index";
import { CHART_SPEC_SETTING_KEY, parseChartSpec } from "./chart-spec";
import { buildPriceChartPreset } from "./presets";

const context: PaneTemplateContext = {
  config: {} as PaneTemplateContext["config"],
  layout: { dockRoot: null, instances: [], floating: [], detached: [] },
  focusedPaneId: null,
  activeTicker: null,
  activeCollectionId: null,
};

describe("chart pane sharing", () => {
  test("round-trips the validated chart spec without unrelated pane state", async () => {
    const template = chartComposerModule.paneTemplates?.find((entry) => entry.id === "chart-composer-pane");
    const spec = buildPriceChartPreset("AAPL");
    const shared = template?.publicShare?.serialize({
      pane: {
        instanceId: "chart-1",
        paneId: "chart-composer",
        title: "AAPL Price",
        settings: { [CHART_SPEC_SETTING_KEY]: spec, privateCursor: "not-shared" },
      },
      paneState: { selectedPoint: 12 },
    });

    expect(shared?.title).toBe("AAPL Price");
    expect(shared?.data).toEqual({ chartSpec: parseChartSpec(spec) });
    const options = template?.publicShare?.restore(shared!.data);
    const instance = await template?.createInstance?.(context, options ?? undefined);
    expect(parseChartSpec(instance?.settings?.[CHART_SPEC_SETTING_KEY])).toEqual(parseChartSpec(spec));
    expect(JSON.stringify(shared)).not.toContain("privateCursor");
  });
});
