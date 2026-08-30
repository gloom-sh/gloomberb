import { describe, expect, test } from "bun:test";
import type { CloudWorldVenuePayload } from "../../../api-client";
import {
  clusterWorldVenues,
  filterWorldVenues,
  projectWorldPoint,
  venueRemainingSeconds,
} from "./model";

function venue(overrides: Partial<CloudWorldVenuePayload>): CloudWorldVenuePayload {
  return {
    mic: "XNYS",
    name: "NYSE",
    title: "New York Stock Exchange",
    country: "United States",
    countryCode: "US",
    city: "New York",
    timezone: "America/New_York",
    latitude: 40.7127,
    longitude: -74.006,
    isOpen: false,
    ...overrides,
  };
}

describe("world venue map model", () => {
  test("projects, clusters, filters, and advances server countdowns", () => {
    expect(projectWorldPoint(-180, 85, 361, 146)).toEqual({ x: 0, y: 0 });
    expect(projectWorldPoint(180, -60, 361, 146)).toEqual({ x: 360, y: 145 });

    const tallTopLeft = projectWorldPoint(-180, 85, 101, 101);
    const tallBottomRight = projectWorldPoint(180, -60, 101, 101);
    expect(tallTopLeft.x).toBe(0);
    expect(tallBottomRight.x).toBe(100);
    expect(100 / (tallBottomRight.y - tallTopLeft.y)).toBeCloseTo(360 / 145);

    const terminalTopLeft = projectWorldPoint(-180, 85, 101, 51, 2);
    const terminalBottomRight = projectWorldPoint(180, -60, 101, 51, 2);
    expect(100 / ((terminalBottomRight.y - terminalTopLeft.y) * 2)).toBeCloseTo(360 / 145);

    const rows = [
      venue({ mic: "XNYS", timeToOpenSeconds: 3_600 }),
      venue({ mic: "XASE", name: "NYSE American", isOpen: true, timeToCloseSeconds: 7_200 }),
      venue({ mic: "XLON", name: "London Stock Exchange", title: "London Stock Exchange", city: "London", country: "United Kingdom", countryCode: "GB", longitude: -0.1278, latitude: 51.5074 }),
    ];

    const clusters = clusterWorldVenues(rows, 80, 24);
    expect(clusters.find((cluster) => cluster.venues.some((item) => item.mic === "XNYS"))?.venues).toHaveLength(2);
    expect(filterWorldVenues(rows, "london").map((item) => item.mic)).toEqual(["XLON"]);
    expect(filterWorldVenues(rows, "")[0]?.mic).toBe("XASE");
    expect(venueRemainingSeconds(rows[0]!, 1_000, 61_000)).toBe(3_540);
  });
});
