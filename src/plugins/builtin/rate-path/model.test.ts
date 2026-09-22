import { describe, expect, test } from "bun:test";
import { ApiRequestError } from "../../../api-client/errors";
import type { RateMeeting, RatePathPayload } from "../../../api-client/rates";
import { fetchRatePath, validateRatePath } from "./client";
import { meetingProbability, ratePathCurves } from "./model";

const metric = { value: 4, asOf: "2026-09-21", percentile: 50, samples: 250, source: "fred" as const };
const meeting: RateMeeting = { date: "2026-10-28", impliedRate: 3.875, targetMidpoint: 3.875, changeBps: -12.5, percentile: 25, samples: 220, asOf: "2026-09-22T14:00:00Z", probabilities: [{ targetMidpoint: 3.75, probability: 0.5 }, { targetMidpoint: 4, probability: 0.5 }], method: "following-month", reason: null };
function payload(): RatePathPayload {
  return { asOf: meeting.asOf, fetchedAt: "2026-09-22T14:01:00Z", stale: false, status: "partial", current: { effr: metric, targetLower: metric, targetUpper: metric }, meetings: [meeting, { ...meeting, date: "2026-12-09", impliedRate: null, probabilities: [], reason: "Missing contract" }], fedFunds: [], sofr: [], ghosts: [{ label: "1W", requestedDate: "2026-09-15", asOf: "2026-09-15", points: [{ date: meeting.date, impliedRate: 4.1 }, { date: "2026-12-09", impliedRate: null }] }], dotPlot: { asOf: "2026-09-16", sourceUrl: "https://www.federalreserve.gov", points: [] }, schedule: { sourceUrl: "https://www.federalreserve.gov", verifiedAt: "2026-09-22", through: "2027-12-08" }, probabilityAssumption: "Two outcomes", slope: { valueBps: null, percentile: null, samples: 0, asOf: null }, gaps: ["Missing contract"] };
}

describe("rate-path integration boundary", () => {
  test("preserves incomplete meeting nodes and historical dates without filling a gap", () => {
    const result = validateRatePath(payload());
    const curves = ratePathCurves(result);
    expect(curves[0]!.points[1]!.value).toBeNull();
    expect(curves[1]!.asOf).toBe("2026-09-15");
    expect(curves[1]!.points[1]!.value).toBeNull();
    expect(curves[0]!.points[0]!.x).toBe(Date.parse(meeting.date));
    expect(meetingProbability(result.meetings[1]!, 4)).toBeNull();
    expect(meetingProbability(result.meetings[0]!, 4)).toBe(0.5);
    expect(meetingProbability(result.meetings[0]!, 4.25)).toBe(0);
  });

  test("rejects broken endpoint probabilities and impossible decision dates", () => {
    const invalid = payload();
    invalid.meetings = [{ ...meeting, probabilities: [{ targetMidpoint: 4, probability: 0.4 }] }];
    expect(() => validateRatePath(invalid)).toThrow("invalid meeting probabilities");
    invalid.meetings = [{ ...meeting, date: "2026-02-30" }];
    expect(() => validateRatePath(invalid)).toThrow("invalid meeting probabilities");
  });

  test("absent endpoint reports unsupported deployment while access errors retain their status", async () => {
    await expect(fetchRatePath({ getCloudRatePath: async () => { throw new ApiRequestError("Not found", 404); } })).rejects.toThrow("not available on this Gloom Cloud server yet");
    const denied = new ApiRequestError("Forbidden", 403);
    try { await fetchRatePath({ getCloudRatePath: async () => { throw denied; } }); throw new Error("Expected access rejection"); }
    catch (error) { expect(error).toBe(denied); }
  });
});
