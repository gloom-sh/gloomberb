import { describe, expect, test } from "bun:test";
import { normalizeWizardFields } from "../../../components/command-bar/workflow/fields";
import { validateRequiredWorkflowFields } from "../../../components/command-bar/workflow/submit";
import { createTestTemplateContext } from "../../../test-support/headless";
import { CHART_SPEC_SETTING_KEY, parseChartSpec } from "./chart-spec";
import { chartComposerModule } from "./index";

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
