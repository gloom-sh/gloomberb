import type { ResolvedLiveStream } from "../../../../types/media";
import { getTvChannel, TV_CHANNELS } from "../../../../plugins/builtin/tv/channels";
import { resolveTvStream } from "../../../../plugins/builtin/tv/youtube-stream";
import type { DesktopBackendRequestPayload } from "../../shared/protocol";

export async function resolveDesktopLiveStream(
  request: DesktopBackendRequestPayload<"media.resolveLiveStream">,
): Promise<ResolvedLiveStream> {
  if (request.provider !== "youtube") {
    throw new Error("Unsupported live-stream provider.");
  }
  const channel = TV_CHANNELS.find((item) => item.id === request.sourceId);
  if (!channel) {
    throw new Error("Unknown TV channel.");
  }
  return resolveTvStream(getTvChannel(channel.id), { force: request.force === true });
}
