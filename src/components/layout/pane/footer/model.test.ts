import { describe, expect, test } from "bun:test";
import { keyHintWords } from "../../../ui/key-hint-words";
import { ageFooterSegment, combinePaneFooterRegistrations, delayedFooterSegment, desktopHintMetrics, fitPaneFooterInfo, paneFooterInfoWidth, savedCopyFooterSegment, layoutPaneFooterHintRow, PANE_FOOTER_SEPARATOR, totalHintsWidth, separatesPaneFooterSegments, splitDelayedStatus, type CombinedPaneFooter, type PaneFooterRegistration, type PaneFooterSegment, type PaneHint } from "./model";

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

  test("how long ago the data loaded goes first, whole, so the source and the date stay; a saved copy stays first", () => {
    const filing: PaneFooterSegment = { id: "filing", parts: [{ text: "10-Q 2026-09-30, filed 2026-10-27", tone: "muted" }] };
    const age = ageFooterSegment("5m ago");
    const rates: PaneFooterSegment = { id: "rates", parts: [{ text: "oldest rate 2026-10-28 05:35 UTC", tone: "muted" }] };
    const fetched = ageFooterSegment("just now", { verb: "fetched" });
    // Wide enough: both, in the pane's order.
    expect(fitPaneFooterInfo([age, filing], 33 + 3 + 6)).toEqual([age, filing]);
    // Leading or trailing, beside hints or not, the age leaves whole rather than cut the date or itself.
    expect(fitPaneFooterInfo([age, filing], 37)).toEqual([filing]);
    expect(fitPaneFooterInfo([rates, fetched], 41, { besideHints: false })).toEqual([rates]);
    // A saved copy is no age: it stays first, whole, beside the date.
    const saved = savedCopyFooterSegment("saved", Date.UTC(2026, 9, 28, 12), Date.UTC(2026, 9, 28, 12, 30));
    expect(fitPaneFooterInfo([saved, rates, fetched], 60)).toEqual([saved, rates]);
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

  test("the status and the hints never touch: hints go under More from the right first, then text before a clock gives way", () => {
    const status: PaneFooterSegment[] = [
      { id: "loading", parts: [{ text: "loading more", tone: "muted" }] },
      { id: "matches", parts: [{ text: "777 matches" }] },
      { id: "currency", parts: [{ text: "USD", tone: "muted" }] },
      delayedFooterSegment({ id: "delay", detail: "15m delayed", delay: "15m", onPress: () => {} }),
    ];
    const whole = paneFooterInfoWidth(status);
    // The whole status, a column, the first hint ([/]search), a column and More.
    const wholeFrom = whole + 1 + 9 + 1 + 6;
    for (let width = 40; width <= 100; width += 1) {
      const row = layoutPaneFooterHintRow(footer(status), width, 4, undefined, { terminal: true });
      const fitted = fitPaneFooterInfo(status, row.infoWidth, { terminal: true });
      expect(row.infoWidth + 1 + row.hintsWidth).toBeLessThanOrEqual(width);
      expect(paneFooterInfoWidth(fitted)).toBeLessThanOrEqual(row.infoWidth);
      expect(fitted.at(-1)!.id).toBe("delay");
      if (width >= wholeFrom) {
        expect(fitted).toEqual(status);
        expect(row.hints[0]!.id).toBe("search");
      }
    }
  });

  test("the desktop's row keeps its hints and gives the status way to its floor first, the terminal's rule left out", () => {
    const status: PaneFooterSegment[] = [
      { id: "loading", parts: [{ text: "loading more", tone: "muted" }] },
      { id: "matches", parts: [{ text: "777 matches" }] },
      { id: "currency", parts: [{ text: "USD", tone: "muted" }] },
      delayedFooterSegment({ id: "delay", detail: "15m delayed", delay: "15m", onPress: () => {} }),
    ];
    const metrics = desktopHintMetrics(8);
    let keptMore = 0;
    for (let width = 40; width <= 120; width += 1) {
      const desktop = layoutPaneFooterHintRow(footer(status), width, 3, metrics);
      const terminal = layoutPaneFooterHintRow(footer(status), width, 3, metrics, { terminal: true });
      // The status takes all the hints leave it, with no column of its own between them.
      expect(desktop.infoWidth).toBe(Math.max(0, width - desktop.hintsWidth));
      expect(desktop.hints.length).toBeGreaterThanOrEqual(terminal.hints.length);
      if (desktop.hints.length > terminal.hints.length) keptMore += 1;
    }
    expect(keptMore).toBeGreaterThan(0);
    // A status ending in its clock is clipped by the row there, the text before the clock kept as it is.
    expect(fitPaneFooterInfo(status, 30).map((segment) => segment.id)).toEqual(status.map((segment) => segment.id));
    expect(fitPaneFooterInfo(status, 30, { terminal: true }).at(-1)!.id).toBe("delay");
  });

  test("a warning icon read and turned muted keeps the room it had, so the hints do not move", () => {
    const status: PaneFooterSegment = { id: "line", parts: [{ text: "Binance 02:15 · Bybit 02:24 UTC · oldest 9 min" }] };
    const icon = (tone: "warning" | "muted"): PaneFooterSegment => ({ id: "notice", icon: "warning", parts: [{ text: "⚠", tone }], onPress: () => {} });
    for (const width of [40, 52, 64]) {
      const { hints: unseen, overflow, infoWidth, hintsWidth } = layoutPaneFooterHintRow(footer([icon("warning"), status]), width, 3);
      const seen = layoutPaneFooterHintRow(footer([icon("muted"), status]), width, 3);
      expect([seen.hints.map((hint) => hint.id), seen.overflow.length, seen.infoWidth, seen.hintsWidth])
        .toEqual([unseen.map((hint) => hint.id), overflow.length, infoWidth, hintsWidth]);
    }
  });

  test("on the desktop a hint is a keycap and whole words, set wider apart, so fewer fit than in the terminal", () => {
    const terminal = totalHintsWidth(hints);
    const desktop = desktopHintMetrics(8);
    expect(totalHintsWidth(hints, desktop)).toBeGreaterThan(terminal);
    // Just wide enough for the terminal's hints, not the desktop's: the desktop's last ones go under More.
    expect(layoutPaneFooterHintRow(footer([]), terminal).overflow).toEqual([]);
    expect(layoutPaneFooterHintRow(footer([]), terminal, 0, desktop).overflow.length).toBeGreaterThan(0);
  });

  // The grid's cell at the smallest, the default and the largest text size (font-scale.ts): the
  // text scales with it, the keycap's padding and the gaps between hints are pixels.
  test.each([6.67, 8, 13.33])("on a %ppx grid the hints as drawn fit the row they were measured for, and More fits beside them", (cellPx) => {
    const metrics = desktopHintMetrics(cellPx);
    // What the web draws for these hints, 0.6em a character: 12px apart, each a keycap
    // of 14px at least (one letter, 4px either side), 4px, then the words.
    const textPx = cellPx * 1.5;
    const captionPx = textPx * 10 / 12;
    const drawnPx = hints.reduce((total, hint, index) => total + (index > 0 ? 12 : 0)
      + Math.max(14, hint.key.length * 0.6 * captionPx + 8) + 4 + keyHintWords(hint).length * 0.6 * textPx, 0);
    expect(totalHintsWidth(hints, metrics) * cellPx).toBeGreaterThanOrEqual(drawnPx);
    const status: PaneFooterSegment = { id: "loading", parts: [{ text: "loading" }] };
    const all = totalHintsWidth(hints, metrics);
    for (let cells = 8; cells <= all + 12; cells += 1) {
      const row = layoutPaneFooterHintRow(footer([status]), cells, 0, metrics);
      const shown = totalHintsWidth(row.hints, metrics)
        + (row.overflow.length > 0 ? (row.hints.length > 0 ? metrics.gap : 0) + row.moreWidth : 0);
      expect(row.hintsWidth).toBeGreaterThanOrEqual(shown);
      expect(row.hintsWidth + row.infoWidth).toBeLessThanOrEqual(cells);
      expect([...row.hints, ...row.overflow].map((hint) => hint.id)).toEqual(hints.map((hint) => hint.id));
    }
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

  // Each pane put its saved copy where it built its footer: after `loading`, after `delisted`, last.
  test("the saved-copy segment comes first wherever a pane registers it, and once, for the oldest copy", () => {
    const loading: PaneFooterSegment = { id: "loading", parts: [{ text: "loading", tone: "muted" }] };
    const stale: PaneFooterSegment = { id: "stale", parts: [{ text: "stale", tone: "warning" }] };
    const footer = combinePaneFooterRegistrations(new Map<string, PaneFooterRegistration>([
      ["list", { info: [loading, savedCopyFooterSegment("list-saved", Date.UTC(2026, 9, 28, 14, 5))] }],
      ["report", { order: 1, info: [stale, savedCopyFooterSegment("report-saved", Date.UTC(2026, 9, 28, 9, 30))] }],
    ]));
    expect(footer.info.map((segment) => segment.id)).toEqual(["report-saved", "loading", "stale"]);
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
