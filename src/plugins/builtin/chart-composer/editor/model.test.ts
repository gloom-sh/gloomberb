import { describe, expect, test } from "bun:test";
import { appendChartSeries, buildFundamentalChartPreset, buildPriceChartPreset } from "../presets";
import {
  buildSeriesEditorActions,
  buildSeriesEditorFields,
  type SeriesEditorActionHandlers,
  type SeriesEditorFieldHandlers,
} from "./model";

const fieldHandlers: SeriesEditorFieldHandlers = {
  setStyle() {},
  setTransform() {},
  setAxis() {},
  setVisibility() {},
  setPanel() {},
  addPanel() {},
  setScale() {},
  setPeriod() {},
  setTimestampMode() {},
};

const actionHandlers: SeriesEditorActionHandlers = {
  add() {},
  remove() {},
  moveUp() {},
  moveDown() {},
  cancel() {},
  save() {},
};

describe("series editor model", () => {
  test("builds the full fundamental field sequence and guards the final visible series", () => {
    const draft = buildFundamentalChartPreset(["AAPL"]);
    const fields = buildSeriesEditorFields({
      draft,
      selected: draft.series[0]!,
      handlers: fieldHandlers,
    });

    expect(fields.map((field) => field.id)).toEqual([
      "style",
      "transform",
      "axis",
      "visibility",
      "panel",
      "scale",
      "period",
      "timing",
    ]);
    expect(fields.find((field) => field.id === "visibility")?.options).toEqual([
      { value: "shown", label: "Shown" },
      { value: "hidden", label: "Hidden", disabled: true },
    ]);
  });

  test("keeps series actions aligned with selection and final-series boundaries", () => {
    const single = buildPriceChartPreset("AAPL");
    const singleActions = buildSeriesEditorActions({
      draft: single,
      selected: single.series[0]!,
      selectedIndex: 0,
      handlers: actionHandlers,
    });
    expect(singleActions.filter((action) => action.disabled).map((action) => action.id)).toEqual([
      "remove",
      "move-up",
      "move-down",
    ]);

    const appended = appendChartSeries(single, {
      kind: "security",
      symbol: "MSFT",
      fieldId: "market.ohlcv",
    }).spec;
    const appendedActions = buildSeriesEditorActions({
      draft: appended,
      selected: appended.series[1]!,
      selectedIndex: 1,
      handlers: actionHandlers,
    });
    expect(appendedActions.filter((action) => action.disabled).map((action) => action.id)).toEqual([
      "move-down",
    ]);
  });
});
