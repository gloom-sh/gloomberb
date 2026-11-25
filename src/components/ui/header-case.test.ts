import { expect, test } from "bun:test";
import { titleCase } from "./header-case";

test("title case capitalises lower-case words and keeps acronyms and minor words", () => {
  expect(titleCase("Open roles by posting age")).toBe("Open Roles by Posting Age");
  expect(titleCase("EPS comparison")).toBe("EPS Comparison");
  expect(titleCase("Split/adjustment factor")).toBe("Split/Adjustment Factor");
  expect(titleCase("what it is for")).toBe("What It Is For");
  expect(titleCase("iShares core (bp)")).toBe("iShares Core (bp)");
});
