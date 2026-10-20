import { expect, test } from "bun:test";
import { commodityNamedIn, isCommodityName } from "./commodity-names";

const named = (text: string) => commodityNamedIn(text)?.symbol ?? null;

test("a commodity is named in any form of its words, the longest name first, and an oil no future trades names none", () => {
  // Singular and plural, as the service reads them.
  expect(named("hog prices")).toBe("HE=F");
  expect(named("lean hog")).toBe("HE=F");
  expect(named("Lean Hogs futures")).toBe("HE=F");
  expect(named("soybeans")).toBe("ZS=F");
  expect(named("soybean oil exports")).toBe("ZL=F");
  expect(named("oil prices")).toBe("CL=F");
  expect(named("heating oil")).toBe("HO=F");
  // Palm, olive and cooking oil are not crude: no route, but a commodity later in the text still counts.
  expect(named("palm oil")).toBeNull();
  expect(named("olive oil prices")).toBeNull();
  expect(named("cooking oil")).toBeNull();
  expect(named("palm oil and sugar")).toBe("SB=F");
  expect(named("european gas")).toBeNull();
  // The text that is only the commodity's name searches what its future's news does.
  expect(isCommodityName("Soybeans", "soybean")).toBe(true);
  expect(isCommodityName("lean hogs", "lean hog")).toBe(true);
  expect(isCommodityName("arabica", "coffee")).toBe(false);
});
