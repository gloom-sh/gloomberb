export type ChatComposerCommand =
  | { kind: "direct"; username: string; draft: string }
  | { kind: "group"; usernames: string[]; name: string | undefined }
  | DiscordComposerCommand;

/** `usage` is anything after /discord that is not a subcommand: it answers with the usage instead of going to the channel as text. */
export type DiscordComposerCommand =
  | { kind: "discord"; action: "connect" | "unlink" | "usage" }
  | { kind: "discord"; action: "mirror"; enabled: boolean };

const USERNAME_PATTERN = "[A-Za-z][A-Za-z0-9_]{2,29}";
const DIRECT_COMMAND_RE = new RegExp(`^/dm\\s+@?(${USERNAME_PATTERN})(?:\\s+([\\s\\S]+))?$`, "i");
const GROUP_COMMAND_RE = /^\/group\s+(.+)$/i;
const DISCORD_COMMAND_RE = /^\/discord(?:\s+([\s\S]*))?$/i;
const GROUP_USERNAME_RE = new RegExp(`@(${USERNAME_PATTERN})`, "g");

function parseDiscordArguments(rest: string): DiscordComposerCommand {
  const [subcommand, value, ...extra] = rest.toLowerCase().split(/\s+/).filter(Boolean);
  if (!subcommand) return { kind: "discord", action: "connect" };
  if (subcommand === "unlink" && value === undefined) return { kind: "discord", action: "unlink" };
  if (subcommand === "mirror" && extra.length === 0 && (value === "on" || value === "off")) {
    return { kind: "discord", action: "mirror", enabled: value === "on" };
  }
  return { kind: "discord", action: "usage" };
}

export function parseChatComposerCommand(content: string): ChatComposerCommand | null {
  const discordCommand = content.match(DISCORD_COMMAND_RE);
  if (discordCommand) return parseDiscordArguments(discordCommand[1] ?? "");

  const directCommand = content.match(DIRECT_COMMAND_RE);
  if (directCommand) {
    return {
      kind: "direct",
      username: directCommand[1]!.toLowerCase(),
      draft: directCommand[2]?.trim() ?? "",
    };
  }

  const groupCommand = content.match(GROUP_COMMAND_RE);
  if (!groupCommand) return null;

  const body = groupCommand[1] ?? "";
  const usernames = [...body.matchAll(GROUP_USERNAME_RE)]
    .map((entry) => entry[1]?.toLowerCase())
    .filter((entry): entry is string => !!entry);
  if (usernames.length === 0) return null;

  return {
    kind: "group",
    usernames,
    name: body.replace(GROUP_USERNAME_RE, "").trim() || undefined,
  };
}
