import { describe, expect, test } from "bun:test";
import type { GeoFeature, GeoPropValue } from "../../../api-client/geo";
import { cellGlyph } from "./geo-draw";
import { featureSymbol, ICON_MAX_VISIBLE, MAP_SYMBOLS, pointStyle } from "./map-symbols";

function feature(entityKind: string, props: Record<string, GeoPropValue> = {}): GeoFeature {
  return { id: `${entityKind}:1`, layer: "x", entityKind, label: "X", geometry: { type: "Point", coordinates: [0, 0] }, ts: null, props };
}

describe("map symbols", () => {
  test("a ship under way points along its course; at rest, or without a course, it is a dot", () => {
    expect(featureSymbol("vessels", feature("vessel", { class: "Tanker", speedKn: 12.4, courseDeg: 271.6 }))).toMatchObject({ id: "ship", rotation: 271.6, tone: "tanker" });
    expect(featureSymbol("vessels", feature("vessel", { class: "Tanker", speedKn: 0.3, courseDeg: 90 }))).toMatchObject({ id: "ship-still", rotation: null, tone: "tanker" });
    // AIS writes 360 for "not available", and a missing speed is not a speed.
    expect(featureSymbol("vessels", feature("vessel", { class: "Cargo", speedKn: 14, courseDeg: 360 })).id).toBe("ship-still");
    expect(featureSymbol("vessels", feature("vessel", { class: "Cargo", speedKn: null, courseDeg: 45 })).id).toBe("ship-still");
  });

  test("ship classes keep their colour role and shape whatever their case; anything unknown reads as other", () => {
    const moving = { speedKn: 10, courseDeg: 10 };
    const symbol = (value: string) => featureSymbol("vessels", feature("vessel", { class: value, ...moving }));
    expect(symbol("Cargo")).toMatchObject({ id: "ship", tone: "layer" });
    expect(symbol("PASSENGER")).toMatchObject({ id: "ship", tone: "passenger" });
    expect(symbol("Fishing")).toMatchObject({ id: "ship-small", tone: "fishing" });
    expect(symbol("Tug and special")).toMatchObject({ id: "ship-small", tone: "service" });
    expect(symbol("Hovercraft")).toMatchObject({ id: "ship-other", tone: "other" });
    expect(featureSymbol("vessels", feature("vessel", moving))).toMatchObject({ id: "ship-other", tone: "other" });
  });

  test("a layer the app has never seen still draws, by its entities' kind or as a dot", () => {
    expect(featureSymbol("lng-terminals-v2", feature("terminal")).id).toBe("terminal");
    expect(featureSymbol("weather-stations", feature("station")).id).toBe("dot");
    expect(cellGlyph("weather-stations", feature("station"))).toBe("•");
    // A known layer id wins over a kind it does not expect.
    expect(featureSymbol("chokepoints", feature("strait")).id).toBe("chokepoint");
  });

  test("dense layers fall back to dots; landmarks stay icons at any count", () => {
    expect(pointStyle(false, ICON_MAX_VISIBLE)).toBe("icons");
    expect(pointStyle(false, ICON_MAX_VISIBLE + 1)).toBe("dots");
    expect(pointStyle(true, 50_000)).toBe("icons");
    expect(MAP_SYMBOLS.chokepoint.landmark).toBe(true);
    expect(MAP_SYMBOLS.ship.landmark).toBeUndefined();
  });
});
