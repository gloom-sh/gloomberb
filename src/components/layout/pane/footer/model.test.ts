import { describe, expect, test } from "bun:test";
import { combinePaneFooterRegistrations, fitPaneFooterInfo, layoutPaneFooterHintRow, type CombinedPaneFooter, type PaneFooterRegistration, type PaneFooterSegment, type PaneHint } from "./model";

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

  test("a status with shorter forms shows the longest that fits beside the hints, its full text kept as the title", () => {
    const full = "Binance 02:15 · Bybit 02:24 UTC · oldest 9 min · delayed · funding = current estimate";
    const line: PaneFooterSegment = { id: "line", parts: [{ text: full }], variants: [[{ text: "Binance 02:15 · Bybit 02:24 UTC · oldest 9 min · delayed" }]] };
    const stale: PaneFooterSegment = { id: "stale", parts: [{ text: "stale" }] };
    expect(fitPaneFooterInfo([line, stale], full.length + 6)).toEqual([line, stale]);
    const narrow = fitPaneFooterInfo([line, stale], 70);
    expect(narrow.map((segment) => segment.parts[0]!.text)).toEqual(["Binance 02:15 · Bybit 02:24 UTC · oldest 9 min · delayed", "stale"]);
    expect(narrow[0]!.title).toBe(full);
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

describe("combining footer registrations", () => {
  // A chart's `p` pin joins every pane that hosts a chart, so a pane's own
  // `p`, drawn or only bound, keeps the key and the pin moves to the menu,
  // unless the pane's `p` is turned off.
  test("a hint that yields its key gives it up to the pane's own hint or key", () => {
    const pin: PaneHint = { id: "chart-pin", key: "p", label: "in", title: "Pin Crosshair", yieldsKey: true, onPress: () => {} };
    const combine = (pane: PaneFooterRegistration) => combinePaneFooterRegistrations(new Map([
      ["chart", { order: 10, hints: [pin] }],
      ["pane", pane],
    ]));
    expect(combine({ hints: [{ id: "open", key: "o", label: "pen" }] }).hints.map((hint) => hint.id)).toEqual(["open", "chart-pin"]);
    expect(combine({ hints: [{ id: "pop-out", key: "p", label: "op out" }] }).hints.map((hint) => hint.id)).toEqual(["pop-out"]);
    // A `p` the pane has turned off does nothing, so the pin keeps it.
    expect(combine({ hints: [{ id: "portfolio", key: "p", label: "ortfolio", disabled: true }] }).hints.map((hint) => hint.id)).toEqual(["portfolio", "chart-pin"]);
    const bound = combine({ keys: [{ id: "window", key: "p", label: "eriod" }] });
    expect(bound.hints).toEqual([]);
    expect(bound.menu.map((item) => item.type === "divider" ? null : [item.label, item.accelerator ?? null])).toEqual([["Pin Crosshair", null]]);
  });
});
