import type { ChatUserSummary } from "../../../api-client";
import { blendForContrastOnSurfaces, higherContrast, parseHex } from "../../../theme/color-utils";
import { blendHex, colors, hoverBg, type ThemeColors } from "../../../theme/colors";
import { DESK_KEYS, type DeskKey } from "../../../layout/desk-keys";
import type { IconName } from "../../../components/ui/icon";
import { isManagedBot } from "./ghost-user";

/**
 * Who someone is in chat, at a glance: a bot's own colour, the icons their
 * account earns, their local time and what they trade. The server derives
 * each from the account; a field it leaves out shows nothing.
 */

type ChatPersonIconId = "bot" | "team" | "pro";

export interface ChatPersonIcon {
  id: ChatPersonIconId;
  /** From the app's icon set: a bot's face, the Gloom mark, a gem. */
  icon: IconName;
  /** What it means, in its tooltip and on the card. */
  label: string;
}

/** Beside a bot's name wherever it signs: the transcript, reply quotes, the composer and the inbox. */
export const CHAT_BOT_ICON: ChatPersonIcon = { id: "bot", icon: "bot", label: "Bot run by Gloom" };
const TEAM_ICON: ChatPersonIcon = { id: "team", icon: "team", label: "Gloom team" };
const PRO_ICON: ChatPersonIcon = { id: "pro", icon: "pro", label: "Pro" };

/**
 * The icons beside a name: at most one role, the bot's for a bot Gloom runs
 * or the team's for Gloom staff, then Pro. A bot carries only its own.
 */
export function chatPersonIcons(user: Pick<ChatUserSummary, "accountType" | "badges"> | null | undefined): ChatPersonIcon[] {
  if (!user) return [];
  if (isManagedBot(user)) return [CHAT_BOT_ICON];
  const badges = user.badges ?? [];
  return [
    ...(badges.includes("team") ? [TEAM_ICON] : []),
    ...(badges.includes("pro") ? [PRO_ICON] : []),
  ];
}

/** Cells one icon takes on a line: a cell of space before it, then the icon. */
export const CHAT_PERSON_ICON_WIDTH = 2;

/**
 * The icons that fit in `width` cells. Pro goes first, then the role: a
 * narrow row keeps the name whole and the row's actions in reach.
 */
export function fitChatPersonIcons(icons: readonly ChatPersonIcon[], width: number): ChatPersonIcon[] {
  let kept = [...icons];
  while (kept.length > 0 && kept.length * CHAT_PERSON_ICON_WIDTH > width) {
    const pro = kept.findIndex((icon) => icon.id === "pro");
    kept = pro >= 0 ? kept.filter((_, index) => index !== pro) : kept.slice(0, -1);
  }
  return kept;
}

/** How far apart two colours look, roughly: the "redmean" distance, 0 to about 765. */
function colourDistance(a: string, b: string): number {
  const [ar, ag, ab] = parseHex(a);
  const [br, bg, bb] = parseHex(b);
  const meanRed = (ar + br) / 2;
  const dr = ar - br;
  const dg = ag - bg;
  const db = ab - bb;
  return Math.sqrt((2 + meanRed / 256) * dr * dr + 4 * dg * dg + (2 + (255 - meanRed) / 256) * db * db);
}

/** Below this the bot colour would read as one of the colours it must stand apart from. */
const BOT_COLOUR_MIN_DISTANCE = 80;
/** Below this the team icon would read as the bot colour. */
const ROLE_COLOUR_MIN_DISTANCE = 90;

/**
 * The two role colours come from the theme's accent and warning tokens: the
 * bot takes the one furthest from the colours chat already uses for people
 * (every user name and an @mention are the positive token, the message text
 * is the text token, and the negative token reads as an error); Team takes
 * the other, so a bot and a staff member never share a colour.
 */
function roleHues(palette: ThemeColors): { bot: string; team: string } {
  const avoid = [palette.positive, palette.text, palette.negative];
  const score = (candidate: string) => Math.min(...avoid.map((colour) => colourDistance(candidate, colour)));
  const [accent, warning] = [palette.borderFocused, palette.warning];
  let bot = score(warning) > score(accent) ? warning : accent;
  let team = bot === warning ? accent : warning;
  // Where the two tokens are one hue (Solarized has a single yellow), Team
  // takes the brightest text instead.
  if (colourDistance(team, bot) < ROLE_COLOUR_MIN_DISTANCE) team = palette.textBright;
  // A palette whose accent and warning both sit on a person's colour (the
  // amber phosphor's text is its accent) still needs the bot apart: the
  // closer hue is paled toward white on a dark theme, deepened on a light one.
  if (score(bot) < BOT_COLOUR_MIN_DISTANCE) {
    bot = blendHex(bot, higherContrast("#ffffff", "#000000", palette.bg), 0.45);
  }
  return { bot, team };
}

/** Lifted until it reads on every surface a row can have: the background, the panel, a hover and a marked message. */
function legibleOnRows(colour: string, palette: ThemeColors): string {
  const surfaces = [palette.bg, palette.panel, hoverBg(palette), blendHex(palette.bg, palette.borderFocused, 0.22)];
  return blendForContrastOnSurfaces(colour, surfaces, higherContrast("#ffffff", "#000000", palette.bg), 4.5);
}

/** The colour a bot's name and its icon are drawn in. */
export function chatBotNameColor(palette: ThemeColors = colors): string {
  return legibleOnRows(roleHues(palette).bot, palette);
}

/** The colour of an icon beside a name: the bot's own, the team's, and Pro in the quiet tone of the time beside it. */
export function chatPersonIconColor(icon: ChatPersonIcon, palette: ThemeColors = colors): string {
  if (icon.id === "bot") return chatBotNameColor(palette);
  if (icon.id === "team") return legibleOnRows(roleHues(palette).team, palette);
  return palette.textDim;
}

/** The colour a name is drawn in: a bot's own, everyone else the colour every person has. */
export function chatAuthorNameColor(user: Pick<ChatUserSummary, "accountType"> | null | undefined, palette: ThemeColors = colors): string {
  return isManagedBot(user) ? chatBotNameColor(palette) : palette.positive;
}

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** A whole-minute offset from UTC the zones use, or null. */
function usableOffset(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= -12 * 60 && value <= 14 * 60 ? value : null;
}

/**
 * Someone's local time as the card shows it: `14:05`, then `tomorrow` or
 * `yesterday` when their day is not the reader's. Null when the person keeps
 * it hidden or their app never said. Their offset is the one their app last
 * reported, so it already follows their daylight saving time.
 */
export function formatChatLocalTime(
  utcOffsetMinutes: number | null | undefined,
  now = Date.now(),
  readerOffsetMinutes: number | null = null,
): string | null {
  const offset = usableOffset(utcOffsetMinutes);
  if (offset === null || !Number.isFinite(now)) return null;
  const theirs = new Date(now + offset * MINUTE_MS);
  const clock = `${String(theirs.getUTCHours()).padStart(2, "0")}:${String(theirs.getUTCMinutes()).padStart(2, "0")}`;
  const reader = usableOffset(readerOffsetMinutes);
  if (reader === null) return clock;
  const theirDay = Math.floor((now + offset * MINUTE_MS) / DAY_MS);
  const readerDay = Math.floor((now + reader * MINUTE_MS) / DAY_MS);
  if (theirDay > readerDay) return `${clock} tomorrow`;
  if (theirDay < readerDay) return `${clock} yesterday`;
  return clock;
}

const DESK_LABELS: Record<DeskKey, string> = {
  equities: "Stocks",
  options: "Options",
  futures: "Futures",
  rates: "Rates",
  fx: "FX",
  active: "Day trading",
};

/** What someone trades, as the coarse words a card shows, in the order they chose; unknown desks are left out. */
function chatDeskLabels(desks: readonly string[] | null | undefined): string[] {
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const desk of desks ?? []) {
    if (seen.has(desk) || !(DESK_KEYS as readonly string[]).includes(desk)) continue;
    seen.add(desk);
    labels.push(DESK_LABELS[desk as DeskKey]);
  }
  return labels;
}

/** The desks someone can show, with the words a card uses for them. */
export function chatDeskChoices(): Array<{ value: DeskKey; label: string }> {
  return DESK_KEYS.map((value) => ({ value, label: DESK_LABELS[value] }));
}

export interface ChatPersonFacts {
  /** "Gloom team" and "Pro", "Bot run by Gloom", or none. */
  roles: string[];
  /** "14:05", "01:30 tomorrow", or null when hidden or unknown. */
  localTime: string | null;
  /** "Options", "Futures": empty unless they chose to show what they trade. */
  trades: string[];
}

/** What a person's card says about them beyond their profile, each only when there is something to say. */
export function chatPersonFacts(
  user: Pick<ChatUserSummary, "accountType" | "badges" | "utcOffsetMinutes" | "desks">,
  now = Date.now(),
  readerOffsetMinutes: number | null = null,
): ChatPersonFacts {
  const bot = isManagedBot(user);
  return {
    roles: chatPersonIcons(user).map((icon) => icon.label),
    localTime: bot ? null : formatChatLocalTime(user.utcOffsetMinutes, now, readerOffsetMinutes),
    trades: bot ? [] : chatDeskLabels(user.desks),
  };
}
