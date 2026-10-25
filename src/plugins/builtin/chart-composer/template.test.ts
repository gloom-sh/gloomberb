import { describe, expect, test } from "bun:test";
import { normalizeWizardFields } from "../../../components/command-bar/workflow/fields";
import { validateRequiredWorkflowFields } from "../../../components/command-bar/workflow/submit";
import { createTestTemplateContext } from "../../../test-support/headless";
import { CHART_SPEC_SETTING_KEY, parseChartSpec, parseChartSpecOr } from "./chart-spec";
import { chartComposerModule } from "./index";
import { buildEmptyChartPreset, buildRegisteredSeriesChart } from "./presets";

const template = chartComposerModule.paneTemplates!.find((entry) => entry.id === "chart-composer-pane")!;

describe("Custom Chart wizard", () => {
  test("the series field can be left empty", () => {
    const { fields } = normalizeWizardFields(template.wizard!);
    expect(validateRequiredWorkflowFields({
      fields,
      values: { series: "" },
      getFieldStringValue: (_field, value) => (typeof value === "string" ? value : ""),
    })).toBeNull();
  });

  test("an empty series charts the active ticker", async () => {
    const instance = await template.createInstance!(
      createTestTemplateContext({ activeTicker: "MSFT" }),
      { values: { series: "" } },
    );
    const spec = parseChartSpec(instance?.settings?.[CHART_SPEC_SETTING_KEY]);
    expect(spec?.series).toHaveLength(1);
    const source = spec!.series[0]!.source;
    expect(source.kind === "security" ? source.instrument.symbol : null).toBe("MSFT");
  });

  test("an empty series with no active ticker opens an empty chart", async () => {
    const instance = await template.createInstance!(createTestTemplateContext(), { values: { series: "" } });
    expect(parseChartSpec(instance?.settings?.[CHART_SPEC_SETTING_KEY])?.series).toEqual([]);
  });
});

describe("a chart of a registered series", () => {
  test("is titled by its ticker and the series once, and a line filled to another stays a band", async () => {
    const chartSpec = buildRegisteredSeriesChart({
      name: "Z-score",
      template: "CAP:pine:z-score/{ticker}",
      placement: "panel",
      lines: [
        { name: "Z", expression: "CAP:pine:z-score~z/{ticker}" },
        { name: "Upper", style: "band", expression: "CAP:pine:z-score~upper/{ticker}" },
        { name: "Lower", expression: "CAP:pine:z-score~lower/{ticker}" },
      ],
    }, "AAPL");
    const instance = await template.createInstance!(createTestTemplateContext(), { shareData: { chartSpec } });
    expect(instance?.title).toBe("G AAPL · Z-score");
    const spec = parseChartSpec(JSON.parse(JSON.stringify(instance?.settings?.[CHART_SPEC_SETTING_KEY])));
    expect(spec?.series.map((series) => series.style)).toEqual(["candles", "line", "band", "line"]);
  });
});

describe("Valuation Graph", () => {
  const valuation = chartComposerModule.paneTemplates!.find((entry) => entry.id === "valuation-graph-pane")!;
  const periods = (spec: ReturnType<typeof parseChartSpec>) => spec?.series.map((series) => series.source.kind === "security" ? series.source.period : null);

  test("a new GE pane opens daily; a pane saved on quarters reopens on quarters", async () => {
    const instance = await valuation.createInstance!(createTestTemplateContext(), { symbols: ["AAPL", "MSFT"] });
    const created = parseChartSpec(instance?.settings?.[CHART_SPEC_SETTING_KEY]);
    expect(periods(created)).toEqual(["daily", "daily"]);
    // A pane saved before the default changed, read the way the pane reads its settings.
    const saved = { ...created!, series: created!.series.map((series) => series.source.kind === "security"
      ? { ...series, source: { ...series.source, period: "quarterly" as const } } : series) };
    expect(periods(parseChartSpecOr(JSON.parse(JSON.stringify(saved)), buildEmptyChartPreset()))).toEqual(["quarterly", "quarterly"]);
  });
});
