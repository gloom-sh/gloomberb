import { describe, expect, test } from "bun:test";
import { contrastRatio } from "../../../theme/color-utils";
import { getThemeColors, hoverBg } from "../../../theme/colors";
import { themes } from "../../../theme/themes";
import { localUtcOffsetMinutes, reportableTimeZone, utcOffsetMinutesAt } from "../../../utils/local-utc-offset";
import {
  chatAuthorNameColor,
  chatBotNameColor,
  chatPersonFacts,
  chatPersonIconColor,
  chatPersonIcons,
  fitChatPersonIcons,
  formatChatLocalTime,
} from "./people";

const ids = (icons: ReturnType<typeof chatPersonIcons>) => icons.map((icon) => icon.id);

describe("chat people", () => {
  test("the account type and badges give the name its icons: one role, then Pro", () => {
    expect(ids(chatPersonIcons({ accountType: "managed_llm" }))).toEqual(["bot"]);
    // A bot only ever carries its own icon, whatever else it is sent with.
    expect(ids(chatPersonIcons({ accountType: "managed_llm", badges: ["team", "pro"] }))).toEqual(["bot"]);
    expect(ids(chatPersonIcons({ accountType: "human", badges: ["pro", "team"] }))).toEqual(["team", "pro"]);
    expect(ids(chatPersonIcons({ accountType: "human" }))).toEqual([]);
    expect(ids(chatPersonIcons({ accountType: "discord" }))).toEqual([]);
  });

  test("a narrow row drops Pro before the role, two cells an icon", () => {
    const icons = chatPersonIcons({ badges: ["team", "pro"] });
    expect(ids(fitChatPersonIcons(icons, 4))).toEqual(["team", "pro"]);
    expect(ids(fitChatPersonIcons(icons, 3))).toEqual(["team"]);
    expect(fitChatPersonIcons(icons, 1)).toEqual([]);
    expect(ids(fitChatPersonIcons(chatPersonIcons({ badges: ["pro"] }), 2))).toEqual(["pro"]);
  });

  test("a bot's colour stands apart from people's names, mentions and the team's icon, and reads in every built-in theme", () => {
    for (const id of Object.keys(themes)) {
      const palette = getThemeColors(id);
      const bot = chatBotNameColor(palette);
      expect(chatAuthorNameColor({ accountType: "managed_llm" }, palette)).toBe(bot);
      // Every person's name and an @mention are drawn in the positive token.
      expect(chatAuthorNameColor({ accountType: "human" }, palette)).toBe(palette.positive);
      expect(bot, id).not.toBe(palette.positive);
      expect(bot, id).not.toBe(palette.text);
      expect(bot, id).not.toBe(chatPersonIconColor(chatPersonIcons({ badges: ["team"] })[0]!, palette));
      for (const surface of [palette.bg, palette.panel, hoverBg(palette)]) {
        expect(contrastRatio(bot, surface), id).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  test("a zone's offset follows its daylight saving time", () => {
    expect(utcOffsetMinutesAt("Europe/Berlin", Date.parse("2026-01-15T12:00:00Z"))).toBe(60);
    expect(utcOffsetMinutesAt("Europe/Berlin", Date.parse("2026-07-15T12:00:00Z"))).toBe(120);
    // The spring change lands at 01:00 UTC.
    expect(utcOffsetMinutesAt("Europe/Berlin", Date.parse("2026-03-29T00:59:00Z"))).toBe(60);
    expect(utcOffsetMinutesAt("Europe/Berlin", Date.parse("2026-03-29T01:00:00Z"))).toBe(120);
    expect(utcOffsetMinutesAt("America/New_York", Date.parse("2026-11-01T05:59:00Z"))).toBe(-240);
    expect(utcOffsetMinutesAt("America/New_York", Date.parse("2026-11-01T06:00:00Z"))).toBe(-300);
    expect(utcOffsetMinutesAt("Asia/Kathmandu", Date.parse("2026-07-15T12:00:00Z"))).toBe(345);
    expect(utcOffsetMinutesAt("Not/AZone", Date.now())).toBeNull();
  });

  test("a missing or UTC zone reports nothing rather than a guess", () => {
    expect(localUtcOffsetMinutes(Date.now(), null)).toBeNull();
    expect(localUtcOffsetMinutes(Date.parse("2026-07-15T12:00:00Z"), "Europe/Berlin")).toBe(120);
    for (const zone of ["UTC", "Etc/UTC", "GMT", "Etc/GMT+0", "Zulu", "", undefined]) {
      expect(reportableTimeZone(zone), String(zone)).toBeNull();
    }
    expect(reportableTimeZone("Europe/London")).toBe("Europe/London");
  });

  test("local time reads as their clock, with the day when it is not the reader's", () => {
    const now = Date.parse("2026-03-29T12:05:00Z");
    expect(formatChatLocalTime(120, now)).toBe("14:05");
    expect(formatChatLocalTime(-300, now, 120)).toBe("07:05");
    expect(formatChatLocalTime(345, Date.parse("2026-03-29T20:00:00Z"), -240)).toBe("01:45 tomorrow");
    expect(formatChatLocalTime(-600, Date.parse("2026-03-29T02:00:00Z"), 60)).toBe("16:00 yesterday");
    // Hidden, never reported, or nothing a zone uses.
    expect(formatChatLocalTime(undefined, now)).toBeNull();
    expect(formatChatLocalTime(null, now)).toBeNull();
    expect(formatChatLocalTime(900, now)).toBeNull();
    expect(formatChatLocalTime(60.5, now)).toBeNull();
  });

  test("the card says only what the person shares: no clock while hidden, no desks unless chosen", () => {
    const now = Date.parse("2026-10-12T09:30:00Z");
    expect(chatPersonFacts({ accountType: "human" }, now)).toEqual({ roles: [], localTime: null, trades: [] });
    expect(chatPersonFacts({ badges: ["team", "pro"], utcOffsetMinutes: 120, desks: ["options", "crypto", "futures"] }, now))
      .toEqual({ roles: ["Gloom team", "Pro"], localTime: "11:30", trades: ["Options", "Futures"] });
    expect(chatPersonFacts({ accountType: "managed_llm", utcOffsetMinutes: 0, desks: ["fx"] }, now))
      .toEqual({ roles: ["Bot run by Gloom"], localTime: null, trades: [] });
  });
});
