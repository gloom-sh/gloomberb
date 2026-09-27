import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "../renderers/opentui/test-utils";
import { MarkdownText } from "./markdown-text";

let setup: Awaited<ReturnType<typeof testRender>> | undefined;

afterEach(async () => {
  if (!setup) return;
  await act(async () => {
    setup!.renderer.destroy();
  });
  setup = undefined;
});

const COMPARISON = [
  "| | JEPQ | QQQ |",
  "|---|---|---|",
  "| Approach | Actively managed Nasdaq-100-oriented portfolio plus option-premium income | Passive Nasdaq-100 tracker |",
  "| Income | Typically much higher, driven partly by option premiums | Low relative income |",
  "| Tax/distribution character | Distributions can vary and are not equivalent to bond interest | Mostly dividends and capital appreciation |",
].join("\n");

async function render(text: string, width: number): Promise<string[]> {
  await act(async () => {
    setup = await testRender(<MarkdownText text={text} lineWidth={width} />, { width, height: 40 });
  });
  await act(async () => {
    await setup!.renderOnce();
  });
  return setup!.captureCharFrame().split("\n").map((line) => line.trimEnd()).filter(Boolean);
}

describe("MarkdownText tables", () => {
  test("lines columns up without the pipes when the table fits", async () => {
    const lines = await render([
      "| Metric | AAPL | MSFT |",
      "|---|---|---|",
      "| P/E | 28.1 | 34.2 |",
      "| Revenue | $391B | $245B |",
    ].join("\n"), 60);

    expect(lines).toEqual([
      "Metric    AAPL   MSFT",
      "P/E       28.1   34.2",
      "Revenue  $391B  $245B",
    ]);
    expect(lines.join("\n")).not.toContain("|");
  });

  test("right-aligns a column of figures unless the delimiter says otherwise", async () => {
    const lines = await render([
      "| Ticker | Yield | Note |",
      "|---|---|:---|",
      "| JEPQ | 10.4% | 1 |",
      "| QQQ | 0.6% | 22 |",
    ].join("\n"), 60);

    expect(lines).toEqual([
      "Ticker  Yield  Note",
      "JEPQ    10.4%  1",
      "QQQ      0.6%  22",
    ]);
  });

  test("wraps long cells inside their column and keeps a short label column whole", async () => {
    const lines = await render(COMPARISON, 90);

    expect(lines.every((line) => line.length <= 90)).toBe(true);
    expect(lines.join("\n")).not.toContain("|");
    const valueColumn = lines[0]!.indexOf("JEPQ");
    expect(lines.find((line) => line.startsWith("Tax/distribution character"))).toBeDefined();
    const approach = lines.findIndex((line) => line.startsWith("Approach"));
    expect(lines[approach]!.slice(valueColumn)).toStartWith("Actively managed");
    // The continuation stays in the JEPQ column, under an empty label cell.
    expect(lines[approach + 1]!.slice(0, valueColumn).trim()).toBe("");
    expect(lines[approach + 1]!.slice(valueColumn)).toStartWith("Nasdaq-100-oriented");
  });

  test("breaks a long hyphenated word at a dash", async () => {
    const lines = await render(COMPARISON, 60);

    expect(lines.every((line) => line.length <= 60)).toBe(true);
    expect(lines.join("\n")).toContain("Nasdaq-100-");
    expect(lines.join("\n")).not.toMatch(/oriente\s*$/m);
  });

  test("falls back to one record per row when the columns cannot fit", async () => {
    const lines = await render(COMPARISON, 30);

    expect(lines.every((line) => line.length <= 30)).toBe(true);
    expect(lines[0]).toBe("Approach");
    expect(lines[1]).toStartWith("  JEPQ  Actively managed");
    expect(lines).toContain("Income");
    expect(lines.some((line) => line.startsWith("  QQQ   Low relative income"))).toBe(true);
  });

  test("keeps escaped pipes as cell text", async () => {
    const lines = await render([
      "| Expression | Meaning |",
      "|---|---|",
      "| a \\| b | either |",
    ].join("\n"), 60);

    expect(lines).toEqual([
      "Expression  Meaning",
      "a | b       either",
    ]);
  });

  test("leaves pipes in prose alone when there is no delimiter row", async () => {
    const lines = await render("Compare JEPQ | QQQ on yield\n\n---", 60);

    expect(lines).toEqual(["Compare JEPQ | QQQ on yield", "---"]);
  });
});
