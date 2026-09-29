import { describe, expect, test } from "bun:test";
import {
  normalizeLookupToken,
  optionPaneState,
  parseArgumentsOption,
  parsePaneCatalogArgs,
  parsePaneFunctionArgs,
} from "./options";

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

  test("normalizes pane ids and shortcuts into one lookup form", () => {
    expect(normalizeLookupToken("comparison-chart-pane")).toBe("comparisonchartpane");
    expect(normalizeLookupToken("CMP")).toBe("cmp");
    expect(normalizeLookupToken("$FA")).toBe("fa");
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

  test("parses catalog queries and limit options", () => {
    expect(parsePaneCatalogArgs(["chart", "price", "--limit", "3"])).toEqual({
      query: "chart price",
      limit: 3,
      botSafeOnly: false,
    });
    expect(parsePaneCatalogArgs(["cash", "flow", "--bot-safe"])).toEqual({
      query: "cash flow",
      limit: 25,
      botSafeOnly: true,
    });
  });
});
