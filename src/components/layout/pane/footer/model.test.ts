import { describe, expect, test } from "bun:test";
import { combinePaneFooterRegistrations, fitPaneFooterInfo, layoutPaneFooterHintRow, PANE_FOOTER_SEPARATOR, separatesPaneFooterSegments, splitDelayedStatus, type CombinedPaneFooter, type PaneFooterRegistration, type PaneFooterSegment, type PaneHint } from "./model";

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
    // The two and the separator between them (" · ").
    expect(fitPaneFooterInfo([line, stale], full.length + 8)).toEqual([line, stale]);
    // The status after it gives way before it shortens.
    const tight = fitPaneFooterInfo([line, stale], full.length + 7);
    expect(tight[0]).toEqual(line);
    expect(tight[1]!.parts[0]!.text).toBe("st…");
    const narrow = fitPaneFooterInfo([line, stale], 70);
    expect(narrow.map((segment) => segment.parts[0]!.text)).toEqual(["Binance 02:15 · Bybit 02:24 UTC · oldest 9 min · delayed", "stale"]);
    expect(narrow[0]!.title).toBe(full);
  });

  test("a trailing status that cannot fit is cut behind an ellipsis, or left out, rather than cut against the hints", () => {
    const contract: PaneFooterSegment = { id: "contract", parts: [{ text: "AAPL261026C00342500" }] };
    const quote: PaneFooterSegment = { id: "quote", parts: [{ text: "quote" }, { text: "12h" }] };
    const trade: PaneFooterSegment = { id: "trade", parts: [{ text: "trade" }, { text: "12h" }] };
    expect(fitPaneFooterInfo([contract, quote, trade], 32).map((segment) => segment.id)).toEqual(["contract", "quote"]);
    const line: PaneFooterSegment = { id: "line", parts: [{ text: "Fri 9 Oct close" }, { text: "· 15 min delayed", tone: "muted" }] };
    const cut = fitPaneFooterInfo([contract, line], 48).at(-1)!;
    expect(cut.parts).toEqual([{ text: "Fri 9 Oct close" }, { text: "· 15 min…", tone: "muted" }]);
    expect(cut.title).toBe("Fri 9 Oct close · 15 min delayed");
    const stale: PaneFooterSegment = { id: "stale", parts: [{ text: "stale", tone: "warning" }] };
    expect(fitPaneFooterInfo([contract, stale], 20).map((segment) => segment.id)).toEqual(["contract", "stale"]);
  });

  test("segments are set apart by the separator, an icon by one column, and the fit counts both", () => {
    expect(PANE_FOOTER_SEPARATOR).toBe(" · ");
    const note: PaneFooterSegment = { id: "note", parts: [{ text: "company data from PBR" }] };
    const status: PaneFooterSegment = { id: "status", parts: [{ text: "as of 2026-06-30" }] };
    const warning: PaneFooterSegment = { id: "warning", icon: "warning", parts: [{ text: "!", tone: "warning" }] };
    expect(separatesPaneFooterSegments(note, status)).toBe(true);
    expect(separatesPaneFooterSegments(warning, note)).toBe(false);
    const both = note.parts[0]!.text.length + 3 + status.parts[0]!.text.length;
    expect(fitPaneFooterInfo([note, status], both)).toEqual([note, status]);
    expect(fitPaneFooterInfo([note, status], both - 1).at(-1)!.parts[0]!.text).toEndWith("…");
    // The icon and its one column, then the note.
    expect(fitPaneFooterInfo([warning, note], 1 + 1 + note.parts[0]!.text.length)).toEqual([warning, note]);
  });

  test("a note with a shorter form keeps its full text while the status after it can give way", () => {
    const listed: PaneFooterSegment = { id: "listed", parts: [{ text: "No events listed after Mon Aug 24", tone: "warning" }] };
    const note: PaneFooterSegment = { id: "note", parts: [{ text: "-- forecast = no consensus yet" }], variants: [[{ text: "no consensus yet" }]] };
    const updated: PaneFooterSegment = { id: "updated", parts: [{ text: "updated 1m ago" }] };
    const all = 33 + 3 + 30 + 3 + 14;
    expect(fitPaneFooterInfo([listed, note, updated], all)).toEqual([listed, note, updated]);
    // A column short: the update time goes, and the note stays whole.
    expect(fitPaneFooterInfo([listed, note, updated], all - 9).map((segment) => segment.parts[0]!.text))
      .toEqual(["No events listed after Mon Aug 24", "-- forecast = no consensus yet"]);
    // Only once the note alone does not fit does it take its shorter form.
    const short = fitPaneFooterInfo([listed, note, updated], 33 + 3 + 20);
    expect(short.map((segment) => segment.parts[0]!.text)).toEqual(["No events listed after Mon Aug 24", "no consensus yet"]);
    expect(short[1]!.title).toBe("-- forecast = no consensus yet");
  });

  test("a failure keeps more of its sentence than a status word does", () => {
    const failure = "Cloud chart data is unavailable for AAPL";
    const row = layoutPaneFooterHintRow(footer([{ id: "error", parts: [{ text: failure, tone: "warning" }] }]), 64);
    expect(row.infoWidth).toBeGreaterThanOrEqual(24);
    expect(row.hintsWidth + row.infoWidth).toBeLessThanOrEqual(64);
  });

  test("a short status is kept whole: the hints that no longer fit go under More rather than cut it", () => {
    const status = "Cloud sync disabled";
    const row = layoutPaneFooterHintRow(footer([{ id: "sync", parts: [{ text: status, tone: "muted" }] }]), 46);
    expect(row.infoWidth).toBeGreaterThanOrEqual(status.length);
    expect(row.overflow.length).toBeGreaterThan(0);
    expect(row.hintsWidth + row.infoWidth).toBeLessThanOrEqual(46);
    // A longer status gives way to the hints, as before.
    const long = layoutPaneFooterHintRow(footer([{ id: "line", parts: [{ text: "Binance 02:15 · Bybit 02:24 UTC · oldest 9 min" }] }]), 46);
    expect(long.hintsWidth).toBeGreaterThan(row.hintsWidth);
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

describe("a delayed status", () => {
  test("its lead becomes the clock, the delay in the terminal's cells and the words in its tooltip, and the rest stays text", () => {
    const [clock, rest, ...more] = splitDelayedStatus({ id: "feed", quoteStatus: true, parts: [{ text: "15m delayed · 14:47 UTC", tone: "muted" }, { text: "tape", tone: "label" }] });
    expect(more).toEqual([]);
    expect(clock).toMatchObject({ id: "feed-delay", icon: "clock", title: "15m delayed", quoteStatus: true, parts: [{ text: "◷15m", tone: "warning" }] });
    expect(rest).toEqual({ id: "feed", quoteStatus: true, parts: [{ text: "14:47 UTC", tone: "muted" }, { text: "tape", tone: "label" }] });
    // A delay with no figure is the clock alone; a status that only mentions a delay later is left as it is.
    expect(splitDelayedStatus({ id: "s", parts: [{ text: "mixed real-time and delayed · as of 15:00:00 UTC" }] })[0]).toMatchObject({ title: "mixed real-time and delayed", parts: [{ text: "◷" }] });
    expect(splitDelayedStatus({ id: "s", parts: [{ text: "delayed" }] })).toHaveLength(1);
    const plain = { id: "s", parts: [{ text: "real-time · 14:47 UTC" }] };
    expect(splitDelayedStatus(plain)).toEqual([plain]);
    expect(splitDelayedStatus({ id: "s", parts: [{ text: "settlement · 15m delayed" }] })[0]?.icon).toBeUndefined();
  });
});
