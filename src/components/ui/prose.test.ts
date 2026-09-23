import { expect, test } from "bun:test";
import { splitFigures } from "./prose";

const figures = (text: string) => {
  const runs = splitFigures(text);
  // Everything is accounted for, nothing dropped or duplicated.
  expect(runs.map((run) => run.text).join("")).toBe(text);
  return runs.filter((run) => run.figure).map((run) => run.text);
};

test("dates, form codes and ids are not figures", () => {
  expect(figures("Filed a 10-K on 2025-10-31 and an 8-K/A on Feb 24, 2026.")).toEqual([]);
  expect(figures("Next ex-date Sep 01, 26 (CIK 0000320193, accession 0000320193-24-000123).")).toEqual([]);
  expect(figures("Ex-dividend on 09/23/2026.")).toEqual([]);
});

test("a figure keeps its sign, and a hyphen between words is not one", () => {
  expect(figures("Moved -0.42% after +12 bps, then −3.1% and -$5 million.")).toEqual([
    "-0.42%", "+12 bps", "−3.1%", "-$5 million",
  ]);
  expect(figures("Sold 3 of 5 lots for US$4.1 billion.")).toEqual(["3", "5", "$4.1 billion"]);
});
