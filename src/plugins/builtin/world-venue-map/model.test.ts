import { describe, expect, test } from "bun:test";
import type { CloudWorldVenuePayload } from "../../../api-client";
import {
  clusterWorldVenues,
  DEFAULT_WORLD_MAP_VIEWPORT,
  filterWorldVenues,
  MAX_WORLD_MAP_ZOOM,
  panWorldMapViewport,
  projectWorldPoint,
  savedWorldMapViewport,
  unprojectWorldPoint,
  venueRemainingSeconds,
  WORLD_MAP_HEIGHT_RATIO,
  zoomWorldMapViewport,
  type WorldMapViewport,
} from "./model";
import { geoViewForViewport } from "./layers";
import { WORLD_OUTLINES } from "./world-outlines";

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
    // The world fills the width of a short map and the height of a tall one.
    const wideTopLeft = projectWorldPoint(-180, 80, 361, 400);
    const wideBottomRight = projectWorldPoint(180, -60, 361, 400);
    expect(wideTopLeft.x).toBe(0);
    expect(wideBottomRight.x).toBe(360);
    expect((wideBottomRight.y - wideTopLeft.y) / 360).toBeCloseTo(WORLD_MAP_HEIGHT_RATIO);

    const tallTopLeft = projectWorldPoint(-180, 80, 201, 61);
    const tallBottomRight = projectWorldPoint(180, -60, 201, 61);
    expect(tallTopLeft.y).toBeCloseTo(0, 9);
    expect(tallBottomRight.y).toBeCloseTo(60, 9);
    expect(tallBottomRight.x - tallTopLeft.x).toBeCloseTo(60 / WORLD_MAP_HEIGHT_RATIO);

    // A terminal row is taller than a column is wide, so the same world takes fewer rows.
    const terminalTopLeft = projectWorldPoint(-180, 80, 101, 51, 2);
    const terminalBottomRight = projectWorldPoint(180, -60, 101, 51, 2);
    expect(100 / ((terminalBottomRight.y - terminalTopLeft.y) * 2)).toBeCloseTo(1 / WORLD_MAP_HEIGHT_RATIO);

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

  test("keeps a cursor point anchored while zooming and splits nearby clusters", () => {
    const width = 361;
    const height = 216;
    const cursor = { x: 90, y: 40 };
    const geographic = unprojectWorldPoint(cursor.x, cursor.y, width, height);
    const zoomed = zoomWorldMapViewport(DEFAULT_WORLD_MAP_VIEWPORT, width, height, cursor, 4);
    expect(zoomed.zoom).toBe(4);
    const stillUnderCursor = projectWorldPoint(geographic.longitude, geographic.latitude, width, height, 1, zoomed);
    expect(stillUnderCursor.x).toBeCloseTo(cursor.x, 6);
    expect(stillUnderCursor.y).toBeCloseTo(cursor.y, 6);

    const nearby = [
      venue({ mic: "WEST", longitude: -20, latitude: 20 }),
      venue({ mic: "EAST", longitude: -18, latitude: 20 }),
    ];
    expect(clusterWorldVenues(nearby, 80, 24)).toHaveLength(1);
    expect(clusterWorldVenues(nearby, 80, 24, 1, {
      zoom: 10,
      centerLongitude: 0,
      centerLatitude: DEFAULT_WORLD_MAP_VIEWPORT.centerLatitude,
    })).toHaveLength(2);

    const panned = panWorldMapViewport(zoomed, width, height, 40, 0);
    expect(panned.centerLongitude).toBeLessThan(zoomed.centerLongitude);
    expect(panWorldMapViewport(DEFAULT_WORLD_MAP_VIEWPORT, width, height, 40, 0)).toEqual(DEFAULT_WORLD_MAP_VIEWPORT);
    expect(zoomWorldMapViewport(zoomed, width, height, cursor, 0.01)).toEqual(DEFAULT_WORLD_MAP_VIEWPORT);
  });

  test("a saved view is read back only when it is one, within the map's zoom", () => {
    expect(savedWorldMapViewport({ zoom: 80, centerLongitude: 54.4, centerLatitude: 24.5 }, 64)).toEqual({ zoom: 64, centerLongitude: 54.4, centerLatitude: 24.5 });
    expect(savedWorldMapViewport({ zoom: 1, centerLongitude: 54.4, centerLatitude: 24.5 })).toEqual(DEFAULT_WORLD_MAP_VIEWPORT);
    for (const junk of [null, "x", {}, { zoom: Number.NaN, centerLongitude: 0, centerLatitude: 0 }, { zoom: 4, centerLongitude: "1", centerLatitude: 0 }]) {
      expect(savedWorldMapViewport(junk)).toBeNull();
    }
  });
});

type Ring = readonly (readonly [number, number])[];

function ringHolds(ring: Ring, longitude: number, latitude: number): boolean {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
    const [x1, y1] = ring[index]!;
    const [x2, y2] = ring[previous]!;
    if ((y1 > latitude) !== (y2 > latitude) && longitude < ((x2 - x1) * (latitude - y1)) / (y2 - y1) + x1) inside = !inside;
  }
  return inside;
}

/** West, south, east, north of the country outline (Natural Earth, public domain) holding a place. */
function countryBox(longitude: number, latitude: number): [number, number, number, number] {
  const ring = WORLD_OUTLINES.find((outline) => ringHolds(outline, longitude, latitude))!;
  const longitudes = ring.map(([x]) => x);
  const latitudes = ring.map(([, y]) => y);
  return [Math.min(...longitudes), Math.min(...latitudes), Math.max(...longitudes), Math.max(...latitudes)];
}

/** How wide and how tall a box is on the ground, in kilometres: its width along the middle parallel. */
function groundSize([west, south, east, north]: [number, number, number, number]) {
  const kmPerDegree = (Math.PI / 180) * 6371;
  return { width: (east - west) * kmPerDegree * Math.cos(((south + north) / 2) * (Math.PI / 180)), height: (north - south) * kmPerDegree };
}

describe("the map's shapes", () => {
  // Mainland France, Germany and Colombia: from 46 degrees north to the equator.
  const countries = [["France", 2.35, 48.85], ["Germany", 10.4, 51], ["Colombia", -74, 4.6]] as const;
  // What the map draws on: pixels (the desktop and the web), and terminal cells, about twice as tall as wide.
  const surfaces = [
    { name: "pixels", width: 900, height: 600, cellAspect: 1 },
    { name: "cells 1:2", width: 200, height: 50, cellAspect: 2 },
    { name: "cells 1:2.25", width: 120, height: 40, cellAspect: 2.25 },
  ];

  for (const [name, longitude, latitude] of countries) {
    test(`${name} is as tall for its width as it is on the ground, on every surface and at every zoom`, () => {
      const box = countryBox(longitude, latitude);
      const ground = groundSize(box);
      const views: WorldMapViewport[] = [DEFAULT_WORLD_MAP_VIEWPORT, { zoom: 6, centerLongitude: (box[0] + box[2]) / 2, centerLatitude: (box[1] + box[3]) / 2 }];
      for (const surface of surfaces) {
        for (const viewport of views) {
          const topLeft = projectWorldPoint(box[0], box[3], surface.width, surface.height, surface.cellAspect, viewport);
          const bottomRight = projectWorldPoint(box[2], box[1], surface.width, surface.height, surface.cellAspect, viewport);
          // A terminal row is `cellAspect` times as tall as a column is wide.
          const drawn = ((bottomRight.y - topLeft.y) * surface.cellAspect) / (bottomRight.x - topLeft.x);
          expect(drawn / (ground.height / ground.width)).toBeCloseTo(1, 1);
        }
      }
    });
  }

  test("mainland France looks about as tall as it is wide, not squat", () => {
    const box = countryBox(2.35, 48.85);
    // Plain latitude would draw it 1.4 times as wide as tall.
    const top = projectWorldPoint(box[0], box[3], 900, 600);
    const bottom = projectWorldPoint(box[2], box[1], 900, 600);
    const ratio = (bottom.y - top.y) / (bottom.x - top.x);
    expect(ratio).toBeGreaterThan(0.9);
    expect(ratio).toBeLessThan(1.1);
  });
});

describe("zooming to a harbor", () => {
  test("every zoom reaches the ceiling with the pointer's place held, and the layers are asked for a harbor's worth of sea", () => {
    const width = 114;
    const height = 98;
    const gibraltar = { longitude: -5.35, latitude: 36.13 };
    const pointer = projectWorldPoint(gibraltar.longitude, gibraltar.latitude, width, height);
    let viewport = DEFAULT_WORLD_MAP_VIEWPORT;
    for (let step = 0; step < 40 && viewport.zoom < MAX_WORLD_MAP_ZOOM; step += 1) {
      const at = projectWorldPoint(gibraltar.longitude, gibraltar.latitude, width, height, 1, viewport);
      viewport = zoomWorldMapViewport(viewport, width, height, at, 1.8, 1, MAX_WORLD_MAP_ZOOM);
    }
    expect(viewport.zoom).toBe(MAX_WORLD_MAP_ZOOM);
    const held = projectWorldPoint(gibraltar.longitude, gibraltar.latitude, width, height, 1, viewport);
    expect(held.x).toBeCloseTo(pointer.x, 6);
    expect(held.y).toBeCloseTo(pointer.y, 6);

    // The ceiling shows about a tenth of a degree, and asks the server for the matching zoom.
    const view = geoViewForViewport(viewport, width, height);
    expect(view.zoom).toBe(12);
    expect(view.bbox[2] - view.bbox[0]).toBeLessThanOrEqual(0.2);
    expect(view.bbox[0]).toBeLessThan(gibraltar.longitude);
    expect(view.bbox[2]).toBeGreaterThan(gibraltar.longitude);
    // Nothing zooms past it, and a pan stays on the map.
    expect(zoomWorldMapViewport(viewport, width, height, pointer, 2).zoom).toBe(MAX_WORLD_MAP_ZOOM);
    const north = panWorldMapViewport(viewport, width, height, 0, 1e9);
    expect(north.centerLatitude).toBeLessThanOrEqual(80);
  });
});
