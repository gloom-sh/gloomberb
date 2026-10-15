import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const forbiddenFooterInstructions: readonly { file: string; phrase: string }[] = [
  { file: "pane-conventions.md", phrase: "shows `loading more`" },
  { file: "quote-board-data.md", phrase: "reports stale status in the existing footer" },
  { file: "supply-chain.md", phrase: "appear as stale in the pane" },
  { file: "supply-chain.md", phrase: "marked stale when refresh fails" },
  { file: "hiring-app-attention.md", phrase: "marks it stale" },
  { file: "research-data.md", phrase: "and a stale warning" },
  { file: "research-data.md", phrase: "1D 164/504" },
  { file: "usage.md", phrase: "Source: Gloom Cloud · observed Sun 4 Oct · lag 6d" },
  { file: "usage.md", phrase: "top 500 ·" },
  { file: "usage.md", phrase: "which the footer says" },
  { file: "usage.md", phrase: "the count stays the board's own" },
  { file: "usage.md", phrase: "the footer counts those holdings" },
  { file: "usage.md", phrase: "how much of the account the estimates cover" },
  { file: "usage.md", phrase: "matches, covered listings" },
];

function docText(file: string): string {
  return readFileSync(join(import.meta.dir, file), "utf8").replace(/\s+/g, " ");
}

describe("footer contract", () => {
  for (const { file, phrase } of forbiddenFooterInstructions) {
    test(`${file} does not instruct ${JSON.stringify(phrase)}`, () => {
      expect(docText(file)).not.toContain(phrase);
    });
  }

  test("usage.md still defines the status Stale", () => {
    const usage = docText("usage.md");
    expect(usage).toContain("Stale (`stale`)");
    expect(usage).toContain("The newest observation is older than its kind allows");
  });
});
