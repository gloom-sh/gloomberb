import { describe, expect, test } from "bun:test";
import { layoutPaneFooterHintRow, type CombinedPaneFooter, type PaneFooterSegment, type PaneHint } from "./model";

const hints: PaneHint[] = [
  { id: "search", key: "/", label: "search" },
  { id: "open", key: "o", label: "pen" },
  { id: "pop-out", key: "p", label: "op out" },
  { id: "share", key: "s", label: "hare" },
  { id: "archive", key: "a", label: "rchive" },
  { id: "bookmark", key: "b", label: "ookmark" },
  { id: "copy", key: "c", label: "opy" },
  { id: "yank", key: "y", label: "ank" },
];

function footer(info: PaneFooterSegment[]): CombinedPaneFooter {
  return {
    info,
    hints: [{ id: "disabled", key: "x", label: "skip", disabled: true }, ...hints],
    menu: [],
    keys: [],
  };
}

describe("footer hint row", () => {
  test("puts hints that do not fit under More, in order, and keeps status space", () => {
    const row = layoutPaneFooterHintRow(footer([{ id: "loading", parts: [{ text: "loading" }] }]), 32);
    expect(row.overflow.length).toBeGreaterThan(0);
    expect(row.moreLabel).toBe("More");
    expect([...row.hints, ...row.overflow].map((hint) => hint.id)).toEqual(hints.map((hint) => hint.id));
    expect(row.infoWidth).toBeGreaterThanOrEqual("loading".length);
    expect(row.hintsWidth + row.infoWidth).toBeLessThanOrEqual(32);
  });

  test("a failure keeps more of its sentence than a status word does", () => {
    const failure = "Cloud chart data is unavailable for AAPL";
    const row = layoutPaneFooterHintRow(footer([{ id: "error", parts: [{ text: failure, tone: "warning" }] }]), 64);
    expect(row.infoWidth).toBeGreaterThanOrEqual(24);
    expect(row.hintsWidth + row.infoWidth).toBeLessThanOrEqual(64);
  });

  test("keeps every hint on a wide row", () => {
    const row = layoutPaneFooterHintRow(footer([{ id: "loading", parts: [{ text: "loading" }] }]), 120);
    expect(row.overflow).toEqual([]);
    expect(row.hints.map((hint) => hint.id)).toEqual(hints.map((hint) => hint.id));
  });
});
