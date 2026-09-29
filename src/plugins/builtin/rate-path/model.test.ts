import { describe, expect, test } from "bun:test";
import { ApiRequestError } from "../../../api-client/errors";
import type { RateMeeting, RatePathPayload } from "../../../api-client/rates";
import { fetchRatePath, validateRatePath } from "./client";
import { meetingLabel, meetingMoves, meetingProbability, moveOddsText, movesPriced, movesText, rateChangeText, ratePathCurves } from "./model";

const metric = { value: 4, asOf: "2026-09-21", percentile: 50, samples: 250, source: "fred" as const };
const meeting: RateMeeting = { date: "2026-10-28", impliedRate: 3.875, targetMidpoint: 3.875, changeBps: -12.5, percentile: 25, samples: 220, asOf: "2026-09-22T14:00:00Z", probabilities: [{ targetMidpoint: 3.75, probability: 0.5 }, { targetMidpoint: 4, probability: 0.5 }], method: "following-month", reason: null };
function payload(): RatePathPayload {
  return { asOf: meeting.asOf, fetchedAt: "2026-09-22T14:01:00Z", stale: false, status: "partial", current: { effr: metric, targetLower: metric, targetUpper: metric }, meetings: [meeting, { ...meeting, date: "2026-12-09", impliedRate: null, probabilities: [], reason: "Missing contract" }], fedFunds: [], sofr: [], ghosts: [{ label: "1W", requestedDate: "2026-09-15", asOf: "2026-09-15", points: [{ date: meeting.date, impliedRate: 4.1 }, { date: "2026-12-09", impliedRate: null }] }], dotPlot: { asOf: "2026-09-16", sourceUrl: "https://www.federalreserve.gov", points: [] }, schedule: { sourceUrl: "https://www.federalreserve.gov", verifiedAt: "2026-09-22", through: "2027-12-08" }, probabilityAssumption: "Two outcomes", slope: { valueBps: null, percentile: null, samples: 0, asOf: null }, gaps: ["Missing contract"] };
}

describe("rate-path integration boundary", () => {
  test("preserves incomplete meeting nodes and historical dates without filling a gap", () => {
    const result = validateRatePath(payload());
    const curves = ratePathCurves(result);
    const weekAgo = curves.find((entry) => entry.id === "1W")!;
    expect(curves[0]!.points[1]!.value).toBeNull();
    expect(weekAgo.asOf).toBe("2026-09-15");
    expect(weekAgo.points[1]!.value).toBeNull();
    expect(curves[0]!.points[0]!.x).toBe(Date.parse(meeting.date));
    expect(meetingProbability(result.meetings[1]!, 4)).toBeNull();
    expect(meetingProbability(result.meetings[0]!, 4)).toBe(0.5);
    expect(meetingProbability(result.meetings[0]!, 4.25)).toBe(0);
  });

  test("charts only near ghosts, the target range as one reference and the SEP dot as a marker", () => {
    const data = payload();
    data.meetings.push({ ...meeting, date: "2027-01-27", impliedRate: 4.3 });
    data.ghosts.push({ label: "1Y", requestedDate: "2025-09-22", asOf: "2025-09-22", points: [{ date: meeting.date, impliedRate: 2.9 }] });
    data.dotPlot.points = [{ year: 2026, rate: 4.1 }, { year: 2028, rate: 3.9 }, { year: "longer-run", rate: 3.2 }];
    const curves = ratePathCurves(validateRatePath(data));
    // What the path is read against comes before the look-backs, so a narrow legend keeps it.
    expect(curves.map((entry) => [entry.id, entry.role, entry.label])).toEqual([
      ["implied", "primary", "EFFR"], ["targetLower", "reference", "Target range"], ["targetUpper", "reference", "Target range"],
      ["sep", "marker", "SEP median"], ["1W", "ghost", "1W"],
    ]);
    expect(curves.find((entry) => entry.id === "sep")!.points).toEqual([{ id: "sep-2026", label: "SEP 2026", x: Date.parse("2026-12-31"), value: 4.1, asOf: "2026-09-16" }]);
    // Meetings read as months on the axis and in the readout, the way CTM names contracts.
    expect(curves[0]!.points.map((point) => point.label)).toEqual(["Oct '26", "Dec '26", "Jan '27"]);
    expect(meetingLabel("2027-03-17")).toBe("Mar '27");
    // The policy rate holds between meetings, so the paths are steps; the band and the dots are not.
    expect(curves.map((entry) => entry.style)).toEqual(["step", undefined, undefined, undefined, "step"]);
    expect(rateChangeText(0.105)).toBe("+10.5bp");
    expect(rateChangeText(-0.0004)).toBe("0.0bp");
    expect(rateChangeText(null)).toBe("--");
  });

  test("moves priced by each meeting and at it alone, read the way the probabilities are", () => {
    // Today's target midpoint is 3.875%; the market prices 15.5bp by October and 35.9bp by December.
    const october: RateMeeting = { ...meeting, date: "2026-10-28", changeBps: 15.5,
      probabilities: [{ targetMidpoint: 3.875, probability: 0.38 }, { targetMidpoint: 4.125, probability: 0.62 }] };
    const december: RateMeeting = { ...meeting, date: "2026-12-09", changeBps: 35.9 };
    const january: RateMeeting = { ...meeting, date: "2027-01-27", changeBps: null, impliedRate: null };
    const march: RateMeeting = { ...meeting, date: "2027-03-17", changeBps: -20 };
    // Out of order on purpose: each meeting's own move is against the one before it in time.
    const moves = meetingMoves([december, march, october, january]);
    expect(movesText(movesPriced(october))).toBe("+0.62");
    expect(moveOddsText(moves.get(october.date)!)).toBe("62% hike");
    // The next meeting's odds are the model's probability of the range one move up.
    expect(moves.get(october.date)).toBeCloseTo(meetingProbability(october, 4.125)!, 10);
    expect(moveOddsText(moves.get(december.date)!)).toBe("82% hike");
    // An unpriced meeting has no move, and neither does the one after it.
    expect(moves.get(january.date)).toBeNull();
    expect(moves.get(march.date)).toBeNull();
    expect(movesText(movesPriced(march))).toBe("-0.80");
    expect(moveOddsText(-1.2)).toBe("120% cut");
    expect(moveOddsText(0.004)).toBe("0%");
    expect(movesText(-0.004)).toBe("0.00");
  });

  test("rejects broken endpoint probabilities and impossible decision dates", () => {
    const invalid = payload();
    invalid.meetings = [{ ...meeting, probabilities: [{ targetMidpoint: 4, probability: 0.4 }] }];
    expect(() => validateRatePath(invalid)).toThrow("invalid meeting probabilities");
    invalid.meetings = [{ ...meeting, date: "2026-02-30" }];
    expect(() => validateRatePath(invalid)).toThrow("invalid meeting probabilities");
  });

  test("absent endpoint reports unsupported deployment while access errors retain their status", async () => {
    await expect(fetchRatePath({ getCloudRatePath: async () => { throw new ApiRequestError("Not found", 404); } })).rejects.toThrow("not available yet");
    const denied = new ApiRequestError("Forbidden", 403);
    try { await fetchRatePath({ getCloudRatePath: async () => { throw denied; } }); throw new Error("Expected access rejection"); }
    catch (error) { expect(error).toBe(denied); }
  });
});
