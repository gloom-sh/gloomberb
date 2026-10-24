import { expect, test } from "bun:test";
import { ApiRequestError } from "../../../api-client/errors";
import { fetchBreadth, fetchChanges, fetchMembers } from "./client";

const funds = { funds: ["IVV", "IJH", "IJR", "IWM", "IWB"].map((ticker) => ({ ticker, name: ticker, aliases: ticker === "IVV" ? ["SPX"] : [], changes: "none" as const, asOf: "2026-10-05" })) };
const notFound = () => Promise.reject(new ApiRequestError("NOT_FOUND", 404));
const client = { getMemberFunds: async () => funds, getFundMembers: notFound, getFundChanges: notFound } as never;
const NOT_YET = "Fund members are not available on this server yet.";

test("a 404 for a fund outside the covered list names the covered funds, for holdings and changes alike", async () => {
  await expect(fetchMembers("IBIT", client)).rejects.toThrow("IBIT is not a covered fund. Covered: IVV");
  await expect(fetchChanges("zzzzz", client)).rejects.toThrow("ZZZZZ is not a covered fund. Covered: IVV");
});

test("a server without the route, or a covered fund that 404s, keeps the not-available message", async () => {
  await expect(fetchMembers("IBIT", { getFundMembers: notFound, getMemberFunds: notFound } as never)).rejects.toThrow(NOT_YET);
  await expect(fetchMembers("IBIT", { getFundMembers: notFound, getMemberFunds: async () => ({ funds: [] }) } as never)).rejects.toThrow(NOT_YET);
  await expect(fetchMembers("IVV", client)).rejects.toThrow(NOT_YET);
  await expect(fetchMembers("SPX", client)).rejects.toThrow(NOT_YET);
});

test("other failures pass through without a list lookup", async () => {
  let lookups = 0;
  const failing = { getMemberFunds: async () => { lookups += 1; return funds; }, getFundMembers: () => Promise.reject(new ApiRequestError("Bad gateway", 502)) } as never;
  await expect(fetchMembers("IBIT", failing)).rejects.toThrow("Bad gateway");
  expect(lookups).toBe(0);
});

test("an old server identifies breadth as the unavailable surface", async () => {
  await expect(fetchBreadth("SPX", { ...client as object, getFundBreadth: notFound } as never)).rejects.toThrow("Fund breadth is not available on this server yet.");
});
