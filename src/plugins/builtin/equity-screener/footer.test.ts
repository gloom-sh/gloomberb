import { expect, test } from "bun:test";
import { screenNotices, screenResultInfo } from "./footer";
import { screenFixture } from "./test-fixture";

const text = (info: ReturnType<typeof screenResultInfo>) => info.map((segment) => segment.parts.map((part) => part.text).join("")).join(" | ");
const found = (matched: number, covered = 4_969) => {
  const data = screenFixture();
  data.universe = { ...data.universe, matched, covered };
  return data;
};

test("the footer says how many listings match, not how many the universe holds or when its snapshot ran", () => {
  expect(text(screenResultInfo(found(778)))).toBe("778 matches | USD");
  expect(text(screenResultInfo(found(1_445)))).toBe("1,445 matches | USD");
  expect(text(screenResultInfo(found(1)))).toBe("1 match | USD");
  expect(text(screenResultInfo(found(0)))).toBe("0 matches | USD");
  // Every currency is no restriction to name; nothing yet loaded has no count.
  const anyCurrency = found(12);
  anyCurrency.definition.currency = null;
  expect(text(screenResultInfo(anyCurrency))).toBe("12 matches");
  expect(screenResultInfo(null)).toEqual([]);
});

test("the warning icon opens only what the server says about this snapshot, never the scope every snapshot has", () => {
  const scope = "Projection is bounded to 5000 listings and 20000 current cache entries; additional cached coverage may exist.";
  const names = "SEC company names were unavailable for this generation; cached provider names are shown.";
  expect(screenNotices([scope])).toEqual([]);
  expect(screenNotices([scope, names, "A wording this list has not heard of."])).toEqual([names, "A wording this list has not heard of."]);
  expect(screenNotices([`  ${scope}`])).toEqual([]);
  expect(screenNotices(undefined)).toEqual([]);
});
