import { afterEach, expect, test } from "bun:test";
import type { CloudWorldVenuePayload } from "../../../api-client";
import { resetGeoCatalogCache } from "../../../api-client/geo";
import { createGeoFixtureRequest } from "../../../test-support/test-fixture-geo";
import { initialMapFocus, mapPlaceBbox, nearestPlaces, resolveMapPlace } from "./place";

afterEach(resetGeoCatalogCache);

const sources = {
  venues: async () => [{ city: "Sydney", longitude: 151.21, latitude: -33.87, country: "Australia", countryCode: "AU", title: "Australian Securities Exchange", mic: "XASX" } as CloudWorldVenuePayload],
  request: createGeoFixtureRequest(),
};

test("coordinates and shipped countries resolve without a network or venue lookup", async () => {
  const offline = { venues: async (): Promise<CloudWorldVenuePayload[]> => { throw new Error("offline"); }, request: createGeoFixtureRequest({ onRequest: () => { throw new Error("must not request"); } }) };
  expect((await resolveMapPlace("51.5, -0.1", offline)).place).toMatchObject({ latitude: 51.5, longitude: -0.1 });
  expect((await resolveMapPlace("france", offline)).place).toMatchObject({ label: "France", zoom: 4 });
  for (const input of ["91,0", "0,-181", "Infinity,0"]) expect((await resolveMapPlace(input, offline)).place).toBeNull();
});

test("venue cities and reference-layer searches resolve through existing data", async () => {
  expect((await resolveMapPlace("Sydney", sources)).place).toMatchObject({ longitude: 151.21, latitude: -33.87 });
  expect((await resolveMapPlace("Suez Canal", sources)).place?.label).toBe("Suez Canal");
  expect((await resolveMapPlace("Rotterdam", sources)).place?.label).toContain("Rotterdam");
  expect((await resolveMapPlace("Heathrow", sources)).place?.label).toContain("Heathrow");
  expect(await resolveMapPlace("Atlantis", sources)).toEqual({ place: null, note: 'Unknown place "Atlantis"; showing world.' });
});

test("a starting place never replaces a valid saved view, including a saved world view", async () => {
  const { place } = await resolveMapPlace("51.5,-0.1", sources);
  expect(initialMapFocus(place, null)).toMatchObject({ longitude: -0.1, latitude: 51.5, zoom: 32 });
  expect(initialMapFocus(place, { zoom: 8, centerLongitude: 150, centerLatitude: -34 })).toBeNull();
  expect(initialMapFocus(place, { zoom: 1, centerLongitude: 0, centerLatitude: 0 })).toBeNull();
  expect(initialMapFocus(place, { zoom: "bad" })).not.toBeNull();
});

test("nearby ordering and bounds wrap the date line rather than spanning the world", async () => {
  const { place } = await resolveMapPlace("0,179", sources);
  expect(mapPlaceBbox(place!)).toEqual([173.375, -5.625, -175.375, 5.625]);
  const rows = [{ longitude: 0, latitude: 0 }, { longitude: -179, latitude: 0 }, { longitude: 178, latitude: 0 }];
  expect(nearestPlaces(rows, place, (row) => row)).toEqual([rows[2]!, rows[1]!, rows[0]!]);
});
