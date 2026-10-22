import { describe, expect, test } from "bun:test";
import { formatRelativeTime } from "../../../utils/datetime-format";
import { loadingText } from "../../../components/ui/status";
import { briefFooterInfo } from "./footer";

describe("briefFooterInfo", () => {
  test("loading, error, delayed, and the as-of age", () => {
    expect(briefFooterInfo({ loading: true, error: "earnings unavailable" })).toBe(loadingText());
    expect(briefFooterInfo({ error: "earnings unavailable" })).toBe("earnings unavailable");
    expect(briefFooterInfo({ stale: true, asOf: "2026-10-05T14:00:00.000Z" })).toBe(formatRelativeTime("2026-10-05T14:00:00.000Z"));
    expect(briefFooterInfo({ asOf: "2026-10-05T14:07:00.000Z" })).toBe(formatRelativeTime("2026-10-05T14:07:00.000Z"));
  });

  test("the status line is not the pane title", () => {
    for (const line of [
      briefFooterInfo({ loading: true }),
      briefFooterInfo({ error: "calendar unavailable" }),
      briefFooterInfo({ stale: true }),
      briefFooterInfo({ asOf: "2026-10-05T14:07:00.000Z" }),
      briefFooterInfo({}),
    ]) {
      expect(line).not.toContain("Daily Brief");
    }
  });
});
