import { expect, test } from "bun:test";
import { exportSource, exportSourceLines } from "./export-source";
import type { ReportFreshness } from "./pane-functions/freshness";

const fred: ReportFreshness = {
  source: "FRED", asOf: "2026-10-08", status: "not-a-feed", basis: "published statistics",
  publisher: "ICE Data Indices, LLC", publishedAt: "2026-10-09T13:08:04.000Z", retrievedAt: "2026-10-11T15:58:18.735Z",
};

test("an export cites its source, publisher, observation date, publication time and retrieval time", () => {
  expect(exportSourceLines(fred)).toEqual([
    "Source: FRED \u00b7 Thu 8 Oct 2026 \u00b7 not a live feed (published statistics)",
    "Publisher: ICE Data Indices, LLC",
    "Observation date: 2026-10-08",
    "Publication time: 2026-10-09T13:08:04.000Z",
    "Retrieval time: 2026-10-11T15:58:18.735Z",
  ]);
  expect(exportSource(fred)).toEqual({
    name: "FRED", publisher: "ICE Data Indices, LLC", observationDate: "2026-10-08",
    publicationTime: "2026-10-09T13:08:04.000Z", retrievalTime: "2026-10-11T15:58:18.735Z",
  });
});

test("what the data does not state is said to be not published, never guessed", () => {
  const { publisher: _publisher, publishedAt: _publishedAt, ...unstated } = fred;
  const undated = { ...unstated, asOf: null };
  expect(exportSourceLines(undated).slice(1)).toEqual([
    "Publisher: not published",
    "Observation date: not published",
    "Publication time: not published",
    "Retrieval time: 2026-10-11T15:58:18.735Z",
  ]);
  expect(exportSource(undated)).toMatchObject({ publisher: null, observationDate: null, publicationTime: null });
});

test("a figure as of its release cites the period it covers as its observation date and the release as its publication", () => {
  const { publisher: _publisher, publishedAt: _publishedAt, ...permits } = fred;
  const released: ReportFreshness = { ...permits, asOf: "2026-10-20", referencePeriod: "2026-09-01", periodicity: "monthly" };
  expect(exportSourceLines(released)).toEqual([
    "Source: FRED \u00b7 Sep 2026, released Tue 20 Oct \u00b7 not a live feed (published statistics)",
    "Publisher: not published",
    "Observation date: 2026-09-01",
    "Publication time: 2026-10-20",
    "Retrieval time: 2026-10-11T15:58:18.735Z",
  ]);
  // A publication time the publisher states to the second is kept over the release day.
  expect(exportSource({ ...released, publishedAt: "2026-10-20T12:33:50.000Z" })).toMatchObject({
    observationDate: "2026-09-01", publicationTime: "2026-10-20T12:33:50.000Z",
  });
});
