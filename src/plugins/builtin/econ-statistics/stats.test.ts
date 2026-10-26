import { expect, test } from "bun:test";
import { readStatArg } from "./stats";

const read = (arg: string) => {
  const found = readStatArg(arg);
  return found && { id: found.stat.id, readAs: found.readAs };
};

test("an indicator's name is read before a FRED series id, and says what it read", () => {
  // FRED files personal spending under PCE, but the number a release week is about is the price index.
  expect(read("PCE")).toEqual({
    id: "pce-yoy",
    readAs: 'Read "PCE" as PCE Prices (PCE y/y). FRED\'s series PCE is personal spending: type personal-spending for it.',
  });
  // gdp is real GDP, not the nowcast its letters start.
  expect(read("gdp")).toEqual({ id: "real-gdp", readAs: 'Read "gdp" as Real GDP (Real GDP q/q).' });
  expect(read("gdpnow")?.id).toBe("gdpnow");
});

test("an id, a label or a FRED series id is spelled, not read", () => {
  expect(read("pce-yoy")).toEqual({ id: "pce-yoy", readAs: null });
  expect(read("PCE y/y")).toEqual({ id: "pce-yoy", readAs: null });
  expect(read("Core CPI")).toEqual({ id: "core-cpi-yoy", readAs: null });
  expect(read("PCEPI")).toEqual({ id: "pce-yoy", readAs: null });
  expect(read("GDPC1")).toEqual({ id: "real-gdp", readAs: null });
  // Personal spending stays reachable by its own name.
  expect(read("personal-spending")).toEqual({ id: "personal-spending", readAs: null });
});

test("the start of a name is read too, and nothing else is guessed", () => {
  expect(read("unemp")).toEqual({ id: "unemployment", readAs: 'Read "unemp" as Unemployment Rate (Unemployment).' });
  expect(readStatArg("zzz")).toBeNull();
  expect(readStatArg("  ")).toBeNull();
});
