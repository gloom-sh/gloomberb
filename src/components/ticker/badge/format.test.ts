import { describe, expect, test } from "bun:test";
import type { Quote } from "../../../types/financials";
import { getThemeColors } from "../../../theme/colors";
import { contrastRatio } from "../../../theme/color-utils";
import { getThemeIds } from "../../../theme/themes";
import { displayWidth } from "../../../utils/format";
import {
  formatTickerBadgeChange,
  getTickerBadgeHoverText,
  getTickerBadgeText,
  tickerBadgeColors,
  type TickerBadgeTextOptions,
} from "./format";

const quote: Quote = {
  symbol: "NFLX",
  price: 1234.5,
  currency: "USD",
  change: 12.3,
  changePercent: 1.24,
  lastUpdated: 1,
};

describe("formatTickerBadgeChange", () => {
  test("keeps one decimal on whole moves and loses a pointless minus on zero", () => {
    expect(formatTickerBadgeChange(1.24)).toBe("+1.2%");
    expect(formatTickerBadgeChange(-5)).toBe("-5.0%");
    expect(formatTickerBadgeChange(-0.01)).toBe("0.0%");
  });
});

describe("getTickerBadgeText", () => {
  test("shows the change next to the symbol once a quote is in", () => {
    expect(getTickerBadgeText({ symbol: "NFLX", status: "ready", quote })).toBe("NFLX +1.2%");
  });

  test("waits with an ellipsis while the quote is loading", () => {
    expect(getTickerBadgeText({ symbol: "NFLX", status: "loading", quote: null })).toBe("NFLX \u2026");
  });

  test("an ambiguous symbol waits for nothing", () => {
    expect(getTickerBadgeText({ symbol: "QSR", status: "ambiguous", quote: null })).toBe("QSR");
  });

  test("a narrow column drops the price rather than clipping it", () => {
    expect(getTickerBadgeText({ symbol: "NFLX", status: "ready", quote, maxTextWidth: 10 }))
      .toBe("NFLX +1.2%");
    expect(getTickerBadgeText({ symbol: "NFLX", status: "ready", quote, maxTextWidth: 9 }))
      .toBe("NFLX");
  });

  test("the symbol survives a budget too small for anything", () => {
    expect(getTickerBadgeText({ symbol: "NFLX", status: "ready", quote, maxTextWidth: 1 })).toBe("NFLX");
  });

  test("a badge without live quotes stays a bare symbol", () => {
    expect(getTickerBadgeText({ symbol: "NFLX", status: "ready", quote, liveQuote: false })).toBe("NFLX");
  });
});

describe("getTickerBadgeHoverText", () => {
  const hover = (options: TickerBadgeTextOptions) => {
    const label = getTickerBadgeHoverText(options);
    // Under the pointer a chip never outgrows its resting text, whatever it shows.
    expect(displayWidth(label ?? "")).toBeLessThanOrEqual(displayWidth(getTickerBadgeText(options)));
    return label;
  };

  test("shows the price alone, in the width of the resting text", () => {
    expect(hover({ symbol: "NFLX", status: "ready", quote })).toBe("$1,234.50");
  });

  test("a narrow column shortens the price before giving it up", () => {
    expect(hover({ symbol: "AAPL", status: "ready", quote: { ...quote, price: 234.56 }, maxTextWidth: 4 })).toBe("$235");
    expect(hover({ symbol: "NFLX", status: "ready", quote, maxTextWidth: 4 })).toBe("1235");
    // $0.5 is not $0.4512, and a one-letter chip has room for no price at all.
    expect(hover({ symbol: "PNY", status: "ready", quote: { ...quote, price: 0.4512 }, maxTextWidth: 3 })).toBeNull();
    expect(hover({ symbol: "F", status: "ready", quote, maxTextWidth: 1 })).toBeNull();
  });

  test("a price longer than the resting text drops its grouping and decimals", () => {
    expect(hover({ symbol: "BTC", status: "ready", quote: { ...quote, price: 1_234_567.89 } })).toBe("$1234568");
    expect(hover({ symbol: "BRK.A", status: "ready", quote: { ...quote, price: 712_345.67 }, maxTextWidth: 5 })).toBeNull();
  });

  test("a chip with no price to show keeps its resting text", () => {
    expect(hover({ symbol: "NFLX", status: "loading", quote })).toBeNull();
    expect(hover({ symbol: "NFLX", status: "loading", quote: null })).toBeNull();
    expect(hover({ symbol: "QSR", status: "ambiguous", quote: null })).toBeNull();
    expect(hover({ symbol: "NFLX", status: "ready", quote, liveQuote: false })).toBeNull();
  });
});

test("a hovered chip's text reads as body text on its fill in every theme", () => {
  for (const id of getThemeIds()) {
    const palette = getThemeColors(id);
    for (const tone of [palette.positive, palette.negative, palette.neutral, palette.borderFocused]) {
      const { fg, bg } = tickerBadgeColors(tone, true, palette);
      if (contrastRatio(fg, bg) < 4.5) throw new Error(`${id}: hovered chip text on ${tone} is ${contrastRatio(fg, bg).toFixed(2)}:1`);
    }
  }
});
