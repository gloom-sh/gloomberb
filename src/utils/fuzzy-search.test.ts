import { describe, expect, test } from "bun:test";
import { fuzzyFilter } from "./fuzzy-search";

interface Row {
  label: string;
  keywords: string;
}

/** Labels and keyword soup lifted from the panes "nvidia" used to drag in. */
const panes: Row[] = [
  { label: "Options Calculator", keywords: "options greeks pricing black scholes implied volatility derivative model" },
  { label: "Changelog", keywords: "release notes version history what is new update" },
  { label: "Connections", keywords: "broker data provider link account integration api" },
  { label: "Correlation Matrix", keywords: "correlation matrix pairs diversification heatmap" },
  { label: "World Venue Map", keywords: "exchanges venues globe map trading hours world" },
  { label: "News", keywords: "headlines articles feed nvidia apple earnings" },
];

function labels(query: string, rows: Row[] = panes): string[] {
  return fuzzyFilter(rows, query, (row) => `${row.label} ${row.keywords}`, (row) => row.label)
    .map((row) => row.label);
}

describe("fuzzyFilter", () => {
  test("scattered letters across the haystack are not a match", () => {
    expect(labels("nvidia", panes.filter((row) => row.label !== "News"))).toEqual([]);
    // The keyword is a whole word here, which is what keywords are for.
    expect(labels("nvidia")).toEqual(["News"]);
  });

  test("keeps the haystack for whole-word hits", () => {
    expect(labels("greeks")).toEqual(["Options Calculator"]);
    expect(labels("broker")).toEqual(["Connections"]);
    expect(labels("apple")).toEqual(["News"]);
  });

  test("still accepts word-prefix runs against the label", () => {
    expect(labels("corr")).toEqual(["Correlation Matrix"]);
    expect(labels("cm")).toEqual(["Correlation Matrix"]);
    expect(labels("corrmat")).toEqual(["Correlation Matrix"]);
    expect(labels("wvm")).toEqual(["World Venue Map"]);
    expect(labels("optcalc")).toEqual(["Options Calculator"]);
  });

  test("rejects a subsequence that is not a run of word prefixes from the first character", () => {
    // c...log skips into the middle of "Changelog".
    expect(labels("clog")).toEqual([]);
    expect(labels("cnn")).toEqual([]);
    // Word initials that skip the first word.
    expect(labels("vm")).toEqual([]);
  });

  test("the fallback never reads keywords, only the label", () => {
    // "hdl" is a word-prefix run through the "headlines ... " keywords only.
    expect(labels("hdl")).toEqual([]);
  });

  test("a keyword-heavy haystack with no label getter still anchors the run to its start", () => {
    const rows = [{ text: "Market Halts circuit breakers of regulatory resume" }];
    expect(fuzzyFilter(rows, "corr", (row) => row.text)).toEqual([]);
    expect(fuzzyFilter(rows, "mh", (row) => row.text)).toEqual(rows);
  });

  test("multi-word queries need every word to match somewhere", () => {
    expect(labels("opt calc")).toEqual(["Options Calculator"]);
    expect(labels("nvidia earnings")).toEqual(["News"]);
    expect(labels("nvidia pricing")).toEqual([]);
    expect(labels("pricing pressure")).toEqual([]);
  });

  test("a phrase hit outranks the same words found apart", () => {
    const rows: Row[] = [
      { label: "Pressure Pricing Model", keywords: "" },
      { label: "Pricing Pressure Report", keywords: "" },
    ];
    expect(labels("pricing pressure", rows)).toEqual(["Pricing Pressure Report", "Pressure Pricing Model"]);
  });

  test("ranks exact, token, prefix, then substring", () => {
    const rows: Row[] = [
      { label: "Correlation Matrix", keywords: "" },
      { label: "Corr", keywords: "" },
      { label: "Recorr Sync", keywords: "" },
      { label: "Bank Corr", keywords: "" },
    ];
    expect(labels("corr", rows)).toEqual(["Corr", "Bank Corr", "Correlation Matrix", "Recorr Sync"]);
  });

  test("falls back to the haystack when no label getter is given", () => {
    const rows = [{ text: "Options Calculator" }];
    expect(fuzzyFilter(rows, "oc", (row) => row.text)).toEqual(rows);
    expect(fuzzyFilter(rows, "", (row) => row.text)).toEqual(rows);
  });
});
