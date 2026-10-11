import { describe, expect, test } from "bun:test";
import {
  optionPaneState,
  parseArgumentsOption,
  parsePaneFunctionArgs,
} from "./options";
import { shotSizeWarnings } from "./screenshot";

describe("pane function CLI args", () => {
  test("inline options do not consume the next positional instrument", () => {
    expect(parsePaneFunctionArgs(["GP", "--range=1M", "ES=F"])).toMatchObject({
      target: "GP", arg: "ES=F", options: { range: "1M" },
    });
  });

  test("parses target, argument, output, size, and pane options", () => {
    const parsed = parsePaneFunctionArgs([
      "FA",
      "$NVDA",
      "--period",
      "quarterly",
      "--statement=balance",
      "--output",
      "/tmp/fa-nvda.png",
      "--width",
      "900",
      "--height=700",
    ]);

    expect(parsed.target).toBe("FA");
    expect(parsed.arg).toBe("$NVDA");
    expect(parsed.outputPath).toBe("/tmp/fa-nvda.png");
    expect(parsed.width).toBe(900);
    expect(parsed.height).toBe(700);
    expect(parsed.requireBotSafe).toBe(false);
    expect(parsed.options).toEqual({
      period: "quarterly",
      statement: "balance",
    });
  });

  test("a shot size outside the limits is drawn at the nearest one, and the warning names the PNG it wrote", () => {
    const narrow = parsePaneFunctionArgs(["AUCT", "--width", "80", "--height=9000"]);
    expect(narrow).toMatchObject({ width: 720, height: 1800 });
    expect(shotSizeWarnings(narrow.clamped, narrow)).toEqual([
      "--width 80 is below the 720 minimum, so the capture used 720 and the PNG is 1440 px wide.",
      "--height 9000 is above the 1800 maximum, so the capture used 1800 and the PNG is 3600 px tall.",
    ]);
    // --scale trades cells for glyph size, so the PNG snaps to whole cells at the same output size.
    const scaled = parsePaneFunctionArgs(["GC", "--width", "40", "--scale", "1.5"]);
    expect(shotSizeWarnings(scaled.clamped, scaled)).toEqual([
      "--width 40 is below the 720 minimum, so the capture used 720 and the PNG is 1440 px wide.",
    ]);
    expect(shotSizeWarnings(parsePaneFunctionArgs(["GC", "--width", "1280"]).clamped, { width: 1280, height: 720 })).toEqual([]);
    expect(() => parsePaneFunctionArgs(["GC", "--width", "wide"])).toThrow('--width takes a size in pixels from 720 to 2400, got "wide".');
  });

  test("--explain is a switch, so the token after it stays the function's argument", () => {
    expect(parsePaneFunctionArgs(["AUCT", "--explain", "bill"])).toMatchObject({ target: "AUCT", arg: "bill", explain: true, options: {} });
  });

  test("expands --arguments key-value pairs", () => {
    expect(parseArgumentsOption("range-preset=1Y, axis_mode=percent")).toEqual({
      rangePreset: "1Y",
      axisMode: "percent",
    });
  });

  test("maps generic screenshot options into pane runtime state", () => {
    expect(optionPaneState({
      activeTab: "chart",
      state: "cursorSymbol=NVDA,customFlag=true",
    })).toEqual({
      activeTabId: "chart",
      cursorSymbol: "NVDA",
      customFlag: true,
    });
  });

  test("maps financial statement options into reusable pane state", () => {
    expect(optionPaneState({
      statement: "balance sheet",
      period: "quarterly",
    })).toEqual({
      financialSubTab: "balance",
      financialPeriod: "quarterly",
    });
  });
});
