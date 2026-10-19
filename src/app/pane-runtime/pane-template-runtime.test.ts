import { describe, expect, test } from "bun:test";
import { templateAsksForSettings } from "./pane-template-runtime";

describe("templateAsksForSettings", () => {
  const wizard = [{ key: "series", label: "Chart Series", type: "text" as const }];

  test("a pane opened with the data it shows does not ask for its settings", () => {
    const template = { wizard };
    expect(templateAsksForSettings(template, undefined)).toBe(true);
    // A plugin opening a chart it built: the form would ask for what the chart already holds.
    expect(templateAsksForSettings(template, { shareData: { chartSpec: {} } })).toBe(false);
    expect(templateAsksForSettings(template, { arg: "AAPL" })).toBe(false);
    expect(templateAsksForSettings(template, { shareData: {} })).toBe(true);
  });

  test("data the template cannot restore still asks", () => {
    const template = { wizard, publicShare: { serialize: () => null, restore: (data: Record<string, unknown>) => (data.chartSpec ? {} : null) } };
    expect(templateAsksForSettings(template, { shareData: { chartSpec: { series: [] } } })).toBe(false);
    expect(templateAsksForSettings(template, { shareData: { drawings: [] } })).toBe(true);
  });
});
