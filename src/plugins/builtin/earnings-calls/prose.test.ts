import { describe, expect, test } from "bun:test";
import { splitFigures } from "../../../components/ui/prose";
import { splitParagraphs, splitSentences } from "./prose";

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

describe("splitParagraphs", () => {
  test("groups sentences to about the target and breaks on a topic shift", () => {
    const sentence = (n: number) => `Sentence number ${n} has exactly seven words.`;
    const text = `${sentence(1)} ${sentence(2)} ${sentence(3)} Turning to margins, they rose. ${sentence(4)}`;
    const paragraphs = splitParagraphs(text, 40);
    expect(paragraphs[1]).toMatch(/^Turning to margins/);
    expect(paragraphs.join(" ")).toBe(text);
  });

  test("short text stays one paragraph", () => {
    expect(splitParagraphs("Thank you. Good morning.")).toEqual(["Thank you. Good morning."]);
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
