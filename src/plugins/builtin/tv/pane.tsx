import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Tabs, usePaneFooter } from "../../../components";
import { updatePaneInstance } from "../../../pane-settings";
import { useShortcut } from "../../../react/input";
import {
  syncConfigActiveLayoutState,
  useAppDispatch,
  useAppStateRef,
  usePaneInstance,
} from "../../../state/app/context";
import { scheduleConfigSave } from "../../../state/config-save-scheduler";
import { colors } from "../../../theme/colors";
import type { PaneProps } from "../../../types/plugin";
import { Box, ImageSurface, MediaSurface, Text, useRendererHost, useUiHost, type MediaSurfaceHandle } from "../../../ui";
import { getTvChannel, TV_CHANNELS, type TvChannelId } from "./channels";
import type { ResolvedLiveStream } from "../../../types/media";
import { buildYoutubeLiveEmbedUrl, isYoutubeEmbedUrl } from "./youtube-embed";
import { resolveTvStream } from "./youtube-stream";

type PlaybackState = "idle" | "loading" | "playing" | "paused" | "error";

function activeWebOrigin(): string | undefined {
  const location = (globalThis as { window?: { location?: { protocol?: string; origin?: string } } }).window?.location;
  if (!location?.protocol || !location.origin) return undefined;
  return /^https?:$/.test(location.protocol) ? location.origin : undefined;
}

function webMediaSource(stream: ResolvedLiveStream): string {
  if (!isYoutubeEmbedUrl(stream.manifestUrl)) return stream.manifestUrl;
  const origin = activeWebOrigin();
  // Autoplay requires starting muted; unmuting afterwards goes through the
  // iframe postMessage API so the URL (and therefore the player) stays stable.
  return buildYoutubeLiveEmbedUrl(stream.videoId, {
    muted: true,
    origin,
    widgetReferrer: origin,
  });
}

export function TvPane({ paneId, focused, width, height }: PaneProps) {
  const isDesktop = useUiHost().kind === "desktop-web";
  const renderer = useRendererHost();
  const dispatch = useAppDispatch();
  const stateRef = useAppStateRef();
  const pane = usePaneInstance();
  const initialChannelIdRef = useRef<TvChannelId>(
    TV_CHANNELS.find((item) => item.id === pane?.settings?.channelId)?.id ?? "bloomberg",
  );
  const [channelId, setChannelId] = useState<TvChannelId>(initialChannelIdRef.current);
  const [stream, setStream] = useState<ResolvedLiveStream | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [playbackState, setPlaybackState] = useState<PlaybackState>("idle");
  const [muted, setMuted] = useState(true);
  const mediaRef = useRef<MediaSurfaceHandle | null>(null);
  const terminalAutoPlayedRef = useRef<string | null>(null);
  const recoveredStreamRef = useRef<string | null>(null);
  const generationRef = useRef(0);
  const channel = getTvChannel(channelId);

  const persistChannelSelection = useCallback((nextId: TvChannelId) => {
    const nextChannel = getTvChannel(nextId);
    const nextTitle = `TV: ${nextChannel.name}`;
    const currentState = stateRef.current;
    const currentPane = currentState.config.layout.instances.find((instance) => instance.instanceId === paneId);
    if (currentPane?.title === nextTitle && currentPane.settings?.channelId === nextId) return;

    const layout = updatePaneInstance(currentState.config.layout, paneId, (instance) => ({
      ...instance,
      title: nextTitle,
      settings: { ...instance.settings, channelId: nextId },
    }));
    const syncedConfig = syncConfigActiveLayoutState(
      { ...currentState.config, layout },
      currentState.paneState,
      currentState.focusedPaneId,
      currentState.activePanel,
    );
    dispatch({ type: "SET_CONFIG", config: syncedConfig });
    scheduleConfigSave(syncedConfig);
  }, [dispatch, paneId, stateRef]);

  const load = useCallback(async (force = false) => {
    const generation = ++generationRef.current;
    setLoading(true);
    setError(null);
    setPlaybackError(null);
    setPlaybackState("idle");
    setStream((current) => current?.sourceId === channel.id ? current : null);
    try {
      const nextStream = renderer.resolveLiveStream
        ? await renderer.resolveLiveStream({ provider: "youtube", sourceId: channel.id, force })
        : await resolveTvStream(channel, { force });
      if (generation !== generationRef.current) return;
      setStream(nextStream);
    } catch (cause) {
      if (generation !== generationRef.current) return;
      setStream(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (generation === generationRef.current) setLoading(false);
    }
  }, [channel, renderer]);

  const refresh = useCallback(() => {
    void load(true);
  }, [load]);

  useEffect(() => {
    void load();
    return () => {
      generationRef.current += 1;
    };
  }, [load]);

  // Resolved YouTube manifests expire within minutes, so an open pane re-resolves
  // shortly before the current one dies instead of playing into an error.
  useEffect(() => {
    if (!stream) return;
    const delay = Math.max(5_000, stream.expiresAt - 60_000 - Date.now());
    const timer = setTimeout(() => {
      void load(true);
    }, delay);
    return () => clearTimeout(timer);
  }, [load, stream]);

  // A dead manifest surfaces as a media error; re-resolve once per stream so a
  // silent expiry recovers without the user pressing anything.
  const handlePlaybackError = useCallback((message: string) => {
    setPlaybackError(message);
    const streamKey = stream ? `${stream.sourceId}:${stream.videoId}` : null;
    if (!streamKey || recoveredStreamRef.current === streamKey) return;
    recoveredStreamRef.current = streamKey;
    void load(true);
  }, [load, stream]);

  useEffect(() => {
    persistChannelSelection(channelId);
  }, [channelId, persistChannelSelection]);

  const selectChannel = useCallback((nextId: string) => {
    if (TV_CHANNELS.some((item) => item.id === nextId)) {
      setMuted(true);
      setChannelId(nextId as TvChannelId);
    }
  }, []);

  const playInTerminal = useCallback(async () => {
    if (!stream || !renderer.playTerminalMedia) return;
    setPlaybackError(null);
    setPlaybackState("playing");
    try {
      await renderer.playTerminalMedia(stream.manifestUrl, stream.title, { muted });
      setPlaybackState("paused");
    } catch (cause) {
      setPlaybackState("error");
      setPlaybackError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [muted, renderer, stream]);

  useEffect(() => {
    if (isDesktop || loading || !stream || stream.sourceId !== channel.id) return;
    const streamKey = `${stream.sourceId}:${stream.videoId}`;
    if (terminalAutoPlayedRef.current === streamKey) return;
    terminalAutoPlayedRef.current = streamKey;
    void playInTerminal();
  }, [channel.id, isDesktop, loading, playInTerminal, stream]);

  const togglePlayback = useCallback(async () => {
    setPlaybackError(null);
    try {
      if (isDesktop) {
        await mediaRef.current?.toggle();
      } else {
        await playInTerminal();
      }
    } catch (cause) {
      setPlaybackState("error");
      setPlaybackError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [isDesktop, playInTerminal]);

  const toggleMute = useCallback(() => {
    if (isDesktop) {
      const nextMuted = mediaRef.current?.toggleMuted();
      if (typeof nextMuted === "boolean") setMuted(nextMuted);
      return;
    }
    setMuted((current) => !current);
  }, [isDesktop]);

  useShortcut((event) => {
    if (!focused) return;
    const channelIndex = Number(event.name) - 1;
    if (Number.isInteger(channelIndex) && TV_CHANNELS[channelIndex]) {
      event.preventDefault?.();
      selectChannel(TV_CHANNELS[channelIndex]!.id);
      return;
    }
    if (event.name === "r") {
      event.preventDefault?.();
      refresh();
      return;
    }
    if (event.name === "p" && stream) {
      event.preventDefault?.();
      void togglePlayback();
      return;
    }
    if (event.name === "m" && stream) {
      event.preventDefault?.();
      toggleMute();
      return;
    }
    if (event.name === "o") {
      event.preventDefault?.();
      void renderer.openExternal(channel.channelUrl);
    }
  });

  const streamKind = stream?.isLive === false ? "latest replay" : "live";
  const replayDetail = stream?.isLive === false && stream.publishedText ? ` · ${stream.publishedText}` : "";
  const status = loading
    ? `resolving ${channel.name}`
    : error || playbackError
      ? "stream error"
      : playbackState === "playing"
        ? `playing ${streamKind}${replayDetail}`
        : playbackState === "loading"
          ? `buffering ${streamKind}${replayDetail}`
          : stream
            ? `${streamKind}${replayDetail}`
            : "offline";

  usePaneFooter(paneId, () => ({
    info: [{
      id: "tv-status",
      parts: [{
        text: status,
        tone: error || playbackError ? "warning" : playbackState === "playing" ? "positive" : "value",
      }],
    }],
    hints: [
      {
        id: "playback",
        key: "p",
        label: playbackState === "playing" ? "ause" : "lay",
        onPress: () => { void togglePlayback(); },
        disabled: loading || !stream,
      },
      {
        id: "mute",
        key: "m",
        label: muted ? "unmute" : "ute",
        onPress: toggleMute,
        disabled: loading || !stream,
      },
      {
        id: "open",
        key: "o",
        label: "pen",
        onPress: () => { void renderer.openExternal(channel.channelUrl); },
      },
    ],
  }), [channel.channelUrl, error, loading, muted, paneId, playbackError, playbackState, refresh, renderer, status, stream, toggleMute, togglePlayback]);

  const channelTabs = useMemo(() => TV_CHANNELS.map((item, index) => ({
    label: `${index + 1} ${item.name}`,
    value: item.id,
  })), []);
  const mediaHeight = Math.max(6, height - 1);

  return (
    <Box flexDirection="column" width={width} height={height}>
      <Box height={1} paddingX={1}>
        <Tabs
          tabs={channelTabs}
          activeValue={channelId}
          onSelect={selectChannel}
          compact
          variant="bare"
          focused={focused}
        />
      </Box>

      {loading && !stream ? (
        <Box flexGrow={1} justifyContent="center" alignItems="center">
          <Text fg={colors.textMuted}>{`Resolving ${channel.name} live stream...`}</Text>
        </Box>
      ) : error || !stream ? (
        <Box flexGrow={1} flexDirection="column" justifyContent="center" alignItems="center" gap={1}>
          <Text fg={colors.warning}>{error ?? `${channel.name} is offline.`}</Text>
          <Button label="Try again" variant="primary" onPress={refresh} />
        </Box>
      ) : isDesktop ? (
        <MediaSurface
          src={webMediaSource(stream)}
          title={stream.title}
          poster={stream.posterUrl}
          autoPlay
          muted={muted}
          mediaHandleRef={mediaRef}
          height={mediaHeight}
          flexGrow={1}
          onPlaybackStateChange={setPlaybackState}
          onMutedChange={setMuted}
          onError={handlePlaybackError}
        >
          <Box flexGrow={1} justifyContent="center" alignItems="center">
            <Text fg={colors.warning}>{playbackError ?? "Live video unavailable."}</Text>
          </Box>
        </MediaSurface>
      ) : (
        <Box flexGrow={1} flexDirection="column" alignItems="center" justifyContent="center" gap={1}>
          <ImageSurface
            src={stream.posterUrl}
            alt={stream.title}
            objectFit="contain"
            width="100%"
            height={Math.max(5, mediaHeight - 2)}
          >
            <Box flexGrow={1} justifyContent="center" alignItems="center">
              <Text fg={colors.text}>{stream.title}</Text>
              {stream.isLive === false && stream.publishedText ? (
                <Text fg={colors.textMuted}>{stream.publishedText}</Text>
              ) : null}
            </Box>
          </ImageSurface>
          <Button
            label="Play in Kitty"
            shortcut="p"
            variant="primary"
            disabled={!renderer.playTerminalMedia}
            onPress={() => void togglePlayback()}
          />
          {playbackError ? <Text fg={colors.warning}>{playbackError}</Text> : null}
        </Box>
      )}
    </Box>
  );
}
