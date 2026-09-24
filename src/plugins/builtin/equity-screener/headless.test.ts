import { expect, test } from "bun:test";
import { MAX_TOOL_RESULT_BYTES } from "../cloud/askg/protocol";
import { equityScreenerHeadless } from "./headless";
import { screenFixture } from "./test-fixture";

test("a full page with more matches is neither an error nor too large for an Ask Gloom tool result", async () => {
  const data = screenFixture();
  const row = data.rows[0]!;
  data.rows = Array.from({ length: 100 }, (_, index) => ({ ...row, symbol: `S${index}` }));
  // Sparse fields make every real payload "partial"; that is not a failure.
  Object.assign(data, { status: "partial", nextCursor: "next", universe: { ...data.universe, covered: 700, matched: 680 } });
  const apiClient = { equityScreener: async () => structuredClone(data) };
  const result = await equityScreenerHeadless.load({ argument: undefined, options: {} } as never, { apiClient } as never);
  expect(result.errors).toEqual([]);
  expect(result.complete).toBe(false);
  expect(result.metadata).toMatchObject({ matched: 680, returned: 100, hasMore: true, notices: ["Top 100 of 680 matches; narrow the criteria to see the rest."] });
  expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThan(MAX_TOOL_RESULT_BYTES);

  data.warnings = ["Bounded scan: some listings were not evaluated."];
  const bounded = await equityScreenerHeadless.load({ argument: undefined, options: {} } as never, { apiClient } as never);
  expect(bounded.errors).toEqual(data.warnings);
});
