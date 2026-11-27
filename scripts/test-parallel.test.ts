import { describe, expect, test } from "bun:test";
import { assignTestBuckets, type SizedTestFile } from "./test-parallel";

describe("assignTestBuckets (LPT)", () => {
  test("places heaviest files first and balances total weight across workers", () => {
    const files: SizedTestFile[] = [
      { path: "a.test.ts", weight: 10 },
      { path: "b.test.ts", weight: 100 },
      { path: "c.test.ts", weight: 90 },
      { path: "d.test.ts", weight: 80 },
      { path: "e.test.ts", weight: 70 },
      { path: "f.test.ts", weight: 30 },
      { path: "g.test.ts", weight: 20 },
    ];
    const buckets = assignTestBuckets(files, 4);
    expect(buckets).toHaveLength(4);
    // Heaviest 4 files start each bucket in descending order.
    expect(buckets.map((bucket) => bucket[0])).toEqual(["b.test.ts", "c.test.ts", "d.test.ts", "e.test.ts"]);
    // Remaining weights (30, 20, 10) fill the lightest buckets first -> loads [100, 100, 100, 100].
    const weights = new Map(files.map((file) => [file.path, file.weight]));
    const totals = buckets.map((bucket) => bucket.reduce((sum, path) => sum + weights.get(path)!, 0));
    expect(totals).toEqual([100, 100, 100, 100]);
  });

  test("preserves every file without duplication and clamps worker count to file count", () => {
    const files: SizedTestFile[] = [
      { path: "one.test.ts", weight: 5 },
      { path: "two.test.ts", weight: 5 },
    ];
    const buckets = assignTestBuckets(files, 4);
    expect(buckets).toHaveLength(2);
    expect(buckets.flat().sort()).toEqual(["one.test.ts", "two.test.ts"]);
  });
});
