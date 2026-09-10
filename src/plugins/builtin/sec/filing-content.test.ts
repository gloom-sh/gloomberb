import { describe, expect, test } from "bun:test";
import { extractFilingContent } from "../../../sources/sec-edgar/content";
import { filingPreviewTruncated } from "./filing-documents";
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

test("preview coverage follows the extracted primary and inline exhibits, not unrelated cached documents", () => {
  const selected = filing("selected");
  const documents: SecFilingDocument[] = [{ document: "release.htm", type: "EX-99.1", url: "https://example.com/release.htm", isPrimary: false }];
  const complete = extractFilingContent("<html><body><p>Complete terms.</p></body></html>", "text/html", { form: "8-K" });
  const truncated = extractFilingContent(`<html><body><p>${"Important merger consideration. ".repeat(1000)}</p></body></html>`, "text/html", { form: "8-K" });
  const cache = new Map([["selected", complete], ["unrelated", truncated]]);
  expect(filingPreviewTruncated(selected, documents, cache)).toBe(false);
  cache.set("selected:release.htm", truncated);
  expect(filingPreviewTruncated(selected, documents, cache)).toBe(true);
  cache.set("selected:release.htm", complete);
  cache.set("selected", truncated);
  expect(filingPreviewTruncated(selected, [], cache)).toBe(true);
});
