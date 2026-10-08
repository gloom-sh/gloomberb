import { apiClient, type ChatDiscordLink } from "../../../api-client";
import { ApiRequestError } from "../../../api-client/errors";
import { safeExternalUrl } from "../../../utils/external-url";
import type { AppNotificationRequest } from "../../../types/plugin";
import type { DiscordComposerCommand } from "./composer-commands";

/** The four Discord calls the composer's /discord command makes. */
export interface DiscordCommandApi {
  getLink(): Promise<ChatDiscordLink>;
  startLink(): Promise<{ url: string }>;
  unlink(): Promise<void>;
  setMirror(enabled: boolean): Promise<void>;
}

const discordCommandApi: DiscordCommandApi = {
  getLink: () => apiClient.getChatDiscordLink(),
  startLink: () => apiClient.startChatDiscordLink(),
  unlink: () => apiClient.unlinkChatDiscord(),
  setMirror: (enabled) => apiClient.setChatDiscordMirror(enabled),
};

export const DISCORD_UNAVAILABLE = "Discord sync is not available yet";
const DISCORD_USAGE = "Use /discord to connect, /discord unlink, or /discord mirror on|off";

type DiscordCommandOutcome = Pick<AppNotificationRequest, "body" | "type">;

/** A server without Discord sync answers its routes with 404, or 501 where it knows them but has no bridge. */
function isUnavailable(error: unknown): boolean {
  return error instanceof ApiRequestError && (error.status === 404 || error.status === 501);
}

function linkedStatus(link: ChatDiscordLink): string {
  const name = link.discordUsername ? `Linked as ${link.discordUsername}` : "Linked to Discord";
  const mirror = link.mirror ? "Mirroring is on" : "Mirroring is off";
  return `${name}. ${mirror}. /discord mirror on|off, /discord unlink`;
}

async function connect(api: DiscordCommandApi, openUrl: (url: string) => Promise<void>): Promise<DiscordCommandOutcome> {
  const link = await api.getLink();
  if (link.linked) return { body: linkedStatus(link), type: "info" };
  const { url } = await api.startLink();
  const approveUrl = safeExternalUrl(url);
  if (!approveUrl) return { body: "Discord sent a link that cannot be opened.", type: "error" };
  await openUrl(approveUrl);
  return { body: "Approve in your browser", type: "info" };
}

async function unlink(api: DiscordCommandApi): Promise<DiscordCommandOutcome> {
  // A 404 from the unlink route alone could mean "no Discord sync" or "nothing linked", so ask first.
  const link = await api.getLink();
  if (!link.linked) return { body: "Discord is not linked", type: "info" };
  await api.unlink();
  return { body: "Unlinked from Discord", type: "success" };
}

/**
 * Runs one /discord subcommand and says what to tell the user. A server that
 * has no Discord sync answers 404 or 501, which reads as "not available yet"
 * and nothing else.
 */
export async function runDiscordCommand(
  command: DiscordComposerCommand,
  deps: { api?: DiscordCommandApi; openUrl: (url: string) => Promise<void> },
): Promise<DiscordCommandOutcome> {
  const api = deps.api ?? discordCommandApi;
  try {
    switch (command.action) {
      case "connect":
        return await connect(api, deps.openUrl);
      case "unlink":
        return await unlink(api);
      case "mirror":
        await api.setMirror(command.enabled);
        return {
          body: command.enabled ? "Your public messages are mirrored to Discord" : "Your public messages are no longer mirrored to Discord",
          type: "success",
        };
      case "usage":
        return { body: DISCORD_USAGE, type: "info" };
    }
  } catch (error) {
    if (isUnavailable(error)) return { body: DISCORD_UNAVAILABLE, type: "info" };
    return { body: error instanceof Error && error.message ? error.message : "Discord request failed.", type: "error" };
  }
}
