import { describe, expect, test } from "bun:test";
import {
  buildScreenerPrompt,
  getScreenerPromptSignature,
  matchesScreenerPromptSignature,
  parseScreenerResponse,
} from "./contract";

describe("AI screener helpers", () => {
  test("malformed candidates are not reported as a successful empty screen", () => {
    expect(() => parseScreenerResponse('{"tickers":[{"reason":"missing symbol"}]}')).toThrow("malformed ticker candidates");
    expect(parseScreenerResponse('{"tickers":[]}').tickers).toEqual([]);
  });
  test("includes the model override in run identity", () => {
    expect(getScreenerPromptSignature("quality", "codex", "gpt-a"))
      .not.toBe(getScreenerPromptSignature("quality", "codex", "gpt-b"));
    expect(getScreenerPromptSignature("quality", "codex", ""))
      .toBe(getScreenerPromptSignature("quality", "codex", null));
    expect(matchesScreenerPromptSignature(
      JSON.stringify(["codex", "quality"]),
      "quality",
      "codex",
      null,
    )).toBe(true);
    expect(matchesScreenerPromptSignature(
      JSON.stringify(["codex", "quality"]),
      "quality",
      "codex",
      "gpt-custom",
    )).toBe(false);
  });

  test("builds a fresh screener prompt with the current date", () => {
    const prompt = buildScreenerPrompt({
      currentDate: "2026-04-01",
      prompt: "Find profitable serial acquirers.",
    });

    expect(prompt).toContain("Today is 2026-04-01.");
    expect(prompt).toContain("Use the available Gloomberb data tools");
    expect(prompt).toContain("Submit the final structured screener result");
    expect(prompt).not.toContain("already found");
    expect(prompt).not.toContain("Prefer new names");
    expect(prompt).not.toContain("CLI");
    expect(prompt).not.toContain("raw JSON");
  });

  test("parses fenced JSON responses and normalizes ticker fields", () => {
    const parsed = parseScreenerResponse(`
\`\`\`json
{
  "title": "Compounders",
  "summary": "High quality names",
  "tickers": [
    { "symbol": " msft ", "exchange": " nasdaq ", "reason": "Recurring software cash flow" }
  ]
}
\`\`\`
`);

    expect(parsed).toEqual({
      title: "Compounders",
      summary: "High quality names",
      tickers: [
        {
          symbol: "MSFT",
          exchange: "NASDAQ",
          reason: "Recurring software cash flow",
        },
      ],
    });
  });

});
