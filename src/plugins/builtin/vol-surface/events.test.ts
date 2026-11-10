import { describe, expect, test } from "bun:test";
import { selectSurfaceExpiries } from "./client";
import { eventBrackets, eventExpiries, surfaceEventReadings, type SurfaceEvent } from "./events";
import type { SurfaceExpiry } from "./model";

const DAY = 86_400;
const stamp = (date: string) => Date.parse(`${date}T21:00:00Z`) / 1000;
const NOW = Date.parse("2026-11-09T21:00:00Z");
const expiry = (date: string, atm: number) => ({
  expiration: stamp(date), years: (stamp(date) - NOW / 1000) / DAY / 365, atmIV: atm, skew: { atm },
}) as unknown as SurfaceExpiry;
const fomc: SurfaceEvent = { kind: "fomc", date: "2026-12-09", history: { meanAbs: 0.0101, count: 40 } };

describe("scheduled releases on the term structure", () => {
  // SPY's weeklies around the 9 Dec FOMC: the default thinning jumped from 4 Dec to 18 Dec.
  const catalogue = ["2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-16", "2026-11-20", "2026-11-27",
    "2026-12-04", "2026-12-11", "2026-12-18", "2027-01-15", "2027-03-19", "2027-06-18", "2027-12-17"].map(stamp);

  test("the expiries either side of a release are kept however the limit thins the list", () => {
    const thinned = selectSurfaceExpiries(catalogue, 8, NOW);
    expect(thinned).not.toContain(stamp("2026-12-11"));
    expect(eventBrackets(catalogue, "2026-12-09")).toMatchObject({ before: stamp("2026-12-04"), after: stamp("2026-12-11") });
    // A release before the close falls in its own day's expiry, and with nothing live before it the one after stands in.
    expect(eventBrackets(catalogue, "2026-11-10")).toEqual({ before: null, after: stamp("2026-11-10"), next: stamp("2026-11-11") });
    expect(eventExpiries(catalogue, [fomc, { date: "2026-11-10" }]).sort()).toEqual([stamp("2026-11-10"), stamp("2026-11-11"),
      stamp("2026-12-04"), stamp("2026-12-11")].sort());
  });

  test("the release day's implied move is the variance between its expiries beyond an ordinary day's", () => {
    const expiries = [expiry("2026-12-04", 0.16), expiry("2026-12-11", 0.17)];
    const [reading] = surfaceEventReadings(expiries, catalogue, [fomc]);
    const [early, late] = expiries as [SurfaceExpiry, SurfaceExpiry];
    const variance = 0.17 ** 2 * late.years - 0.16 ** 2 * early.years;
    expect(reading!.forwardVol).toBeCloseTo(Math.sqrt(variance / (late.years - early.years)), 10);
    const eventVariance = variance - 0.16 ** 2 * (late.years - early.years - 1 / 365);
    expect(reading!.impliedMove).toBeCloseTo(Math.sqrt(eventVariance * 2 / Math.PI), 10);
    // Flat vol prices the day as an ordinary one; a falling term structure prices less, and no move is read.
    expect(surfaceEventReadings([expiry("2026-12-04", 0.16), expiry("2026-12-11", 0.16)], catalogue, [fomc])[0]!.impliedMove).toBeCloseTo(
      Math.sqrt(0.16 ** 2 / 365 * 2 / Math.PI), 10);
    expect(surfaceEventReadings([expiry("2026-12-04", 0.17), expiry("2026-12-11", 0.15)], catalogue, [fomc])[0]!.impliedMove).toBeNull();
  });

  test("a release before the first live expiry reads from now, against the forward vol past it", () => {
    const cpi: SurfaceEvent = { kind: "cpi", date: "2026-11-10", history: null };
    const [front, next] = [expiry("2026-11-10", 0.2), expiry("2026-11-11", 0.18)];
    const [reading] = surfaceEventReadings([front, next], catalogue, [cpi]);
    const ordinary = (0.18 ** 2 * next.years - 0.2 ** 2 * front.years) / (next.years - front.years);
    expect(reading!.before).toBeNull();
    expect(reading!.forwardVol).toBeCloseTo(0.2, 10);
    expect(reading!.impliedMove).toBeCloseTo(Math.sqrt((0.2 ** 2 * front.years - ordinary * Math.max(0, front.years - 1 / 365)) * 2 / Math.PI), 10);
  });
});
