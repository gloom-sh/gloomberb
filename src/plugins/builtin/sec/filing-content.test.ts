import { describe, expect, test } from "bun:test";
import type { SecFilingDocument, SecFilingItem } from "../../../types/data-provider";
import {
  buildInlineFilingContentTargets,
  nextUncachedFilingContentTarget,
} from "./filing-content";

function filing(accessionNumber: string): SecFilingItem {
  return {
    accessionNumber,
    filingDate: "2026-01-01",
    filingUrl: `https://example.com/${accessionNumber}`,
    form: "8-K",
    primaryDocument: "filing.htm",
  };
}

describe("SEC filing content cache", () => {
  test("loads unique content targets sequentially in caller priority order", () => {
    const selected = filing("selected");
    const background = filing("background");
    const targets = [selected, selected, background];

    expect(nextUncachedFilingContentTarget(targets, new Map())?.accessionNumber).toBe("selected");
    expect(nextUncachedFilingContentTarget(
      targets,
      new Map([["selected", null]]),
    )?.accessionNumber).toBe("background");
  });

  test("builds content targets only for readable inline exhibits", () => {
    const selected = filing("selected");
    const documents: SecFilingDocument[] = [
      { document: "exhibit.htm", description: "Press release", type: "EX-99.1", url: "https://example.com/exhibit.htm", isPrimary: false },
      { document: "schema.xsd", description: "Schema", type: "EX-101", url: "https://example.com/schema.xsd", isPrimary: false },
    ];

    expect(buildInlineFilingContentTargets(selected, documents).map((target) => target.accessionNumber))
      .toEqual(["selected:exhibit.htm"]);
  });
});
