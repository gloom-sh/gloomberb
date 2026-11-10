import { describe, expect, test } from "bun:test";
import { selectSurfaceExpiries } from "./client";
import { eventBrackets, eventExpiries, releaseSearchDay, surfaceEventReadings, surfaceEventSummary, surfaceReadingLabel,
  type SurfaceEvent } from "./events";
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
    expect(reading!.events).toEqual([cpi]);
    expect(reading!.impliedMove).toBeCloseTo(Math.sqrt((0.2 ** 2 * front.years - ordinary * Math.max(0, front.years - 1 / 365)) * 2 / Math.PI), 10);
  });

  test("releases between the same two expiries are one reading, every release day out of the ordinary days", () => {
    // FOMC on 9 Dec and CPI on 10 Dec, both between the 4 and 11 Dec expiries.
    const cpi: SurfaceEvent = { kind: "cpi", date: "2026-12-10", history: { meanAbs: 0.0098, count: 58 } };
    const expiries = [expiry("2026-12-04", 0.16), expiry("2026-12-11", 0.18)];
    const readings = surfaceEventReadings(expiries, catalogue, [cpi, fomc]);
    expect(readings).toHaveLength(1);
    const [reading] = readings as [ReturnType<typeof surfaceEventReadings>[number]];
    expect(surfaceReadingLabel(reading)).toBe("FOMC 12-09 + CPI 12-10");
    const [early, late] = expiries as [SurfaceExpiry, SurfaceExpiry];
    const variance = 0.18 ** 2 * late.years - 0.16 ** 2 * early.years;
    const eventVariance = variance - 0.16 ** 2 * (late.years - early.years - 2 / 365);
    expect(reading.impliedMove).toBeCloseTo(Math.sqrt(eventVariance * 2 / Math.PI), 10);
    expect(surfaceEventSummary(reading)).toBe(`fwd ${(reading.forwardVol! * 100).toFixed(1)}% · move ≈${(reading.impliedMove! * 100).toFixed(2)}% · MDAY 1.01/0.98%`);
  });

  test("a release after the last listed expiry has a row that says so, and nothing read", () => {
    const late: SurfaceEvent = { kind: "fomc", date: "2028-01-26", history: null };
    const [reading] = surfaceEventReadings([expiry("2027-12-17", 0.2)], catalogue, [late]);
    expect(reading).toMatchObject({ before: stamp("2027-12-17"), after: null, forwardVol: null, impliedMove: null });
    expect(surfaceEventSummary(reading!)).toBe("no listed expiry after it");
    expect(eventExpiries(catalogue, [late])).toEqual([stamp("2027-12-17")]);
  });

  test("a release drops from the search once its New York time has passed", () => {
    // 10 Nov 2026: CPI at 08:30 New York (13:30 UTC), an FOMC decision at 14:00 (19:00 UTC).
    expect(releaseSearchDay("cpi", Date.parse("2026-11-10T13:29:00Z"))).toBe("2026-11-10");
    expect(releaseSearchDay("cpi", Date.parse("2026-11-10T13:30:00Z"))).toBe("2026-11-11");
    expect(releaseSearchDay("fomc", Date.parse("2026-11-10T18:59:00Z"))).toBe("2026-11-10");
    expect(releaseSearchDay("fomc", Date.parse("2026-11-10T19:00:00Z"))).toBe("2026-11-11");
    // At 23:00 New York on 9 Nov (04:00 UTC on the 10th) the 10 Nov release is still to come.
    expect(releaseSearchDay("cpi", Date.parse("2026-11-10T04:00:00Z"))).toBe("2026-11-10");
  });
});
