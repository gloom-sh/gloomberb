import { expect, test } from "bun:test";
import { blendHex } from "../../theme/colors";
import { perceivedLightness } from "../../theme/color-utils";
import { themedColorSet } from "../../theme/series-colors";
import { themes } from "../../theme/themes";
import { ROLE_SLOTS } from "../../plugins/builtin/supply-chain/model";
import { ratioBarGlyphs, ratioBarTrack, TRACK_MIN_SEPARATION } from "./ratio-bar";

test("rounds a ratio to the nearest half cell and never overflows the width", () => {
  expect(ratioBarGlyphs(1, 20)).toBe("█".repeat(20));
  expect(ratioBarGlyphs(0.5, 20)).toBe("█".repeat(10));
  expect(ratioBarGlyphs(0.525, 20)).toBe(`${"█".repeat(10)}▌`);
  expect(ratioBarGlyphs(0.99, 20)).toBe("█".repeat(20));
  expect(ratioBarGlyphs(2, 20)).toBe("█".repeat(20));
});

test("keeps a nonzero ratio visible instead of rounding it away", () => {
  expect(ratioBarGlyphs(0.001, 20)).toBe("▌");
  expect(ratioBarGlyphs(0.001, 20, { resolution: "eighth" })).toBe("▏");
  expect(ratioBarGlyphs(0, 20)).toBe("");
  expect(ratioBarGlyphs(-0.5, 20)).toBe("");
  expect(ratioBarGlyphs(Number.NaN, 20)).toBe("");
  expect(ratioBarGlyphs(0.5, 0)).toBe("");
});

test("mirrors a bar that grows from the end, which has only half cells", () => {
  expect(ratioBarGlyphs(0.525, 20, { align: "end" })).toBe(`▐${"█".repeat(10)}`);
  expect(ratioBarGlyphs(0.33, 10, { align: "end", resolution: "eighth" })).toBe(`▐${"█".repeat(3)}`);
});

test("draws the partial cell in eighths when asked", () => {
  expect(ratioBarGlyphs(0.33, 10, { resolution: "eighth" })).toBe(`${"█".repeat(3)}▎`);
  expect(ratioBarGlyphs(0.399, 10, { resolution: "eighth" })).toBe("█".repeat(4));
});

test("a track stands off the page in every theme, light ones included, and keeps its tint where it already did", () => {
  for (const [id, theme] of Object.entries(themes)) {
    for (const bar of [...Object.values(themedColorSet(ROLE_SLOTS, id)), theme.positive, theme.negative]) {
      expect(Math.abs(perceivedLightness(ratioBarTrack(theme.bg, bar)) - perceivedLightness(theme.bg))).toBeGreaterThanOrEqual(TRACK_MIN_SEPARATION);
    }
  }
  // A black page already shows a 16% tint of orange, so it stays; a pale mint on white is tinted until it shows.
  expect(ratioBarTrack("#000000", "#ff8800")).toBe(blendHex("#000000", "#ff8800", 0.16));
  expect(ratioBarTrack("#ffffff", "#7fd6b0")).not.toBe(blendHex("#ffffff", "#7fd6b0", 0.16));
});
