import { describe, expect, test } from "bun:test";
import { splitFigures, splitSentences } from "./prose";

describe("splitFigures", () => {
  test("picks out money, percentages and quantities, leaves years and labels", () => {
    const runs = splitFigures(
      "Revenue grew 20% to $1.2 billion in 2026, or 150 bps above Q2 guidance of $900 million to $1 billion, with 2,500 hires.",
    );
    expect(runs.filter((run) => run.figure).map((run) => run.text)).toEqual([
      "20%",
      "$1.2 billion",
      "150 bps",
      "$900 million",
      "$1 billion",
      "2,500",
    ]);
    // Everything is accounted for, nothing dropped or duplicated.
    expect(runs.map((run) => run.text).join("")).toBe(
      "Revenue grew 20% to $1.2 billion in 2026, or 150 bps above Q2 guidance of $900 million to $1 billion, with 2,500 hires.",
    );
  });
});

describe("splitSentences", () => {
  test("splits on sentence ends but not on abbreviations or decimals", () => {
    expect(
      splitSentences(
        "The U.S. business grew. Margins were 27.8% vs. 25% last year. Acme Inc. expects $5 million and under; management sees this as transferable.",
      ),
    ).toEqual([
      "The U.S. business grew.",
      "Margins were 27.8% vs. 25% last year.",
      "Acme Inc. expects $5 million and under; management sees this as transferable.",
    ]);
  });
});
